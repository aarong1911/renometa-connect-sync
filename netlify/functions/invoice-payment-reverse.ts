/// <reference types="node" />
// netlify/functions/invoice-payment-reverse.ts
//
// Phase 13.10 — trusted server-side "Reverse Payment" write path for a
// MANUALLY recorded customer invoice payment. This is an accounting
// correction, not a Stripe refund — Stripe-backed payments are rejected
// here (both by this endpoint and, redundantly, by the DB trigger/RPC) and
// require the actual Stripe Refund API integration deferred to Phase
// 13.11. Append-only (Part 2): the original succeeded payment row is never
// rewritten — record_invoice_payment_reversal() (supabase/migrations/
// 20260825_customer_credits_vendor_credits.sql) locks the invoice then the
// original payment, validates it, and inserts a brand-new payment row
// (reverses_payment_id -> original.id). The invoice's amount_paid/status
// are then recomputed automatically by the existing sync_invoice_amount_
// paid() trigger, netting successful originals against successful
// reversals.

import type { Handler, HandlerEvent, HandlerResponse } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { findJournalEntry, reverseJournalEntry } from "../lib/accounting";

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

function json(statusCode: number, body: Record<string, unknown>): HandlerResponse {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}

export const handler: Handler = async (event: HandlerEvent): Promise<HandlerResponse> => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  const resolved = await resolveOrgFromBearerToken(admin, event.headers.authorization ?? event.headers.Authorization);
  if (!resolved) return json(401, { error: "Unauthorized" });
  const { userId, orgId } = resolved;

  let body: { paymentId?: string; reason?: string; reversalDate?: string };
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return json(400, { error: "Invalid request body" });
  }
  const { paymentId } = body;
  const reason = body.reason?.trim();

  if (!paymentId) return json(400, { error: "paymentId required" });
  if (!reason) return json(400, { error: "A reversal reason is required" });

  // Pre-check for a clear, specific message before the RPC's own (equally
  // authoritative) validation — mirrors vendor-payment-reverse.ts.
  const { data: payment, error: paymentError } = await admin
    .from("invoice_payments").select("id, provider, status").eq("id", paymentId).eq("org_id", orgId).maybeSingle();
  if (paymentError) return json(500, { error: "Could not load the payment." });
  if (!payment) return json(404, { error: "Payment not found." });
  if (payment.provider !== "manual") {
    return json(409, { error: "Only manually recorded payments can be reversed here — Stripe payments require a refund (coming in a future phase)." });
  }

  const reversalDate = body.reversalDate || new Date().toISOString().slice(0, 10);

  const { data: rpcRows, error: rpcError } = await admin.rpc("record_invoice_payment_reversal", {
    p_org_id: orgId,
    p_payment_id: paymentId,
    p_reason: reason,
    p_reversal_date: reversalDate,
    p_created_by: userId,
  });
  if (rpcError) {
    // See customer-credit-create.ts's identical comment — SQLSTATE 42883
    // does not reliably mean "migration not applied"; surface the real
    // database error instead of a hardcoded, potentially false claim.
    if (rpcError.code === "42883" || rpcError.code === "PGRST202") {
      console.error("[invoice-payment-reverse] record_invoice_payment_reversal not resolvable — verify migration 20260825 is applied AND that PostgREST's schema cache reflects its current signature", {
        code: rpcError.code, message: rpcError.message, details: (rpcError as any).details, hint: (rpcError as any).hint,
      });
      return json(501, { error: `Reversing this payment is unavailable: ${rpcError.message}` });
    }
    return json(409, { error: rpcError.message || "Could not reverse this payment." });
  }
  const result = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
  const reversalPaymentId: string = result?.reversal_payment_id;
  if (!reversalPaymentId) {
    console.error("[invoice-payment-reverse] RPC returned no reversal_payment_id", { paymentId, orgId, result });
    return json(500, { error: "Could not reverse this payment." });
  }

  let accountingWarning: string | undefined;
  try {
    const originalEntry = await findJournalEntry(admin, orgId, "invoice_payment", paymentId, "succeeded");
    if (originalEntry) {
      await reverseJournalEntry(admin, {
        orgId, entryId: originalEntry.id, reversalDate, reason, createdBy: userId,
      });
    }
  } catch (accountingError) {
    console.error("[invoice-payment-reverse] accounting reversal failed (non-blocking)", {
      paymentId, reversalPaymentId, orgId, error: accountingError instanceof Error ? accountingError.message : String(accountingError),
    });
    accountingWarning = "Payment reversal recorded, but accounting posting failed and needs manual review.";
  }

  return json(200, {
    ok: true,
    reversalPaymentId,
    invoiceId: result.invoice_id,
    invoiceStatus: result.invoice_status,
    invoiceAmountPaid: Number(result.invoice_amount_paid),
    alreadyReversed: result.already_reversed,
    accountingWarning,
  });
};
