/// <reference types="node" />
// netlify/functions/vendor-payment-reverse.ts
//
// Phase 13.9 (Tier 1) — trusted server-side "Reverse Payment" write path
// for a vendor bill payment. Append-only (Part 17/18): the ORIGINAL
// succeeded vendor_payments row is never rewritten — record_vendor_payment_
// reversal() (supabase/migrations/20260823_accounting_reversals_credits.sql)
// locks it, validates it, and inserts a brand-new payment row (reverses_
// payment_id -> original.id). The bill's amount_paid/status are then
// recomputed automatically by the existing sync_vendor_bill_amount_paid()
// trigger, which nets successful originals against successful reversals.
//
// Accounting: finds the ORIGINAL payment's posted journal entry (source_
// type='vendor_payment', source_id=original.id, posting_key='succeeded')
// and reverses THAT exact entry. Phase 13.9A: reverse_journal_entry() now
// derives its OWN reversal's source_type/source_id from the entry being
// reversed (always the original payment's id) and hardcodes posting_key=
// 'reversed' — this endpoint no longer passes source identity at all, it
// only says *which entry* to reverse. The new reversal payment row's own
// id is still stored operationally (reverses_payment_id), just not used
// as a GL posting identity.

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

  const reversalDate = body.reversalDate || new Date().toISOString().slice(0, 10);

  const { data: rpcRows, error: rpcError } = await admin.rpc("record_vendor_payment_reversal", {
    p_org_id: orgId,
    p_payment_id: paymentId,
    p_reason: reason,
    p_reversal_date: reversalDate,
    p_created_by: userId,
  });
  if (rpcError) {
    if (rpcError.code === "42883") {
      return json(501, { error: "Payment reversals haven't been set up in this environment yet (pending migration 20260823_accounting_reversals_credits.sql)." });
    }
    return json(409, { error: rpcError.message || "Could not reverse this payment." });
  }
  const result = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
  const reversalPaymentId: string = result?.reversal_payment_id;
  if (!reversalPaymentId) {
    console.error("[vendor-payment-reverse] RPC returned no reversal_payment_id", { paymentId, orgId, result });
    return json(500, { error: "Could not reverse this payment." });
  }

  let accountingWarning: string | undefined;
  try {
    const originalEntry = await findJournalEntry(admin, orgId, "vendor_payment", paymentId, "succeeded");
    if (originalEntry) {
      await reverseJournalEntry(admin, {
        orgId, entryId: originalEntry.id, reversalDate, reason, createdBy: userId,
      });
    }
  } catch (accountingError) {
    console.error("[vendor-payment-reverse] accounting reversal failed (non-blocking)", {
      paymentId, reversalPaymentId, orgId, error: accountingError instanceof Error ? accountingError.message : String(accountingError),
    });
    accountingWarning = "Payment reversal recorded, but accounting posting failed and needs manual review.";
  }

  return json(200, {
    ok: true,
    reversalPaymentId,
    billId: result.vendor_bill_id,
    billStatus: result.bill_status,
    billAmountPaid: Number(result.bill_amount_paid),
    alreadyReversed: result.already_reversed,
    accountingWarning,
  });
};
