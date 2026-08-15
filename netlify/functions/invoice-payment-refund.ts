/// <reference types="node" />
// netlify/functions/invoice-payment-refund.ts
//
// Phase 13.11 — trusted server-side "Refund Payment" write path for a
// Stripe-confirmed customer invoice payment. Full or partial. This is a
// SEPARATE domain operation from invoice-payment-reverse.ts's manual
// payment reversal (Phase 13.10) — a Stripe refund moves real money back
// through Stripe, a manual reversal is a pure accounting correction with
// no money movement. Stripe payments are explicitly rejected by the
// manual-reversal path and vice versa (each RPC validates provider).
//
// Flow: authenticate -> resolve org -> validate payment belongs to this
// org/invoice -> create_invoice_payment_refund_request() RPC (locks
// invoice then payment, enforces the refundable ceiling under lock,
// idempotent on (org, idempotencyKey)) -> if a NEW local 'pending' row was
// created (or an existing pending one has no Stripe id yet), call Stripe's
// Refund API with a deterministic Idempotency-Key -> converge the local
// row via apply_invoice_payment_refund_result() -> best-effort, non-
// blocking accounting posting, exactly like every other payment path in
// this codebase.
//
// The webhook (stripe-webhook.ts) is the CANONICAL confirmation and calls
// the exact same apply_invoice_payment_refund_result() RPC — if this
// function's own post-Stripe-call update fails (the classic "Stripe
// succeeded, our HTTP response/DB write failed" window), the webhook
// still safely converges the row to its correct terminal state and posts
// accounting exactly once, because both paths route through the same
// idempotent RPC and post_journal_entry()'s own source-id uniqueness.

import type { Handler, HandlerEvent, HandlerResponse } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { postInvoicePaymentRefundSucceeded } from "../lib/accounting";

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

function json(statusCode: number, body: Record<string, unknown>): HandlerResponse {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Maps Stripe's Refund.status to this codebase's invoice_payment_refunds.status vocabulary — identical values today, kept as an explicit function (not a passthrough) so a future Stripe API change is caught at one call site. */
function mapRefundStatus(s: string | null | undefined): string {
  if (s === "succeeded" || s === "failed" || s === "canceled" || s === "requires_action") return s;
  return "pending";
}

export const handler: Handler = async (event: HandlerEvent): Promise<HandlerResponse> => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  const resolved = await resolveOrgFromBearerToken(admin, event.headers.authorization ?? event.headers.Authorization);
  if (!resolved) return json(401, { error: "Unauthorized" });
  const { userId, orgId } = resolved;

  let body: { paymentId?: string; amount?: number; reason?: string; idempotencyKey?: string };
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return json(400, { error: "Invalid request body" });
  }
  const { paymentId } = body;
  const amount = Number(body.amount);
  const reason = body.reason?.trim() || null;
  const idempotencyKey = body.idempotencyKey?.trim();

  if (!paymentId) return json(400, { error: "paymentId required" });
  if (!Number.isFinite(amount) || amount <= 0) return json(400, { error: "amount must be a positive number" });
  if (!idempotencyKey) return json(400, { error: "idempotencyKey required" });

  // Pre-check for a clear, specific message before the RPC's own (equally
  // authoritative) validation — mirrors invoice-payment-reverse.ts.
  const { data: payment, error: paymentError } = await admin
    .from("invoice_payments")
    .select("id, provider, status, invoice_id")
    .eq("id", paymentId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (paymentError) return json(500, { error: "Could not load the payment." });
  if (!payment) return json(404, { error: "Payment not found." });
  if (payment.provider !== "stripe") {
    return json(409, { error: "Only Stripe payments can be refunded here — manually recorded payments use Reverse Payment instead." });
  }

  const { data: rpcRows, error: rpcError } = await admin.rpc("create_invoice_payment_refund_request", {
    p_org_id: orgId,
    p_payment_id: paymentId,
    p_amount: round2(amount),
    p_reason: reason,
    p_idempotency_key: idempotencyKey,
    p_created_by: userId,
  });
  if (rpcError) {
    if (rpcError.code === "42883" || rpcError.code === "PGRST202") {
      console.error("[invoice-payment-refund] create_invoice_payment_refund_request not resolvable — verify migration 20260827 is applied AND that PostgREST's schema cache reflects its current signature", {
        code: rpcError.code, message: rpcError.message, details: (rpcError as any).details, hint: (rpcError as any).hint,
      });
      return json(501, { error: `Refunding this payment is unavailable: ${rpcError.message}` });
    }
    return json(409, { error: rpcError.message || "Could not start this refund." });
  }
  const requestResult = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
  const refundId: string = requestResult?.refund_id;
  const providerPaymentId: string | null = requestResult?.provider_payment_id ?? null;
  if (!refundId) {
    console.error("[invoice-payment-refund] RPC returned no refund_id", { paymentId, orgId, requestResult });
    return json(500, { error: "Could not start this refund." });
  }

  // Already resolved to a terminal state (a genuine idempotent replay of a
  // completed request) — return it as-is, no Stripe call.
  if (requestResult.already_exists && ["succeeded", "failed", "canceled"].includes(requestResult.status)) {
    return json(200, {
      ok: true,
      refundId,
      status: requestResult.status,
      amount: Number(requestResult.amount),
      stripeRefundId: requestResult.stripe_refund_id,
      alreadyExists: true,
    });
  }

  // Already exists as pending WITH a Stripe id already attached — a prior
  // attempt already called Stripe; don't call it again, let the webhook
  // (or a future poll) converge it.
  if (requestResult.already_exists && requestResult.stripe_refund_id) {
    return json(200, {
      ok: true,
      refundId,
      status: requestResult.status,
      amount: Number(requestResult.amount),
      stripeRefundId: requestResult.stripe_refund_id,
      alreadyExists: true,
      pending: true,
    });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return json(501, { error: "Stripe is not configured." });
  if (!providerPaymentId) return json(409, { error: "This payment has no Stripe reference and cannot be refunded." });

  const stripe = new Stripe(stripeKey);
  // Deterministic per logical request — the local idempotencyKey already
  // guarantees "same request never creates two local rows"; folding it (and
  // the refund row's own id, which is itself only ever created once per
  // idempotencyKey) into the Stripe key guarantees Stripe-side idempotency
  // for exactly the same logical request too, without relying on Stripe to
  // dedupe purely by amount/payment_intent (a legitimate second, distinct
  // partial refund against the same payment must NOT collide with this key).
  const stripeIdempotencyKey = `invoice-refund:${refundId}`;
  await admin.rpc("record_invoice_payment_refund_stripe_key", {
    p_org_id: orgId, p_refund_id: refundId, p_stripe_idempotency_key: stripeIdempotencyKey,
  }).then(({ error }) => { if (error) console.warn("[invoice-payment-refund] could not persist stripe_idempotency_key (non-blocking)", error.message); });

  let stripeRefund: Stripe.Refund;
  try {
    stripeRefund = await stripe.refunds.create(
      {
        payment_intent: providerPaymentId,
        amount: Math.round(round2(requestResult.amount) * 100),
        metadata: {
          org_id: orgId,
          invoice_id: payment.invoice_id,
          invoice_payment_id: paymentId,
          local_refund_id: refundId,
        },
      },
      { idempotencyKey: stripeIdempotencyKey },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Stripe refund request failed";
    console.error("[invoice-payment-refund] Stripe refund creation failed", { refundId, paymentId, orgId, error: message });
    await admin.rpc("apply_invoice_payment_refund_result", {
      p_org_id: orgId, p_local_refund_id: refundId, p_stripe_refund_id: null, p_status: "failed", p_failure_reason: message,
    }).then(({ error }) => { if (error) console.error("[invoice-payment-refund] could not record failed refund result", error.message); });
    return json(502, { error: message });
  }

  const mappedStatus = mapRefundStatus(stripeRefund.status);
  const { data: applyRows, error: applyError } = await admin.rpc("apply_invoice_payment_refund_result", {
    p_org_id: orgId,
    p_local_refund_id: refundId,
    p_stripe_refund_id: stripeRefund.id,
    p_status: mappedStatus,
    p_failure_reason: (stripeRefund as any).failure_reason ?? null,
  });
  if (applyError) {
    // Part 16 of the brief — Stripe already confirmed this refund (or is
    // processing it); a failure here must NEVER be reported as a failed
    // refund. The webhook (refund.created, guaranteed to fire) will
    // converge this row via the same idempotent RPC shortly.
    console.error("[invoice-payment-refund] apply_invoice_payment_refund_result failed after Stripe call succeeded — webhook will converge (non-blocking)", {
      refundId, stripeRefundId: stripeRefund.id, orgId, error: applyError.message,
    });
    return json(200, {
      ok: true, refundId, status: "pending", amount: Number(requestResult.amount),
      stripeRefundId: stripeRefund.id, alreadyExists: false,
      warning: "Refund was submitted to Stripe; status will update shortly.",
    });
  }
  const applyResult = Array.isArray(applyRows) ? applyRows[0] : applyRows;

  let accountingWarning: string | undefined;
  if (applyResult?.changed && applyResult.status === "succeeded") {
    try {
      const { data: accountingSettings } = await admin
        .from("accounting_settings").select("status").eq("org_id", orgId).maybeSingle();
      if (accountingSettings?.status === "initialized") {
        const { data: invoiceForPosting } = await admin
          .from("invoices").select("invoice_number").eq("id", applyResult.invoice_id).maybeSingle();
        await postInvoicePaymentRefundSucceeded(admin, orgId, {
          id: refundId, invoicePaymentId: paymentId, amount: Number(applyResult.amount),
          processedAt: new Date().toISOString().slice(0, 10),
          invoiceNumber: invoiceForPosting?.invoice_number ?? "", projectId: applyResult.project_id ?? null, contactId: applyResult.contact_id ?? null,
        }, userId);
      }
    } catch (accountingError) {
      console.error("[invoice-payment-refund] accounting posting failed (non-blocking, retryable via webhook replay)", {
        refundId, paymentId, orgId, error: accountingError instanceof Error ? accountingError.message : String(accountingError),
      });
      accountingWarning = "Refund recorded successfully, but accounting posting failed and needs manual review.";
    }
  }

  return json(200, {
    ok: true,
    refundId,
    status: applyResult?.status ?? mappedStatus,
    amount: Number(requestResult.amount),
    stripeRefundId: stripeRefund.id,
    alreadyExists: false,
    accountingWarning,
  });
};
