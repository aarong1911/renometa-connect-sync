// src/components/financials/accounting/ProfitAndLoss.tsx
import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/format";
import { fetchProfitAndLoss, type ProfitAndLoss as PL } from "@/lib/accounting/statements";
import { EmptySchemaNotice } from "./ChartOfAccounts";

type RangeKey = "month" | "quarter" | "year" | "custom";

function toDateOnly(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function rangeFor(key: RangeKey, now: Date): { from: string; to: string } {
  if (key === "month") return { from: toDateOnly(new Date(now.getFullYear(), now.getMonth(), 1)), to: toDateOnly(now) };
  if (key === "quarter") { const q = Math.floor(now.getMonth() / 3); return { from: toDateOnly(new Date(now.getFullYear(), q * 3, 1)), to: toDateOnly(now) }; }
  return { from: toDateOnly(new Date(now.getFullYear(), 0, 1)), to: toDateOnly(now) };
}

export function ProfitAndLoss({ orgId }: { orgId: string }) {
  const now = useMemo(() => new Date(), []);
  const [rangeKey, setRangeKey] = useState<RangeKey>("month");
  const [customFrom, setCustomFrom] = useState(toDateOnly(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [customTo, setCustomTo] = useState(toDateOnly(now));
  const [loading, setLoading] = useState(true);
  const [pl, setPl] = useState<PL | null>(null);
  const [schemaMissing, setSchemaMissing] = useState(false);

  const { from, to } = rangeKey === "custom" ? { from: customFrom, to: customTo } : rangeFor(rangeKey, now);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchProfitAndLoss(orgId, from, to).then((r) => {
      if (cancelled) return;
      setSchemaMissing(r === null);
      setPl(r);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [orgId, from, to]);

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-2 p-2">
        {(["month", "quarter", "year", "custom"] as const).map((k) => (
          <button key={k} onClick={() => setRangeKey(k)} className={cn("h-8 rounded-md px-3 text-[12px] font-medium capitalize", rangeKey === k ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/60")}>
            {k === "month" ? "This Month" : k}
          </button>
        ))}
        {rangeKey === "custom" && (
          <>
            <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="h-8 rounded-md border border-input bg-transparent px-2 text-xs" />
            <span className="text-xs text-muted-foreground">to</span>
            <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="h-8 rounded-md border border-input bg-transparent px-2 text-xs" />
          </>
        )}
      </Card>

      {loading ? (
        <div className="flex items-center justify-center gap-2 p-12 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
      ) : schemaMissing || !pl ? <EmptySchemaNotice /> : (
        <Card className="p-5">
          <Section title="Revenue" items={pl.revenue} total={pl.totalRevenue} />
          <Section title="Cost of Goods Sold" items={pl.cogs} total={pl.totalCogs} />
          <TotalRow label="Gross Profit" value={pl.grossProfit} bold />
          <Section title="Operating Expenses" items={pl.operatingExpenses} total={pl.totalOperatingExpenses} />
          <TotalRow label="Net Income" value={pl.netIncome} bold emphasize />
          {pl.totalRevenue === 0 && pl.totalCogs === 0 && pl.totalOperatingExpenses === 0 && (
            <p className="mt-4 text-xs text-muted-foreground">No posted activity in this date range.</p>
          )}
        </Card>
      )}
    </div>
  );
}

function Section({ title, items, total }: { title: string; items: { accountId: string; name: string; amount: number }[]; total: number }) {
  return (
    <div className="mb-4">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
      {items.length === 0 ? (
        <p className="py-1 text-sm text-muted-foreground">—</p>
      ) : (
        <div className="space-y-1">
          {items.map((i) => (
            <div key={i.accountId} className="flex justify-between text-sm"><span>{i.name}</span><span className="tabular-nums">{formatMoney(i.amount)}</span></div>
          ))}
        </div>
      )}
      <div className="mt-1 flex justify-between border-t border-border pt-1 text-sm font-semibold"><span>Total {title}</span><span className="tabular-nums">{formatMoney(total)}</span></div>
    </div>
  );
}

function TotalRow({ label, value, bold, emphasize }: { label: string; value: number; bold?: boolean; emphasize?: boolean }) {
  return (
    <div className={cn("flex justify-between border-t-2 border-foreground/20 py-2 text-sm", bold && "font-bold", emphasize && (value >= 0 ? "text-success" : "text-destructive"))}>
      <span>{label}</span><span className="tabular-nums">{formatMoney(value)}</span>
    </div>
  );
}
