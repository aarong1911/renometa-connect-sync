// src/components/financials/accounting/BalanceSheet.tsx
import { useEffect, useState } from "react";
import { Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatMoney, todayDateOnlyValue } from "@/lib/format";
import { fetchBalanceSheet, type BalanceSheet as BS } from "@/lib/accounting/statements";
import { EmptySchemaNotice } from "./ChartOfAccounts";

export function BalanceSheet({ orgId }: { orgId: string }) {
  const [asOf, setAsOf] = useState(todayDateOnlyValue);
  const [loading, setLoading] = useState(true);
  const [bs, setBs] = useState<BS | null>(null);
  const [schemaMissing, setSchemaMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchBalanceSheet(orgId, asOf).then((r) => {
      if (cancelled) return;
      setSchemaMissing(r === null);
      setBs(r);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [orgId, asOf]);

  return (
    <div className="space-y-4">
      <Card className="flex items-center gap-2 p-2">
        <span className="px-2 text-xs text-muted-foreground">As of</span>
        <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="h-8 w-[160px]" />
      </Card>

      {loading ? (
        <div className="flex items-center justify-center gap-2 p-12 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
      ) : schemaMissing || !bs ? <EmptySchemaNotice /> : bs.totalAssets === 0 && bs.totalLiabilities === 0 && bs.totalEquity === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">No posted balances as of this date.</Card>
      ) : (
        <Card className="p-5">
          <Section title="Assets" items={bs.assets} total={bs.totalAssets} />
          <Section title="Liabilities" items={bs.liabilities} total={bs.totalLiabilities} />
          {/* Phase 13.6, Part 15 — this is a computed DISPLAY line only, never
              a journal entry: no year-close/retained-earnings-rollover
              process exists yet, so current-period net income is shown here
              (distinctly labeled, never merged into the real 3100 Retained
              Earnings account's own balance) as a breakout of an amount
              already folded into Total Equity below (see computeBalanceSheet
              — totalEquity = equityFromAccounts + netIncomeToDate) until a
              real close sweeps it into Retained Earnings. */}
          <Section title="Equity" items={[...bs.equity, { accountId: "__ni__", name: "Current Period Earnings (unclosed)", amount: bs.netIncomeToDate }]} total={bs.totalEquity} />
          <div className={`mt-3 flex items-center gap-1.5 border-t border-border pt-3 text-sm font-medium ${bs.balances ? "text-success" : "text-destructive"}`}>
            {bs.balances ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
            {bs.balances ? "Assets = Liabilities + Equity" : `Out of balance — Assets ${formatMoney(bs.totalAssets)} vs Liabilities + Equity ${formatMoney(bs.totalLiabilities + bs.totalEquity)}`}
          </div>
        </Card>
      )}
    </div>
  );
}

function Section({ title, items, total }: { title: string; items: { accountId: string; name: string; amount: number }[]; total: number }) {
  return (
    <div className="mb-4">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
      {items.filter((i) => i.amount !== 0).length === 0 ? (
        <p className="py-1 text-sm text-muted-foreground">—</p>
      ) : (
        <div className="space-y-1">
          {items.filter((i) => i.amount !== 0).map((i) => (
            <div key={i.accountId} className="flex justify-between text-sm"><span>{i.name}</span><span className="tabular-nums">{formatMoney(i.amount)}</span></div>
          ))}
        </div>
      )}
      <div className="mt-1 flex justify-between border-t border-border pt-1 text-sm font-semibold"><span>Total {title}</span><span className="tabular-nums">{formatMoney(total)}</span></div>
    </div>
  );
}
