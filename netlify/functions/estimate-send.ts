/// <reference types="node" />
// netlify/functions/estimate-send.ts
//
// Phase 10.4 — authenticated estimate proposal delivery.
//
// Flow:
// 1. Authenticate the current user.
// 2. Confirm the estimate belongs to the user's organization.
// 3. Load the customer and estimate items.
// 4. Recalculate all totals server-side.
// 5. Persist the secure proposal token and calculated totals.
// 6. Send the proposal email through Amazon SES.
// 7. Mark the estimate as sent only after SES confirms delivery.
// 8. Record one sent/re-sent activity.
// 9. Trigger estimate_sent workflows.
//
// The proposal email path intentionally does not use Gmail SMTP.

import type { Handler, HandlerEvent, HandlerResponse } from "@netlify/functions";
import {
  SESv2Client,
  SendEmailCommand,
  type SendEmailCommandInput,
} from "@aws-sdk/client-sesv2";
import { createClient, type PostgrestError } from "@supabase/supabase-js";
import crypto from "node:crypto";

import {
  calculateEstimate,
  type CalcLineItem,
} from "../../src/lib/estimate-calculations";
import {
  isCustomerActionable,
  type EstimateStatus,
} from "../../src/lib/estimate-status";
import { syncEstimateDeal, logDealSyncWarning } from "../lib/estimate-deal-sync";

const SUPABASE_URL =
  process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const AWS_REGION =
  process.env.AWS_REGION ??
  process.env.AWS_DEFAULT_REGION ??
  "us-west-2";

const SES_FROM_EMAIL =
  process.env.SES_FROM_EMAIL ??
  process.env.SMTP_FROM_EMAIL ??
  process.env.FROM_EMAIL ??
  "info@connect.renometa.com";

const SES_REPLY_TO_EMAIL =
  process.env.SES_REPLY_TO_EMAIL ??
  process.env.REPLY_TO_EMAIL ??
  SES_FROM_EMAIL;

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

const ses = new SESv2Client({
  region: AWS_REGION,
});

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

async function sendProposalEmail(input: {
  to: string;
  senderName: string;
  organizationName: string;
  customerName: string;
  estimateNumber: string | null;
  estimateTitle: string | null;
  proposalUrl: string;
}): Promise<void> {
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

  const subjectParts = [
    safeEstimateNumber
      ? `Proposal ${safeEstimateNumber}`
      : "New proposal",
    `from ${safeOrganizationName}`,
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

  const message: SendEmailCommandInput = {
    FromEmailAddress: `"${input.senderName}" <${SES_FROM_EMAIL}>`,
    Destination: {
      ToAddresses: [input.to],
    },
    ReplyToAddresses: SES_REPLY_TO_EMAIL
      ? [SES_REPLY_TO_EMAIL]
      : undefined,
    Content: {
      Simple: {
        Subject: {
          Data: subject,
          Charset: "UTF-8",
        },
        Body: {
          Html: {
            Data: html,
            Charset: "UTF-8",
          },
          Text: {
            Data: text,
            Charset: "UTF-8",
          },
        },
      },
    },
  };

  const response = await ses.send(
    new SendEmailCommand(message),
  );

  console.info("[estimate-send] SES accepted email", {
    messageId: response.MessageId ?? null,
    recipientDomain:
      input.to.split("@")[1]?.toLowerCase() ?? null,
  });
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

  if (!SES_FROM_EMAIL) {
    console.error(
      "[estimate-send] SES sender email is missing",
    );

    return json(500, {
      error:
        "The proposal email sender is not configured.",
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

  const { estimateId } = parseRequestBody(event);

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
    discount_value
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

    const publicToken =
      estimate.public_token ||
      crypto.randomBytes(32).toString("hex");

    const isFirstSend =
      !isCustomerActionable(estimate.status) &&
      estimate.status !== "changes_requested";

    // Save the secure token and canonical totals first.
    // Do not mark the estimate as sent until SES confirms delivery.
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

      return json(500, {
        error:
          "Could not prepare the estimate for sending.",
        code: preparationError.code ?? null,
      });
    }

    const proposalUrl = `${getAppBaseUrl(
      event,
    )}/proposal/${publicToken}`;

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
      organizationName ||
      "RenoMeta Connect";

    try {
      console.info(
        "[estimate-send] Sending proposal through SES",
        {
          estimateId: estimate.id,
          region: AWS_REGION,
          fromEmail: SES_FROM_EMAIL,
          recipientDomain:
            recipientEmail.split("@")[1]?.toLowerCase() ??
            null,
        },
      );

      await sendProposalEmail({
        to: recipientEmail,
        senderName,
        organizationName,
        customerName:
          customer?.full_name?.trim() || "there",
        estimateNumber: estimate.number,
        estimateTitle: estimate.title,
        proposalUrl,
      });
    } catch (emailError) {
  const serialized = serializeError(emailError);

  console.error("[estimate-send] SES delivery failed", {
    ...serialized,
    region: AWS_REGION,
    fromEmail: SES_FROM_EMAIL,
    hasAwsAccessKey: Boolean(process.env.AWS_ACCESS_KEY_ID),
    hasAwsSecretKey: Boolean(process.env.AWS_SECRET_ACCESS_KEY),
  });

  return json(500, {
    error:
      "The estimate was saved, but the proposal email was not delivered.",
    name: serialized.name,
    code: serialized.code,
    details: serialized.message,
    region: AWS_REGION,
    fromEmail: SES_FROM_EMAIL,
    hasAwsAccessKey: Boolean(
      process.env.AWS_ACCESS_KEY_ID,
    ),
    hasAwsSecretKey: Boolean(
      process.env.AWS_SECRET_ACCESS_KEY,
    ),
    proposalUrl,
  });
}

    const sentAt = new Date().toISOString();

    const nextStatus =
      estimate.status === "draft" ||
      estimate.status === "ready"
        ? "sent"
        : estimate.status;

    const {
      error: sentUpdateError,
    } = await admin
      .from("estimates")
      .update({
        status: nextStatus,
        sent_at: sentAt,
      })
      .eq("id", estimate.id)
      .eq("org_id", orgId);

    if (sentUpdateError) {
      logDatabaseError(
        "Email delivered but sent-state update failed",
        sentUpdateError,
      );

      return json(500, {
        error:
          "The proposal email was delivered, but the estimate status could not be updated.",
        proposalUrl,
      });
    }

    const {
      error: activityError,
    } = await admin
      .from("estimate_activities")
      .insert({
        org_id: orgId,
        estimate_id: estimate.id,
        version_number: estimate.version_number,
        activity_type: "sent",
        actor_type: "user",
        actor_id: user.id,
        title: isFirstSend
          ? "Proposal sent"
          : "Proposal re-sent",
        description: `Sent to ${recipientEmail}`,
        metadata: {
          delivery_channel: "email",
          sent_at: sentAt,
        },
      });

    if (activityError) {
      // Do not report the email as failed after confirmed delivery.
      logDatabaseError(
        "Sent activity insert failed",
        activityError,
      );
    }

    const workflowUrl = `${
      process.env.URL ??
      getAppBaseUrl(event)
    }/.netlify/functions/execute-workflow`;

    void fetch(workflowUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        orgId,
        triggerType: "estimate_sent",
        triggerData: {
          estimateId: estimate.id,
          estimateNumber: estimate.number,
          version: estimate.version_number,
          status: nextStatus,
          total: totals.total,
          depositAmount: totals.depositAmount,
          clientId: estimate.client_id,
          ownerId: user.id,
          occurredAt: sentAt,
        },
      }),
    }).catch((workflowError: unknown) => {
      console.warn(
        "[estimate-send] Workflow trigger failed",
        serializeError(workflowError),
      );
    });

    // Deal sync is advisory: the email already delivered and the estimate
    // is already marked sent above, so a sync failure here must never turn
    // this successful send into an error response — it's logged and the
    // response still reports success either way.
    try {
      const syncResult = await syncEstimateDeal(admin, {
        estimateId: estimate.id, orgId, trigger: "sent", actorUserId: user.id,
      });
      if (!syncResult.ok) {
        logDealSyncWarning("sent -> deal sync failed (non-blocking)", { estimateId: estimate.id, orgId, error: syncResult.error });
      }
    } catch (syncError) {
      logDealSyncWarning("sent -> deal sync threw (non-blocking)", { estimateId: estimate.id, orgId, error: serializeError(syncError).message });
    }

    return json(200, {
      ok: true,
      publicToken,
      proposalUrl,
      status: nextStatus,
      total: totals.total,
      depositAmount: totals.depositAmount,
      balanceDue: totals.balanceDue,
      sentAt,
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