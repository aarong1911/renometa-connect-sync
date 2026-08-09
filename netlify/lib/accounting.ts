// netlify/lib/accounting.ts
//
// Phase 13.5 — Central server-side Accounting Posting Service. React never
// writes journal entries directly (no client insert/update/delete grant
// exists on any accounting_* table — see supabase/migrations/
// 20260820_accounting_foundation.sql). Every posting goes through this
// module's functions, which call the post_journal_entry() SECURITY DEFINER
// RPC (service_role-only) — that RPC is the single transactional boundary
// that guarantees a posted entry is balanced, idempotent, and immutable.
//
// IMPORTANT — not wired into any live event handler yet (Phase 13.5 Part
// 41): invoice-send.ts and invoice-record-payment.ts do NOT call these
// functions. This module exists so the posting rules are implemented and
// reviewable, and so a future phase can call postInvoiceIssued/
// postInvoicePaymentSucceeded from the real event handlers once the
// migration is applied, default accounts are seeded, and a backfill
// strategy is explicitly approved (accounting_settings.status advances
// past 'not_initialized').

import type { SupabaseClient } from "@supabase/supabase-js";

const AR_CODE = "1100";
const UNDEPOSITED_FUNDS_CODE = "1020";
const CONSTRUCTION_REVENUE_CODE = "4000";
const CHANGE_ORDER_REVENUE_CODE = "4100";
const ACCOUNTS_PAYABLE_CODE = "2000";

export type SystemAccountIds = {
  accountsReceivable: string;
  undepositedFunds: string;
  constructionRevenue: string;
  changeOrderRevenue: string;
  accountsPayable: string;
};

/** Resolves this org's system accounts by their well-known Chart of Accounts code. Throws (not silently falls back) if a required system account is missing — posting must never silently pick the wrong account. */
export async function resolveSystemAccounts(admin: SupabaseClient, orgId: string): Promise<SystemAccountIds> {
  const { data, error } = await admin
    .from("accounting_accounts")
    .select("id, code")
    .eq("org_id", orgId)
    .in("code", [AR_CODE, UNDEPOSITED_FUNDS_CODE, CONSTRUCTION_REVENUE_CODE, CHANGE_ORDER_REVENUE_CODE, ACCOUNTS_PAYABLE_CODE]);
  if (error) throw new Error(`Could not load system accounts: ${error.message}`);

  const byCode = new Map((data ?? []).map((r: any) => [r.code, r.id as string]));
  const require = (code: string, label: string): string => {
    const id = byCode.get(code);
    if (!id) throw new Error(`Org ${orgId} is missing required system account ${code} (${label}) — run seed_default_chart_of_accounts() first.`);
    return id;
  };

  return {
    accountsReceivable: require(AR_CODE, "Accounts Receivable"),
    undepositedFunds: require(UNDEPOSITED_FUNDS_CODE, "Undeposited Funds"),
    constructionRevenue: require(CONSTRUCTION_REVENUE_CODE, "Construction Revenue"),
    changeOrderRevenue: require(CHANGE_ORDER_REVENUE_CODE, "Change Order Revenue"),
    accountsPayable: require(ACCOUNTS_PAYABLE_CODE, "Accounts Payable"),
  };
}

export type PostJournalEntryInput = {
  orgId: string;
  entryDate: string; // YYYY-MM-DD
  description: string;
  sourceType: "invoice" | "invoice_payment" | "expense" | "vendor_bill" | "vendor_payment" | "change_order" | "manual" | "refund" | "credit_memo" | "opening_balance";
  sourceId: string | null;
  postingKey: string;
  lines: Array<{ accountId: string; debit?: number; credit?: number; description?: string; projectId?: string | null; contactId?: string | null }>;
  projectId?: string | null;
  contactId?: string | null;
  createdBy?: string | null;
};

export type PostJournalEntryResult = { entryId: string; entryNumber: string; alreadyPosted: boolean };

/** Thin wrapper over the post_journal_entry() RPC — the RPC itself is the transactional/idempotent/balance-checked boundary; this function only shapes the call. */
export async function postJournalEntry(admin: SupabaseClient, input: PostJournalEntryInput): Promise<PostJournalEntryResult> {
  const { data, error } = await admin.rpc("post_journal_entry", {
    p_org_id: input.orgId,
    p_entry_date: input.entryDate,
    p_description: input.description,
    p_source_type: input.sourceType,
    p_source_id: input.sourceId,
    p_posting_key: input.postingKey,
    p_lines: input.lines.map((l) => ({
      account_id: l.accountId, debit: l.debit ?? 0, credit: l.credit ?? 0,
      description: l.description ?? null, project_id: l.projectId ?? null, contact_id: l.contactId ?? null,
    })),
    p_project_id: input.projectId ?? null,
    p_contact_id: input.contactId ?? null,
    p_created_by: input.createdBy ?? null,
  });
  if (error) throw new Error(`post_journal_entry failed: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return { entryId: row.entry_id, entryNumber: row.entry_number, alreadyPosted: row.already_posted };
}

export type InvoiceForPosting = {
  id: string; invoiceNumber: string; totalAmount: number; issueDate: string;
  projectId: string | null; clientId: string | null;
};

/**
 * Part 12 — Dr Accounts Receivable / Cr Construction Revenue for the
 * invoice's full total. Never call for a draft invoice (callers must only
 * invoke this once an invoice is genuinely issued — this function does not
 * re-check status itself, since "issued" is a business decision the caller
 * already made). Idempotent via post_journal_entry's (org, source_type,
 * source_id, posting_key) uniqueness — safe to call more than once for the
 * same invoice.
 *
 * Revenue account is currently always Construction Revenue (4000) —
 * Part 12 explicitly flags that real invoices can represent deposits,
 * progress billing, change-order work, taxes, or discounts that should
 * eventually post to different revenue accounts per line item. This
 * foundation posts the invoice total as a single line so that per-line
 * revenue categorization can be layered on later without changing the
 * entry shape (see Phase 13.5 report's "assumptions" section).
 */
export async function postInvoiceIssued(admin: SupabaseClient, orgId: string, invoice: InvoiceForPosting, createdBy: string | null): Promise<PostJournalEntryResult> {
  const accounts = await resolveSystemAccounts(admin, orgId);
  return postJournalEntry(admin, {
    orgId,
    entryDate: invoice.issueDate,
    description: `Invoice ${invoice.invoiceNumber} issued`,
    sourceType: "invoice",
    sourceId: invoice.id,
    postingKey: "issued",
    projectId: invoice.projectId,
    contactId: invoice.clientId,
    createdBy,
    lines: [
      { accountId: accounts.accountsReceivable, debit: invoice.totalAmount, projectId: invoice.projectId, contactId: invoice.clientId, description: `A/R — Invoice ${invoice.invoiceNumber}` },
      { accountId: accounts.constructionRevenue, credit: invoice.totalAmount, projectId: invoice.projectId, contactId: invoice.clientId, description: `Revenue — Invoice ${invoice.invoiceNumber}` },
    ],
  });
}

export type PaymentForPosting = {
  id: string; amount: number; paidAt: string;
  invoiceNumber: string; projectId: string | null; contactId: string | null;
};

/**
 * Part 13/14 — Dr Undeposited Funds / Cr Accounts Receivable for the
 * payment amount actually received (never the full invoice total — partial
 * payments post exactly their own amount, and the remaining A/R balance
 * simply falls out of the ledger arithmetic with no special-casing for
 * "partial" status). Never touches Revenue — the revenue recognition
 * already happened at invoice-issued time; crediting revenue again here
 * would double-count it.
 */
export async function postInvoicePaymentSucceeded(admin: SupabaseClient, orgId: string, payment: PaymentForPosting, createdBy: string | null): Promise<PostJournalEntryResult> {
  const accounts = await resolveSystemAccounts(admin, orgId);
  return postJournalEntry(admin, {
    orgId,
    entryDate: payment.paidAt,
    description: `Payment received — Invoice ${payment.invoiceNumber}`,
    sourceType: "invoice_payment",
    sourceId: payment.id,
    postingKey: "succeeded",
    projectId: payment.projectId,
    contactId: payment.contactId,
    createdBy,
    lines: [
      { accountId: accounts.undepositedFunds, debit: payment.amount, projectId: payment.projectId, contactId: payment.contactId, description: `Payment — Invoice ${payment.invoiceNumber}` },
      { accountId: accounts.accountsReceivable, credit: payment.amount, projectId: payment.projectId, contactId: payment.contactId, description: `A/R paid down — Invoice ${payment.invoiceNumber}` },
    ],
  });
}

/**
 * Phase 13.5B Part 20 — new-organization accounting initialization.
 *
 * Audit finding: `createOrganization()` (src/lib/auth.ts) does a plain
 * client-side `supabase.from("organizations").insert(...)` from the
 * onboarding flow (src/routes/onboarding.tsx) — there is no server-side
 * hook on org creation today. seed_default_chart_of_accounts() is
 * service_role-only by design (Part 3 — it must never be callable by an
 * authenticated browser with an arbitrary org id), so it cannot be called
 * directly from that client-side insert.
 *
 * This function is the safe backend helper: call it with the org id
 * resolved server-side (from the caller's own authenticated identity, the
 * same trusted pattern invoice-record-payment.ts already uses — never
 * trust a client-supplied org id), and it upserts accounting_settings +
 * seeds the default Chart of Accounts for that org via the service-role
 * RPC. It is idempotent (accounting_settings upsert + seed's own ON
 * CONFLICT DO NOTHING) — safe to call more than once.
 *
 * NOT YET WIRED UP: nothing calls this after createOrganization() succeeds
 * today. That is the precise remaining integration point — either call
 * this from a new trusted Netlify function invoked right after onboarding
 * completes, or move org creation itself server-side. Deliberately not
 * done in this hardening pass (it's a product-behavior change to the
 * onboarding flow, out of scope for "harden the un-applied migration").
 */
export async function ensureAccountingInitialized(admin: SupabaseClient, orgId: string): Promise<void> {
  const { error: settingsError } = await admin
    .from("accounting_settings")
    .upsert({ org_id: orgId, status: "not_initialized" }, { onConflict: "org_id", ignoreDuplicates: true });
  if (settingsError) throw new Error(`Could not create accounting_settings for org ${orgId}: ${settingsError.message}`);

  const { error: seedError } = await admin.rpc("seed_default_chart_of_accounts", { p_org_id: orgId });
  if (seedError) throw new Error(`Could not seed Chart of Accounts for org ${orgId}: ${seedError.message}`);
}

// ── Phase 13.6 — server-side reconciliation (service-role client) ──────────
//
// src/lib/accounting/reconciliation.ts is the browser-facing equivalent
// (anon/authenticated client, RLS-scoped). This is the same comparison —
// operational invoice/payment totals vs posted ledger balances — run with
// the service-role client from the trusted backfill endpoint, so the
// backfill can verify its own result before accounting-backfill.ts is
// allowed to flip accounting_settings.status to 'initialized'.

export type ServerReconciliation = {
  operationalAR: number;
  accountingAR: number;
  arDifference: number;
  operationalCollected: number;
  accountingUndepositedFunds: number;
  collectedDifference: number;
  totalDebits: number;
  totalCredits: number;
  trialBalanced: boolean;
  journalEntryCount: number;
  reconciled: boolean;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function computeServerReconciliation(admin: SupabaseClient, orgId: string): Promise<ServerReconciliation> {
  const [invoicesRes, paymentsRes, linesRes, entriesRes] = await Promise.all([
    admin.from("invoices").select("total_amount, amount_paid, status").eq("org_id", orgId).not("status", "in", "(draft,cancelled)"),
    admin.from("invoice_payments").select("amount, status").eq("org_id", orgId),
    admin.from("accounting_journal_entry_lines").select("debit, credit, account_id, accounting_accounts!account_id(code)").eq("org_id", orgId),
    admin.from("accounting_journal_entries").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("status", "posted"),
  ]);
  if (invoicesRes.error) throw new Error(`Reconciliation: could not load invoices: ${invoicesRes.error.message}`);
  if (paymentsRes.error) throw new Error(`Reconciliation: could not load invoice_payments: ${paymentsRes.error.message}`);
  if (linesRes.error) throw new Error(`Reconciliation: could not load journal lines: ${linesRes.error.message}`);
  if (entriesRes.error) throw new Error(`Reconciliation: could not count journal entries: ${entriesRes.error.message}`);

  const operationalAR = round2((invoicesRes.data ?? []).reduce((s: number, i: any) => s + (Number(i.total_amount ?? 0) - Number(i.amount_paid ?? 0)), 0));
  const succeeded = (paymentsRes.data ?? []).filter((p: any) => p.status === "succeeded").reduce((s: number, p: any) => s + Number(p.amount ?? 0), 0);
  const refunded = (paymentsRes.data ?? []).filter((p: any) => p.status === "refunded").reduce((s: number, p: any) => s + Number(p.amount ?? 0), 0);
  const operationalCollected = round2(succeeded - refunded);

  let arDebit = 0, arCredit = 0, ufDebit = 0, ufCredit = 0, totalDebits = 0, totalCredits = 0;
  for (const line of (linesRes.data ?? []) as any[]) {
    const debit = Number(line.debit ?? 0);
    const credit = Number(line.credit ?? 0);
    totalDebits += debit;
    totalCredits += credit;
    const code = line.accounting_accounts?.code;
    if (code === "1100") { arDebit += debit; arCredit += credit; }
    if (code === "1020") { ufDebit += debit; ufCredit += credit; }
  }
  const accountingAR = round2(arDebit - arCredit);
  const accountingUndepositedFunds = round2(ufDebit - ufCredit);
  totalDebits = round2(totalDebits);
  totalCredits = round2(totalCredits);

  const arDifference = round2(operationalAR - accountingAR);
  const collectedDifference = round2(operationalCollected - accountingUndepositedFunds);
  const trialBalanced = totalDebits === totalCredits;
  const journalEntryCount = entriesRes.count ?? 0;

  return {
    operationalAR, accountingAR, arDifference,
    operationalCollected, accountingUndepositedFunds, collectedDifference,
    totalDebits, totalCredits, trialBalanced, journalEntryCount,
    reconciled: arDifference === 0 && collectedDifference === 0 && trialBalanced && journalEntryCount > 0,
  };
}
