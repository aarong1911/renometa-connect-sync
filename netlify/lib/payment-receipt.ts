/// <reference types="node" />
// netlify/lib/payment-receipt.ts
//
// Phase 13.7C — polished, tenant-branded payment receipt email. Extracted
// out of stripe-webhook.ts (which previously embedded the HTML inline) so
// the webhook stays readable. Currently called only from the Stripe
// success path (Part 16 — primary scope), but nothing here assumes Stripe:
// `provider`/`providerPaymentId` are optional and the copy adapts (no
// "processed securely by Stripe" line, no Stripe Reference row) when a
// future manual-payment receipt reuses this same builder.
//
// Tenant branding (Part 1): every business-facing string comes from the
// caller's own `business` object, resolved by the caller from that
// invoice's own org_id — this module has no knowledge of RenoMeta
// specifically and invents nothing for a field the org hasn't set.

import nodemailer from "nodemailer";
import { formatDateOnly } from "../../src/lib/format";
import { formatPaymentMethod, formatPaymentProvider } from "../../src/lib/payment-method";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function money(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** "pi_3U2AxTDU8IcWPOR02xzAMtlL" -> "pi_3U2A…AMtlL". Never shows a full internal/provider id as the dominant receipt reference. */
function truncateMiddle(value: string, headLen: number, tailLen: number): string {
  if (value.length <= headLen + tailLen + 1) return value;
  return tailLen > 0 ? `${value.slice(0, headLen)}…${value.slice(-tailLen)}` : `${value.slice(0, headLen)}…`;
}

/** Joins only the parts that actually exist — never renders an empty/dangling " · " separator for a missing business field (Part 22). */
function joinExisting(parts: (string | null | undefined)[], sep: string): string {
  return parts.filter((p): p is string => Boolean(p && p.trim())).join(sep);
}

export type PaymentReceiptBusiness = {
  name: string;
  logoUrl: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  address: string | null;
};

export type PaymentReceiptInput = {
  toEmail: string;
  customerName: string;
  business: PaymentReceiptBusiness;
  invoiceNumber: string;
  projectName: string | null;
  paymentId: string;
  paymentMethod: string;
  /** e.g. "stripe" | "manual" — distinct from paymentMethod (Part 7). */
  provider: string;
  providerPaymentId: string | null;
  /** Date-only (YYYY-MM-DD) business date, same convention as invoice-send.ts. */
  paidAtDateOnly: string;
  amountPaid: number;
  invoiceTotal: number;
  /** Total paid on this invoice BEFORE this payment — never negative (Part 4 clamps floating-point noise). */
  previouslyPaid: number;
  remainingBalance: number;
  /** null when a secure link couldn't be minted — the CTA is simply omitted, never a broken/placeholder link. */
  viewInvoiceUrl: string | null;
};

export function buildPaymentReceiptEmail(input: PaymentReceiptInput): { subject: string; html: string; text: string } {
  const businessName = input.business.name;
  const isPaidInFull = round2(input.remainingBalance) <= 0.005;
  const isStripe = input.provider === "stripe";
  const methodLabel = formatPaymentMethod(input.paymentMethod);
  const providerLabel = formatPaymentProvider(input.provider);
  const paymentDateLabel = formatDateOnly(input.paidAtDateOnly, "—");

  const subject = `Receipt for payment — ${input.invoiceNumber}`;

  const reference = isStripe && input.providerPaymentId
    ? { label: "Stripe Reference", value: truncateMiddle(input.providerPaymentId, 8, 4) }
    : { label: "Receipt Reference", value: truncateMiddle(input.paymentId, 8, 0) };

  const contactLine = joinExisting([input.business.phone, input.business.email, input.business.website], "  ·  ");

  const org = escapeHtml(businessName);
  const customer = escapeHtml(input.customerName);
  const project = input.projectName ? escapeHtml(input.projectName) : null;

  // Phase 13.7F — max-width added so a wide horizontal wordmark (helmet +
  // business name) has room to render in full rather than being visually
  // dominated by the icon portion at this size; height stays bounded so a
  // very wide logo still scales down proportionally instead of overflowing
  // the 560px-wide card.
  const logoOrName = input.business.logoUrl
    ? `<img src="${escapeHtml(input.business.logoUrl)}" alt="${org} logo" height="44" style="display:block;height:44px;max-height:44px;width:auto;max-width:220px;border:0;outline:none;margin:0 auto;" />`
    : `<span style="font-size:18px;font-weight:700;color:#111827;">${org}</span>`;

  const statusBadge = isPaidInFull
    ? `<span style="display:inline-block;background:#dcfce7;color:#166534;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:4px 10px;border-radius:999px;">Paid in full</span>`
    : `<span style="display:inline-block;background:#fef3c7;color:#92400e;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:4px 10px;border-radius:999px;">Partial payment</span>`;

  const ctaBlock = input.viewInvoiceUrl
    ? `
            <tr>
              <td align="center" style="padding:24px 32px 0 32px;">
                <a href="${escapeHtml(input.viewInvoiceUrl)}" style="display:inline-block;background:#111827;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:12px 26px;border-radius:8px;">View Invoice</a>
                <p style="margin:10px 0 0;font-size:12px;line-height:1.5;color:#6b7280;">You can securely view your invoice and payment details online.</p>
              </td>
            </tr>`
    : "";

  const html = `
<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f5f7;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">

            <tr><td align="center" style="padding:32px 32px 0 32px;">${logoOrName}</td></tr>

            <tr>
              <td align="center" style="padding:18px 32px 0 32px;">
                <span style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;">Payment Received</span>
                <p style="margin:10px 0 0;font-size:14px;line-height:1.6;color:#374151;">Thank you, ${customer}.</p>
                <p style="margin:2px 0 0;font-size:14px;line-height:1.6;color:#374151;">We've received your payment${project ? ` for <strong>${project}</strong>` : ""}.</p>
              </td>
            </tr>

            <tr>
              <td align="center" style="padding:20px 32px 0 32px;">
                <div style="font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#9ca3af;">Amount Paid</div>
                <div style="margin-top:4px;font-size:34px;font-weight:700;color:#111827;">${money(input.amountPaid)}</div>
              </td>
            </tr>

            <tr>
              <td style="padding:20px 32px 0 32px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;">
                  <tr>
                    <td style="padding:16px 20px 0 20px;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#6b7280;" colspan="2">Receipt Details</td>
                  </tr>
                  <tr>
                    <td style="padding:10px 20px 0 20px;font-size:13px;color:#6b7280;">Invoice</td>
                    <td style="padding:10px 20px 0 20px;font-size:13px;color:#111827;font-weight:600;text-align:right;">${escapeHtml(input.invoiceNumber)}</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 20px 0 20px;font-size:13px;color:#6b7280;">Payment Date</td>
                    <td style="padding:8px 20px 0 20px;font-size:13px;color:#111827;font-weight:600;text-align:right;">${escapeHtml(paymentDateLabel)}</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 20px 0 20px;font-size:13px;color:#6b7280;">Payment Method</td>
                    <td style="padding:8px 20px 0 20px;font-size:13px;color:#111827;font-weight:600;text-align:right;">${escapeHtml(methodLabel)}${isStripe ? ` <span style="color:#9ca3af;font-weight:400;">via ${escapeHtml(providerLabel)}</span>` : ""}</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 20px 0 20px;font-size:13px;color:#6b7280;">${escapeHtml(reference.label)}</td>
                    <td style="padding:8px 20px 0 20px;font-size:12px;color:#6b7280;font-family:monospace;text-align:right;">${escapeHtml(reference.value)}</td>
                  </tr>
                  <tr>
                    <td style="padding:12px 20px 16px 20px;font-size:13px;color:#6b7280;border-top:1px solid #e5e7eb;padding-top:12px;">Status</td>
                    <td style="padding:12px 20px 16px 20px;text-align:right;border-top:1px solid #e5e7eb;padding-top:12px;">${statusBadge}</td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:20px 32px 0 32px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e7eb;border-radius:8px;">
                  <tr>
                    <td style="padding:14px 20px 0 20px;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#6b7280;" colspan="2">Payment Summary</td>
                  </tr>
                  <tr>
                    <td style="padding:10px 20px 0 20px;font-size:13px;color:#374151;">Invoice Total</td>
                    <td style="padding:10px 20px 0 20px;font-size:13px;color:#111827;text-align:right;">${money(input.invoiceTotal)}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 20px 0 20px;font-size:13px;color:#374151;">Previously Paid</td>
                    <td style="padding:6px 20px 0 20px;font-size:13px;color:#111827;text-align:right;">${money(input.previouslyPaid)}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 20px 0 20px;font-size:13px;color:#374151;">This Payment</td>
                    <td style="padding:6px 20px 0 20px;font-size:13px;color:#111827;text-align:right;">${money(input.amountPaid)}</td>
                  </tr>
                  <tr>
                    <td style="padding:10px 20px 14px 20px;font-size:13px;font-weight:700;color:#111827;border-top:1px solid #e5e7eb;padding-top:10px;">Remaining Balance</td>
                    <td style="padding:10px 20px 14px 20px;font-size:13px;font-weight:700;color:${isPaidInFull ? "#166534" : "#92400e"};text-align:right;border-top:1px solid #e5e7eb;padding-top:10px;">${money(input.remainingBalance)}</td>
                  </tr>
                </table>
              </td>
            </tr>
${ctaBlock}
            ${isStripe ? `<tr><td align="center" style="padding:18px 32px 0 32px;"><p style="margin:0;font-size:11px;color:#9ca3af;">Payment processed securely by Stripe.</p></td></tr>` : ""}

            <tr>
              <td style="padding:26px 32px 30px 32px;">
                <p style="margin:0 0 4px;font-size:12px;font-weight:600;color:#374151;">Questions about this payment?</p>
                ${contactLine ? `<p style="margin:0;font-size:12px;line-height:1.6;color:#6b7280;">${escapeHtml(contactLine)}</p>` : `<p style="margin:0;font-size:12px;line-height:1.6;color:#6b7280;">Reply to this email and we'll help.</p>`}
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`.trim();

  const text = [
    businessName,
    "",
    "PAYMENT RECEIVED",
    "",
    `Thank you, ${input.customerName}.`,
    `We've received your payment${input.projectName ? ` for ${input.projectName}` : ""}.`,
    "",
    `Amount Paid: ${money(input.amountPaid)}`,
    "",
    "Receipt Details",
    `Invoice: ${input.invoiceNumber}`,
    `Payment Date: ${paymentDateLabel}`,
    `Payment Method: ${methodLabel}${isStripe ? ` via ${providerLabel}` : ""}`,
    `${reference.label}: ${reference.value}`,
    `Status: ${isPaidInFull ? "PAID IN FULL" : "PARTIAL PAYMENT"}`,
    "",
    "Payment Summary",
    `Invoice Total: ${money(input.invoiceTotal)}`,
    `Previously Paid: ${money(input.previouslyPaid)}`,
    `This Payment: ${money(input.amountPaid)}`,
    `Remaining Balance: ${money(input.remainingBalance)}`,
    "",
    input.viewInvoiceUrl ? `View Invoice: ${input.viewInvoiceUrl}` : null,
    input.viewInvoiceUrl ? "You can securely view your invoice and payment details online." : null,
    "",
    isStripe ? "Payment processed securely by Stripe." : null,
    "",
    "Questions about this payment?",
    contactLine || null,
  ].filter((line): line is string => line !== null).join("\n");

  return { subject, html, text };
}

export async function sendPaymentReceipt(input: PaymentReceiptInput): Promise<void> {
  const { subject, html, text } = buildPaymentReceiptEmail(input);
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com", port: 587, secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
  });
  await transporter.sendMail({
    from: `"${input.business.name} Billing" <${process.env.SMTP_USER}>`,
    to: input.toEmail,
    subject,
    html,
    text,
  });
}
