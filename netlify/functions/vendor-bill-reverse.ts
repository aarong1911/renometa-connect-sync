/// <reference types="node" />
// netlify/functions/vendor-bill-reverse.ts
//
// Phase 13.9 (Tier 1) — trusted server-side "Reverse Bill" write path.
// Only a fully-unpaid, open, posted bill may be reversed (Part 13: "Only
// reverse a vendor bill if it has NO succeeded vendor payments" — reversing
// a bill some of which was already paid would leave A/P wrong unless the
// payments were reversed first, in a deliberate order). The DB trigger
// (enforce_vendor_bill_immutability, 20260823 migration) enforces this same
// rule at the schema level — this endpoint's own pre-check exists only to
// return a clear, specific message before hitting that trigger.

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

  let body: { billId?: string; reason?: string; reversalDate?: string };
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return json(400, { error: "Invalid request body" });
  }
  const { billId } = body;
  const reason = body.reason?.trim();

  if (!billId) return json(400, { error: "billId required" });
  if (!reason) return json(400, { error: "A reversal reason is required" });

  const { data: bill, error: billError } = await admin
    .from("vendor_bills")
    .select("id, org_id, status, amount_paid, bill_number, project_id")
    .eq("id", billId).eq("org_id", orgId).maybeSingle();
  if (billError) return json(500, { error: "Could not load the bill." });
  if (!bill) return json(404, { error: "Bill not found." });

  if (bill.status === "reversed") {
    return json(200, { ok: true, billId, status: "reversed", alreadyReversed: true });
  }
  // "overdue" is never literally the stored value today (nothing sweeps
  // bills to it yet — see vendors.ts's client-side overlay), but a fully
  // unpaid overdue bill is just as reversible as an open one, so both are
  // accepted here and enforced identically by enforce_vendor_bill_
  // immutability's DB-level allowlist.
  if (bill.status !== "open" && bill.status !== "overdue") {
    return json(409, { error: `Only a fully unpaid (open or overdue), posted bill can be reversed (current status: ${bill.status}).` });
  }
  // amount_paid is the trigger-maintained EFFECTIVE balance (original
  // succeeded payments minus successful reversals, see sync_vendor_bill_
  // amount_paid) — not "do any payment rows exist." A bill whose payment
  // was fully reversed already shows amount_paid=0 here and is eligible,
  // exactly as intended (Part 14) — no need to delete or hide history.
  if (Number(bill.amount_paid) !== 0) {
    return json(409, { error: "This bill has a non-zero amount paid — reverse its vendor payments first before reversing the bill." });
  }

  const originalEntry = await findJournalEntry(admin, orgId, "vendor_bill", billId, "opened");
  if (!originalEntry) {
    return json(409, { error: "This bill was never posted to the accounting ledger (accounting wasn't initialized at the time) — there is nothing to reverse." });
  }

  const reversalDate = body.reversalDate || new Date().toISOString().slice(0, 10);

  let reversal;
  try {
    reversal = await reverseJournalEntry(admin, {
      orgId, entryId: originalEntry.id, reversalDate, reason, createdBy: userId,
    });
  } catch (reversalError) {
    console.error("[vendor-bill-reverse] accounting reversal failed:", reversalError);
    return json(500, { error: reversalError instanceof Error ? reversalError.message : "Could not reverse this bill's accounting entry." });
  }

  const { error: updateError } = await admin
    .from("vendor_bills")
    .update({ status: "reversed", reversal_reason: reason })
    .eq("id", billId)
    .in("status", ["open", "overdue"])
    .eq("amount_paid", 0);
  if (updateError) {
    console.error("[vendor-bill-reverse] status update failed after successful accounting reversal:", updateError);
    return json(500, { error: "The accounting reversal posted, but the bill's status could not be updated. Refresh and check the ledger for entry consistency." });
  }

  return json(200, {
    ok: true, billId, status: "reversed", alreadyReversed: reversal.alreadyReversed,
    reversalEntryNumber: reversal.reversalEntryNumber,
  });
};
