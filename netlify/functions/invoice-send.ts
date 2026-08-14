/// <reference types="node" />
// netlify/functions/invoice-send.ts
//
// Phase 13.4 follow-up — trusted server-side Draft -> Sent transition for
// invoices. Modeled on estimate-send.ts's authentication/ownership pattern
// (bearer token -> profile -> org-scoped row lookup) and send-email.ts's
// Gmail SMTP transporter, since invoices have no SES-backed public token
// flow the way estimate proposals do.
//
// invoices has no sent_at column (verified against the live schema —
// see report) and no invoice_activities table, so this never invents one:
// the transition is status-only ("draft" -> "sent"), updated_at serves as
// the de facto "when" signal (same approximation src/lib/financials.ts
// already uses for "collected this month"), and the send is logged as a
// project_notes row when the invoice has a project — the same activity
// feed ProjectDetailSheet already reads from.
//
// Phase 13.10F — extended to also handle RESEND for any already-issued,
// non-void/cancelled invoice (Task 2: replaces the standalone "Copy
// Payment Link" endpoint/button entirely, so there is exactly one place
// that mints a token + sends the invoice email, never two). A resend:
//   - mints a brand-new token via the same mintPublicInvoiceToken() helper
//     the original draft->sent send already used (no duplicated token
//     logic)
//   - sends the exact same email template as the original send
//   - does NOT transition invoice status (stays whatever it already was —
//     sent/viewed/partial/paid/overdue)
//   - does NOT re-run postInvoiceIssued() — that posted once, at the
//     original draft->sent transition, and never needs to post again
// A draft invoice still goes through the original path unchanged. A void
// or cancelled invoice is rejected for either path.

import type { Handler, HandlerEvent, HandlerResponse } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";
import { formatDateOnly } from "../../src/lib/format";
import { isIssuedInvoice } from "../../src/lib/invoice-status";
import { postInvoiceIssued } from "../lib/accounting";
import { mintPublicInvoiceToken, revokePublicInvoiceTokenByRawToken } from "../lib/invoice-tokens";

const SITE_URL = process.env.URL || process.env.DEPLOY_PRIME_URL || "http://localhost:9999";

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

function json(statusCode: number, body: Record<string, unknown>): HandlerResponse {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}

function money(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
}

// due_date is a DATE-ONLY column — formatDateOnly (not `new Date(s).toLocaleDateString()`,
// which would parse it as UTC midnight and then render in the server's
// local timezone, potentially shifting the calendar date shown in the
// customer's inbox by a day).
function fmtDate(s: string | null): string {
  return formatDateOnly(s, "—");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

/**
 * Branded transactional email — tenant-aware (Part 7): every value comes
 * from this org's own organizations row (name/logo/phone/website/address),
 * with a generic fallback only when a field is missing, so this template
 * is correct for any org sending an invoice under its own branding, not
 * hardcoded to RenoMeta specifically. Table-based layout + inline styles
 * for Gmail/Outlook rendering; no external CSS, no JS, no huge images.
 */
function buildInvoiceEmail(input: {
  customerName: string;
  organizationName: string;
  organizationLogoUrl: string | null;
  organizationPhone: string | null;
  organizationEmail: string | null;
  projectName: string | null;
  invoiceNumber: string;
  amountDue: string;
  dueDate: string;
  payUrl: string;
}): { subject: string; html: string; text: string } {
  const org = escapeHtml(input.organizationName);
  const customer = escapeHtml(input.customerName);
  const project = input.projectName ? escapeHtml(input.projectName) : null;
  const subject = `Invoice ${input.invoiceNumber} from ${org}`;

  // Phase 13.7F — no HTML width="" attribute: some email clients (notably
  // Outlook's Word rendering engine) honor a fixed width attribute over
  // CSS width:auto, which would squash/distort a wide horizontal wordmark
  // (helmet + business name) instead of letting it scale proportionally.
  // max-height + max-width bound it without cropping or forcing a square.
  const brandMark = input.organizationLogoUrl
    ? `<img src="${escapeHtml(input.organizationLogoUrl)}" alt="${org} logo" style="display:block;height:auto;max-height:44px;width:auto;max-width:200px;border:0;outline:none;" />`
    : `<span style="font-size:18px;font-weight:700;color:#111827;">${org}</span>`;

  const contactLine = [input.organizationEmail, input.organizationPhone]
    .filter((v): v is string => Boolean(v))
    .map(escapeHtml)
    .join(" &nbsp;·&nbsp; ");

  const html = `
<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f5f7;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 0 32px;">${brandMark}</td>
            </tr>
            <tr>
              <td style="padding:20px 32px 0 32px;">
                <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#111827;">Invoice from ${org}</h1>
                <p style="margin:0 0 8px;font-size:15px;line-height:1.6;">Hi ${customer},</p>
                <p style="margin:0 0 20px;font-size:15px;line-height:1.6;">${org} has sent you an invoice${project ? ` for <strong>${project}</strong>` : ""}.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;">
                  <tr>
                    <td style="padding:16px 20px;font-size:13px;color:#6b7280;">Invoice</td>
                    <td style="padding:16px 20px;font-size:13px;color:#111827;font-weight:600;text-align:right;">${escapeHtml(input.invoiceNumber)}</td>
                  </tr>
                  ${project ? `<tr>
                    <td style="padding:0 20px 16px 20px;font-size:13px;color:#6b7280;">Project</td>
                    <td style="padding:0 20px 16px 20px;font-size:13px;color:#111827;font-weight:600;text-align:right;">${project}</td>
                  </tr>` : ""}
                  <tr>
                    <td style="padding:0 20px 16px 20px;font-size:13px;color:#6b7280;border-top:1px solid #e5e7eb;padding-top:16px;">Amount Due</td>
                    <td style="padding:0 20px 16px 20px;font-size:18px;color:#111827;font-weight:700;text-align:right;border-top:1px solid #e5e7eb;padding-top:16px;">${escapeHtml(input.amountDue)}</td>
                  </tr>
                  <tr>
                    <td style="padding:0 20px 16px 20px;font-size:13px;color:#6b7280;">Due Date</td>
                    <td style="padding:0 20px 16px 20px;font-size:13px;color:#111827;font-weight:600;text-align:right;">${escapeHtml(input.dueDate)}</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 0 32px;" align="center">
                <a href="${escapeHtml(input.payUrl)}" style="display:inline-block;background:#111827;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:13px 28px;border-radius:8px;">View &amp; Pay Invoice</a>
                <p style="margin:10px 0 0;font-size:12px;line-height:1.5;color:#6b7280;">You can securely view your invoice and make a payment online.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 28px 32px;">
                <p style="margin:0;font-size:13px;line-height:1.6;color:#6b7280;">Questions? Reply to this email${contactLine ? ` or contact ${org} at ${contactLine}` : ""}.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`.trim();

  const text = [
    `Invoice from ${input.organizationName}`,
    "",
    `Hi ${input.customerName},`,
    "",
    `${input.organizationName} has sent you an invoice${input.projectName ? ` for ${input.projectName}` : ""}.`,
    "",
    `Invoice: ${input.invoiceNumber}`,
    input.projectName ? `Project: ${input.projectName}` : null,
    `Amount Due: ${input.amountDue}`,
    `Due Date: ${input.dueDate}`,
    "",
    `View & Pay Invoice: ${input.payUrl}`,
    "You can securely view your invoice and make a payment online.",
    "",
    `Questions? Reply to this email${input.organizationEmail || input.organizationPhone ? ` or contact ${input.organizationName} at ${[input.organizationEmail, input.organizationPhone].filter(Boolean).join(" / ")}` : ""}.`,
  ].filter((line): line is string => line !== null).join("\n");

  return { subject, html, text };
}

export const handler: Handler = async (event: HandlerEvent): Promise<HandlerResponse> => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  const token = event.headers.authorization?.slice(7) ?? event.headers.Authorization?.slice(7);
  if (!token) return json(401, { error: "Unauthorized" });

  const { data: { user }, error: authError } = await admin.auth.getUser(token);
  if (authError || !user) return json(401, { error: "Invalid token" });

  let invoiceId: string | undefined;
  try {
    ({ invoiceId } = JSON.parse(event.body ?? "{}"));
  } catch {
    return json(400, { error: "Invalid request body" });
  }
  if (!invoiceId) return json(400, { error: "invoiceId required" });

  const { data: profile, error: profileError } = await admin
    .from("profiles").select("organization_id, first_name, last_name").eq("id", user.id).maybeSingle();
  if (profileError) return json(500, { error: "Could not load your organization profile." });
  const orgId = profile?.organization_id;
  if (!orgId) return json(403, { error: "No organization was found for this user." });

  const { data: invoice, error: invoiceError } = await admin
    .from("invoices")
    .select("id, org_id, status, invoice_number, total_amount, issue_date, due_date, client_id, project_id, projects!project_id(name)")
    .eq("id", invoiceId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (invoiceError) return json(500, { error: "Could not load the invoice." });
  if (!invoice) return json(404, { error: "Invoice not found." });

  // Phase 13.10F, Task 2 — a draft goes through the original one-time
  // draft->sent path below unchanged. Any already-issued invoice
  // (sent/viewed/partial/paid/overdue) is a RESEND: same email, a fresh
  // token, but no status transition and no re-posting. void/cancelled is
  // rejected either way — isIssuedInvoice() excludes draft too, so this
  // check only ever rejects void/cancelled here (draft already branched).
  const isResend = invoice.status !== "draft";
  if (isResend && !isIssuedInvoice(invoice.status)) {
    return json(409, { error: `A ${invoice.status} invoice cannot be resent.` });
  }

  if (!invoice.client_id) {
    return json(400, { error: "This invoice has no customer assigned, so it has no email to send to." });
  }

  const { data: client, error: clientError } = await admin
    .from("contacts").select("full_name, email").eq("id", invoice.client_id).eq("org_id", orgId).maybeSingle();
  if (clientError) return json(500, { error: "Could not load the invoice customer." });

  const recipientEmail = client?.email?.trim();
  if (!recipientEmail) {
    return json(400, { error: "This invoice's customer has no email address on file. Add one before sending." });
  }

  const { data: organization } = await admin
    .from("organizations").select("name, public_name, logo_url, phone, email, website, address, business_address").eq("id", orgId).maybeSingle();
  const organizationName = organization?.public_name?.trim() || organization?.name?.trim() || "Your contractor";
  // Part 6 — a customer invoice should read as coming from the business,
  // not the staff member who clicked Send. SMTP_USER stays the verified
  // From address (required for SPF/DKIM alignment — never spoofed), only
  // the display name changes.
  const senderDisplayName = `${organizationName} Billing`;
  const projectName = (invoice as any).projects?.name ?? null;

  // Phase 13.7A Part 1 — mints a BRAND NEW token every send (a previously
  // stored hash can never be turned back into its raw token, so "reuse"
  // was never actually possible — see netlify/lib/invoice-tokens.ts).
  // Multiple active token rows per invoice are intentional: this doesn't
  // invalidate any earlier emailed link.
  let rawToken: string;
  let payUrl: string;
  try {
    rawToken = await mintPublicInvoiceToken(admin, orgId, invoiceId);
    payUrl = `${SITE_URL}/invoice/pay/${encodeURIComponent(rawToken)}`;
  } catch (tokenError) {
    console.error("[invoice-send] could not create public invoice token:", tokenError instanceof Error ? tokenError.message : tokenError);
    return json(500, { error: "Could not prepare the secure invoice link. The invoice was not sent." });
  }

  const { subject, html, text } = buildInvoiceEmail({
    customerName: client?.full_name?.trim() || "there",
    organizationName,
    organizationLogoUrl: organization?.logo_url ?? null,
    organizationPhone: organization?.phone ?? null,
    organizationEmail: organization?.email ?? null,
    projectName,
    invoiceNumber: invoice.invoice_number,
    amountDue: money(Number(invoice.total_amount ?? 0)),
    dueDate: fmtDate(invoice.due_date),
    payUrl,
  });

  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com", port: 587, secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    });
    await transporter.sendMail({ from: `"${senderDisplayName}" <${process.env.SMTP_USER}>`, to: recipientEmail, subject, html, text });
  } catch (err) {
    console.error("[invoice-send] SMTP delivery failed:", err);
    // Part 15 — the token minted above was never actually delivered to the
    // customer; revoke it so it doesn't sit around as an unused-but-valid
    // link. Best-effort: a revoke failure here must not mask the real SMTP
    // error being reported below.
    await revokePublicInvoiceTokenByRawToken(admin, rawToken);
    return json(500, { error: isResend ? "The invoice email could not be delivered." : "The invoice email could not be delivered. The invoice was not marked as sent." });
  }

  // Phase 13.10F, Task 2 — resend path ends here: no status transition, no
  // accounting re-post. The invoice's financial status is exactly what it
  // was before this request.
  if (isResend) {
    if (invoice.project_id) {
      const { error: noteError } = await admin.from("project_notes").insert({
        project_id: invoice.project_id,
        body: `Invoice ${invoice.invoice_number} (${money(Number(invoice.total_amount ?? 0))}) resent to ${recipientEmail}.`,
        author: [profile?.first_name, profile?.last_name].filter(Boolean).join(" ").trim() || organizationName,
        is_client_message: false,
      });
      if (noteError) console.warn("[invoice-send] resend activity note insert failed (non-blocking):", noteError.message);
    }
    return json(200, { ok: true, status: invoice.status, resent: true, recipientEmail });
  }

  const nowIso = new Date().toISOString();
  // Guard the update with .eq("status","draft") so a concurrent/duplicate
  // request that raced past the earlier check can't apply a second "sent"
  // transition to a row this same request (or another one) already moved.
  const { data: updated, error: updateError } = await admin
    .from("invoices")
    .update({ status: "sent", updated_at: nowIso })
    .eq("id", invoiceId).eq("org_id", orgId).eq("status", "draft")
    .select("id, status")
    .maybeSingle();

  if (updateError) {
    return json(500, { error: "The invoice email was sent, but the invoice status could not be updated." });
  }
  if (!updated) {
    // Someone else already flipped it (double-click/retry race) — email may
    // have gone out twice, but no duplicate status/activity side effect.
    return json(409, { error: "This invoice was already sent." });
  }

  if (invoice.project_id) {
    const { error: noteError } = await admin.from("project_notes").insert({
      project_id: invoice.project_id,
      body: `Invoice ${invoice.invoice_number} (${money(Number(invoice.total_amount ?? 0))}) sent to ${recipientEmail}.`,
      author: [profile?.first_name, profile?.last_name].filter(Boolean).join(" ").trim() || organizationName,
      is_client_message: false,
    });
    if (noteError) console.warn("[invoice-send] activity note insert failed (non-blocking):", noteError.message);
  }

  // Phase 13.6 Part 17 — accounting posting is best-effort and NEVER blocks
  // the operational outcome: the email already sent and invoices.status is
  // already authoritatively "sent" above regardless of what happens next.
  // Only runs once this org's accounting has been deliberately activated
  // (status='initialized' — see accounting-backfill.ts); every other org
  // keeps behaving exactly as before with zero posting attempted. Guarded
  // by the same draft->sent transition this function already made exactly
  // once (the .eq("status","draft") update above only ever succeeds for
  // the FIRST send), so a re-send of an already-sent invoice never reaches
  // this code path at all — combined with post_journal_entry's own
  // (org, source_type, source_id, posting_key) idempotency, this invoice
  // can only ever post its "issued" event once.
  let accountingWarning: string | undefined;
  try {
    const { data: accountingSettings } = await admin
      .from("accounting_settings").select("status").eq("org_id", orgId).maybeSingle();
    if (accountingSettings?.status === "initialized") {
      if (!invoice.issue_date) {
        accountingWarning = "Invoice has no issue_date — accounting entry not posted; needs manual review.";
        console.error("[invoice-send] accounting posting skipped: missing issue_date", { invoiceId: invoice.id, orgId });
      } else {
        await postInvoiceIssued(admin, orgId, {
          id: invoice.id, invoiceNumber: invoice.invoice_number, totalAmount: Number(invoice.total_amount ?? 0),
          issueDate: invoice.issue_date, projectId: invoice.project_id, clientId: invoice.client_id,
        }, user.id);
      }
    }
  } catch (accountingError) {
    // Structured, non-fatal — the invoice send itself already fully
    // succeeded and must be reported as such; this is logged for
    // operational follow-up (post_journal_entry's idempotency makes a
    // later manual re-attempt through accounting-backfill.ts, or a future
    // dedicated repair path, safe to run without risk of a duplicate entry).
    console.error("[invoice-send] accounting posting failed (non-blocking)", {
      invoiceId: invoice.id, orgId, error: accountingError instanceof Error ? accountingError.message : String(accountingError),
    });
    accountingWarning = "Invoice sent successfully, but accounting posting failed and needs manual review.";
  }

  return json(200, { ok: true, status: "sent", sentAt: nowIso, recipientEmail, accountingWarning });
};
