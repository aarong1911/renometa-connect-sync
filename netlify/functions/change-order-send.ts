/// <reference types="node" />
// netlify/functions/change-order-send.ts
//
// Phase 13.3B — authenticated Change Order delivery.
//
// Security audit, round 3 — trust architecture (see the matching "8. TRUST
// ARCHITECTURE" comment block in 20260815_project_change_orders.sql):
// send_project_change_order() is now service_role-only. This function is
// the entire trust boundary for a send: it authenticates the caller's
// bearer token, resolves their real org_id server-side, checks the
// change_orders "send" permission via the shared resolver (same table the
// Permissions settings UI reads), and only then calls the RPC using the
// SERVICE ROLE key (never exposed to the browser) — an authenticated
// client has no grant to call that RPC directly under any circumstances.
//
// Financial totals and the customer-facing snapshot are no longer
// computed here and passed in — the RPC recalculates totals from
// persisted project_change_order_items and builds the snapshot from
// persisted rows itself. This function only generates the plaintext
// approval token (a Node-only capability) and hashes it before sending
// the hash to the RPC; the plaintext is never persisted anywhere.
//
// Email: the customer email goes FROM the contractor's connected Gmail
// account (lib/gmail-send.ts), never AWS SES / a renometa.com address.
//
// Delivery order (customer has an email address) — see migration
// 20261030_change_order_pending_sends.sql:
//   1. Preflight Gmail and take the duplicate-send claim — nothing written.
//   2. Mint the approval token in memory and record its HASH as a pending
//      link (prepare_project_change_order_send). No status change, no live
//      token, existing links untouched. The claim keeps the hash too.
//   3. Send through Gmail.
//        rejected  -> pending link discarded, claim released, Change Order
//                     untouched, error returned.
//        ambiguous -> claim held as delivery_unknown, pending link kept; the
//                     next attempt checks Sent mail and never resends
//                     without the user's informed confirmation.
//   4. Gmail accepted -> claim records the Gmail ids (sent_unrecorded), then
//      activate_project_change_order_send() runs the unchanged
//      send_project_change_order() with the SAME hash: status sent, link
//      live, in one transaction.
// If step 4 fails, the link is still not lost: the customer's first use of
// it activates it (change-order-data.ts / change-order-action.ts — only the
// delivered email has the token), and the contractor's next Send finishes
// it from the stored hash without emailing again.
//
// Without a customer email it's a link-only send: the RPC runs directly and
// the returned link is copied for the contractor to share, as before.

import type { Handler, HandlerEvent, HandlerResponse } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

import { resolveChangeOrderPermissionServer, resolveMemberRole } from "../../src/lib/change-order-permissions";
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
  type ClaimRefusal,
} from "./lib/email-send-claim";
import { persistGmailApiSentEmail } from "./lib/gmail-sent-reconcile";
import {
  activatePendingChangeOrderLink,
  discardPendingChangeOrderLink,
  type PendingLinkStatus,
  type SendRpcResult,
} from "./lib/change-order-pending-link";

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const APPROVAL_TOKEN_DEFAULT_TTL_DAYS = 30;
/** Statuses send_project_change_order() accepts — checked up front so nothing is emailed for a Change Order it would refuse. */
const SENDABLE_STATUSES = new Set(["ready_to_send", "sent", "viewed"]);

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function json(statusCode: number, body: Record<string, unknown>): HandlerResponse {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}

function getBearerToken(event: HandlerEvent): string | null {
  const authorization = event.headers.authorization ?? event.headers.Authorization;
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function getAppBaseUrl(event: HandlerEvent): string {
  const configured = process.env.CONNECT_APP_URL ?? process.env.APP_URL ?? process.env.URL;
  if (configured) return configured.replace(/\/+$/, "");
  const forwardedProto = event.headers["x-forwarded-proto"] ?? "http";
  const forwardedHost = event.headers["x-forwarded-host"] ?? event.headers.host;
  if (forwardedHost) return `${forwardedProto}://${forwardedHost}`.replace(/\/+$/, "");
  return "http://localhost:9999";
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function buildChangeOrderEmail(input: {
  organizationName: string; customerName: string;
  changeOrderNumber: string; changeOrderTitle: string; totalAmount: number; approvalUrl: string;
}): { subject: string; html: string; text: string } {
  const safeCustomerName = escapeHtml(input.customerName || "there");
  const safeOrganizationName = escapeHtml(input.organizationName);
  const safeTitle = escapeHtml(input.changeOrderTitle);
  const safeNumber = escapeHtml(input.changeOrderNumber);
  const safeUrl = escapeHtml(input.approvalUrl);
  const amountLabel = input.totalAmount < 0
    ? `-$${Math.abs(input.totalAmount).toFixed(2)} credit`
    : `$${input.totalAmount.toFixed(2)}`;

  // Plain text — a MIME header, not HTML.
  const subject = `Change Order ${input.changeOrderNumber} from ${input.organizationName}`;
  const html = `
<!doctype html>
<html lang="en"><body style="margin:0;padding:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;color:#111827;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;padding:32px 16px;"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;"><tr><td style="padding:32px;">
<p style="margin:0 0 8px;color:#6b7280;font-size:14px;">Change Order ${safeNumber}</p>
<h1 style="margin:0 0 20px;font-size:24px;line-height:1.3;color:#111827;">A Change Order is ready for your review</h1>
<p style="margin:0 0 16px;font-size:16px;line-height:1.6;">Hi ${safeCustomerName},</p>
<p style="margin:0 0 8px;font-size:16px;line-height:1.6;">${safeOrganizationName} has sent you a Change Order for <strong>${safeTitle}</strong>.</p>
<p style="margin:0 0 24px;font-size:16px;line-height:1.6;">Amount: <strong>${amountLabel}</strong></p>
<table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="border-radius:8px;background:#2563eb;">
<a href="${safeUrl}" style="display:inline-block;padding:12px 22px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;">Review Change Order</a>
</td></tr></table>
<p style="margin:24px 0 6px;color:#6b7280;font-size:13px;line-height:1.5;">If the button does not work, copy and paste this link:</p>
<p style="margin:0;word-break:break-all;font-size:13px;line-height:1.5;"><a href="${safeUrl}" style="color:#2563eb;">${safeUrl}</a></p>
</td></tr></table></td></tr></table></body></html>`.trim();

  const text = `Hi ${input.customerName || "there"},\n\n${input.organizationName} has sent you Change Order ${input.changeOrderNumber} for ${input.changeOrderTitle} (${amountLabel}).\n\nReview and respond: ${input.approvalUrl}`;

  return { subject, html, text };
}

/** The emailed link is live (now or from an earlier call). */
const isLive = (status: PendingLinkStatus) => status === "activated" || status === "already_active";

/** The emailed link can never go live — a new send is needed to give the customer a working one. */
function deadLinkMessage(status: PendingLinkStatus): string {
  if (status === "expired") return "The link in the Change Order email has expired.";
  if (status === "changed") return "The Change Order was edited after the email was sent, so the link in that email can't be used.";
  if (status === "not_sendable") return "The Change Order is no longer awaiting approval, so the link in that email can't be used.";
  return "The link in that Change Order email is no longer valid.";
}

const NOT_RECORDED_WARNING =
  "The Change Order email was sent from your Gmail account, but RenoMeta couldn't finish marking the Change Order sent. The link in the customer's email still works — opening it finishes the job — or click Send again to finish now. The customer will not get a second email.";

function claimRefusalResponse(refusal: ClaimRefusal): HandlerResponse {
  if (refusal.code === "email_send_in_progress") {
    return json(409, { error: "This Change Order is already being sent. Check your Gmail Sent folder before trying again.", code: "email_send_in_progress" });
  }
  if (refusal.code === "email_recently_sent") {
    return json(409, { error: "This Change Order was just sent. Wait a minute before sending it again.", code: "email_recently_sent" });
  }
  return json(500, { error: "Could not prepare the Change Order for sending." });
}

/**
 * Gmail already accepted this Change Order's email on an earlier request
 * that couldn't finish. Make the emailed link live from the stored token
 * hash — never email again. The plaintext link isn't stored, so none is
 * returned; the customer already has it.
 */
async function recoverUnrecordedSend(
  ctx: { changeOrderId: string; status: string; orgId: string; userId: string; recipientEmail: string },
  refusal: Extract<ClaimRefusal, { code: "email_sent_unrecorded" }>,
): Promise<HandlerResponse> {
  const claimRef = { id: ctx.changeOrderId, orgId: ctx.orgId };
  const recoveryClaimId = await takeOverEmailSendClaim(admin, "project_change_orders", {
    ...claimRef, claimId: refusal.claimId, userId: ctx.userId,
  }, { state: "sent_unrecorded" });
  if (!recoveryClaimId) return claimRefusalResponse({ ok: false, code: "email_send_in_progress" });

  const recovered = {
    approvalUrl: null, emailDelivered: true, emailError: null, recipientEmail: ctx.recipientEmail,
    fromEmail: refusal.fromEmail, gmailMessageId: refusal.gmailMessageId, gmailThreadId: refusal.gmailThreadId,
    sentAt: refusal.sentAt, recoveredEarlierSend: true,
  };

  if (!refusal.tokenHash || !refusal.tokenExpiresAt) {
    // Should not happen (the hash is stored before Gmail is called). The
    // emailed link can't be activated, so free the claim for a new send.
    await releaseEmailSendClaim(admin, "project_change_orders", { ...claimRef, claimId: recoveryClaimId });
    return json(409, { error: "The earlier Change Order email can't be linked to an approval link. Send it again to give the customer a working link.", code: "email_recovery_failed" });
  }

  // Idempotent: if the customer already opened the link (or an earlier call
  // committed and its response was lost), this is `already_active`.
  const activation = await activatePendingChangeOrderLink(admin, refusal.tokenHash);
  if (activation.status === "error" || activation.status === "not_pending") {
    return json(200, { ok: true, recorded: false, code: "email_sent_not_recorded", warning: NOT_RECORDED_WARNING, status: ctx.status, ...recovered });
  }
  if (!isLive(activation.status)) {
    await releaseEmailSendClaim(admin, "project_change_orders", { ...claimRef, claimId: recoveryClaimId });
    return json(409, {
      error: `${deadLinkMessage(activation.status)} Send the Change Order again to give the customer a working link.`,
      code: activation.status === "expired" ? "email_recovery_expired" : "email_recovery_link_invalid",
    });
  }

  await updateEmailSendClaim(admin, "project_change_orders", { ...claimRef, claimId: recoveryClaimId }, { state: "sent" });
  return json(200, {
    ok: true, recorded: true, status: "sent",
    isFirstSend: activation.result?.isFirstSend ?? ctx.status === "ready_to_send",
    totalAmount: activation.result ? Number(activation.result.totalAmount ?? 0) : null,
    ...recovered,
  });
}

export const handler: Handler = async (event): Promise<HandlerResponse> => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: "The Change Order service is not configured correctly." });
  }

  const accessToken = getBearerToken(event);
  if (!accessToken) return json(401, { error: "Unauthorized" });

  const { data: { user }, error: authError } = await admin.auth.getUser(accessToken);
  if (authError || !user) return json(401, { error: "Invalid token" });

  let body: { changeOrderId?: string; confirmResend?: boolean } = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch { body = {}; }
  const { changeOrderId } = body;
  if (!changeOrderId) return json(400, { error: "changeOrderId required" });

  try {
    const { data: profile } = await admin.from("profiles").select("organization_id, first_name, last_name").eq("id", user.id).maybeSingle();
    const orgId = profile?.organization_id;
    if (!orgId) return json(403, { error: "No organization was found for this user." });

    const permission = await resolveChangeOrderPermissionServer(admin, user.id, orgId, "send");
    if (!permission) return json(403, { error: "You do not have permission to send Change Orders for approval." });

    // Read-only pre-check for a clean error message + the deadline used to
    // size the token TTL. The RPC re-validates status itself regardless.
    const { data: co, error: coError } = await admin
      .from("project_change_orders")
      .select("id, status, approval_due_at, project_id, version, change_order_number, title")
      .eq("id", changeOrderId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (coError) return json(500, { error: "Could not load the Change Order." });
    if (!co) return json(404, { error: "Change Order not found." });
    if (!SENDABLE_STATUSES.has(co.status)) {
      return json(409, { error: `Cannot send a Change Order in "${co.status}" status` });
    }

    const expiresAt = co.approval_due_at
      ? new Date(co.approval_due_at).toISOString()
      : new Date(Date.now() + APPROVAL_TOKEN_DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    if (!(Date.parse(expiresAt) > Date.now())) {
      return json(409, { error: "This Change Order's approval deadline has passed. Update the deadline before sending." });
    }

    // Read-only lookups for the email recipient/content — org-scoped, and
    // never used to decide anything the RPC decides authoritatively.
    const { data: projectRow } = await admin.from("projects").select("client_id").eq("id", co.project_id).eq("org_id", orgId).maybeSingle();
    const { data: customer } = projectRow?.client_id
      ? await admin.from("contacts").select("full_name, email").eq("id", projectRow.client_id).eq("org_id", orgId).maybeSingle()
      : { data: null };
    const { data: organization } = await admin.from("organizations").select("name, public_name").eq("id", orgId).maybeSingle();
    const organizationName = organization?.public_name?.trim() || organization?.name?.trim() || "Your contractor";
    const senderName = [profile?.first_name, profile?.last_name].filter((v): v is string => Boolean(v?.trim())).join(" ").trim() || organizationName;
    const recipientEmail = customer?.email?.trim() || null;

    const plaintextToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(plaintextToken).digest("hex");
    const approvalUrl = `${getAppBaseUrl(event)}/change-order/${plaintextToken}`;

    // ── Link-only send (no customer email on file): unchanged behavior ──
    if (!recipientEmail) {
      const { data: rpcResult, error: rpcError } = await admin.rpc("send_project_change_order", {
        p_change_order_id: changeOrderId,
        p_org_id: orgId,
        p_actor_user_id: user.id,
        p_token_hash: tokenHash,
        p_expires_at: expiresAt,
      });
      if (rpcError) return json(409, { error: rpcError.message });
      const result = rpcResult as SendRpcResult;
      return json(200, {
        ok: true,
        status: "sent",
        isFirstSend: result?.isFirstSend ?? false,
        totalAmount: Number(result?.totalAmount ?? 0),
        approvalUrl,
        emailDelivered: false,
        emailError: null,
        recipientEmail: null,
        fromEmail: null,
        gmailMessageId: null,
        gmailThreadId: null,
        sentAt: new Date().toISOString(),
      });
    }

    // ── Email delivery through the org's Gmail ──
    if (!isValidRecipientEmail(recipientEmail)) {
      return json(400, { error: "This customer's email address is not valid.", code: "invalid_recipient" });
    }

    let gmailSender: GmailSender;
    try {
      gmailSender = await resolveGmailSender(admin, orgId);
    } catch (preflightError) {
      if (preflightError instanceof GmailSendError) {
        console.warn("[change-order-send] Gmail sender unavailable", { changeOrderId, code: preflightError.code });
        // Only the owner can open Settings → Integrations; others are told to ask them.
        const role = await resolveMemberRole(admin, user.id, orgId);
        return json(preflightError.httpStatus, preflightError.toResponseBody({ canManageIntegrations: role === "owner" }));
      }
      throw preflightError;
    }

    const claimRef = { id: co.id, orgId };
    let claim = await acquireEmailSendClaim(admin, "project_change_orders", {
      ...claimRef, userId: user.id, version: typeof co.version === "number" ? co.version : null,
    });

    // An earlier send whose outcome Gmail never confirmed: look for it in
    // Sent mail before anything is emailed again.
    if (!claim.ok && claim.code === "email_delivery_unconfirmed") {
      const outcome = await reconcileUnconfirmedSend(admin, "project_change_orders", {
        ...claimRef, userId: user.id, refusal: claim, sender: gmailSender, confirmResend: body.confirmResend === true,
      });
      if (outcome.kind === "delivered") {
        claim = {
          ok: false, code: "email_sent_unrecorded", claimId: outcome.claimId, sendId: claim.sendId,
          gmailMessageId: outcome.gmailMessageId, gmailThreadId: outcome.gmailThreadId,
          fromEmail: gmailSender.accountEmail, sentAt: outcome.sentAt,
          tokenHash: claim.tokenHash, tokenExpiresAt: claim.tokenExpiresAt,
        };
      } else if (outcome.kind === "not_sent") {
        claim = { ok: true, claimId: outcome.claimId };
      } else if (outcome.kind === "unconfirmed") {
        return json(409, {
          error: unconfirmedDeliveryMessage("Change Order", outcome),
          code: "email_delivery_unconfirmed",
          canConfirmResend: outcome.canConfirmResend,
          sentFolderChecked: outcome.sentFolderChecked,
        });
      } else {
        claim = { ok: false, code: "email_send_in_progress" };
      }
    }

    if (!claim.ok) {
      if (claim.code === "email_sent_unrecorded") {
        return await recoverUnrecordedSend({ changeOrderId: co.id, status: co.status, orgId, userId: user.id, recipientEmail }, claim);
      }
      return claimRefusalResponse(claim);
    }
    const claimId = claim.claimId;

    // Record the link as PENDING (hash only) before anything is emailed. The
    // RPC re-validates membership/org/status and returns the DB-authoritative
    // title/total the email states; activation later refuses to go live if
    // the Change Order no longer matches them.
    const { data: preparedData, error: prepareError } = await admin.rpc("prepare_project_change_order_send", {
      p_change_order_id: co.id,
      p_org_id: orgId,
      p_actor_user_id: user.id,
      p_token_hash: tokenHash,
      p_expires_at: expiresAt,
    });
    const preparedLink = preparedData as SendRpcResult;
    const totalAmount = Number(preparedLink?.totalAmount);
    if (prepareError || !preparedLink || !Number.isFinite(totalAmount)) {
      console.error("[change-order-send] could not prepare the approval link", { changeOrderId, message: prepareError?.message ?? null });
      await releaseEmailSendClaim(admin, "project_change_orders", { ...claimRef, claimId });
      return json(409, { error: prepareError?.message ?? "Could not prepare the Change Order for sending." });
    }
    const changeOrderNumber = preparedLink.changeOrderNumber ?? co.change_order_number ?? "";
    const changeOrderTitle = preparedLink.title ?? co.title ?? "";

    // The claim keeps the same hash so the contractor's next Send can finish
    // a delivered email's activation without emailing again.
    const prepared = await updateEmailSendClaim(admin, "project_change_orders", { ...claimRef, claimId }, {
      state: "sending", tokenHash, tokenExpiresAt: expiresAt,
    });
    if (!prepared.ok) {
      await discardPendingChangeOrderLink(admin, { tokenHash, orgId });
      await releaseEmailSendClaim(admin, "project_change_orders", { ...claimRef, claimId });
      return json(500, { error: "Could not prepare the Change Order for sending." });
    }

    const content = buildChangeOrderEmail({
      organizationName, customerName: customer?.full_name?.trim() || "there",
      changeOrderNumber, changeOrderTitle, totalAmount, approvalUrl,
    });

    let sent: Awaited<ReturnType<typeof sendGmailMessage>>;
    try {
      sent = await sendGmailMessage(gmailSender, {
        fromName: senderName, fromEmail: gmailSender.accountEmail, to: recipientEmail,
        subject: content.subject, html: content.html, text: content.text, sendId: claimId,
      });
    } catch (err) {
      if (!(err instanceof GmailSendError)) throw err; // claim stays `sending` -> reconciled once stale
      console.error("[change-order-send] Gmail delivery failed", { changeOrderId, code: err.code, maybeSent: err.maybeSent });
      if (err.maybeSent) {
        // Possibly delivered: the pending link is kept, so if the customer
        // did get it, opening it still works.
        await updateEmailSendClaim(admin, "project_change_orders", { ...claimRef, claimId }, { state: "delivery_unknown" });
      } else {
        // Definitely not delivered: the link must never go live.
        await discardPendingChangeOrderLink(admin, { tokenHash, orgId });
        await releaseEmailSendClaim(admin, "project_change_orders", { ...claimRef, claimId });
      }
      const role = err.action ? await resolveMemberRole(admin, user.id, orgId) : null;
      // The Change Order is untouched (not sent, no live link) in both cases.
      return json(err.httpStatus, {
        ...err.toResponseBody({ canManageIntegrations: role === "owner" }),
        changeOrderStatus: co.status,
        emailDelivered: false,
      });
    }

    const sentAt = new Date().toISOString();
    const recorded = await updateEmailSendClaim(admin, "project_change_orders", { ...claimRef, claimId }, {
      state: "sent_unrecorded", gmailMessageId: sent.gmailMessageId, gmailThreadId: sent.gmailThreadId,
      fromEmail: gmailSender.accountEmail, sentAt,
    });
    if (!recorded.ok) console.error("[change-order-send] Gmail ids not saved on the Change Order (email was sent)", { changeOrderId, reason: recorded.error });

    const history = await persistGmailApiSentEmail(admin, {
      orgId, gmailMessageId: sent.gmailMessageId, gmailThreadId: sent.gmailThreadId, rfcMessageId: sent.rfcMessageId,
      fromEmail: gmailSender.accountEmail, to: recipientEmail, subject: content.subject, body: content.text,
    });

    const activation = await activatePendingChangeOrderLink(admin, tokenHash);
    const delivery = {
      emailDelivered: true,
      emailError: null,
      recipientEmail,
      fromEmail: gmailSender.accountEmail,
      gmailMessageId: sent.gmailMessageId,
      gmailThreadId: sent.gmailThreadId,
      historyRecorded: history.persisted,
      sentAt,
    };
    if (activation.status === "error" || activation.status === "not_pending") {
      // Gmail accepted, so this is a success with a warning — reporting a
      // failure would invite a duplicate resend. The link stays pending: the
      // customer opening it, or the next Send (claim stays sent_unrecorded
      // with the hash), makes it live.
      return json(200, {
        ok: true, recorded: false, code: "email_sent_not_recorded", warning: NOT_RECORDED_WARNING,
        status: co.status, approvalUrl, totalAmount, ...delivery,
      });
    }
    if (!isLive(activation.status)) {
      // Delivered, but the Change Order was edited/cancelled in the moment
      // between preparing and activating, so this email's link can never
      // work. Free the claim so a fresh send can give the customer one.
      await releaseEmailSendClaim(admin, "project_change_orders", { ...claimRef, claimId });
      return json(200, {
        ok: true, recorded: false, code: "email_sent_link_inactive",
        warning: `The email was sent, but ${deadLinkMessage(activation.status).replace(/^The /, "the ")} Send the Change Order again to give the customer a working link.`,
        status: co.status, approvalUrl: null, totalAmount, ...delivery,
      });
    }

    await updateEmailSendClaim(admin, "project_change_orders", { ...claimRef, claimId }, { state: "sent", sentAt });
    const rpc = activation.result;

    return json(200, {
      ok: true, recorded: true, status: "sent",
      isFirstSend: rpc?.isFirstSend ?? co.status === "ready_to_send",
      totalAmount: rpc ? Number(rpc.totalAmount ?? totalAmount) : totalAmount,
      approvalUrl, ...delivery,
    });

  } catch (error) {
    console.error("[change-order-send] Unhandled failure", error instanceof Error ? error.message : String(error));
    return json(500, { error: "The Change Order could not be sent because of an unexpected server error." });
  }
};
