// src/lib/financials.ts
//
// Phase 13.4 — Company-wide financial source-of-truth helpers for the main
// /financials dashboard. There is no dedicated payments table (see
// received-payments.ts) — invoices.amount_paid is the only ledger of cash
// actually collected, and invoices.status is the only lifecycle signal.
// These helpers exist so the definitions below are computed exactly once
// instead of re-derived (and potentially drifting) in every page that
// needs them:
//
//   Issued        = any invoice whose status is not "draft". A draft is a
//                   working document, not yet a receivable.
//   Invoiced      = sum(total_amount) over Issued invoices.
//   Collected     = sum(amount_paid) over Issued invoices (drafts never
//                   carry a payment).
//   Outstanding   = sum(total_amount - amount_paid - creditsTotal) over
//                   Issued invoices with a balance > 0 (Phase 13.10A — a
//                   posted customer credit memo reduces this exactly like a
//                   payment does; ignoring credits would OVERSTATE A/R).
//                   Never includes drafts.
//   Overdue       = the subset of Outstanding whose due_date has passed,
//                   isn't already "paid", and still has a positive
//                   effective balance (a fully-credited invoice is never
//                   overdue even if its raw status hasn't caught up). A
//                   draft is never overdue, regardless of its due_date.
//   Open/Current  = Outstanding minus Overdue (mutually exclusive with it).
//
// Contracted Revenue reuses the exact Project → Financials contract
// baseline (approved linked Estimate's client_total ?? total, else
// projects.budget_total — see projects.index.tsx) plus the same approved
// Change Order ledger (project_financial_adjustments, source_type=
// 'change_order', status='applied', reversed_at is null) that
// fetchApprovedChangeOrderTotalsByProject() already exposes — no second
// contract calculation is introduced here.

import { supabase } from "@/lib/supabase";
import { fetchApprovedChangeOrderTotalsByProject } from "@/lib/project-change-orders";
import { isIssuedInvoice, isInvoiceOverdue as isInvoiceOverdueStatus, getInvoiceBalance } from "@/lib/invoice-status";
import { fetchPostedCustomerCreditTotals } from "@/lib/customer-credits";
import { dateOnlyToLocalDate } from "@/lib/format";

// issue_date and a ledger payment's paid_at are DATE-ONLY business values
// (see src/lib/format.ts's dateOnlyToLocalDate) — bucketing/comparing them
// as raw timestamps against LOCAL bucket boundaries (new Date(year, month,
// day), below) shifted a payment/invoice into the wrong day or even the
// wrong month near a boundary in any negative-UTC-offset timezone, because
// a date-only value stored/rendered as UTC midnight is already the
// *previous* local day for part of the day. Falls back to the real
// timestamp (createdAt/updatedAt) when there's no date-only value to read,
// since those genuinely are instants and should keep varying with them.
function businessDateOrTimestamp(dateOnly: string | null, timestamp: string): Date {
  return dateOnlyToLocalDate(dateOnly) ?? new Date(timestamp);
}

async function getOrgId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: p } = await supabase.from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
  if (p?.organization_id) return p.organization_id;
  const { data: m } = await supabase.from("org_memberships").select("org_id").eq("member_id", user.id).maybeSingle();
  return m?.org_id ?? null;
}

export type FinancialInvoice = {
  id: string;
  invoiceNumber: string;
  status: string;
  issueDate: string | null;
  dueDate: string | null;
  totalAmount: number;
  amountPaid: number;
  /** Sum of posted customer credit memos against this invoice — Phase 13.10A. Never folded into amountPaid (credits are not payments). */
  creditsTotal: number;
  createdAt: string;
  updatedAt: string;
  clientId: string | null;
  clientName: string;
  clientAvatarKey: string | null;
  projectId: string | null;
  projectName: string;
};

export async function fetchFinancialInvoices(orgId: string): Promise<FinancialInvoice[]> {
  const [{ data, error }, creditTotals] = await Promise.all([
    supabase
      .from("invoices")
      .select("id, invoice_number, status, issue_date, due_date, total_amount, amount_paid, created_at, updated_at, client_id, project_id, contacts!client_id(full_name,avatar_key), projects!project_id(name)")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false }),
    fetchPostedCustomerCreditTotals(orgId),
  ]);
  if (error) { console.error("[financials]", error); return []; }
  return (data ?? []).map((r: any) => ({
    id: r.id,
    invoiceNumber: r.invoice_number,
    status: r.status,
    issueDate: r.issue_date,
    dueDate: r.due_date,
    totalAmount: Number(r.total_amount ?? 0),
    amountPaid: Number(r.amount_paid ?? 0),
    creditsTotal: creditTotals.get(r.id) ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? r.created_at,
    clientId: r.client_id,
    clientName: r.contacts?.full_name ?? "—",
    clientAvatarKey: r.contacts?.avatar_key ?? null,
    projectId: r.project_id,
    projectName: r.projects?.name ?? "—",
  }));
}

// Status/lifecycle primitives are canonically owned by src/lib/invoice-
// status.ts (Phase 13.4 follow-up — see its header for why); these are
// thin FinancialInvoice-shaped wrappers so call sites here don't change.

/** A draft is a working document, not yet a receivable. */
export function isIssued(inv: Pick<FinancialInvoice, "status">): boolean {
  return isIssuedInvoice(inv.status);
}

/**
 * Never true for a draft/paid, regardless of due_date — and never true once
 * the effective balance (total - paid - posted credits) hits zero, even if
 * the raw stored status hasn't caught up (Phase 13.10A, Part 19).
 */
export function isInvoiceOverdue(inv: Pick<FinancialInvoice, "status" | "dueDate" | "totalAmount" | "amountPaid" | "creditsTotal">, now: Date = new Date()): boolean {
  return isInvoiceOverdueStatus(inv.status, inv.dueDate, now, invoiceBalance(inv));
}

/** Canonical effective balance: total - paid - posted credits, floored at 0. */
export function invoiceBalance(inv: Pick<FinancialInvoice, "totalAmount" | "amountPaid" | "creditsTotal">): number {
  return getInvoiceBalance(inv.totalAmount, inv.amountPaid, inv.creditsTotal ?? 0);
}

// ── Payment ledger (optional — falls back gracefully) ───────────────────
//
// invoice_payments (supabase/migrations/20260818_invoice_payments_ledger.sql)
// is the canonical "collected" source once applied: real paid_at dates
// instead of approximating from invoices.updated_at. That migration is
// additive and NOT auto-applied, so every read here degrades gracefully —
// a missing-relation error (Postgres 42P01) is treated as "ledger not
// deployed in this environment yet," not a hard failure, and callers fall
// back to the amount_paid/updated_at approximation exactly as before.

export type InvoicePaymentRecord = {
  id: string;
  invoiceId: string;
  amount: number;
  status: "pending" | "succeeded" | "failed" | "refunded" | "voided";
  paidAt: string;
  /**
   * 'reversal' for an append-only manual-payment reversal row (status stays
   * 'succeeded' — see accounting-integrity skill), or 'refund' for a
   * synthetic event representing a SUCCEEDED Stripe refund (Phase 13.11 —
   * not a real invoice_payments row at all; see fetchInvoicePayments()).
   * Never treat either as an ordinary positive receipt — see
   * isNegativeLedgerEvent().
   */
  source: string;
};

/** True for an append-only reversal row (source='reversal') or a succeeded Stripe refund (source='refund') — both always net NEGATIVE against any Collected/Received total, regardless of status='succeeded'. */
export function isNegativeLedgerEvent(p: Pick<InvoicePaymentRecord, "source">): boolean {
  return p.source === "reversal" || p.source === "refund";
}

/**
 * Returns null (not []) when the ledger table doesn't exist yet, so callers
 * can distinguish "no payments" from "no ledger."
 *
 * Phase 13.11 — also merges in one synthetic InvoicePaymentRecord per
 * SUCCEEDED row in invoice_payment_refunds (source='refund', status=
 * 'succeeded', amount = the refunded amount, paidAt = when the refund
 * actually succeeded). These are not real invoice_payments rows — a Stripe
 * refund lives in its own table (see the Phase 13.11 migration's data-model
 * rationale) — but every caller in this file already knows how to net a
 * negative-source ledger event into Collected/Received totals via
 * isNegativeLedgerEvent(), so folding refunds in here (rather than
 * threading a second parameter through every metrics function) keeps that
 * logic in exactly one place.
 */
export async function fetchInvoicePayments(orgId: string): Promise<InvoicePaymentRecord[] | null> {
  const [paymentsRes, refundsRes] = await Promise.all([
    supabase
      .from("invoice_payments")
      .select("id, invoice_id, amount, status, paid_at, source")
      .eq("org_id", orgId)
      .order("paid_at", { ascending: false }),
    supabase
      .from("invoice_payment_refunds")
      .select("id, invoice_id, amount, status, succeeded_at, requested_at")
      .eq("org_id", orgId)
      .eq("status", "succeeded"),
  ]);
  if (paymentsRes.error) {
    if (paymentsRes.error.code !== "42P01") console.error("[financials]", paymentsRes.error);
    return null;
  }
  const records: InvoicePaymentRecord[] = (paymentsRes.data ?? []).map((r: any) => ({
    id: r.id, invoiceId: r.invoice_id, amount: Number(r.amount ?? 0), status: r.status, paidAt: r.paid_at, source: r.source ?? "manual",
  }));
  // 42P01 here just means invoice_payment_refunds isn't deployed yet in
  // this environment — degrade to "no refunds," same fallback posture as
  // the payments query above, never a hard failure.
  if (!refundsRes.error) {
    for (const r of (refundsRes.data ?? []) as any[]) {
      records.push({
        id: r.id, invoiceId: r.invoice_id, amount: Number(r.amount ?? 0), status: "succeeded",
        paidAt: r.succeeded_at ?? r.requested_at, source: "refund",
      });
    }
  }
  return records;
}

export type InvoiceMetrics = {
  /** Outstanding = Open + Overdue, issued invoices only. */
  outstandingAmount: number;
  outstandingCount: number;
  overdueAmount: number;
  overdueCount: number;
  /** Non-overdue outstanding balance — mutually exclusive with overdueAmount. */
  openAmount: number;
  openCount: number;
  /** Cash actually collected (amount_paid) across all issued invoices, all-time. Never includes credits — credits are not payments. */
  paidAmount: number;
  /** Sum of posted customer credit memos across all issued invoices, all-time — informational only, already netted out of outstandingAmount/overdueAmount/openAmount. */
  creditsIssuedAmount: number;
  collectedThisMonth: number;
  collectedThisMonthCount: number;
  invoicedYTD: number;
  /** sum(total_amount) over issued invoices — "Invoiced", not "Revenue". */
  totalIssuedInvoiced: number;
  totalInvoices: number;
  avgInvoice: number;
  /** Collected / Invoiced, guarded against divide-by-zero. */
  collectionRate: number;
};

export function computeInvoiceMetrics(invoices: FinancialInvoice[], now: Date = new Date(), payments: InvoicePaymentRecord[] | null = null): InvoiceMetrics {
  const issued = invoices.filter(isIssued);
  const overdue = issued.filter((i) => isInvoiceOverdue(i, now));
  const overdueIds = new Set(overdue.map((i) => i.id));
  const open = issued.filter((i) => !overdueIds.has(i.id) && invoiceBalance(i) > 0);

  const overdueAmount = round2(overdue.reduce((s, i) => s + invoiceBalance(i), 0));
  const openAmount = round2(open.reduce((s, i) => s + invoiceBalance(i), 0));
  const paidAmount = round2(issued.reduce((s, i) => s + i.amountPaid, 0));
  const creditsIssuedAmount = round2(issued.reduce((s, i) => s + (i.creditsTotal ?? 0), 0));
  const totalIssuedInvoiced = round2(issued.reduce((s, i) => s + i.totalAmount, 0));

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  let collectedThisMonth: number;
  let collectedThisMonthCount: number;
  if (payments) {
    // Payment ledger deployed — real paid_at dates, no approximation.
    // paid_at is a DATE-ONLY business date here (see businessDateOrTimestamp).
    // A reversal row also has status='succeeded' (append-only model — see
    // accounting-integrity skill), so it must be excluded from `succeeded`
    // and netted separately, or a reversed payment would double-count as a
    // positive receipt instead of netting to zero.
    const succeeded = payments.filter((p) => p.status === "succeeded" && !isNegativeLedgerEvent(p) && (dateOnlyToLocalDate(p.paidAt) ?? new Date(p.paidAt)) >= monthStart);
    const negatives = payments.filter((p) => p.status === "succeeded" && isNegativeLedgerEvent(p) && (dateOnlyToLocalDate(p.paidAt) ?? new Date(p.paidAt)) >= monthStart);
    const refunded = payments.filter((p) => p.status === "refunded" && (dateOnlyToLocalDate(p.paidAt) ?? new Date(p.paidAt)) >= monthStart);
    collectedThisMonth = round2(succeeded.reduce((s, p) => s + p.amount, 0) - negatives.reduce((s, p) => s + p.amount, 0) - refunded.reduce((s, p) => s + p.amount, 0));
    collectedThisMonthCount = succeeded.length;
  } else {
    // No ledger yet — amount_paid is a running balance, so "collected this
    // month" is approximated from invoices whose balance moved (amount_paid
    // > 0) and whose row was last updated this month. Same approximation
    // received-payments.ts already uses for "received date." Not exact for
    // invoices paid across a month boundary in multiple installments, but
    // never fabricated.
    const collectedThisMonthInvoices = issued.filter((i) => i.amountPaid > 0 && new Date(i.updatedAt) >= monthStart);
    collectedThisMonth = round2(collectedThisMonthInvoices.reduce((s, i) => s + i.amountPaid, 0));
    collectedThisMonthCount = collectedThisMonthInvoices.length;
  }

  const yearStart = new Date(now.getFullYear(), 0, 1);
  const invoicedYTD = round2(
    issued.filter((i) => businessDateOrTimestamp(i.issueDate, i.createdAt) >= yearStart).reduce((s, i) => s + i.totalAmount, 0),
  );

  return {
    outstandingAmount: round2(overdueAmount + openAmount),
    outstandingCount: overdue.length + open.length,
    overdueAmount,
    overdueCount: overdue.length,
    openAmount,
    openCount: open.length,
    paidAmount,
    creditsIssuedAmount,
    collectedThisMonth,
    collectedThisMonthCount,
    invoicedYTD,
    totalIssuedInvoiced,
    totalInvoices: issued.length,
    avgInvoice: issued.length > 0 ? round2(totalIssuedInvoiced / issued.length) : 0,
    collectionRate: totalIssuedInvoiced > 0 ? paidAmount / totalIssuedInvoiced : 0,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Invoiced vs Collected trend ─────────────────────────────────────────

export type TrendRange = "30d" | "90d" | "12m";
export type TrendPoint = { label: string; invoiced: number; collected: number };

/**
 * Real-data buckets only — no synthetic/fake points. 30d buckets by day,
 * 90d by week, 12m by calendar month, all derived from actual dates.
 * "Collected" per bucket uses real payment_ledger paid_at dates when the
 * ledger is deployed (payments != null); otherwise falls back to the same
 * amount_paid/updated_at running-balance approximation
 * computeInvoiceMetrics uses when no ledger is available.
 */
export function computeInvoicedVsCollectedTrend(invoices: FinancialInvoice[], range: TrendRange, now: Date = new Date(), payments: InvoicePaymentRecord[] | null = null): TrendPoint[] {
  const issued = invoices.filter(isIssued);
  const buckets = buildBuckets(range, now);

  for (const inv of issued) {
    const issuedAt = businessDateOrTimestamp(inv.issueDate, inv.createdAt);
    const bucket = buckets.find((b) => issuedAt >= b.start && issuedAt < b.end);
    if (bucket) bucket.invoiced += inv.totalAmount;
  }

  if (payments) {
    for (const p of payments) {
      if (p.status !== "succeeded" && p.status !== "refunded") continue;
      const paidAt = dateOnlyToLocalDate(p.paidAt) ?? new Date(p.paidAt);
      const bucket = buckets.find((b) => paidAt >= b.start && paidAt < b.end);
      // A reversal row is status='succeeded' too (append-only model), and a
      // succeeded refund is folded in as a synthetic status='succeeded'
      // source='refund' event (see fetchInvoicePayments()) — both must net
      // negative here, same as a 'refunded' row, or double-count as a
      // positive "Collected" data point.
      if (bucket) bucket.collected += (p.status === "refunded" || isNegativeLedgerEvent(p)) ? -p.amount : p.amount;
    }
  } else {
    for (const inv of issued) {
      if (inv.amountPaid <= 0) continue;
      const updatedAt = new Date(inv.updatedAt);
      const paidBucket = buckets.find((b) => updatedAt >= b.start && updatedAt < b.end);
      if (paidBucket) paidBucket.collected += inv.amountPaid;
    }
  }

  return buckets.map((b) => ({ label: b.label, invoiced: round2(b.invoiced), collected: round2(b.collected) }));
}

type Bucket = { start: Date; end: Date; label: string; invoiced: number; collected: number };

function buildBuckets(range: TrendRange, now: Date): Bucket[] {
  const buckets: Bucket[] = [];
  if (range === "12m") {
    for (let i = 11; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      buckets.push({ start, end, label: start.toLocaleDateString("en-US", { month: "short" }), invoiced: 0, collected: 0 });
    }
  } else if (range === "90d") {
    const dayMs = 86_400_000;
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    for (let i = 12; i >= 0; i--) {
      const end = new Date(todayEnd.getTime() - i * 7 * dayMs);
      const start = new Date(end.getTime() - 7 * dayMs);
      buckets.push({ start, end, label: start.toLocaleDateString("en-US", { month: "short", day: "numeric" }), invoiced: 0, collected: 0 });
    }
  } else {
    const dayMs = 86_400_000;
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    for (let i = 29; i >= 0; i--) {
      const end = new Date(todayEnd.getTime() - i * dayMs);
      const start = new Date(end.getTime() - dayMs);
      buckets.push({ start, end, label: start.toLocaleDateString("en-US", { month: "short", day: "numeric" }), invoiced: 0, collected: 0 });
    }
  }
  return buckets;
}

// ── Contracted Revenue (company-wide) ───────────────────────────────────
//
// Same "active" grouping the Projects board's own pipeline-value KPI uses
// (ACTIVE_STATUSES in projects.index.tsx: every status except on-hold/
// cancelled). Deliberately NOT projects.budget_total alone — that column
// is historically overloaded (see CLAUDE.md) — the same approved-Estimate-
// or-budget_total baseline, plus the same approved Change Order ledger,
// that Project → Financials already uses per Project.

const ACTIVE_PROJECT_STATUSES = ["planning", "contracted", "pre-construction", "active", "punch-list", "completed"];

export type ContractedRevenueSummary = {
  contractedRevenue: number;
  activeProjectCount: number;
};

export async function fetchContractedRevenue(orgId: string): Promise<ContractedRevenueSummary> {
  const { data: projectRows, error } = await supabase
    .from("projects")
    .select("id, budget_total, estimate_id, status")
    .eq("org_id", orgId)
    .in("status", ACTIVE_PROJECT_STATUSES);
  if (error) { console.error("[financials]", error); return { contractedRevenue: 0, activeProjectCount: 0 }; }

  const projects = projectRows ?? [];
  const estimateIds = Array.from(new Set(projects.map((p: any) => p.estimate_id).filter((id: unknown): id is string => !!id)));

  const [estimateAmounts, approvedCOTotals] = await Promise.all([
    estimateIds.length > 0
      ? supabase.from("estimates").select("id, total, client_total").in("id", estimateIds).then(({ data }) => {
          const m = new Map<string, number>();
          for (const row of data ?? []) m.set(row.id, Number(row.client_total ?? row.total ?? 0));
          return m;
        })
      : Promise.resolve(new Map<string, number>()),
    fetchApprovedChangeOrderTotalsByProject(),
  ]);

  let contractedRevenue = 0;
  for (const p of projects as any[]) {
    const baseline = p.estimate_id && estimateAmounts.has(p.estimate_id) ? estimateAmounts.get(p.estimate_id)! : Number(p.budget_total ?? 0);
    contractedRevenue += baseline + (approvedCOTotals.get(p.id) ?? 0);
  }

  return { contractedRevenue: round2(contractedRevenue), activeProjectCount: projects.length };
}

export { getOrgId as fetchFinancialsOrgId };
