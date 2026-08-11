/// <reference types="node" />
// netlify/functions/vendor-bill-record-payment.ts
//
// Phase 13.8, Part 10/11 — records a (possibly partial) payment against an
// open/partial bill: Dr Accounts Payable, Cr the payment-method-resolved
// asset/liability account. Never credits an expense account again — that
// already happened when the bill posted. The DB trigger
// sync_vendor_bill_amount_paid() keeps vendor_bills.amount_paid/status in
// sync automatically once the vendor_payments row is inserted; this
// function does not update the bill directly.
//
// Phase 13.8A, Part 12/13 — the insert itself, and the overpayment guard
// protecting it, now go through the record_vendor_payment() RPC
// (supabase/migrations/20260822_expenses_vendors_ap.sql), which locks the
// bill row (`select ... for update`) and recomputes the remaining balance
// from SUM(succeeded payments) inside that lock before inserting. The
// pre-checks below still run first purely so a bad request gets a clear,
// specific error message before we even attempt the RPC — the RPC's own
// checks are what's actually authoritative against concurrent requests.

import type { Handler, HandlerEvent, HandlerResponse } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { postVendorPaymentSucceeded } from "../lib/accounting";

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const VALID_METHODS = new Set(["cash", "check", "ach", "wire", "bank_transfer", "card", "other"]);

function json(statusCode: number, body: Record<string, unknown>): HandlerResponse {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}

export const handler: Handler = async (event: HandlerEvent): Promise<HandlerResponse> => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  const resolved = await resolveOrgFromBearerToken(admin, event.headers.authorization ?? event.headers.Authorization);
  if (!resolved) return json(401, { error: "Unauthorized" });
  const { userId, orgId } = resolved;

  let body: { billId?: string; amount?: number; method?: string; paidAt?: string; reference?: string; notes?: string };
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return json(400, { error: "Invalid request body" });
  }
  const { billId, method = "other", paidAt, reference, notes } = body;
  const amount = Number(body.amount);

  if (!billId) return json(400, { error: "billId required" });
  if (!Number.isFinite(amount) || amount <= 0) return json(400, { error: "Amount must be a positive number" });
  if (!VALID_METHODS.has(method)) return json(400, { error: "Invalid payment method" });

  // Pre-check only, for a clear 404/409 message — record_vendor_payment()
  // re-validates org/status/balance itself, under lock, before inserting.
  const { data: bill, error: billError } = await admin
    .from("vendor_bills")
    .select("id, org_id, status, bill_number, total_amount, amount_paid, vendor_id, project_id")
    .eq("id", billId).eq("org_id", orgId).maybeSingle();
  if (billError) return json(500, { error: "Could not load the bill." });
  if (!bill) return json(404, { error: "Bill not found." });
  if (bill.status === "draft") return json(409, { error: "This bill must be posted before it can be paid." });
  if (bill.status === "cancelled") return json(409, { error: "This bill is cancelled." });
  if (bill.status === "paid") return json(409, { error: "This bill is already fully paid." });

  const paidAtIso = paidAt ? new Date(paidAt).toISOString() : new Date().toISOString();

  const { data: rpcRows, error: rpcError } = await admin.rpc("record_vendor_payment", {
    p_org_id: orgId,
    p_vendor_bill_id: billId,
    p_amount: amount,
    p_currency: "usd",
    p_payment_method: method,
    p_provider: "manual",
    p_provider_payment_id: null,
    p_source: "manual",
    p_paid_at: paidAtIso,
    p_reference: reference?.trim() || null,
    p_notes: notes?.trim() || null,
    p_created_by: userId,
  });

  if (rpcError) {
    if (rpcError.code === "42883") {
      return json(501, { error: "Vendor payments haven't been set up in this environment yet (pending migration 20260822_expenses_vendors_ap.sql)." });
    }
    // record_vendor_payment() raises plain `raise exception` messages for
    // every expected failure (bad status, no remaining balance,
    // overpayment) — these are already client-safe text, not internal
    // details, so they're surfaced directly as 409s.
    return json(409, { error: rpcError.message || "Could not record this payment." });
  }
  const result = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
  const paymentId: string = result?.payment_id;
  if (!paymentId) {
    console.error("[vendor-bill-record-payment] RPC returned no payment_id", { billId, orgId, result });
    return json(500, { error: "Could not record this payment." });
  }

  let accountingWarning: string | undefined;
  try {
    const { data: accountingSettings } = await admin
      .from("accounting_settings").select("status").eq("org_id", orgId).maybeSingle();
    if (accountingSettings?.status === "initialized") {
      await postVendorPaymentSucceeded(admin, orgId, {
        id: paymentId, amount, paidAt: paidAtIso.slice(0, 10), paymentMethod: method,
        billNumber: bill.bill_number, projectId: bill.project_id,
      }, userId);
    }
  } catch (accountingError) {
    console.error("[vendor-bill-record-payment] accounting posting failed (non-blocking)", {
      paymentId, billId, orgId, error: accountingError instanceof Error ? accountingError.message : String(accountingError),
    });
    accountingWarning = "Payment recorded successfully, but accounting posting failed and needs manual review.";
  }

  return json(200, {
    ok: true,
    paymentId,
    status: result?.bill_status ?? bill.status,
    amountPaid: Number(result?.bill_amount_paid ?? bill.amount_paid),
    accountingWarning,
  });
};
