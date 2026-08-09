// src/lib/accounting/ledger.ts
import { supabase } from "@/lib/supabase";
import { isMissingAccountingSchema } from "./accounts";
import type { GeneralLedgerRow, TrialBalanceRow } from "./types";

export type GeneralLedgerFilters = {
  dateFrom?: string;
  dateTo?: string;
  accountId?: string;
  projectId?: string;
  sourceType?: string;
};

const GL_SELECT = `
  id, org_id, journal_entry_id, account_id, project_id, contact_id, description, debit, credit, created_at,
  accounting_journal_entries!journal_entry_id!inner(entry_number, entry_date, description, status, source_type),
  accounting_accounts!account_id(code, name, account_type, account_subtype, normal_balance),
  projects!project_id(name)
`;

/**
 * Excludes DRAFT lines only — not just status='posted'. Phase 13.5B: once a
 * future reversal RPC exists, a reversed original entry must remain
 * visible here alongside its compensating entry so reports net to zero
 * (see the migration's enforce_journal_entry_immutability() comment) —
 * filtering to 'posted' only would make the original's lines vanish from
 * every report the moment it's reversed while the reversal stayed visible
 * alone. 'draft' is the only status that never represents a real
 * financial event. Returns null when the accounting schema isn't deployed yet.
 */
export async function fetchGeneralLedgerLines(orgId: string, filters: GeneralLedgerFilters = {}): Promise<GeneralLedgerRow[] | null> {
  let query = supabase
    .from("accounting_journal_entry_lines")
    .select(GL_SELECT)
    .eq("org_id", orgId)
    .neq("accounting_journal_entries.status", "draft");

  if (filters.accountId) query = query.eq("account_id", filters.accountId);
  if (filters.projectId) query = query.eq("project_id", filters.projectId);

  const { data, error } = await query;
  if (error) {
    if (!isMissingAccountingSchema(error)) console.error("[accounting/ledger]", error);
    return null;
  }

  let rows = (data ?? [])
    .filter((r: any) => r.accounting_journal_entries) // inner-join guard: postgrest returns null for the joined row if the eq filter above excluded it
    .map((r: any): GeneralLedgerRow => ({
      id: r.id, orgId: r.org_id, journalEntryId: r.journal_entry_id, accountId: r.account_id,
      projectId: r.project_id, contactId: r.contact_id, description: r.description,
      debit: Number(r.debit ?? 0), credit: Number(r.credit ?? 0), createdAt: r.created_at,
      entryNumber: r.accounting_journal_entries.entry_number,
      entryDate: r.accounting_journal_entries.entry_date,
      entryDescription: r.accounting_journal_entries.description,
      entryStatus: r.accounting_journal_entries.status,
      sourceType: r.accounting_journal_entries.source_type,
      accountCode: r.accounting_accounts?.code ?? "—",
      accountName: r.accounting_accounts?.name ?? "Unknown account",
      accountType: r.accounting_accounts?.account_type ?? "asset",
      accountSubtype: r.accounting_accounts?.account_subtype ?? "other_expense",
      normalBalance: r.accounting_accounts?.normal_balance ?? "debit",
      projectName: r.projects?.name ?? null,
    }));

  if (filters.dateFrom) rows = rows.filter((r) => r.entryDate >= filters.dateFrom!);
  if (filters.dateTo) rows = rows.filter((r) => r.entryDate <= filters.dateTo!);
  if (filters.sourceType) rows = rows.filter((r) => r.sourceType === filters.sourceType);

  rows.sort((a, b) => a.entryDate === b.entryDate ? a.entryNumber.localeCompare(b.entryNumber) : a.entryDate.localeCompare(b.entryDate));
  return rows;
}

/** Running balance per account, in the order rows are given — call after sorting/filtering to a single account for a meaningful running total. */
export function withRunningBalance(rows: GeneralLedgerRow[]): Array<GeneralLedgerRow & { runningBalance: number }> {
  let balance = 0;
  return rows.map((r) => {
    const delta = r.normalBalance === "debit" ? r.debit - r.credit : r.credit - r.debit;
    balance += delta;
    return { ...r, runningBalance: balance };
  });
}

/** Trial Balance: sum(debit)/sum(credit) per active account, from posted lines only, optionally as-of a date. Returns null when the schema isn't deployed yet. */
export async function fetchTrialBalance(orgId: string, asOfDate?: string): Promise<TrialBalanceRow[] | null> {
  const lines = await fetchGeneralLedgerLines(orgId, asOfDate ? { dateTo: asOfDate } : {});
  if (lines === null) return null;

  const { data: accounts, error } = await supabase
    .from("accounting_accounts")
    .select("id, code, name, account_type, normal_balance")
    .eq("org_id", orgId)
    .eq("is_active", true)
    .order("code", { ascending: true });
  if (error) {
    if (!isMissingAccountingSchema(error)) console.error("[accounting/ledger]", error);
    return null;
  }

  const byAccount = new Map<string, { debit: number; credit: number }>();
  for (const line of lines) {
    const agg = byAccount.get(line.accountId) ?? { debit: 0, credit: 0 };
    agg.debit += line.debit;
    agg.credit += line.credit;
    byAccount.set(line.accountId, agg);
  }

  return (accounts ?? [])
    .map((a: any): TrialBalanceRow => {
      const agg = byAccount.get(a.id) ?? { debit: 0, credit: 0 };
      const balance = a.normal_balance === "debit" ? agg.debit - agg.credit : agg.credit - agg.debit;
      return {
        accountId: a.id, code: a.code, name: a.name, accountType: a.account_type, normalBalance: a.normal_balance,
        debit: round2(agg.debit), credit: round2(agg.credit), balance: round2(balance),
      };
    })
    .filter((row) => row.debit > 0 || row.credit > 0);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
