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

import type { Handler, HandlerEvent, HandlerResponse } from "@netlify/functions";
import { SESv2Client, SendEmailCommand, type SendEmailCommandInput } from "@aws-sdk/client-sesv2";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

import { resolveChangeOrderPermissionServer } from "../../src/lib/change-order-permissions";

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const AWS_REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-west-2";
const SES_FROM_EMAIL = process.env.SES_FROM_EMAIL ?? process.env.SMTP_FROM_EMAIL ?? process.env.FROM_EMAIL ?? "info@connect.renometa.com";

const APPROVAL_TOKEN_DEFAULT_TTL_DAYS = 30;

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const ses = new SESv2Client({ region: AWS_REGION });

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

async function sendChangeOrderEmail(input: {
  to: string; senderName: string; organizationName: string; customerName: string;
  changeOrderNumber: string; changeOrderTitle: string; totalAmount: number; approvalUrl: string;
}): Promise<void> {
  const safeCustomerName = escapeHtml(input.customerName || "there");
  const safeOrganizationName = escapeHtml(input.organizationName);
  const safeTitle = escapeHtml(input.changeOrderTitle);
  const safeNumber = escapeHtml(input.changeOrderNumber);
  const safeUrl = escapeHtml(input.approvalUrl);
  const amountLabel = input.totalAmount < 0
    ? `-$${Math.abs(input.totalAmount).toFixed(2)} credit`
    : `$${input.totalAmount.toFixed(2)}`;

  const subject = `Change Order ${safeNumber} from ${safeOrganizationName}`;
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

  const message: SendEmailCommandInput = {
    FromEmailAddress: `"${input.senderName}" <${SES_FROM_EMAIL}>`,
    Destination: { ToAddresses: [input.to] },
    Content: { Simple: { Subject: { Data: subject, Charset: "UTF-8" }, Body: { Html: { Data: html, Charset: "UTF-8" }, Text: { Data: text, Charset: "UTF-8" } } } },
  };
  await ses.send(new SendEmailCommand(message));
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

  let body: { changeOrderId?: string } = {};
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
    const { data: co, error: coError } = await admin.from("project_change_orders").select("id, status, approval_due_at").eq("id", changeOrderId).eq("org_id", orgId).maybeSingle();
    if (coError) return json(500, { error: "Could not load the Change Order." });
    if (!co) return json(404, { error: "Change Order not found." });

    const plaintextToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(plaintextToken).digest("hex");
    const expiresAt = co.approval_due_at
      ? new Date(co.approval_due_at).toISOString()
      : new Date(Date.now() + APPROVAL_TOKEN_DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // The single transactional write — service-role call to a
    // service_role-only RPC. org_id/actor_user_id were independently
    // resolved/verified above, never taken from the request body.
    const { data: rpcResult, error: rpcError } = await admin.rpc("send_project_change_order", {
      p_change_order_id: changeOrderId,
      p_org_id: orgId,
      p_actor_user_id: user.id,
      p_token_hash: tokenHash,
      p_expires_at: expiresAt,
    });
    if (rpcError) return json(409, { error: rpcError.message });

    const result = rpcResult as { isFirstSend?: boolean; changeOrderNumber?: string; title?: string; totalAmount?: number } | null;
    const totalAmount = Number(result?.totalAmount ?? 0);
    const changeOrderNumber = result?.changeOrderNumber ?? "";
    const changeOrderTitle = result?.title ?? "";
    const isFirstSend = result?.isFirstSend ?? false;

    const approvalUrl = `${getAppBaseUrl(event)}/change-order/${plaintextToken}`;

    // Read-only lookups for the email content only — never used to decide
    // anything the RPC has already authoritatively decided.
    const { data: coProject } = await admin.from("project_change_orders").select("project_id").eq("id", changeOrderId).maybeSingle();
    const { data: projectRow } = coProject ? await admin.from("projects").select("client_id").eq("id", coProject.project_id).maybeSingle() : { data: null };
    const { data: customer } = projectRow ? await admin.from("contacts").select("full_name, email").eq("id", projectRow.client_id).maybeSingle() : { data: null };
    const { data: organization } = await admin.from("organizations").select("name, public_name").eq("id", orgId).maybeSingle();
    const organizationName = organization?.public_name?.trim() || organization?.name?.trim() || "Your contractor";
    const senderName = [profile?.first_name, profile?.last_name].filter((v): v is string => Boolean(v?.trim())).join(" ").trim() || organizationName;
    const recipientEmail = customer?.email?.trim();

    let emailDelivered = false;
    let emailError: string | null = null;
    if (recipientEmail) {
      try {
        await sendChangeOrderEmail({
          to: recipientEmail, senderName, organizationName, customerName: customer?.full_name?.trim() || "there",
          changeOrderNumber, changeOrderTitle, totalAmount, approvalUrl,
        });
        emailDelivered = true;
      } catch (err) {
        emailError = err instanceof Error ? err.message : String(err);
        console.error("[change-order-send] SES delivery failed (non-fatal — link remains valid)", emailError);
      }
    }

    return json(200, {
      ok: true,
      status: "sent",
      isFirstSend,
      totalAmount,
      approvalUrl,
      emailDelivered,
      emailError,
      recipientEmail: recipientEmail ?? null,
      sentAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[change-order-send] Unhandled failure", error);
    return json(500, { error: "The Change Order could not be sent because of an unexpected server error." });
  }
};
