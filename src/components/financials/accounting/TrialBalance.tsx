// src/components/financials/accounting/TrialBalance.tsx
import { useEffect, useState } from "react";
import { Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { formatMoney } from "@/lib/format";
import { fetchTrialBalance } from "@/lib/accounting/ledger";
import type { TrialBalanceRow } from "@/lib/accounting/types";
import { EmptySchemaNotice } from "./ChartOfAccounts";

export function TrialBalance({ orgId }: { orgId: string }) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<TrialBalanceRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchTrialBalance(orgId).then((r) => { if (!cancelled) { setRows(r); setLoading(false); } });
    return () => { cancelled = true; };
  }, [orgId]);

  if (loading) return <div className="flex items-center justify-center gap-2 p-12 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>;
  if (rows === null) return <EmptySchemaNotice />;

  const totalDebit = round2(rows.reduce((s, r) => s + r.debit, 0));
  const totalCredit = round2(rows.reduce((s, r) => s + r.credit, 0));
  // No tolerance — post_journal_entry() enforces exact numeric balance at
  // posting time, so a real discrepancy here means something bypassed that
  // path, and hiding it behind a rounding tolerance would hide that.
  const balanced = totalDebit === totalCredit;

  return (
    <Card className="overflow-hidden">
      <div className="grid grid-cols-[90px_1fr_120px_120px] gap-3 border-b border-border bg-secondary/40 px-4 py-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
        <div>Code</div><div>Account</div><div className="text-right">Debit</div><div className="text-right">Credit</div>
      </div>
      {rows.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">No posted journal activity yet.</div>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <li key={r.accountId} className="grid grid-cols-[90px_1fr_120px_120px] items-center gap-3 px-4 py-2.5 text-[13px]">
              <div className="tabular-nums text-muted-foreground">{r.code}</div>
              <div className="font-medium">{r.name}</div>
              <div className="text-right tabular-nums">{r.debit > 0 ? formatMoney(r.debit) : ""}</div>
              <div className="text-right tabular-nums">{r.credit > 0 ? formatMoney(r.credit) : ""}</div>
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-[90px_1fr_120px_120px] items-center gap-3 border-t-2 border-foreground/20 px-4 py-3 text-[13px] font-semibold">
        <div className="col-span-2">Total</div>
        <div className="text-right tabular-nums">{formatMoney(totalDebit)}</div>
        <div className="text-right tabular-nums">{formatMoney(totalCredit)}</div>
      </div>
      <div className={`flex items-center gap-1.5 px-4 pb-3 text-xs font-medium ${balanced ? "text-success" : "text-destructive"}`}>
        {balanced ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
        {balanced ? "Balanced" : `Out of balance by ${formatMoney(Math.abs(totalDebit - totalCredit))}`}
      </div>
    </Card>
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
