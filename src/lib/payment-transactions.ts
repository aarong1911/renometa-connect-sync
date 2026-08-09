// src/lib/payment-transactions.ts
//
// Phase 13.7B — the canonical, transaction-level read model for
// invoice_payments. Fixes the Financials → Payments bug where rows were
// fabricated from invoices.amount_paid (one row per INVOICE, method always
// "Other", id = invoice.id) instead of from the real payment ledger — see
// the old src/lib/received-payments.ts comment this replaces. One
// PaymentTransaction = exactly one invoice_payments row, never aggregated
// by invoice: an invoice with two separate payments (e.g. $500 then $100)
// must produce two PaymentTransaction rows, not one $600 row.
import { supabase } from "@/lib/supabase";

async function getOrgId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: p } = await supabase.from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
  if (p?.organization_id) return p.organization_id;
  const { data: m } = await supabase.from("org_memberships").select("org_id").eq("member_id", user.id).maybeSingle();
  return m?.org_id ?? null;
}

export type PaymentTransactionStatus = "pending" | "succeeded" | "failed" | "refunded" | "voided";

/**
 * One row = one invoice_payments.id. Deliberately named/shaped to avoid the
 * ambiguity that caused the original bug (an "id" that was secretly
 * invoice.id, a "method" that was never actually read from the ledger):
 * every field here is exactly the canonical column it's named after, plus
 * the minimal display-only joins (invoiceNumber, contactName, projectName).
 */
export type PaymentTransaction = {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  contactId: string | null;
  contactName: string;
  projectId: string | null;
  projectName: string | null;
  amount: number;
  currency: string;
  status: PaymentTransactionStatus;
  paymentMethod: string;
  provider: string;
  providerPaymentId: string | null;
  source: string;
  paidAt: string;
  reference: string | null;
  notes: string | null;
};

/** Returns [] (not an error) when the ledger table doesn't exist yet in this environment, or the caller has no org — callers should treat that identically to "no payments yet." */
export async function fetchPaymentTransactions(): Promise<PaymentTransaction[]> {
  const orgId = await getOrgId();
  if (!orgId) return [];

  const { data, error } = await supabase
    .from("invoice_payments")
    .select(`
      id, invoice_id, project_id, contact_id, amount, currency, status,
      payment_method, provider, provider_payment_id, source, paid_at, reference, notes,
      invoices!invoice_id(invoice_number),
      contacts!contact_id(full_name),
      projects!project_id(name)
    `)
    .eq("org_id", orgId)
    .order("paid_at", { ascending: false });

  if (error) {
    if (error.code !== "42P01") console.error("[payment-transactions]", error);
    return [];
  }

  return (data ?? []).map((r: any) => ({
    id: r.id,
    invoiceId: r.invoice_id,
    invoiceNumber: r.invoices?.invoice_number ?? "—",
    contactId: r.contact_id ?? null,
    contactName: r.contacts?.full_name ?? "—",
    projectId: r.project_id ?? null,
    projectName: r.projects?.name ?? null,
    amount: Number(r.amount ?? 0),
    currency: r.currency ?? "usd",
    status: r.status,
    paymentMethod: r.payment_method ?? "other",
    provider: r.provider ?? "manual",
    providerPaymentId: r.provider_payment_id ?? null,
    source: r.source ?? "manual",
    paidAt: r.paid_at,
    reference: r.reference ?? null,
    notes: r.notes ?? null,
  }));
}
