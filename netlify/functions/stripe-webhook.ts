/// <reference types="node" />
// netlify/functions/stripe-webhook.ts
//
// Phase 13.7 — the SOLE payment authority for public invoice payments.
// Client redirects, Stripe.js "success", or a customer landing on the
// success page are never sufficient to mark an invoice paid (Part 10) —
// only a verified event from Stripe itself, here, is.
//
// Listens for payment_intent.succeeded only (not checkout.session.completed
// — Part 11). A Checkout Session "completes" the moment a customer submits
// the form, but for delayed-settlement methods (ACH via us_bank_account)
// the PaymentIntent doesn't actually succeed until days later; Stripe fires
// payment_intent.succeeded exactly once when money has genuinely landed,
// for both instant (card/wallet) and asynchronous (ACH) methods alike, so
// it is the single correct signal regardless of method — never mark ACH
// paid just because the customer submitted bank details.
//
// invoice-create-payment.ts puts invoice_id/org_id/project_id/contact_id
// into payment_intent_data.metadata (not just session metadata) specifically
// so this handler can read them directly off the PaymentIntent — Part 12 —
// and never trusts anything else about the event's shape.
//
// Overpayment (Phase 13.7A Part 7): a confirmed Stripe payment is ALWAYS
// recorded even if the invoice's ledger state changed since Checkout was
// created and the new total would exceed the invoice total — this only
// logs a structured warning for manual reconciliation follow-up. It never
// silently drops, refunds, or rewrites a real confirmed charge.
//
// Idempotency (Part 17): invoice_payments has a unique index on
// (provider, provider_payment_id) where provider_payment_id is not null
// (supabase/migrations/20260818_invoice_payments_ledger.sql) — inserting
// the same PaymentIntent id twice (a Stripe retry, or a re-delivered event)
// hits that constraint and is treated as an already-processed no-op, never
// a duplicate payment row and never a duplicate accounting entry (which is
// additionally guarded by post_journal_entry's own idempotency key).

import type { Handler, HandlerEvent, HandlerResponse } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { postInvoicePaymentSucceeded, postInvoicePaymentRefundSucceeded } from "../lib/accounting";
import { mintPublicInvoiceToken, revokePublicInvoiceTokenByRawToken } from "../lib/invoice-tokens";
import { sendPaymentReceipt } from "../lib/payment-receipt";

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const SITE_URL = process.env.URL || process.env.DEPLOY_PRIME_URL || "http://localhost:9999";

function json(statusCode: number, body: Record<string, unknown>): HandlerResponse {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}

function money(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Maps Stripe's payment_method_types to invoice_payments' payment_method check-constraint vocabulary (cash/check/card/ach/bank_transfer/other). */
function mapPaymentMethod(stripeTypes: string[] | undefined): string {
  const first = stripeTypes?.[0];
  if (first === "card") return "card";
  if (first === "us_bank_account" || first === "acss_debit" || first === "sepa_debit") return "ach";
  return "other";
}

export const handler: Handler = async (event: HandlerEvent): Promise<HandlerResponse> => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeKey || !webhookSecret) {
    console.error("[stripe-webhook] STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET not configured");
    return json(500, { error: "Webhook not configured" });
  }

  const signature = event.headers["stripe-signature"] ?? event.headers["Stripe-Signature"];
  if (!signature) return json(400, { error: "Missing stripe-signature header" });

  // Signature verification requires the EXACT raw bytes Stripe sent — never
  // JSON.parse then re-stringify first, which can reorder keys/reformat
  // whitespace and break the signature (Part 11).
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64") : (event.body ?? "");

  const stripe = new Stripe(stripeKey);
  let stripeEvent: Stripe.Event;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error("[stripe-webhook] signature verification failed:", err instanceof Error ? err.message : err);
    return json(400, { error: "Invalid signature" });
  }

  // Phase 13.11 — refund lifecycle. Handled via the refund-level events
  // (Stripe's own recommendation), never charge.refunded — refund.created/
  // refund.updated/refund.failed carry the refund's own id/status directly,
  // where charge.refunded only summarizes the parent charge's aggregate
  // refunded amount.
  if (stripeEvent.type === "refund.created" || stripeEvent.type === "refund.updated" || stripeEvent.type === "refund.failed") {
    return handleRefundEvent(stripeEvent);
  }

  // Every other event type is acknowledged (200) so Stripe stops retrying
  // it, but only payment_intent.succeeded and the refund events above are
  // ever acted on.
  if (stripeEvent.type !== "payment_intent.succeeded") {
    return json(200, { received: true, ignored: stripeEvent.type });
  }

  const paymentIntent = stripeEvent.data.object as Stripe.PaymentIntent;
  const invoiceId = paymentIntent.metadata?.invoice_id;
  const orgId = paymentIntent.metadata?.org_id;
  if (!invoiceId || !orgId) {
    // Our own session-creation bug, not something a retry can fix — ack so
    // Stripe stops resending, but log loudly for manual follow-up.
    console.error("[stripe-webhook] payment_intent.succeeded missing invoice_id/org_id metadata", { paymentIntentId: paymentIntent.id });
    return json(200, { received: true, error: "missing metadata" });
  }

  // Part 7 — re-read the invoice's CURRENT amount_paid/total_amount right
  // before deciding anything, since real time may have passed since
  // Checkout was created (other payments, manual staff payments, etc).
  const { data: invoice, error: invoiceError } = await admin
    .from("invoices")
    .select("id, org_id, invoice_number, status, total_amount, amount_paid, project_id, client_id")
    .eq("id", invoiceId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (invoiceError || !invoice) {
    console.error("[stripe-webhook] invoice not found for succeeded PaymentIntent", { paymentIntentId: paymentIntent.id, invoiceId, orgId });
    return json(200, { received: true, error: "invoice not found" });
  }

  const amount = Math.round((paymentIntent.amount_received || paymentIntent.amount) ) / 100;
  const paidAtIso = new Date(paymentIntent.created * 1000).toISOString();
  const paymentMethod = mapPaymentMethod(paymentIntent.payment_method_types);

  // Part 7 — a real Stripe success is never rejected/discarded merely
  // because ledger state moved after Checkout creation (e.g. the idempotency
  // key in invoice-create-payment.ts collapsed the race for the COMMON
  // case, but a genuinely independent second PaymentIntent, a manual staff
  // payment recorded in between, or a stale balance at click time can still
  // produce this). Money that Stripe confirms was actually charged is
  // always recorded — deleting or silently dropping a confirmed Stripe
  // payment would create an un-reconciled real-world charge with no ledger
  // trace, which is worse than a flagged overpayment. This only logs a
  // structured warning for manual follow-up; it does not invent a refund.
  const projectedTotal = round2(Number(invoice.amount_paid ?? 0) + amount);
  const isOverpayment = projectedTotal > Number(invoice.total_amount ?? 0) + 0.005;
  if (isOverpayment) {
    console.warn("[stripe-webhook] OVERPAYMENT DETECTED — invoice will be paid beyond its total; flagging for reconciliation follow-up", {
      invoiceId: invoice.id, invoiceNumber: invoice.invoice_number, orgId,
      paymentIntentId: paymentIntent.id, incomingAmount: amount,
      existingAmountPaid: Number(invoice.amount_paid ?? 0), totalAmount: Number(invoice.total_amount ?? 0), projectedTotal,
    });
  }

  const { data: payment, error: insertError } = await admin
    .from("invoice_payments")
    .insert({
      org_id: orgId,
      invoice_id: invoiceId,
      project_id: invoice.project_id,
      contact_id: invoice.client_id,
      amount,
      currency: paymentIntent.currency ?? "usd",
      status: "succeeded",
      payment_method: paymentMethod,
      provider: "stripe",
      provider_payment_id: paymentIntent.id,
      source: "stripe_webhook",
      paid_at: paidAtIso,
    })
    .select("id")
    .maybeSingle();

  if (insertError) {
    // Unique violation on (provider, provider_payment_id) — this exact
    // PaymentIntent was already recorded by a prior delivery of this same
    // event (Stripe retries aggressively). Idempotent no-op, not an error.
    if (insertError.code === "23505") {
      return json(200, { received: true, duplicate: true });
    }
    console.error("[stripe-webhook] invoice_payments insert failed:", insertError);
    return json(500, { error: "Could not record payment" }); // 500 → Stripe will retry; a transient DB error should be retried
  }
  if (!payment) return json(200, { received: true, duplicate: true });

  // Part 13 — accounting posting, exactly like the verified manual-payment
  // path (invoice-record-payment.ts), gated on accounting already being
  // initialized for this org, best-effort/non-blocking.
  try {
    const { data: accountingSettings } = await admin
      .from("accounting_settings").select("status").eq("org_id", orgId).maybeSingle();
    if (accountingSettings?.status === "initialized") {
      await postInvoicePaymentSucceeded(admin, orgId, {
        id: payment.id, amount, paidAt: paidAtIso.slice(0, 10),
        invoiceNumber: invoice.invoice_number, projectId: invoice.project_id, contactId: invoice.client_id,
      }, null);
    }
  } catch (accountingError) {
    console.error("[stripe-webhook] accounting posting failed (non-blocking)", {
      paymentId: payment.id, invoiceId, orgId, error: accountingError instanceof Error ? accountingError.message : String(accountingError),
    });
  }

  if (invoice.project_id) {
    await admin.from("project_notes").insert({
      project_id: invoice.project_id,
      body: `Payment of ${money(amount)} (Stripe, ${paymentMethod}) received online for invoice ${invoice.invoice_number}.`,
      author: "Stripe",
      is_client_message: false,
    }).then(({ error }) => { if (error) console.warn("[stripe-webhook] activity note insert failed (non-blocking):", error.message); });
  }

  // Branded receipt email (Phase 13.7C) — best-effort, only AFTER the
  // canonical payment row above has already succeeded (Part 13/18 — never
  // before webhook confirmation, and a failure here must never roll back
  // or retry-loop the already-successful payment). Tenant-branded from
  // this invoice's own org — never hardcoded to RenoMeta (Part 1). Stripe's
  // own automatic receipt, if the Stripe account has one enabled, is
  // separate and unaffected by this (see Part 15 audit in the report).
  try {
    if (invoice.client_id) {
      const [{ data: client }, { data: org }, { data: project }] = await Promise.all([
        admin.from("contacts").select("full_name, email").eq("id", invoice.client_id).maybeSingle(),
        admin.from("organizations").select("public_name, name, logo_url, phone, email, website, address, business_address").eq("id", orgId).maybeSingle(),
        invoice.project_id ? admin.from("projects").select("name").eq("id", invoice.project_id).maybeSingle() : Promise.resolve({ data: null }),
      ]);
      const toEmail = client?.email?.trim();
      if (toEmail) {
        const { data: updatedInvoice } = await admin.from("invoices").select("amount_paid, total_amount").eq("id", invoiceId).maybeSingle();
        const invoiceTotal = Number(updatedInvoice?.total_amount ?? invoice.total_amount);
        const currentAmountPaid = round2(Number(updatedInvoice?.amount_paid ?? invoice.amount_paid));
        // Part 4 — previouslyPaid = currentAmountPaid - thisPayment, clamped
        // to >= 0 so floating-point noise (or an overpayment edge case)
        // can never render a negative "Previously Paid" line.
        const previouslyPaid = Math.max(0, round2(currentAmountPaid - amount));
        const remainingBalance = Math.max(0, round2(invoiceTotal - currentAmountPaid));

        const business = {
          name: org?.public_name?.trim() || org?.name?.trim() || "Your contractor",
          logoUrl: org?.logo_url ?? null,
          phone: org?.phone ?? null,
          email: org?.email ?? null,
          website: org?.website ?? null,
          address: org?.business_address?.trim() || org?.address?.trim() || null,
        };

        // Part 5 — a fresh public token minted specifically for this
        // receipt's "View Invoice" link. The raw token behind the invoice
        // email is not recoverable from its stored hash (by design), so
        // this mints a NEW row rather than trying to reuse one — the same
        // multiple-active-tokens-per-invoice model invoice-send.ts uses.
        let viewInvoiceUrl: string | null = null;
        let mintedRawToken: string | null = null;
        try {
          mintedRawToken = await mintPublicInvoiceToken(admin, orgId, invoiceId);
          viewInvoiceUrl = `${SITE_URL}/invoice/pay/${encodeURIComponent(mintedRawToken)}`;
        } catch (tokenError) {
          console.error("[stripe-webhook] could not mint receipt view-invoice token (non-blocking, CTA omitted)", {
            paymentId: payment.id, invoiceId, orgId, error: tokenError instanceof Error ? tokenError.message : String(tokenError),
          });
        }

        try {
          await sendPaymentReceipt({
            toEmail,
            customerName: client?.full_name?.trim() || "there",
            business,
            invoiceNumber: invoice.invoice_number,
            projectName: project?.name ?? null,
            paymentId: payment.id,
            paymentMethod,
            provider: "stripe",
            providerPaymentId: paymentIntent.id,
            paidAtDateOnly: paidAtIso.slice(0, 10),
            amountPaid: amount,
            invoiceTotal,
            previouslyPaid,
            remainingBalance,
            viewInvoiceUrl,
          });
          console.log("[stripe-webhook] receipt email sent", { paymentId: payment.id, invoiceId, orgId, providerPaymentId: paymentIntent.id });
        } catch (sendError) {
          // Part 5 — the token minted above was never actually delivered;
          // best-effort revoke so it doesn't sit around unused. Failure to
          // revoke is logged, not thrown — it must never mask the real
          // send error being reported below.
          if (mintedRawToken) await revokePublicInvoiceTokenByRawToken(admin, mintedRawToken);
          throw sendError;
        }
      }
    }
  } catch (receiptError) {
    // Part 13/18 — logged only, never re-thrown past this point: the
    // payment itself (insert + accounting) already fully succeeded above,
    // and the webhook must still return 200 so Stripe does not retry an
    // already-processed payment merely because SMTP/receipt delivery
    // failed. Never logs the raw public token, Stripe client_secret, SMTP
    // password, or any service-role/signing-secret value.
    console.error("[stripe-webhook] receipt email failed (non-blocking)", { paymentId: payment.id, invoiceId, orgId, error: receiptError instanceof Error ? receiptError.message : String(receiptError) });
  }

  return json(200, { received: true, paymentId: payment.id });
};

/** Maps Stripe's Refund.status to invoice_payment_refunds.status — see the identical helper in invoice-payment-refund.ts (kept local rather than shared, matching this file's existing style of standalone webhook logic). */
function mapRefundStatus(s: string | null | undefined): string {
  if (s === "succeeded" || s === "failed" || s === "canceled" || s === "requires_action") return s;
  return "pending";
}

// Phase 13.11 — refund.created / refund.updated / refund.failed. This is
// the CANONICAL confirmation path for a Stripe refund (Part "Stripe
// webhook is the canonical external confirmation" in the lifecycle
// diagram) — the synchronous invoice-payment-refund.ts handler already
// calls the exact same apply_invoice_payment_refund_result() RPC right
// after stripe.refunds.create() returns, so this handler's job is to
// converge state for: (a) the case that synchronous update failed after
// Stripe already confirmed success, (b) any later lifecycle change
// (pending/requires_action -> succeeded/failed) that happens asynchronously
// after the initial API response, and (c) event replays/out-of-order
// delivery, both made safe by apply_invoice_payment_refund_result()'s own
// idempotent, terminal-state-frozen design.
async function handleRefundEvent(stripeEvent: Stripe.Event): Promise<HandlerResponse> {
  const refund = stripeEvent.data.object as Stripe.Refund;
  const orgId = refund.metadata?.org_id;
  const localRefundId = refund.metadata?.local_refund_id || null;

  if (!orgId) {
    // Not one of our refunds (or a pre-Phase-13.11 refund created outside
    // this flow) — nothing we can safely act on. Ack so Stripe stops
    // retrying; log for manual follow-up.
    console.warn("[stripe-webhook] refund event missing org_id metadata — ignoring", { refundId: refund.id, type: stripeEvent.type });
    return json(200, { received: true, ignored: "missing org_id metadata" });
  }

  const mappedStatus = mapRefundStatus(refund.status);
  const { data: rows, error } = await admin.rpc("apply_invoice_payment_refund_result", {
    p_org_id: orgId,
    p_local_refund_id: localRefundId,
    p_stripe_refund_id: refund.id,
    p_status: mappedStatus,
    p_failure_reason: refund.failure_reason ?? null,
  });
  if (error) {
    console.error("[stripe-webhook] apply_invoice_payment_refund_result failed", { refundId: refund.id, orgId, error: error.message });
    // 500 -> Stripe will retry; this may be a transient DB error.
    return json(500, { error: "Could not process refund event" });
  }
  const result = Array.isArray(rows) ? rows[0] : rows;
  if (!result?.refund_id) {
    console.error("[stripe-webhook] refund event resolved no local row", { refundId: refund.id, orgId });
    return json(200, { received: true, error: "refund row not found" });
  }

  // Post accounting exactly once — only when THIS call is what actually
  // transitioned the row into 'succeeded' (result.changed=true). A replay
  // of an already-succeeded refund returns changed=false and skips this
  // entirely, so post_journal_entry's own idempotency is a backstop, not
  // the only guard.
  if (result.changed && result.status === "succeeded") {
    try {
      const { data: accountingSettings } = await admin
        .from("accounting_settings").select("status").eq("org_id", orgId).maybeSingle();
      if (accountingSettings?.status === "initialized") {
        const { data: invoiceForPosting } = await admin
          .from("invoices").select("invoice_number").eq("id", result.invoice_id).maybeSingle();
        await postInvoicePaymentRefundSucceeded(admin, orgId, {
          id: result.refund_id, invoicePaymentId: result.invoice_payment_id, amount: Number(result.amount),
          processedAt: new Date().toISOString().slice(0, 10),
          invoiceNumber: invoiceForPosting?.invoice_number ?? "", projectId: result.project_id ?? null, contactId: result.contact_id ?? null,
        }, null);
      }
    } catch (accountingError) {
      console.error("[stripe-webhook] refund accounting posting failed (non-blocking)", {
        refundId: result.refund_id, orgId, error: accountingError instanceof Error ? accountingError.message : String(accountingError),
      });
    }
  }

  return json(200, { received: true, refundId: result.refund_id, status: result.status });
}
