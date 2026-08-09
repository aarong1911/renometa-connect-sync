// src/lib/received-payments.ts
//
// Phase 13.7B — fetchReceivedPayments() previously fabricated one row per
// PAID/PARTIAL INVOICE from invoices.amount_paid, which meant: the "id"
// shown was actually invoice.id (not a payment id), the method was always
// hardcoded "Other" (never read from the ledger), and two separate
// payments on the same invoice collapsed into a single aggregated row.
// Now a thin adapter over the canonical, transaction-level
// src/lib/payment-transactions.ts — one Payment row per real
// invoice_payments.id, with its actual stored payment_method and a proper
// payment id. Used by both financials.payments.tsx and
// financials.reports.tsx.
import type { Payment } from "@/lib/mock-data";
import { fetchPaymentTransactions } from "@/lib/payment-transactions";
import { supabase } from "@/lib/supabase";

async function getOrgId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: p } = await supabase.from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
  if (p?.organization_id) return p.organization_id;
  const { data: m } = await supabase.from("org_memberships").select("org_id").eq("member_id", user.id).maybeSingle();
  return m?.org_id ?? null;
}

export async function fetchReceivedPayments(): Promise<Payment[]> {
  const transactions = await fetchPaymentTransactions();
  return transactions
    .filter((t) => t.status === "succeeded")
    .map((t) => ({
      id: t.id,
      invoice: t.invoiceNumber,
      client: t.contactName,
      amount: t.amount,
      method: t.paymentMethod,
      receivedAt: t.paidAt,
      status: "Received" as const,
      invoiceId: t.invoiceId,
      contactId: t.contactId,
      projectId: t.projectId,
      projectName: t.projectName,
      provider: t.provider,
      providerPaymentId: t.providerPaymentId,
      source: t.source,
      currency: t.currency,
      reference: t.reference,
      notes: t.notes,
    }));
}

export type OutstandingInvoice = {
  id: string;
  invoice_number: string;
  total_amount: number;
  amount_paid: number;
  due_date: string | null;
  status: string;
};

/** Invoices that are sent/viewed/overdue/partial with a balance still owed. */
export async function fetchOutstandingInvoices(): Promise<OutstandingInvoice[]> {
  const orgId = await getOrgId();
  if (!orgId) return [];
  const { data, error } = await supabase
    .from("invoices")
    .select("id, invoice_number, total_amount, amount_paid, due_date, status")
    .eq("org_id", orgId)
    .not("status", "in", "(draft,paid)");
  if (error) { console.error("[received-payments]", error); return []; }
  return (data ?? []).map((r: any) => ({
    id: r.id,
    invoice_number: r.invoice_number ?? "—",
    total_amount: Number(r.total_amount ?? 0),
    amount_paid: Number(r.amount_paid ?? 0),
    due_date: r.due_date,
    status: r.status ?? "sent",
  }));
}

export type AllInvoiceTotal = { total_amount: number };

/** All non-draft invoices, for a total "invoiced" figure. */
export async function fetchInvoicedTotal(): Promise<number> {
  const orgId = await getOrgId();
  if (!orgId) return 0;
  const { data, error } = await supabase
    .from("invoices")
    .select("total_amount")
    .eq("org_id", orgId)
    .neq("status", "draft");
  if (error) { console.error("[received-payments]", error); return 0; }
  return (data ?? []).reduce((s: number, r: any) => s + Number(r.total_amount ?? 0), 0);
}
