// src/lib/received-payments.ts
// There is no dedicated payments table — "received" payments are derived
// from paid/partial invoices (amount_paid, updated_at as the received
// date). Payment method isn't tracked at the invoice level, so it's
// reported as "Other" rather than guessed.
import { supabase } from "@/lib/supabase";
import type { Payment } from "@/lib/mock-data";

async function getOrgId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: p } = await supabase.from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
  if (p?.organization_id) return p.organization_id;
  const { data: m } = await supabase.from("org_memberships").select("org_id").eq("member_id", user.id).maybeSingle();
  return m?.org_id ?? null;
}

export async function fetchReceivedPayments(): Promise<Payment[]> {
  const orgId = await getOrgId();
  if (!orgId) return [];
  const { data, error } = await supabase
    .from("invoices")
    .select(`id, invoice_number, amount_paid, updated_at, contacts!client_id(full_name)`)
    .eq("org_id", orgId)
    .in("status", ["paid", "partial"])
    .gt("amount_paid", 0);
  if (error) { console.error("[received-payments]", error); return []; }
  return (data ?? []).map((r: any) => ({
    id: r.id,
    invoice: r.invoice_number ?? "—",
    client: r.contacts?.full_name ?? "—",
    amount: Number(r.amount_paid ?? 0),
    method: "Other" as const,
    receivedAt: r.updated_at,
    status: "Received" as const,
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
