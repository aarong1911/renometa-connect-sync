// src/lib/accounting/statements.ts
import { fetchGeneralLedgerLines } from "./ledger";
import type { GeneralLedgerRow } from "./types";

// Phase 13.5B — classified by account_subtype (the actual semantic field),
// not by account CODE range. Codes are just a numbering convention; a
// future custom expense account created outside the default seed range
// (e.g. a 7000-coded subcontractor account) would have silently landed in
// Operating Expenses under the old code-range check. Every COGS subtype
// used by the default Chart of Accounts (supabase/migrations/
// 20260820_accounting_foundation.sql's seed_default_chart_of_accounts) is
// listed here — Materials/Permits & Fees/Other Direct Project Costs all
// use 'cost_of_goods_sold'; Direct Labor uses 'labor'; Subcontractors uses
// 'subcontractor'; Equipment Rental uses 'equipment'.
const COGS_SUBTYPES = new Set(["cost_of_goods_sold", "labor", "subcontractor", "equipment"]);

export type StatementLineItem = { accountId: string; code: string; name: string; amount: number };
export type ProfitAndLoss = {
  revenue: StatementLineItem[];
  totalRevenue: number;
  cogs: StatementLineItem[];
  totalCogs: number;
  grossProfit: number;
  operatingExpenses: StatementLineItem[];
  totalOperatingExpenses: number;
  netIncome: number;
};

function amountForType(rows: GeneralLedgerRow[], normalBalance: "debit" | "credit"): number {
  return round2(rows.reduce((s, r) => s + (normalBalance === "credit" ? r.credit - r.debit : r.debit - r.credit), 0));
}

function groupByAccount(rows: GeneralLedgerRow[]): StatementLineItem[] {
  const byAccount = new Map<string, { code: string; name: string; rows: GeneralLedgerRow[] }>();
  for (const r of rows) {
    const g = byAccount.get(r.accountId) ?? { code: r.accountCode, name: r.accountName, rows: [] };
    g.rows.push(r);
    byAccount.set(r.accountId, g);
  }
  return Array.from(byAccount.entries())
    .map(([accountId, g]) => ({ accountId, code: g.code, name: g.name, amount: amountForType(g.rows, g.rows[0].normalBalance) }))
    .filter((li) => li.amount !== 0)
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** Built entirely from non-draft journal lines (fetchGeneralLedgerLines excludes only 'draft', so a future reversed original stays visible alongside its reversal) — never from invoice/operational cards. Distinguishes "no activity in range" from "$0 line items" by returning an empty array either way; the caller decides how to present a wholly-empty statement (see AccountingOverview's initialization gating). */
export function computeProfitAndLoss(lines: GeneralLedgerRow[], dateFrom: string, dateTo: string): ProfitAndLoss {
  const inRange = lines.filter((l) => l.entryDate >= dateFrom && l.entryDate <= dateTo);
  const revenueRows = inRange.filter((l) => l.accountType === "revenue");
  const cogs = inRange.filter((l) => l.accountType === "expense" && COGS_SUBTYPES.has(l.accountSubtype));
  const opex = inRange.filter((l) => l.accountType === "expense" && !COGS_SUBTYPES.has(l.accountSubtype));

  const revenue = groupByAccount(revenueRows);
  const totalRevenue = round2(revenue.reduce((s, r) => s + r.amount, 0));
  const cogsItems = groupByAccount(cogs);
  const totalCogs = round2(cogsItems.reduce((s, r) => s + r.amount, 0));
  const opexItems = groupByAccount(opex);
  const totalOperatingExpenses = round2(opexItems.reduce((s, r) => s + r.amount, 0));
  const grossProfit = round2(totalRevenue - totalCogs);
  const netIncome = round2(grossProfit - totalOperatingExpenses);

  return { revenue, totalRevenue, cogs: cogsItems, totalCogs, grossProfit, operatingExpenses: opexItems, totalOperatingExpenses, netIncome };
}

export type BalanceSheet = {
  assets: StatementLineItem[];
  totalAssets: number;
  liabilities: StatementLineItem[];
  totalLiabilities: number;
  equity: StatementLineItem[];
  totalEquity: number;
  netIncomeToDate: number;
  balances: boolean;
};

/** As-of a single date — assets/liabilities/equity are cumulative balances, not period activity. Net income to date is folded into totalEquity (so Assets = Liabilities + Equity always holds) and ALSO returned separately as netIncomeToDate so the UI can break it out distinctly (e.g. "Current Period Earnings (unclosed)") as a labeled component of that same equity total — not as an addition on top of it — rather than merging it into the real 3100 Retained Earnings account's own balance. No year-close/retained-earnings-rollover logic exists yet, so nothing is ever swept into that account by a fake journal entry. */
export function computeBalanceSheet(lines: GeneralLedgerRow[], asOfDate: string): BalanceSheet {
  const asOf = lines.filter((l) => l.entryDate <= asOfDate);
  const assetRows = asOf.filter((l) => l.accountType === "asset");
  const liabilityRows = asOf.filter((l) => l.accountType === "liability");
  const equityRows = asOf.filter((l) => l.accountType === "equity");
  const revenueRows = asOf.filter((l) => l.accountType === "revenue");
  const expenseRows = asOf.filter((l) => l.accountType === "expense");

  const assets = groupByAccount(assetRows);
  const totalAssets = round2(assets.reduce((s, r) => s + r.amount, 0));
  const liabilities = groupByAccount(liabilityRows);
  const totalLiabilities = round2(liabilities.reduce((s, r) => s + r.amount, 0));
  const equity = groupByAccount(equityRows);
  const equityFromAccounts = round2(equity.reduce((s, r) => s + r.amount, 0));

  const netIncomeToDate = round2(amountForType(revenueRows, "credit") - amountForType(expenseRows, "debit"));
  const totalEquity = round2(equityFromAccounts + netIncomeToDate);

  return {
    assets, totalAssets, liabilities, totalLiabilities, equity, totalEquity, netIncomeToDate,
    balances: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
  };
}

export async function fetchProfitAndLoss(orgId: string, dateFrom: string, dateTo: string): Promise<ProfitAndLoss | null> {
  const lines = await fetchGeneralLedgerLines(orgId, { dateFrom, dateTo });
  if (lines === null) return null;
  return computeProfitAndLoss(lines, dateFrom, dateTo);
}

export async function fetchBalanceSheet(orgId: string, asOfDate: string): Promise<BalanceSheet | null> {
  const lines = await fetchGeneralLedgerLines(orgId, { dateTo: asOfDate });
  if (lines === null) return null;
  return computeBalanceSheet(lines, asOfDate);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
