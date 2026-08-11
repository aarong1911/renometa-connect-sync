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
const OPERATING_BANK_CODE = "1010";
const CREDIT_CARD_CODE = "2100";

export type SystemAccountIds = {
  accountsReceivable: string;
  undepositedFunds: string;
  constructionRevenue: string;
  changeOrderRevenue: string;
  accountsPayable: string;
  operatingBank: string;
  creditCard: string;
};

/**
 * Resolves this org's system accounts by their well-known Chart of Accounts
 * code. Throws (not silently falls back) if a required system account is
 * missing OR inactive — posting must never silently pick the wrong account.
 *
 * Phase 13.8A, Part 11 — 1020/1100/2000/3100/4000/4100 are `is_system=true`
 * and DB-protected from ever being deactivated (20260820_accounting_
 * foundation.sql's prevent_system_account_structural_change trigger), so
 * this check is a no-op for those in practice today. 1010 Operating Bank
 * and 2100 Credit Cards are NOT system accounts, though, and could be
 * deactivated by a future Chart of Accounts UI — this guard is what stops
 * that from silently producing journal entries against an account staff
 * have marked inactive.
 */
export async function resolveSystemAccounts(admin: SupabaseClient, orgId: string): Promise<SystemAccountIds> {
  const { data, error } = await admin
    .from("accounting_accounts")
    .select("id, code, is_active")
    .eq("org_id", orgId)
    .in("code", [AR_CODE, UNDEPOSITED_FUNDS_CODE, CONSTRUCTION_REVENUE_CODE, CHANGE_ORDER_REVENUE_CODE, ACCOUNTS_PAYABLE_CODE, OPERATING_BANK_CODE, CREDIT_CARD_CODE]);
  if (error) throw new Error(`Could not load system accounts: ${error.message}`);

  const byCode = new Map((data ?? []).map((r: any) => [r.code, { id: r.id as string, active: r.is_active as boolean }]));
  const require = (code: string, label: string): string => {
    const row = byCode.get(code);
    if (!row) throw new Error(`Org ${orgId} is missing required system account ${code} (${label}) — run seed_default_chart_of_accounts() first.`);
    if (!row.active) throw new Error(`Org ${orgId}'s ${label} account (${code}) is inactive — reactivate it before posting.`);
    return row.id;
  };

  return {
    accountsReceivable: require(AR_CODE, "Accounts Receivable"),
    undepositedFunds: require(UNDEPOSITED_FUNDS_CODE, "Undeposited Funds"),
    constructionRevenue: require(CONSTRUCTION_REVENUE_CODE, "Construction Revenue"),
    changeOrderRevenue: require(CHANGE_ORDER_REVENUE_CODE, "Change Order Revenue"),
    accountsPayable: require(ACCOUNTS_PAYABLE_CODE, "Accounts Payable"),
    operatingBank: require(OPERATING_BANK_CODE, "Operating Bank"),
    creditCard: require(CREDIT_CARD_CODE, "Credit Cards"),
  };
}

/**
 * Phase 13.8, Part 27 — payment-method -> asset/liability account mapping.
 * No accounting_settings default-account columns exist yet (audited: not
 * needed for this phase, see the Phase 13.8 report) — resolution is by
 * well-known system-account code instead. `card` maps to the Credit Cards
 * liability (a company purchase made ON a card is a liability incurred, not
 * cash leaving a bank account yet); every other allowed method (cash/check/
 * ach/wire/bank_transfer/other) maps to Operating Bank. This is a Phase
 * 13.8 DEFAULT mapping, not a configurable multi-bank-account system — a
 * future phase may let an org choose its own default bank/card accounts,
 * but nothing here reads such a setting today.
 *
 * Phase 13.8B, Part 5 — a missing/blank method is never silently treated as
 * "not card, so Operating Bank." Every caller of this function is posting a
 * real journal entry that credits one specific account; a null method would
 * make that choice arbitrary rather than a real business fact. Both current
 * callers (expense-create.ts, vendor-bill-record-payment.ts) already reject
 * a missing method before reaching this point (DB-enforced for expenses via
 * expenses_posted_requires_payment_method, and vendor_payments.payment_method
 * is `not null` already) — this throw exists so that guarantee holds even if
 * a future caller forgets to check first.
 */
export function resolvePaymentAccount(accounts: SystemAccountIds, method: string | null | undefined): string {
  if (!method) throw new Error("resolvePaymentAccount: payment method is required — refusing to guess a default asset/liability account.");
  return method === "card" ? accounts.creditCard : accounts.operatingBank;
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

// ── Phase 13.8 — Expenses / Vendor Bills / Vendor Payments ─────────────────

export type ExpenseForPosting = {
  id: string; amount: number; expenseDate: string; description: string;
  accountId: string; paymentMethod: string | null;
  projectId: string | null; contactId: string | null;
};

/**
 * Part 6/9 — direct/cash-paid expense: Dr the selected expense/COGS account,
 * Cr the payment-method-resolved asset/liability account (Operating Bank or
 * Credit Cards — see resolvePaymentAccount). This is a single already-
 * incurred, already-paid transaction (unlike a vendor bill, there is no
 * separate "owed" state) — the debit and credit both post at the same
 * event, same as postInvoiceIssued posts both sides of an invoice at once.
 */
export async function postExpenseRecorded(admin: SupabaseClient, orgId: string, expense: ExpenseForPosting, createdBy: string | null): Promise<PostJournalEntryResult> {
  const accounts = await resolveSystemAccounts(admin, orgId);
  const paymentAccountId = resolvePaymentAccount(accounts, expense.paymentMethod);
  return postJournalEntry(admin, {
    orgId,
    entryDate: expense.expenseDate,
    description: `Expense — ${expense.description}`,
    sourceType: "expense",
    sourceId: expense.id,
    postingKey: "recorded",
    projectId: expense.projectId,
    contactId: expense.contactId,
    createdBy,
    lines: [
      { accountId: expense.accountId, debit: expense.amount, projectId: expense.projectId, contactId: expense.contactId, description: expense.description },
      { accountId: paymentAccountId, credit: expense.amount, projectId: expense.projectId, contactId: expense.contactId, description: `Payment — ${expense.description}` },
    ],
  });
}

export type VendorBillLineForPosting = { accountId: string; amount: number; description: string; projectId: string | null };
export type VendorBillForPosting = {
  id: string; billNumber: string | null; totalAmount: number; billDate: string;
  vendorId: string; projectId: string | null; lines: VendorBillLineForPosting[];
};

/**
 * Part 9 — accrual recognition: Dr each line's expense/COGS account for its
 * own amount (preserving per-line project_id so project-cost attribution —
 * Part 21 — survives into the ledger), Cr Accounts Payable for the bill
 * total. Only ever called once a DRAFT bill is explicitly posted (never for
 * a draft) — the caller (vendor-bill-post.ts) enforces that transition.
 * post_journal_entry requires >=2 lines and a balanced entry; a single-line
 * bill therefore naturally produces the minimum valid 2-line entry (one
 * expense line + one A/P line).
 */
export async function postVendorBillOpened(admin: SupabaseClient, orgId: string, bill: VendorBillForPosting, createdBy: string | null): Promise<PostJournalEntryResult> {
  const accounts = await resolveSystemAccounts(admin, orgId);
  const label = bill.billNumber ? `Bill ${bill.billNumber}` : "Vendor bill";
  return postJournalEntry(admin, {
    orgId,
    entryDate: bill.billDate,
    description: `${label} posted`,
    sourceType: "vendor_bill",
    sourceId: bill.id,
    postingKey: "opened",
    projectId: bill.projectId,
    contactId: null,
    createdBy,
    lines: [
      ...bill.lines.map((l) => ({
        accountId: l.accountId, debit: l.amount,
        projectId: l.projectId ?? bill.projectId,
        description: `${label} — ${l.description}`,
      })),
      { accountId: accounts.accountsPayable, credit: bill.totalAmount, projectId: bill.projectId, description: `A/P — ${label}` },
    ],
  });
}

export type VendorPaymentForPosting = {
  id: string; amount: number; paidAt: string; paymentMethod: string;
  billNumber: string | null; projectId: string | null;
};

/**
 * Part 10 — bill payment: Dr Accounts Payable, Cr the payment-method-
 * resolved asset/liability account. Never touches an expense/COGS account —
 * the expense was already recognized when the bill posted (Part 10: "Do NOT
 * credit expense again").
 */
export async function postVendorPaymentSucceeded(admin: SupabaseClient, orgId: string, payment: VendorPaymentForPosting, createdBy: string | null): Promise<PostJournalEntryResult> {
  const accounts = await resolveSystemAccounts(admin, orgId);
  const paymentAccountId = resolvePaymentAccount(accounts, payment.paymentMethod);
  const label = payment.billNumber ? `Bill ${payment.billNumber}` : "vendor bill";
  return postJournalEntry(admin, {
    orgId,
    entryDate: payment.paidAt,
    description: `Payment sent — ${label}`,
    sourceType: "vendor_payment",
    sourceId: payment.id,
    postingKey: "succeeded",
    projectId: payment.projectId,
    contactId: null,
    createdBy,
    lines: [
      { accountId: accounts.accountsPayable, debit: payment.amount, projectId: payment.projectId, description: `A/P paid down — ${label}` },
      { accountId: paymentAccountId, credit: payment.amount, projectId: payment.projectId, description: `Payment — ${label}` },
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
