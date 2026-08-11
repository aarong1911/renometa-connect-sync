// src/lib/vendors.ts — Phase 13.8 read-side helpers for Vendors / Expenses /
// Vendor Bills / A/P Aging. Reads go straight through Supabase (RLS-scoped,
// select-only for expenses/vendor_bills/vendor_bill_lines/vendor_payments —
// see 20260822_expenses_vendors_ap.sql). All financial writes go through the
// trusted Netlify functions (expense-create, vendor-bill-create,
// vendor-bill-post, vendor-bill-record-payment) — never a direct client
// insert.
//
// Phase 13.8D CORRECTION — `vendors` is NOT a table this migration creates.
// It already exists live (like `companies`/`contacts`, its CREATE TABLE was
// never captured in supabase/migrations/) with a CRM-relational shape:
//   id, org_id, company_id (FK -> companies.id, nullable), contact_id
//   (FK -> contacts.id, nullable), vendor_type (default 'subcontractor'),
//   specialties (text[]), license_number, insurance_expiry (date), rating
//   (int), is_active (boolean), notes, custom_fields (jsonb), created_at,
//   updated_at. There is NO vendors.name/status/email/phone/created_by — a
//   vendor's identity/contact info is resolved through its linked
//   companies/contacts row, the same "resolve linked entity via embedded
//   select, fallback to em-dash" pattern src/lib/contacts-store.ts and this
//   file already use for project/account names (see vendorDisplayName
//   below — the one shared resolver every vendor-linked read in this file
//   goes through, so the company-then-contact-then-"Vendor" fallback logic
//   lives in exactly one place).

import { supabase } from "@/lib/supabase";

async function getOrgId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: p } = await supabase.from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
  if (p?.organization_id) return p.organization_id;
  const { data: m } = await supabase.from("org_memberships").select("org_id").eq("member_id", user.id).maybeSingle();
  return m?.org_id ?? null;
}

export { getOrgId as fetchVendorsOrgId };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The one place a vendor's display name is resolved: linked company name first, then linked contact name, then a safe fallback. Never invents identity data — never a vendors.name column, because none exists. */
export function vendorDisplayName(v: { companyName?: string | null; contactName?: string | null } | null | undefined): string {
  if (!v) return "—";
  return v.companyName || v.contactName || "Vendor";
}

// ── Vendors ──────────────────────────────────────────────────────────────

export type Vendor = {
  id: string;
  companyId: string | null;
  companyName: string | null;
  contactId: string | null;
  contactName: string | null;
  vendorType: string;
  specialties: string[] | null;
  licenseNumber: string | null;
  insuranceExpiry: string | null;
  rating: number | null;
  isActive: boolean;
  notes: string | null;
  createdAt: string;
};

/** Returns null (not []) when the table doesn't exist yet, so callers can distinguish "no vendors" from "migration not applied." */
export async function fetchVendors(orgId: string): Promise<Vendor[] | null> {
  const { data, error } = await supabase
    .from("vendors")
    .select("id, company_id, contact_id, vendor_type, specialties, license_number, insurance_expiry, rating, is_active, notes, created_at, companies!company_id(name), contacts!contact_id(full_name)")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });
  if (error) {
    if (error.code !== "42P01") console.error("[vendors]", error);
    return null;
  }
  return (data ?? []).map((r: any) => ({
    id: r.id,
    companyId: r.company_id,
    companyName: r.companies?.name ?? null,
    contactId: r.contact_id,
    contactName: r.contacts?.full_name ?? null,
    vendorType: r.vendor_type ?? "subcontractor",
    specialties: r.specialties ?? null,
    licenseNumber: r.license_number,
    insuranceExpiry: r.insurance_expiry,
    rating: r.rating,
    isActive: r.is_active,
    notes: r.notes,
    createdAt: r.created_at,
  })).sort((a, b) => vendorDisplayName(a).localeCompare(vendorDisplayName(b)));
}

export async function createVendor(orgId: string, input: {
  companyId?: string | null; contactId?: string | null; vendorType?: string;
  specialties?: string[]; licenseNumber?: string; insuranceExpiry?: string; notes?: string;
}): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from("vendors")
    .insert({
      org_id: orgId,
      company_id: input.companyId || null,
      contact_id: input.contactId || null,
      vendor_type: input.vendorType || "subcontractor",
      specialties: input.specialties && input.specialties.length > 0 ? input.specialties : null,
      license_number: input.licenseNumber?.trim() || null,
      insurance_expiry: input.insuranceExpiry || null,
      notes: input.notes?.trim() || null,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { id: data.id };
}

// ── Chart of Accounts (expense/COGS categories only) ────────────────────

export type ExpenseCategoryAccount = { id: string; code: string; name: string; subtype: string; isCogs: boolean };

const COGS_SUBTYPES = new Set(["cost_of_goods_sold", "labor", "subcontractor", "equipment"]);

export async function fetchExpenseCategoryAccounts(orgId: string): Promise<ExpenseCategoryAccount[]> {
  const { data, error } = await supabase
    .from("accounting_accounts")
    .select("id, code, name, account_subtype")
    .eq("org_id", orgId)
    .eq("account_type", "expense")
    .eq("is_active", true)
    .order("code", { ascending: true });
  if (error) { console.error("[vendors]", error); return []; }
  return (data ?? []).map((r: any) => ({ id: r.id, code: r.code, name: r.name, subtype: r.account_subtype, isCogs: COGS_SUBTYPES.has(r.account_subtype) }));
}

// ── Expenses ─────────────────────────────────────────────────────────────

export type Expense = {
  id: string;
  vendorId: string | null;
  vendorName: string;
  projectId: string | null;
  projectName: string;
  expenseDate: string;
  description: string;
  amount: number;
  paymentMethod: string | null;
  accountId: string;
  accountName: string;
  isCogs: boolean;
  status: "draft" | "posted" | "cancelled";
  reference: string | null;
  createdAt: string;
};

export async function fetchExpenses(orgId: string): Promise<Expense[] | null> {
  const { data, error } = await supabase
    .from("expenses")
    .select("id, vendor_id, project_id, expense_date, description, amount, payment_method, account_id, status, reference, created_at, vendors!vendor_id(companies!company_id(name), contacts!contact_id(full_name)), projects!project_id(name), accounting_accounts!account_id(name, account_subtype)")
    .eq("org_id", orgId)
    .order("expense_date", { ascending: false });
  if (error) {
    if (error.code !== "42P01") console.error("[vendors]", error);
    return null;
  }
  return (data ?? []).map((r: any) => ({
    id: r.id,
    vendorId: r.vendor_id,
    vendorName: vendorDisplayName({ companyName: r.vendors?.companies?.name, contactName: r.vendors?.contacts?.full_name }),
    projectId: r.project_id,
    projectName: r.projects?.name ?? "—",
    expenseDate: r.expense_date,
    description: r.description,
    amount: Number(r.amount ?? 0),
    paymentMethod: r.payment_method,
    accountId: r.account_id,
    accountName: r.accounting_accounts?.name ?? "—",
    isCogs: COGS_SUBTYPES.has(r.accounting_accounts?.account_subtype),
    status: r.status,
    reference: r.reference,
    createdAt: r.created_at,
  }));
}

// ── Vendor Bills ─────────────────────────────────────────────────────────

export type VendorBillLine = { id: string; description: string; quantity: number; unitCost: number; amount: number; accountId: string; accountName: string; projectId: string | null };

export type VendorBill = {
  id: string;
  vendorId: string;
  vendorName: string;
  projectId: string | null;
  projectName: string;
  billNumber: string | null;
  billDate: string;
  dueDate: string | null;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  amountPaid: number;
  status: "draft" | "open" | "partial" | "paid" | "overdue" | "cancelled";
  reference: string | null;
  notes: string | null;
  createdAt: string;
};

export async function fetchVendorBills(orgId: string): Promise<VendorBill[] | null> {
  const { data, error } = await supabase
    .from("vendor_bills")
    .select("id, vendor_id, project_id, bill_number, bill_date, due_date, subtotal, tax_amount, total_amount, amount_paid, status, reference, notes, created_at, vendors!vendor_id(companies!company_id(name), contacts!contact_id(full_name)), projects!project_id(name)")
    .eq("org_id", orgId)
    .order("bill_date", { ascending: false });
  if (error) {
    if (error.code !== "42P01") console.error("[vendors]", error);
    return null;
  }
  const now = new Date();
  return (data ?? []).map((r: any) => {
    const isOverdue = (r.status === "open" || r.status === "partial") && r.due_date && new Date(r.due_date) < now;
    return {
      id: r.id, vendorId: r.vendor_id,
      vendorName: vendorDisplayName({ companyName: r.vendors?.companies?.name, contactName: r.vendors?.contacts?.full_name }),
      projectId: r.project_id, projectName: r.projects?.name ?? "—",
      billNumber: r.bill_number, billDate: r.bill_date, dueDate: r.due_date,
      subtotal: Number(r.subtotal ?? 0), taxAmount: Number(r.tax_amount ?? 0),
      totalAmount: Number(r.total_amount ?? 0), amountPaid: Number(r.amount_paid ?? 0),
      status: isOverdue ? "overdue" : r.status,
      reference: r.reference, notes: r.notes, createdAt: r.created_at,
    };
  });
}

export async function fetchVendorBillLines(billId: string): Promise<VendorBillLine[]> {
  const { data, error } = await supabase
    .from("vendor_bill_lines")
    .select("id, description, quantity, unit_cost, amount, account_id, project_id, accounting_accounts!account_id(name)")
    .eq("vendor_bill_id", billId)
    .order("created_at", { ascending: true });
  if (error) { console.error("[vendors]", error); return []; }
  return (data ?? []).map((r: any) => ({
    id: r.id, description: r.description, quantity: Number(r.quantity ?? 1), unitCost: Number(r.unit_cost ?? 0),
    amount: Number(r.amount ?? 0), accountId: r.account_id, accountName: r.accounting_accounts?.name ?? "—", projectId: r.project_id,
  }));
}

export type VendorPayment = {
  id: string; amount: number; status: string; paymentMethod: string; paidAt: string; reference: string | null;
};

export async function fetchVendorPaymentsForBill(billId: string): Promise<VendorPayment[]> {
  const { data, error } = await supabase
    .from("vendor_payments")
    .select("id, amount, status, payment_method, paid_at, reference")
    .eq("vendor_bill_id", billId)
    .order("paid_at", { ascending: false });
  if (error) { console.error("[vendors]", error); return []; }
  return (data ?? []).map((r: any) => ({ id: r.id, amount: Number(r.amount ?? 0), status: r.status, paymentMethod: r.payment_method, paidAt: r.paid_at, reference: r.reference }));
}

// ── A/P Aging (Part 12) ──────────────────────────────────────────────────
//
// Only open/partial bills (draft/paid/cancelled excluded). Bucketed by
// due_date, same day-boundary logic as the existing A/R aging in
// financials.tsx. A null due_date bucket into "Current" — there is no way
// to judge lateness without a due date, and treating it as always-overdue
// would be a false signal.

export type ApAgingBuckets = { current: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number };

export function computeApAging(bills: VendorBill[], now: Date = new Date()): ApAgingBuckets {
  const buckets: ApAgingBuckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  for (const bill of bills) {
    if (bill.status !== "open" && bill.status !== "partial" && bill.status !== "overdue") continue;
    const balance = round2(bill.totalAmount - bill.amountPaid);
    if (balance <= 0) continue;
    if (!bill.dueDate) { buckets.current += balance; continue; }
    const daysOverdue = Math.floor((now.getTime() - new Date(bill.dueDate).getTime()) / 86_400_000);
    if (daysOverdue <= 0) buckets.current += balance;
    else if (daysOverdue <= 30) buckets.d1_30 += balance;
    else if (daysOverdue <= 60) buckets.d31_60 += balance;
    else if (daysOverdue <= 90) buckets.d61_90 += balance;
    else buckets.d90_plus += balance;
  }
  (Object.keys(buckets) as (keyof ApAgingBuckets)[]).forEach((k) => { buckets[k] = round2(buckets[k]); });
  return buckets;
}

export type ExpenseKpis = {
  expensesThisMonth: number;
  directProjectCosts: number;
  operatingExpenses: number;
  openBillsCount: number;
  openBillsAmount: number;
  overdueBillsAmount: number;
  totalPayable: number;
};

export function computeExpenseKpis(expenses: Expense[], bills: VendorBill[], now: Date = new Date()): ExpenseKpis {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const postedThisMonth = expenses.filter((e) => e.status === "posted" && new Date(e.expenseDate) >= monthStart);
  const expensesThisMonth = round2(postedThisMonth.reduce((s, e) => s + e.amount, 0));
  const directProjectCosts = round2(postedThisMonth.filter((e) => e.isCogs && e.projectId).reduce((s, e) => s + e.amount, 0));
  const operatingExpenses = round2(postedThisMonth.filter((e) => !e.isCogs || !e.projectId).reduce((s, e) => s + e.amount, 0));

  const openBills = bills.filter((b) => b.status === "open" || b.status === "partial" || b.status === "overdue");
  const openBillsAmount = round2(openBills.reduce((s, b) => s + (b.totalAmount - b.amountPaid), 0));
  const overdueBillsAmount = round2(bills.filter((b) => b.status === "overdue").reduce((s, b) => s + (b.totalAmount - b.amountPaid), 0));

  return {
    expensesThisMonth, directProjectCosts, operatingExpenses,
    openBillsCount: openBills.length, openBillsAmount, overdueBillsAmount,
    totalPayable: openBillsAmount,
  };
}
