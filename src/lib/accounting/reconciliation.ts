// src/lib/accounting/reconciliation.ts
//
// Phase 13.5 Part 32 — compares OPERATIONAL totals (invoices/invoice_payments
// — already authoritative today) against ACCOUNTING ledger balances, so the
// UI can say plainly whether the ledger is reconciled, partially populated,
// or not initialized at all, instead of ever implying a $0 statement is the
// real state of the business.

import { supabase } from "@/lib/supabase";
import { fetchFinancialInvoices, isIssued, invoiceBalance } from "@/lib/financials";
import { fetchTrialBalance } from "./ledger";
import { fetchAccountingSettings } from "./accounts";
import type { AccountingInitStatus } from "./types";

export type ReconciliationReport = {
  initStatus: AccountingInitStatus | "schema_not_deployed";
  operationalAR: number;
  accountingAR: number | null;
  arDifference: number | null;
  operationalCollected: number;
  accountingUndepositedFunds: number | null;
  collectedDifference: number | null;
  reconciled: boolean;
};

const AR_CODE = "1100";
const UNDEPOSITED_FUNDS_CODE = "1020";

export async function fetchReconciliationReport(orgId: string): Promise<ReconciliationReport> {
  const [invoices, payments, trialBalance, settings] = await Promise.all([
    fetchFinancialInvoices(orgId),
    supabase.from("invoice_payments").select("amount, status").eq("org_id", orgId),
    fetchTrialBalance(orgId),
    fetchAccountingSettings(orgId),
  ]);

  const issued = invoices.filter(isIssued);
  const operationalAR = round2(issued.reduce((s, i) => s + invoiceBalance(i), 0));
  const succeeded = (payments.data ?? []).filter((p: any) => p.status === "succeeded").reduce((s: number, p: any) => s + Number(p.amount ?? 0), 0);
  const refunded = (payments.data ?? []).filter((p: any) => p.status === "refunded").reduce((s: number, p: any) => s + Number(p.amount ?? 0), 0);
  const operationalCollected = round2(succeeded - refunded);

  if (trialBalance === null) {
    return {
      initStatus: "schema_not_deployed",
      operationalAR, accountingAR: null, arDifference: null,
      operationalCollected, accountingUndepositedFunds: null, collectedDifference: null,
      reconciled: false,
    };
  }

  const arRow = trialBalance.find((r) => r.code === AR_CODE);
  const undepositedRow = trialBalance.find((r) => r.code === UNDEPOSITED_FUNDS_CODE);
  const accountingAR = round2(arRow?.balance ?? 0);
  const accountingUndepositedFunds = round2(undepositedRow?.balance ?? 0);
  const arDifference = round2(operationalAR - accountingAR);
  const collectedDifference = round2(operationalCollected - accountingUndepositedFunds);

  return {
    initStatus: settings?.status ?? "not_initialized",
    operationalAR, accountingAR, arDifference,
    operationalCollected, accountingUndepositedFunds, collectedDifference,
    reconciled: Math.abs(arDifference) < 0.01 && Math.abs(collectedDifference) < 0.01 && trialBalance.length > 0,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
