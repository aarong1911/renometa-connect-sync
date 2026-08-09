// src/lib/accounting/types.ts
// Phase 13.5 — Accounting Foundation. Mirrors supabase/migrations/20260820_accounting_foundation.sql.

export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";
export type NormalBalance = "debit" | "credit";

export type AccountingAccount = {
  id: string;
  orgId: string;
  code: string;
  name: string;
  description: string | null;
  accountType: AccountType;
  accountSubtype: string;
  normalBalance: NormalBalance;
  isSystem: boolean;
  isActive: boolean;
  parentAccountId: string | null;
};

export type JournalEntryStatus = "draft" | "posted" | "reversed";

export type SourceType =
  | "invoice" | "invoice_payment" | "expense" | "vendor_bill" | "vendor_payment"
  | "change_order" | "manual" | "refund" | "credit_memo" | "opening_balance";

export type JournalEntry = {
  id: string;
  orgId: string;
  entryNumber: string;
  entryDate: string;
  description: string | null;
  status: JournalEntryStatus;
  sourceType: SourceType;
  sourceId: string | null;
  postingKey: string;
  projectId: string | null;
  contactId: string | null;
  postedAt: string | null;
  reversedEntryId: string | null;
  createdAt: string;
};

export type JournalEntryLine = {
  id: string;
  orgId: string;
  journalEntryId: string;
  accountId: string;
  projectId: string | null;
  contactId: string | null;
  description: string | null;
  debit: number;
  credit: number;
  createdAt: string;
};

/** A journal entry line joined with its parent entry + account, for General Ledger display. */
export type GeneralLedgerRow = JournalEntryLine & {
  entryNumber: string;
  entryDate: string;
  entryDescription: string | null;
  entryStatus: JournalEntryStatus;
  sourceType: SourceType;
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  accountSubtype: string;
  normalBalance: NormalBalance;
  projectName: string | null;
};

export type TrialBalanceRow = {
  accountId: string;
  code: string;
  name: string;
  accountType: AccountType;
  normalBalance: NormalBalance;
  debit: number;
  credit: number;
  /** Signed per normal_balance — positive means "on the normal side." */
  balance: number;
};

export type AccountingInitStatus = "not_initialized" | "ready_for_backfill" | "initialized";

export type AccountingSettings = {
  orgId: string;
  status: AccountingInitStatus;
  fiscalYearStartMonth: number;
  backfillApprovedAt: string | null;
  backfilledAt: string | null;
};
