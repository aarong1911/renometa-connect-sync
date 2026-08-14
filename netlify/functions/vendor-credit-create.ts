/// <reference types="node" />
// netlify/functions/vendor-credit-create.ts
//
// Phase 13.10B — rewritten from Phase 13.10's one-shot create+post design
// into an explicit prepare -> post GL -> finalize flow, mirroring
// customer-credit-create.ts exactly (see that file's header for the full
// reasoning). A vendor credit must never become financially effective
// (status='posted', counted in A/P/aging/payment ceilings) before its
// journal entry actually exists. The credited account MUST be one of the
// original bill's own line accounts (Part 12/39) — validated here for a
// clean error message AND independently re-verified inside both the
// record_vendor_credit() RPC and the DB trigger on vendor_credit_lines.

import type { Handler, HandlerEvent, HandlerResponse } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { postVendorCredit } from "../lib/accounting";

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

  let body: { billId?: string; amount?: number; reason?: string; description?: string; accountId?: string; creditDate?: string; idempotencyKey?: string };
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return json(400, { error: "Invalid request body" });
  }
  const { billId, accountId } = body;
  const reason = body.reason?.trim();
  const amount = Number(body.amount);
  const idempotencyKey = body.idempotencyKey?.trim();

  if (!billId) return json(400, { error: "billId required" });
  if (!accountId) return json(400, { error: "accountId required" });
  if (!Number.isFinite(amount) || amount <= 0) return json(400, { error: "Amount must be a positive number" });
  if (!reason) return json(400, { error: "A reason is required" });
  // Phase 13.10C, Part 19/20/44 — defense in depth; the DB RPC also rejects
  // a missing/blank key.
  if (!idempotencyKey) return json(400, { error: "idempotencyKey required" });

  const { data: bill, error: billError } = await admin
    .from("vendor_bills")
    .select("id, org_id, status, bill_number, project_id")
    .eq("id", billId).eq("org_id", orgId).maybeSingle();
  if (billError) return json(500, { error: "Could not load the bill." });
  if (!bill) return json(404, { error: "Bill not found." });
  if (bill.status !== "open" && bill.status !== "partial" && bill.status !== "overdue") {
    return json(409, { error: `Cannot credit a ${bill.status} vendor bill.` });
  }

  const { data: billLines } = await admin
    .from("vendor_bill_lines").select("account_id").eq("vendor_bill_id", billId);
  const billAccountIds = new Set((billLines ?? []).map((l: any) => l.account_id));
  if (!billAccountIds.has(accountId)) {
    return json(400, { error: "The credited category must be one of this bill's own line categories." });
  }

  const creditDate = body.creditDate || new Date().toISOString().slice(0, 10);

  const { data: rpcRows, error: rpcError } = await admin.rpc("record_vendor_credit", {
    p_org_id: orgId,
    p_vendor_bill_id: billId,
    p_amount: amount,
    p_reason: reason,
    p_description: body.description?.trim() || null,
    p_account_id: accountId,
    p_credit_date: creditDate,
    p_created_by: userId,
    p_idempotency_key: idempotencyKey,
  });
  if (rpcError) {
    // See customer-credit-create.ts's identical comment — SQLSTATE 42883
    // does not reliably mean "migration not applied" (stale schema cache /
    // leftover overload can cause it just as easily once the migration
    // really has been applied); surface the real database error instead of
    // a hardcoded, potentially false claim.
    if (rpcError.code === "42883" || rpcError.code === "PGRST202") {
      console.error("[vendor-credit-create] record_vendor_credit not resolvable — verify migration 20260825 is applied AND that PostgREST's schema cache reflects its current signature", {
        code: rpcError.code, message: rpcError.message, details: (rpcError as any).details, hint: (rpcError as any).hint,
      });
      return json(501, { error: `Vendor credit creation is unavailable: ${rpcError.message}` });
    }
    return json(409, { error: rpcError.message || "Could not create this vendor credit." });
  }
  const prepared = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
  const vendorCreditId: string = prepared?.vendor_credit_id;
  if (!vendorCreditId) {
    console.error("[vendor-credit-create] RPC returned no vendor_credit_id", { billId, orgId, prepared });
    return json(500, { error: "Could not create this vendor credit." });
  }

  // Phase 13.10C, Part 26 — GL posting and finalize are ALWAYS attempted,
  // even when already 'posted' from a prior call — both are cheaply
  // idempotent and finalize's content re-verification gives back the
  // authoritative posted-only bill_effective_balance rather than the
  // prepare RPC's own bill_available_balance (Part 27 — never conflate
  // the two).
  try {
    await postVendorCredit(admin, orgId, {
      id: vendorCreditId, creditNumber: prepared.credit_number, amount, creditDate,
      expenseAccountId: accountId, vendorBillId: billId, billNumber: bill.bill_number, projectId: bill.project_id,
    }, userId);
  } catch (accountingError) {
    console.error("[vendor-credit-create] accounting posting failed — credit remains draft, safe to retry", {
      vendorCreditId, billId, orgId, error: accountingError instanceof Error ? accountingError.message : String(accountingError),
    });
    return json(502, {
      error: "Could not post accounting for this vendor credit. It has NOT been applied to the bill balance. Retry the same request to resume.",
      vendorCreditId,
      recoverable: true,
    });
  }

  const { data: finalizeRows, error: finalizeError } = await admin.rpc("finalize_vendor_credit", {
    p_org_id: orgId,
    p_vendor_credit_id: vendorCreditId,
    p_created_by: userId,
  });
  if (finalizeError) {
    console.error("[vendor-credit-create] finalize failed — GL is posted but credit remains draft, safe to retry", {
      vendorCreditId, billId, orgId, error: finalizeError.message,
    });
    return json(502, {
      error: "Accounting posted, but the vendor credit could not be finalized. Retry the same request to resume.",
      vendorCreditId,
      recoverable: true,
    });
  }
  const finalized = Array.isArray(finalizeRows) ? finalizeRows[0] : finalizeRows;

  return json(200, {
    ok: true,
    vendorCreditId,
    creditNumber: finalized.credit_number,
    billEffectiveBalance: Number(finalized.bill_effective_balance),
  });
};
