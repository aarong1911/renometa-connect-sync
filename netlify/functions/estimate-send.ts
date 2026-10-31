/// <reference types="node" />
// netlify/functions/estimate-send.ts
//
// Phase 10.4 — authenticated estimate proposal delivery.
//
// Flow:
// 1. Authenticate the current user and check they may send estimates
//    (resolveEstimateSendPermission — same boundary as before Gmail sending).
// 2. Confirm the estimate belongs to the user's organization.
// 3. Load the customer and estimate items.
// 4. Recalculate all totals server-side.
// 5. Preflight the org's connected Gmail account (lib/gmail-send.ts) —
//    not connected / expired / missing send scope fails here, before any write.
// 6. Claim the send (lib/email-send-claim.ts) so a double submit can't email
//    twice. An earlier ambiguous send is reconciled against Gmail's Sent mail
//    first; an earlier unrecorded one is finished without re-emailing.
// 7. Persist the secure proposal token and calculated totals.
// 8. Send the proposal email FROM the contractor's Gmail account.
// 9. Mark the estimate as sent only after Gmail accepts the message.
// 10. Record one sent/re-sent activity (with Gmail message/thread ids) and
//     the outbound row in gmail_messages for the contact's email thread.
// 11. Trigger estimate_sent workflows.
//
// Customer proposals are never sent through AWS SES or from a renometa.com
// address — with no usable Gmail connection the send is refused with a
// structured `email_not_connected` / `email_reconnect_required` error.

import type { Handler, HandlerEvent, HandlerResponse } from "@netlify/functions";
import { createClient, type PostgrestError } from "@supabase/supabase-js";
import crypto from "node:crypto";

import {
  calculateEstimate,
  type CalcLineItem,
} from "../../src/lib/estimate-calculations";
import { type EstimateStatus } from "../../src/lib/estimate-status";
import {
  UNPRICED_ESTIMATE_ERROR,
  hasPricePendingItems,
  type PricingGateItem,
} from "../../src/lib/estimate-pricing-gate";
import { resolveEstimateSendPermission, resolveMemberRole } from "../../src/lib/change-order-permissions";
import {
  GmailSendError,
  isValidRecipientEmail,
  resolveGmailSender,
  sendGmailMessage,
  type GmailSender,
} from "./lib/gmail-send";
import {
  acquireEmailSendClaim,
  reconcileUnconfirmedSend,
  releaseEmailSendClaim,
  takeOverEmailSendClaim,
  unconfirmedDeliveryMessage,
  updateEmailSendClaim,
} from "./lib/email-send-claim";
import { persistGmailApiSentEmail } from "./lib/gmail-sent-reconcile";
import { completeEstimateSend } from "./lib/estimate-send-completion";

const SUPABASE_URL =
  process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const admin = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  },
);

type EstimateRow = {
  id: string;
  org_id: string;
  status: EstimateStatus;
  number: string | null;
  title: string | null;
  version_number: number;
  public_token: string | null;
  deposit_type: "percent" | "fixed" | null;
  deposit_value: number | string | null;
  discount_type: "percent" | "fixed" | null;
  discount_value: number | string | null;
  tax_rate: number | string | null;
  client_id: string;
  project_id: string | null;
};

type ContactRow = {
  full_name: string | null;
  email: string | null;
};

type OrganizationRow = {
  name: string | null;
  public_name: string | null;
};

type ProfileRow = {
  organization_id: string | null;
  first_name: string | null;
  last_name: string | null;
};

type EstimateItemRow = {
  quantity: number | string | null;
  unit_price: number | string | null;
  taxable: boolean | null;
  optional: boolean | null;
  selected_by_customer: boolean | null;
  is_heading: boolean | null;
  discount_type: "percent" | "fixed" | null;
  discount_value: number | string | null;
};

type RequestBody = {
  estimateId?: string;
  /** The user saw "couldn't confirm the earlier send" and chose to send anyway. */
  confirmResend?: boolean;
};

type SerializableError = {
  name: string | null;
  code: string | null;
  message: string;
  details: string | null;
  hint: string | null;
  status: number | null;
  stack: string | null;
};

const TERMINAL_SEND_STATUSES = new Set([
  "approved",
  "rejected",
  "expired",
  "converted",
  "cancelled",
  "archived",
]);

function json(
  statusCode: number,
  body: Record<string, unknown>,
): HandlerResponse {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function serializeError(error: unknown): SerializableError {
  if (error instanceof Error) {
    const extended = error as Error & {
      code?: unknown;
      details?: unknown;
      hint?: unknown;
      status?: unknown;
      statusCode?: unknown;
    };

    return {
      name: extended.name || null,
      code:
        typeof extended.code === "string"
          ? extended.code
          : null,
      message: extended.message || "Unknown error",
      details:
        typeof extended.details === "string"
          ? extended.details
          : null,
      hint:
        typeof extended.hint === "string"
          ? extended.hint
          : null,
      status:
        typeof extended.status === "number"
          ? extended.status
          : typeof extended.statusCode === "number"
            ? extended.statusCode
            : null,
      stack: extended.stack ?? null,
    };
  }

  if (error && typeof error === "object") {
    const value = error as {
      name?: unknown;
      code?: unknown;
      message?: unknown;
      details?: unknown;
      hint?: unknown;
      status?: unknown;
      statusCode?: unknown;
      stack?: unknown;
    };

    return {
      name:
        typeof value.name === "string"
          ? value.name
          : null,
      code:
        typeof value.code === "string"
          ? value.code
          : null,
      message:
        typeof value.message === "string"
          ? value.message
          : String(error),
      details:
        typeof value.details === "string"
          ? value.details
          : null,
      hint:
        typeof value.hint === "string"
          ? value.hint
          : null,
      status:
        typeof value.status === "number"
          ? value.status
          : typeof value.statusCode === "number"
            ? value.statusCode
            : null,
      stack:
        typeof value.stack === "string"
          ? value.stack
          : null,
    };
  }

  return {
    name: null,
    code: null,
    message: String(error),
    details: null,
    hint: null,
    status: null,
    stack: null,
  };
}

function logDatabaseError(
  stage: string,
  error: PostgrestError | null,
): void {
  if (!error) return;

  console.error(`[estimate-send] ${stage}`, {
    code: error.code ?? null,
    message: error.message ?? null,
    details: error.details ?? null,
    hint: error.hint ?? null,
  });
}

function parseRequestBody(event: HandlerEvent): RequestBody {
  if (!event.body) return {};

  try {
    return JSON.parse(event.body) as RequestBody;
  } catch {
    return {};
  }
}

function getBearerToken(event: HandlerEvent): string | null {
  const authorization =
    event.headers.authorization ??
    event.headers.Authorization;

  if (!authorization) return null;

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function getAppBaseUrl(event: HandlerEvent): string {
  const configured =
    process.env.CONNECT_APP_URL ??
    process.env.APP_URL ??
    process.env.URL;

  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  const forwardedProto =
    event.headers["x-forwarded-proto"] ?? "http";

  const forwardedHost =
    event.headers["x-forwarded-host"] ??
    event.headers.host;

  if (forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`.replace(
      /\/+$/,
      "",
    );
  }

  return "http://localhost:9999";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toFiniteNumber(
  value: number | string | null | undefined,
): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildCalcItems(
  rows: EstimateItemRow[],
): CalcLineItem[] {
  return rows.map((item) => ({
    quantity: toFiniteNumber(item.quantity),
    unitPrice: toFiniteNumber(item.unit_price),
    taxable: item.taxable !== false,
    optional: item.optional === true,
    selectedByCustomer:
      item.selected_by_customer !== false,
    isHeading: item.is_heading === true,
    discountType: item.discount_type,
    discountValue:
      item.discount_value === null
        ? null
        : toFiniteNumber(item.discount_value),
  }));
}

function buildProposalEmail(input: {
  organizationName: string;
  customerName: string;
  estimateNumber: string | null;
  estimateTitle: string | null;
  proposalUrl: string;
}): { subject: string; html: string; text: string } {
  const safeCustomerName = escapeHtml(
    input.customerName || "there",
  );

  const safeOrganizationName = escapeHtml(
    input.organizationName,
  );

  const safeEstimateTitle = input.estimateTitle
    ? escapeHtml(input.estimateTitle)
    : null;

  const safeEstimateNumber = input.estimateNumber
    ? escapeHtml(input.estimateNumber)
    : null;

  const safeProposalUrl = escapeHtml(input.proposalUrl);

  // Plain text: the subject is a MIME header (RFC 2047-encoded by
  // lib/gmail-send.ts), not HTML, so it must not carry HTML entities.
  const subjectParts = [
    input.estimateNumber
      ? `Proposal ${input.estimateNumber}`
      : "New proposal",
    `from ${input.organizationName}`,
  ];

  const subject = subjectParts.join(" ");

  const proposalDescription = safeEstimateTitle
    ? ` for <strong>${safeEstimateTitle}</strong>`
    : "";

  const numberLine = safeEstimateNumber
    ? `<p style="margin:0 0 8px;color:#6b7280;font-size:14px;">Proposal ${safeEstimateNumber}</p>`
    : "";

  const html = `
<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:32px;">
                ${numberLine}
                <h1 style="margin:0 0 20px;font-size:24px;line-height:1.3;color:#111827;">
                  Your proposal is ready
                </h1>

                <p style="margin:0 0 16px;font-size:16px;line-height:1.6;">
                  Hi ${safeCustomerName},
                </p>

                <p style="margin:0 0 24px;font-size:16px;line-height:1.6;">
                  ${safeOrganizationName} has sent you a proposal${proposalDescription}.
                </p>

                <table role="presentation" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="border-radius:8px;background:#2563eb;">
                      <a
                        href="${safeProposalUrl}"
                        style="display:inline-block;padding:12px 22px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;"
                      >
                        View Proposal
                      </a>
                    </td>
                  </tr>
                </table>

                <p style="margin:24px 0 6px;color:#6b7280;font-size:13px;line-height:1.5;">
                  If the button does not work, copy and paste this link:
                </p>

                <p style="margin:0;word-break:break-all;font-size:13px;line-height:1.5;">
                  <a href="${safeProposalUrl}" style="color:#2563eb;">
                    ${safeProposalUrl}
                  </a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`.trim();

  const text = [
    `Hi ${input.customerName || "there"},`,
    "",
    `${input.organizationName} has sent you a proposal${
      input.estimateTitle
        ? ` for ${input.estimateTitle}`
        : ""
    }.`,
    input.estimateNumber
      ? `Proposal: ${input.estimateNumber}`
      : null,
    "",
    `View proposal: ${input.proposalUrl}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return { subject, html, text };
}

function gmailErrorResponse(
  error: GmailSendError,
  canManageIntegrations: boolean,
): HandlerResponse {
  return json(
    error.httpStatus,
    error.toResponseBody({ canManageIntegrations }),
  );
}

export const handler: Handler = async (
  event,
): Promise<HandlerResponse> => {
  if (event.httpMethod !== "POST") {
    return json(405, {
      error: "Method Not Allowed",
    });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
      "[estimate-send] Missing Supabase server environment variables",
      {
        hasSupabaseUrl: Boolean(SUPABASE_URL),
        hasServiceRoleKey: Boolean(
          SUPABASE_SERVICE_ROLE_KEY,
        ),
      },
    );

    return json(500, {
      error:
        "The proposal service is not configured correctly.",
    });
  }

  const accessToken = getBearerToken(event);

  if (!accessToken) {
    return json(401, {
      error: "Unauthorized",
    });
  }

  const {
    data: { user },
    error: authError,
  } = await admin.auth.getUser(accessToken);

  if (authError || !user) {
    console.warn("[estimate-send] Invalid access token", {
      code: authError?.code ?? null,
      message: authError?.message ?? null,
    });

    return json(401, {
      error: "Invalid token",
    });
  }

  const { estimateId, confirmResend } = parseRequestBody(event);

  if (!estimateId) {
    return json(400, {
      error: "estimateId required",
    });
  }

  console.info("[estimate-send] Request received", {
    estimateId,
    userId: user.id,
  });

  try {
    const {
      data: profile,
      error: profileError,
    } = await admin
      .from("profiles")
      .select(
        "organization_id, first_name, last_name",
      )
      .eq("id", user.id)
      .maybeSingle<ProfileRow>();

    if (profileError) {
      logDatabaseError(
        "Profile lookup failed",
        profileError,
      );

      return json(500, {
        error:
          "Could not load your organization profile.",
      });
    }

    const orgId = profile?.organization_id;

    if (!orgId) {
      return json(403, {
        error:
          "No organization was found for this user.",
      });
    }

    // Role defaults + member_permissions overrides, preserving the pre-Gmail
    // boundary (every role with estimates access, accountants included).
    const canSend = await resolveEstimateSendPermission(
      admin,
      user.id,
      orgId,
    );

    if (!canSend) {
      return json(403, {
        error:
          "You do not have permission to send estimates.",
        code: "forbidden",
      });
    }

    const {
      data: estimate,
      error: estimateError,
    } = await admin
      .from("estimates")
      .select(
        [
          "id",
          "org_id",
          "status",
          "number",
          "title",
          "version_number",
          "public_token",
          "deposit_type",
          "deposit_value",
          "discount_type",
          "discount_value",
          "tax_rate",
          "client_id",
          "project_id",
        ].join(","),
      )
      .eq("id", estimateId)
      .eq("org_id", orgId)
      .maybeSingle<EstimateRow>();

    if (estimateError) {
      logDatabaseError(
        "Estimate lookup failed",
        estimateError,
      );

      return json(500, {
        error: "Could not load the estimate.",
      });
    }

    if (!estimate) {
      return json(404, {
        error: "Estimate not found.",
      });
    }

    if (TERMINAL_SEND_STATUSES.has(estimate.status)) {
      return json(409, {
        error: `Cannot send an estimate in "${estimate.status}" status.`,
      });
    }

    const {
      data: customer,
      error: customerError,
    } = await admin
      .from("contacts")
      .select("full_name, email")
      .eq("id", estimate.client_id)
      .eq("org_id", orgId)
      .maybeSingle<ContactRow>();

    if (customerError) {
      logDatabaseError(
        "Customer lookup failed",
        customerError,
      );

      return json(500, {
        error:
          "Could not load the estimate customer.",
      });
    }

    const recipientEmail = customer?.email?.trim();

    if (!recipientEmail) {
      return json(400, {
        error:
          "This estimate's customer has no email address on file.",
      });
    }

    if (!isValidRecipientEmail(recipientEmail)) {
      return json(400, {
        error:
          "This estimate's customer email address is not valid.",
        code: "invalid_recipient",
      });
    }

    const {
      data: organization,
      error: organizationError,
    } = await admin
      .from("organizations")
      .select("name, public_name")
      .eq("id", orgId)
      .maybeSingle<OrganizationRow>();

    if (organizationError) {
      logDatabaseError(
        "Organization lookup failed",
        organizationError,
      );

      return json(500, {
        error:
          "Could not load organization information.",
      });
    }

    const {
  data: itemRows,
  error: itemsError,
} = await admin
  .from("estimate_items")
  .select(`
    quantity,
    unit_price,
    taxable,
    optional,
    selected_by_customer,
    is_heading,
    discount_type,
    discount_value,
    metadata
  `)
  .eq("estimate_id", estimate.id)
  .order("position", { ascending: true })
  .returns<EstimateItemRow[]>();

    if (itemsError) {
      logDatabaseError(
        "Estimate items lookup failed",
        itemsError,
      );

      return json(500, {
        error:
          "Could not load the estimate line items.",
      });
    }

    // PRICING GATE (Estimate Assistant safety hardening). This is the ONE
    // function that creates the public proposal token, emails the customer
    // and marks an estimate sent, so it is the authoritative boundary: an
    // estimate with any line item still flagged `price_pending` (e.g. an
    // AI-proposed draft nobody has priced yet) is refused BEFORE a token is
    // generated, any row is updated, any email is sent, or any activity /
    // workflow event is recorded. Keyed on the explicit marker — a real,
    // unmarked $0 line is NOT blocked. UI disabling is only a convenience.
    if (hasPricePendingItems((itemRows ?? []) as PricingGateItem[])) {
      return json(422, {
        error: UNPRICED_ESTIMATE_ERROR,
        code: "estimate_unpriced",
      });
    }

    const calcItems = buildCalcItems(
      (itemRows ?? []) as EstimateItemRow[],
    );

    const totals = calculateEstimate({
      items: calcItems,
      discountType: estimate.discount_type,
      discountValue: toFiniteNumber(
        estimate.discount_value,
      ),
      taxRate: toFiniteNumber(estimate.tax_rate),
      depositType: estimate.deposit_type,
      depositValue: toFiniteNumber(
        estimate.deposit_value,
      ),
    });

    if (
      !Number.isFinite(totals.total) ||
      !Number.isFinite(totals.depositAmount) ||
      !Number.isFinite(totals.balanceDue)
    ) {
      console.error(
        "[estimate-send] Invalid calculated totals",
        {
          estimateId: estimate.id,
          subtotal: totals.subtotal,
          discountTotal: totals.discountTotal,
          taxTotal: totals.taxTotal,
          total: totals.total,
          depositAmount: totals.depositAmount,
          balanceDue: totals.balanceDue,
        },
      );

      return json(422, {
        error:
          "The estimate contains invalid pricing values.",
      });
    }

    if (totals.depositAmount > totals.total) {
      return json(422, {
        error:
          "The required deposit cannot exceed the estimate total.",
      });
    }

    // Gmail preflight after every validation/pricing check but before the
    // first write: no connection, an expired/revoked one, or one without the
    // send scope leaves the estimate and its send state exactly as they were.
    let gmailSender: GmailSender;

    try {
      gmailSender = await resolveGmailSender(admin, orgId);
    } catch (preflightError) {
      if (preflightError instanceof GmailSendError) {
        console.warn("[estimate-send] Gmail sender unavailable", {
          estimateId: estimate.id,
          code: preflightError.code,
        });

        // Only the owner can open Settings → Integrations; everyone else is
        // told to ask them rather than shown a button they can't use.
        const role = await resolveMemberRole(admin, user.id, orgId);

        return gmailErrorResponse(preflightError, role === "owner");
      }

      throw preflightError;
    }

    let claim = await acquireEmailSendClaim(admin, "estimates", {
      id: estimate.id,
      orgId,
      userId: user.id,
      version: estimate.version_number,
    });

    let claimId: string;
    let publicToken: string;
    let delivery: {
      gmailMessageId: string;
      gmailThreadId: string | null;
      fromEmail: string | null;
      sentAt: string;
    };
    let recoveredUnrecordedSend = false;
    let historyRecorded = false;

    // An earlier send whose outcome Gmail never confirmed: look for it in the
    // account's Sent mail before anything is emailed again.
    if (!claim.ok && claim.code === "email_delivery_unconfirmed") {
      const outcome = await reconcileUnconfirmedSend(admin, "estimates", {
        id: estimate.id,
        orgId,
        userId: user.id,
        refusal: claim,
        sender: gmailSender,
        confirmResend: confirmResend === true,
      });

      if (outcome.kind === "delivered") {
        claim = {
          ok: false,
          code: "email_sent_unrecorded",
          claimId: outcome.claimId,
          sendId: claim.sendId,
          gmailMessageId: outcome.gmailMessageId,
          gmailThreadId: outcome.gmailThreadId,
          fromEmail: gmailSender.accountEmail,
          sentAt: outcome.sentAt,
          tokenHash: null,
          tokenExpiresAt: null,
        };
      } else if (outcome.kind === "not_sent") {
        claim = { ok: true, claimId: outcome.claimId };
      } else if (outcome.kind === "unconfirmed") {
        return json(409, {
          error: unconfirmedDeliveryMessage("proposal", outcome),
          code: "email_delivery_unconfirmed",
          canConfirmResend: outcome.canConfirmResend,
          sentFolderChecked: outcome.sentFolderChecked,
        });
      } else {
        claim = { ok: false, code: "email_send_in_progress" };
      }
    }

    if (!claim.ok) {
      const recoveryClaimId =
        claim.code === "email_sent_unrecorded" && estimate.public_token
          ? await takeOverEmailSendClaim(
              admin,
              "estimates",
              {
                id: estimate.id,
                orgId,
                claimId: claim.claimId,
                userId: user.id,
              },
              { state: "sent_unrecorded" },
            )
          : null;

      if (
        claim.code === "email_sent_unrecorded" &&
        estimate.public_token &&
        recoveryClaimId
      ) {
        // Gmail already accepted this proposal on an earlier request whose
        // database update failed. Finish recording it — never email the
        // customer a second time. Taking the claim over first means only one
        // of several concurrent retries records it.
        claimId = recoveryClaimId;
        publicToken = estimate.public_token;
        delivery = {
          gmailMessageId: claim.gmailMessageId,
          gmailThreadId: claim.gmailThreadId,
          fromEmail: claim.fromEmail,
          sentAt: claim.sentAt ?? new Date().toISOString(),
        };
        recoveredUnrecordedSend = true;
      } else if (
        claim.code === "email_send_in_progress" ||
        claim.code === "email_sent_unrecorded"
      ) {
        return json(409, {
          error:
            "This proposal is already being sent. Check your Gmail Sent folder before trying again.",
          code: "email_send_in_progress",
        });
      } else if (claim.code === "email_recently_sent") {
        return json(409, {
          error:
            "This proposal was just sent. Wait a minute before sending it again.",
          code: "email_recently_sent",
        });
      } else {
        return json(500, {
          error:
            "Could not prepare the estimate for sending.",
        });
      }
    } else {
      claimId = claim.claimId;
      publicToken =
        estimate.public_token ||
        crypto.randomBytes(32).toString("hex");

      // Save the secure token and canonical totals first.
      // Do not mark the estimate as sent until Gmail accepts the message.
      const {
        error: preparationError,
      } = await admin
        .from("estimates")
        .update({
          public_token: publicToken,
          subtotal: totals.subtotal,
          discount_total: totals.discountTotal,
          tax_total: totals.taxTotal,
          total: totals.total,
          client_total: totals.total,
          deposit_amount: totals.depositAmount,
          balance_due: totals.balanceDue,
        })
        .eq("id", estimate.id)
        .eq("org_id", orgId);

      if (preparationError) {
        logDatabaseError(
          "Estimate preparation update failed",
          preparationError,
        );

        await releaseEmailSendClaim(admin, "estimates", {
          id: estimate.id,
          orgId,
          claimId,
        });

        return json(500, {
          error:
            "Could not prepare the estimate for sending.",
          code: preparationError.code ?? null,
        });
      }

      delivery = {
        gmailMessageId: "",
        gmailThreadId: null,
        fromEmail: gmailSender.accountEmail,
        sentAt: "",
      };
    }

    const proposalUrl = `${getAppBaseUrl(
      event,
    )}/proposal/${publicToken}`;

    if (!recoveredUnrecordedSend) {
      const organizationName =
        organization?.public_name?.trim() ||
        organization?.name?.trim() ||
        "Your contractor";

      const senderName =
        [profile?.first_name, profile?.last_name]
          .filter(
            (value): value is string =>
              Boolean(value?.trim()),
          )
          .join(" ")
          .trim() ||
        organizationName;

      const content = buildProposalEmail({
        organizationName,
        customerName:
          customer?.full_name?.trim() || "there",
        estimateNumber: estimate.number,
        estimateTitle: estimate.title,
        proposalUrl,
      });

      try {
        console.info(
          "[estimate-send] Sending proposal through the org's Gmail account",
          {
            estimateId: estimate.id,
            integrationId: gmailSender.integrationId,
            recipientDomain:
              recipientEmail.split("@")[1]?.toLowerCase() ??
              null,
          },
        );

        const sent = await sendGmailMessage(gmailSender, {
          fromName: senderName,
          fromEmail: gmailSender.accountEmail,
          to: recipientEmail,
          subject: content.subject,
          html: content.html,
          text: content.text,
          sendId: claimId,
        });

        delivery = {
          gmailMessageId: sent.gmailMessageId,
          gmailThreadId: sent.gmailThreadId,
          fromEmail: gmailSender.accountEmail,
          sentAt: new Date().toISOString(),
        };

        // The outbound message in the contact's email thread. Best-effort:
        // the email is already delivered, and gmail-sync imports it anyway.
        const history = await persistGmailApiSentEmail(admin, {
          orgId,
          gmailMessageId: sent.gmailMessageId,
          gmailThreadId: sent.gmailThreadId,
          rfcMessageId: sent.rfcMessageId,
          fromEmail: gmailSender.accountEmail,
          to: recipientEmail,
          subject: content.subject,
          body: content.text,
        });
        historyRecorded = history.persisted;
      } catch (emailError) {
        if (!(emailError instanceof GmailSendError)) {
          // Unknown failure inside the send: Gmail may have accepted it, so
          // the claim is kept (blocks an immediate duplicate) and rethrown.
          throw emailError;
        }

        console.error("[estimate-send] Gmail delivery failed", {
          estimateId: estimate.id,
          code: emailError.code,
          maybeSent: emailError.maybeSent,
        });

        // A definite failure sent nothing, so the user may retry at once. An
        // ambiguous one is held for reconciliation against Sent mail on the
        // next attempt — never assumed failed, never resent automatically.
        if (emailError.maybeSent) {
          await updateEmailSendClaim(
            admin,
            "estimates",
            { id: estimate.id, orgId, claimId },
            { state: "delivery_unknown" },
          );
        } else {
          await releaseEmailSendClaim(admin, "estimates", {
            id: estimate.id,
            orgId,
            claimId,
          });
        }

        const role = emailError.action
          ? await resolveMemberRole(admin, user.id, orgId)
          : null;

        return json(emailError.httpStatus, {
          ...emailError.toResponseBody({
            canManageIntegrations: role === "owner",
          }),
          proposalUrl,
        });
      }
    }

    const sentAt = delivery.sentAt;

    // Mark sent (same UPDATE that closes the claim), activity, workflow,
    // Deal sync — shared with the customer-view recovery in
    // lib/estimate-send-completion.ts.
    const finalized = await completeEstimateSend(admin, {
      estimate,
      claimId,
      delivery,
      recipientEmail,
      actorUserId: user.id,
      totals: { total: totals.total, depositAmount: totals.depositAmount },
      recordedAfterRetry: recoveredUnrecordedSend,
      workflowBaseUrl: process.env.URL ?? getAppBaseUrl(event),
    });

    if (!finalized.ok) {
      console.error(
        "[estimate-send] Email delivered but sent-state update failed",
        { estimateId: estimate.id, reason: finalized.error },
      );

      // Remember the delivery so the next Send finishes recording instead
      // of emailing the customer again (see lib/email-send-claim.ts).
      if (!recoveredUnrecordedSend) {
        await updateEmailSendClaim(
          admin,
          "estimates",
          { id: estimate.id, orgId, claimId },
          {
            state: "sent_unrecorded",
            gmailMessageId: delivery.gmailMessageId,
            gmailThreadId: delivery.gmailThreadId,
            fromEmail: delivery.fromEmail,
            sentAt,
          },
        );
      }

      // Success, because Gmail accepted the message — reporting a failure
      // here would invite a duplicate resend.
      return json(200, {
        ok: true,
        recorded: false,
        code: "email_sent_not_recorded",
        warning:
          "The proposal email was sent from your Gmail account, but RenoMeta could not update the estimate. Click Send again to finish recording it — the customer will not get a second email.",
        publicToken,
        proposalUrl,
        status: estimate.status,
        gmailMessageId: delivery.gmailMessageId,
        gmailThreadId: delivery.gmailThreadId,
        fromEmail: delivery.fromEmail,
        sentAt,
      });
    }

    return json(200, {
      ok: true,
      publicToken,
      proposalUrl,
      status: finalized.nextStatus,
      total: totals.total,
      depositAmount: totals.depositAmount,
      balanceDue: totals.balanceDue,
      sentAt,
      recorded: true,
      historyRecorded,
      gmailMessageId: delivery.gmailMessageId,
      gmailThreadId: delivery.gmailThreadId,
      fromEmail: delivery.fromEmail,
    });
  } catch (error) {
    const serialized = serializeError(error);

    console.error(
      "[estimate-send] Unhandled failure",
      serialized,
    );

    return json(500, {
      error:
        "The proposal could not be sent because of an unexpected server error.",
      code: serialized.code,
      details:
        process.env.NODE_ENV === "development"
          ? serialized.message
          : undefined,
    });
  }
};