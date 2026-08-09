// src/components/financials/accounting/AccountingOverview.tsx
import { useEffect, useState } from "react";
import { Loader2, CheckCircle2, AlertTriangle, BookOpenCheck } from "lucide-react";
import { Card } from "@/components/ui/card";
import { formatMoney } from "@/lib/format";
import { fetchAccountingSettings } from "@/lib/accounting/accounts";
import { fetchTrialBalance } from "@/lib/accounting/ledger";
import { fetchReconciliationReport, type ReconciliationReport } from "@/lib/accounting/reconciliation";
import type { AccountingSettings } from "@/lib/accounting/types";

export function AccountingOverview({ orgId }: { orgId: string }) {
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<AccountingSettings | null>(null);
  const [totals, setTotals] = useState<{ debit: number; credit: number } | null>(null);
  const [reconciliation, setReconciliation] = useState<ReconciliationReport | null>(null);
  const [schemaMissing, setSchemaMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [settingsResult, trialBalance, recon] = await Promise.all([
        fetchAccountingSettings(orgId),
        fetchTrialBalance(orgId),
        fetchReconciliationReport(orgId),
      ]);
      if (cancelled) return;
      setSettings(settingsResult);
      setSchemaMissing(trialBalance === null);
      if (trialBalance) setTotals({ debit: trialBalance.reduce((s, r) => s + r.debit, 0), credit: trialBalance.reduce((s, r) => s + r.credit, 0) });
      setReconciliation(recon);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [orgId]);

  if (loading) return <div className="flex items-center justify-center gap-2 p-12 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>;

  if (schemaMissing) {
    return (
      <Card className="flex flex-col items-center gap-2 p-12 text-center">
        <BookOpenCheck className="h-6 w-6 text-muted-foreground/40" />
        <p className="text-sm font-semibold">Accounting foundation not deployed yet</p>
        <p className="max-w-md text-xs text-muted-foreground">
          supabase/migrations/20260820_accounting_foundation.sql hasn't been applied in this
          environment. Chart of Accounts, General Ledger, and financial statements will appear
          here once it's run in the Supabase SQL Editor.
        </p>
      </Card>
    );
  }

  const status = settings?.status ?? "not_initialized";
  const balanced = totals ? Math.abs(totals.debit - totals.credit) < 0.01 : true;
  const hasActivity = (totals?.debit ?? 0) > 0 || (totals?.credit ?? 0) > 0;

  return (
    <div className="space-y-4">
      {!hasActivity && (
        <Card className="flex items-start gap-3 border-info-soft bg-info-soft/40 p-4">
          <BookOpenCheck className="mt-0.5 h-5 w-5 shrink-0 text-info" />
          <div>
            <p className="text-sm font-semibold">Accounting foundation ready</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Chart of Accounts is seeded. Historical transactions have not been posted yet — no
              live invoice/payment event is wired to accounting until a backfill is explicitly
              approved. Statements below are correctly empty, not broken.
            </p>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Status" value={status.replace(/_/g, " ")} />
        <StatCard label="Total Debits" value={formatMoney(totals?.debit ?? 0)} />
        <StatCard label="Total Credits" value={formatMoney(totals?.credit ?? 0)} />
        <StatCard
          label="Balance Check"
          value={balanced ? "Balanced" : "Out of balance"}
          icon={balanced ? CheckCircle2 : AlertTriangle}
          tone={balanced ? "text-success" : "text-destructive"}
        />
      </div>

      {reconciliation && hasActivity && (
        <Card className="p-4">
          <p className="mb-3 text-sm font-semibold">Operational ↔ Accounting Reconciliation</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ReconRow label="Accounts Receivable" operational={reconciliation.operationalAR} accounting={reconciliation.accountingAR} />
            <ReconRow label="Undeposited Funds / Collected" operational={reconciliation.operationalCollected} accounting={reconciliation.accountingUndepositedFunds} />
          </div>
          <p className={`mt-3 text-xs font-medium ${reconciliation.reconciled ? "text-success" : "text-warning-soft-foreground"}`}>
            {reconciliation.reconciled ? "Reconciled — accounting matches operational totals." : "Not yet reconciled — expected until a full backfill runs (see Phase 13.5 report)."}
          </p>
        </Card>
      )}
    </div>
  );
}

function StatCard({ label, value, icon: Icon, tone }: { label: string; value: string; icon?: React.ComponentType<{ className?: string }>; tone?: string }) {
  return (
    <Card className="p-4">
      <p className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-2 flex items-center gap-1.5 text-lg font-semibold capitalize ${tone ?? ""}`}>{Icon && <Icon className="h-4 w-4" />}{value}</p>
    </Card>
  );
}

function ReconRow({ label, operational, accounting }: { label: string; operational: number; accounting: number | null }) {
  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-3 text-sm">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-1 flex items-center justify-between">
        <span>Operational: <span className="font-semibold tabular-nums">{formatMoney(operational)}</span></span>
        <span>Ledger: <span className="font-semibold tabular-nums">{accounting === null ? "—" : formatMoney(accounting)}</span></span>
      </div>
    </div>
  );
}
