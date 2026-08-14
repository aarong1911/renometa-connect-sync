// src/lib/customer-credits.ts — Phase 13.10 read-side helpers for customer
// credit memos and manual invoice payment reversal. Reads go straight
// through Supabase (RLS-scoped, select-only — writes are backend-only, see
// 20260825_customer_credits_vendor_credits.sql). All writes go through the
// trusted Netlify functions (customer-credit-create, invoice-payment-
// reverse) — never a direct client insert.

import { supabase } from "@/lib/supabase";

export type CustomerCreditMemo = {
  id: string;
  invoiceId: string;
  creditNumber: string | null;
  creditDate: string;
  reason: string;
  totalAmount: number;
  status: "draft" | "posted" | "reversed";
  createdAt: string;
};

export async function fetchCustomerCreditMemosForInvoice(invoiceId: string): Promise<CustomerCreditMemo[]> {
  const { data, error } = await supabase
    .from("customer_credit_memos")
    .select("id, invoice_id, credit_number, credit_date, reason, total_amount, status, created_at")
    .eq("invoice_id", invoiceId)
    .order("credit_date", { ascending: false });
  if (error) { console.error("[customer-credits]", error); return []; }
  return (data ?? []).map((r: any) => ({
    id: r.id, invoiceId: r.invoice_id, creditNumber: r.credit_number, creditDate: r.credit_date,
    reason: r.reason, totalAmount: Number(r.total_amount ?? 0), status: r.status, createdAt: r.created_at,
  }));
}

/** Sum of posted credit memos, per invoice, for every invoice in orgId — batched (one query), not N+1. */
export async function fetchPostedCustomerCreditTotals(orgId: string): Promise<Map<string, number>> {
  const { data, error } = await supabase
    .from("customer_credit_memos")
    .select("invoice_id, total_amount")
    .eq("org_id", orgId)
    .eq("status", "posted");
  const totals = new Map<string, number>();
  if (error) { console.error("[customer-credits]", error); return totals; }
  for (const r of data ?? []) {
    const invoiceId = (r as any).invoice_id as string;
    totals.set(invoiceId, Math.round(((totals.get(invoiceId) ?? 0) + Number((r as any).total_amount ?? 0)) * 100) / 100);
  }
  return totals;
}
