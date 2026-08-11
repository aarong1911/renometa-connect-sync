/// <reference types="node" />
// netlify/functions/expense-reverse.ts
//
// Phase 13.9 (Tier 1) — trusted server-side "Reverse Expense" write path.
// Never edits the original expense's financial fields or the original
// journal entry — finds the posted journal entry this expense created
// (source_type='expense', source_id=expense.id, posting_key='recorded'),
// reverses it via reverse_journal_entry() (swaps debit/credit, posts a
// brand-new entry, links the original), and only THEN flips the expense's
// own status to 'reversed'. If the accounting posting fails, the expense
// stays 'posted' — never partially reversed.

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

  let body: { expenseId?: string; reason?: string; reversalDate?: string };
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return json(400, { error: "Invalid request body" });
  }
  const { expenseId } = body;
  const reason = body.reason?.trim();

  if (!expenseId) return json(400, { error: "expenseId required" });
  if (!reason) return json(400, { error: "A reversal reason is required" });

  const { data: expense, error: expenseError } = await admin
    .from("expenses")
    .select("id, org_id, status, amount, expense_date, description, account_id, project_id, contact_id, reversal_reason")
    .eq("id", expenseId).eq("org_id", orgId).maybeSingle();
  if (expenseError) return json(500, { error: "Could not load the expense." });
  if (!expense) return json(404, { error: "Expense not found." });

  if (expense.status === "reversed") {
    return json(200, { ok: true, expenseId, status: "reversed", alreadyReversed: true });
  }
  if (expense.status !== "posted") {
    return json(409, { error: `Only a posted expense can be reversed (current status: ${expense.status}).` });
  }

  const originalEntry = await findJournalEntry(admin, orgId, "expense", expenseId, "recorded");
  if (!originalEntry) {
    return json(409, { error: "This expense was never posted to the accounting ledger (accounting wasn't initialized at the time) — there is nothing to reverse." });
  }

  const reversalDate = body.reversalDate || new Date().toISOString().slice(0, 10);

  let reversal;
  try {
    reversal = await reverseJournalEntry(admin, {
      orgId, entryId: originalEntry.id, reversalDate, reason, createdBy: userId,
    });
  } catch (reversalError) {
    console.error("[expense-reverse] accounting reversal failed:", reversalError);
    return json(500, { error: reversalError instanceof Error ? reversalError.message : "Could not reverse this expense's accounting entry." });
  }

  const { error: updateError } = await admin
    .from("expenses")
    .update({ status: "reversed", reversal_reason: reason })
    .eq("id", expenseId)
    .eq("status", "posted");
  if (updateError) {
    console.error("[expense-reverse] status update failed after successful accounting reversal:", updateError);
    return json(500, { error: "The accounting reversal posted, but the expense's status could not be updated. Refresh and check the ledger for entry consistency." });
  }

  return json(200, {
    ok: true, expenseId, status: "reversed", alreadyReversed: reversal.alreadyReversed,
    reversalEntryNumber: reversal.reversalEntryNumber,
  });
};
