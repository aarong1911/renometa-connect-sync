/// <reference types="node" />
// netlify/functions/vendor-bill-post.ts
//
// Phase 13.8, Part 9/16 — transitions a DRAFT bill to 'open' and posts the
// accrual journal entry (Dr each line's expense/COGS account, Cr Accounts
// Payable for the total). Idempotent via post_journal_entry's (org,
// source_type='vendor_bill', source_id=bill.id, posting_key='opened')
// uniqueness — safe to retry. Requires accounting to be initialized for
// this org (unlike expenses/invoices, a bill with no accounting entry would
// never show up in A/P or Project Profitability at all, so posting without
// an initialized ledger would silently produce a bill nobody can act on
// correctly — this function refuses rather than silently degrading).

import type { Handler, HandlerEvent, HandlerResponse } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { postVendorBillOpened } from "../lib/accounting";

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

export const handler: Handler = async (event: HandlerEvent): Promise<HandlerResponse> => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  const resolved = await resolveOrgFromBearerToken(admin, event.headers.authorization ?? event.headers.Authorization);
  if (!resolved) return json(401, { error: "Unauthorized" });
  const { userId, orgId } = resolved;

  let body: { billId?: string };
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return json(400, { error: "Invalid request body" });
  }
  if (!body.billId) return json(400, { error: "billId required" });

  const { data: bill, error: billError } = await admin
    .from("vendor_bills")
    .select("id, org_id, status, bill_number, bill_date, subtotal, tax_amount, total_amount, vendor_id, project_id")
    .eq("id", body.billId).eq("org_id", orgId).maybeSingle();
  if (billError) return json(500, { error: "Could not load the bill." });
  if (!bill) return json(404, { error: "Bill not found." });
  if (bill.status !== "draft") return json(409, { error: `This bill is already ${bill.status} and cannot be posted again.` });

  const { data: accountingSettings } = await admin
    .from("accounting_settings").select("status").eq("org_id", orgId).maybeSingle();
  if (accountingSettings?.status !== "initialized") {
    return json(409, { error: "Accounting hasn't been initialized for this organization yet, so bills can't be posted to the ledger." });
  }

  const { data: lines, error: linesError } = await admin
    .from("vendor_bill_lines")
    .select("account_id, amount, description, project_id")
    .eq("vendor_bill_id", bill.id);
  if (linesError) return json(500, { error: "Could not load bill line items." });
  if (!lines || lines.length === 0) return json(409, { error: "This bill has no line items." });

  // Phase 13.8A, Part 26 — bill totals must be re-verified against the
  // persisted lines immediately before posting, not just trusted from the
  // subtotal/total_amount columns set at create time. There is no "edit
  // draft bill" endpoint today so these can't currently drift, but this
  // guard makes that a verified invariant rather than an assumption that
  // silently breaks if an edit path is ever added without updating totals.
  const computedSubtotal = round2(lines.reduce((s: number, l: any) => s + Number(l.amount), 0));
  const expectedTotal = round2(computedSubtotal + Number(bill.tax_amount ?? 0));
  if (computedSubtotal !== round2(Number(bill.subtotal ?? 0)) || expectedTotal !== round2(Number(bill.total_amount))) {
    console.error("[vendor-bill-post] bill totals do not match line items", {
      billId: bill.id, storedSubtotal: bill.subtotal, computedSubtotal, storedTotal: bill.total_amount, expectedTotal,
    });
    return json(409, { error: "This bill's totals don't match its line items and can't be posted safely. Contact support." });
  }

  try {
    await postVendorBillOpened(admin, orgId, {
      id: bill.id, billNumber: bill.bill_number, totalAmount: Number(bill.total_amount), billDate: bill.bill_date,
      vendorId: bill.vendor_id, projectId: bill.project_id,
      lines: lines.map((l: any) => ({ accountId: l.account_id, amount: Number(l.amount), description: l.description, projectId: l.project_id })),
    }, userId);
  } catch (postError) {
    console.error("[vendor-bill-post] posting failed:", postError);
    return json(500, { error: postError instanceof Error ? postError.message : "Could not post this bill to the ledger." });
  }

  const { error: updateError } = await admin.from("vendor_bills").update({ status: "open" }).eq("id", bill.id);
  if (updateError) {
    console.error("[vendor-bill-post] status update failed after successful posting:", updateError);
    return json(500, { error: "Bill was posted to the ledger, but its status could not be updated. Refresh and check the ledger for entry consistency." });
  }

  return json(200, { ok: true, billId: bill.id, status: "open" });
};
