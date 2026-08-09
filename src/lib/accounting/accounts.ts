// src/lib/accounting/accounts.ts
import { supabase } from "@/lib/supabase";
import type { AccountingAccount, AccountingSettings, AccountType } from "./types";

/** true when the query failed because the accounting migration hasn't been applied in this environment yet (Postgres 42P01, undefined_table) — every accounting fetch degrades gracefully rather than throwing, matching src/lib/financials.ts's fetchInvoicePayments pattern. */
export function isMissingAccountingSchema(error: { code?: string } | null): boolean {
  return error?.code === "42P01";
}

function mapAccountRow(r: any): AccountingAccount {
  return {
    id: r.id,
    orgId: r.org_id,
    code: r.code,
    name: r.name,
    description: r.description,
    accountType: r.account_type,
    accountSubtype: r.account_subtype,
    normalBalance: r.normal_balance,
    isSystem: r.is_system,
    isActive: r.is_active,
    parentAccountId: r.parent_account_id,
  };
}

/** Returns null when the accounting schema doesn't exist yet — never []. */
export async function fetchChartOfAccounts(orgId: string): Promise<AccountingAccount[] | null> {
  const { data, error } = await supabase
    .from("accounting_accounts")
    .select("*")
    .eq("org_id", orgId)
    .order("code", { ascending: true });
  if (error) {
    if (!isMissingAccountingSchema(error)) console.error("[accounting/accounts]", error);
    return null;
  }
  return (data ?? []).map(mapAccountRow);
}

export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  asset: "Assets", liability: "Liabilities", equity: "Equity", revenue: "Revenue", expense: "Expenses",
};
export const ACCOUNT_TYPE_ORDER: AccountType[] = ["asset", "liability", "equity", "revenue", "expense"];

export function groupAccountsByType(accounts: AccountingAccount[]): Array<{ type: AccountType; label: string; accounts: AccountingAccount[] }> {
  return ACCOUNT_TYPE_ORDER.map((type) => ({
    type, label: ACCOUNT_TYPE_LABEL[type], accounts: accounts.filter((a) => a.accountType === type),
  })).filter((g) => g.accounts.length > 0);
}

export async function fetchAccountingSettings(orgId: string): Promise<AccountingSettings | null> {
  const { data, error } = await supabase
    .from("accounting_settings")
    .select("org_id, status, fiscal_year_start_month, backfill_approved_at, backfilled_at")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    if (!isMissingAccountingSchema(error)) console.error("[accounting/accounts]", error);
    return null;
  }
  if (!data) return null;
  return {
    orgId: data.org_id,
    status: data.status,
    fiscalYearStartMonth: data.fiscal_year_start_month,
    backfillApprovedAt: data.backfill_approved_at,
    backfilledAt: data.backfilled_at,
  };
}
