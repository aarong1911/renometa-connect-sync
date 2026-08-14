import { createFileRoute, Outlet, Link, useLocation } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  DollarSign, LayoutDashboard, Receipt, CreditCard, FolderKanban, Wallet, BookOpenCheck,
  AlertCircle, CheckCircle2, Clock, TrendingUp, Plus,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { InvoiceModal } from "@/components/projects/InvoiceModal";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { formatMoney, formatCompactMoney } from "@/lib/format";
import {
  fetchFinancialsOrgId, fetchFinancialInvoices, computeInvoiceMetrics, computeInvoicedVsCollectedTrend,
  fetchContractedRevenue, fetchInvoicePayments, isIssued, invoiceBalance,
  type FinancialInvoice, type InvoicePaymentRecord, type TrendRange,
} from "@/lib/financials";
import { dateOnlyToLocalDate } from "@/lib/format";
import { AreaChart, Area, BarChart, Bar, ResponsiveContainer, XAxis, YAxis, Tooltip, Legend } from "recharts";

export const Route = createFileRoute("/financials")({
  component: FinancialsLayout,
});

const NAV = [
  { to: "/financials", label: "Overview", icon: LayoutDashboard, exact: true },
  { to: "/financials/invoices", label: "Invoices", icon: Receipt },
  { to: "/financials/payments", label: "Payments", icon: CreditCard },
  { to: "/financials/projects", label: "Projects", icon: FolderKanban },
  { to: "/financials/expenses", label: "Expenses", icon: Wallet },
  { to: "/financials/accounting", label: "Accounting", icon: BookOpenCheck },
];

function FinancialsLayout() {
  const { pathname } = useLocation();
  const isRoot = pathname === "/financials" || pathname === "/financials/";
  const [createOpen, setCreateOpen] = useState(false);
  // Create Invoice lives in the shared layout (visible from every tab), but
  // Overview/Invoices/Payments each own their own data fetch — bumping this
  // key forces the active tab to remount (and therefore refetch) right
  // after a new invoice is created, without lifting all their state up.
  const [refreshToken, setRefreshToken] = useState(0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-success-soft text-success ring-1 ring-black/5">
            <DollarSign className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-[22px] font-semibold leading-tight tracking-tight text-foreground">Financials</h1>
            <p className="mt-0.5 text-[13px] text-muted-foreground">Invoices, payments, cash flow, and accounting across your business.</p>
          </div>
        </div>
        <Button onClick={() => setCreateOpen(true)}><Plus className="mr-1.5 h-4 w-4" />Create Invoice</Button>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[170px_1fr]">
        <nav className="space-y-0.5">
          {NAV.map((s) => {
            const active = s.exact ? isRoot : pathname.startsWith(s.to);
            const Icon = s.icon;
            return (
              <Link key={s.to} to={s.to}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
                  active ? "bg-primary-soft text-primary" : "text-foreground hover:bg-secondary",
                )}>
                <Icon className="h-3.5 w-3.5" />{s.label}
              </Link>
            );
          })}
        </nav>
        <div className="min-w-0">{isRoot ? <FinancialsOverview key={refreshToken} /> : <Outlet key={refreshToken} />}</div>
      </div>

      <InvoiceModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); setRefreshToken((k) => k + 1); }} />
    </div>
  );
}

const CHART_COLORS = { invoiced: "#2F6FE4", collected: "#10b981", overdue: "#EF4444", open: "#F59E0B", current: "#94a3b8" };

const AGING_BUCKETS = [
  { key: "current", label: "Current", color: CHART_COLORS.current },
  { key: "d1_30", label: "1–30 days", color: "#F59E0B" },
  { key: "d31_60", label: "31–60 days", color: "#F97316" },
  { key: "d61_90", label: "61–90 days", color: "#EF4444" },
  { key: "d90_plus", label: "90+ days", color: "#B91C1C" },
] as const;

function computeAging(invoices: FinancialInvoice[], now: Date) {
  const buckets: Record<string, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  for (const inv of invoices.filter(isIssued)) {
    const balance = invoiceBalance(inv);
    if (balance <= 0) continue; // fully paid/credited invoices never appear in aging
    const due = dateOnlyToLocalDate(inv.dueDate);
    const daysOverdue = due ? Math.floor((now.getTime() - due.getTime()) / 86_400_000) : -1;
    if (daysOverdue <= 0) buckets.current += balance;
    else if (daysOverdue <= 30) buckets.d1_30 += balance;
    else if (daysOverdue <= 60) buckets.d31_60 += balance;
    else if (daysOverdue <= 90) buckets.d61_90 += balance;
    else buckets.d90_plus += balance;
  }
  return buckets;
}

function FinancialsOverview() {
  const [loading, setLoading] = useState(true);
  const [invoices, setInvoices] = useState<FinancialInvoice[]>([]);
  const [range, setRange] = useState<TrendRange>("12m");
  const [chartMode, setChartMode] = useState<"cumulative" | "activity">("cumulative");
  const [contractedRevenue, setContractedRevenue] = useState(0);
  const [activeProjectCount, setActiveProjectCount] = useState(0);
  const [payments, setPayments] = useState<InvoicePaymentRecord[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const orgId = await fetchFinancialsOrgId();
      if (!orgId) { if (!cancelled) { setInvoices([]); setLoading(false); } return; }
      const [invoiceRows, contracted, paymentRows] = await Promise.all([
        fetchFinancialInvoices(orgId), fetchContractedRevenue(orgId), fetchInvoicePayments(orgId),
      ]);
      if (cancelled) return;
      setInvoices(invoiceRows);
      setContractedRevenue(contracted.contractedRevenue);
      setActiveProjectCount(contracted.activeProjectCount);
      setPayments(paymentRows);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const now = useMemo(() => new Date(), []);
  const metrics = useMemo(() => computeInvoiceMetrics(invoices, now, payments), [invoices, now, payments]);
  const trend = useMemo(() => computeInvoicedVsCollectedTrend(invoices, range, now, payments), [invoices, range, now, payments]);
  const cumulativeTrend = useMemo(() => {
    let ci = 0, cc = 0;
    return trend.map((t) => { ci += t.invoiced; cc += t.collected; return { label: t.label, invoiced: Math.round(ci * 100) / 100, collected: Math.round(cc * 100) / 100 }; });
  }, [trend]);
  const chartData = chartMode === "cumulative" ? cumulativeTrend : trend;
  const hasTrendActivity = trend.some((t) => t.invoiced > 0 || t.collected > 0);

  const aging = useMemo(() => computeAging(invoices, now), [invoices, now]);
  const agingTotal = Object.values(aging).reduce((s, v) => s + v, 0);

  const remainingToInvoice = Math.round((contractedRevenue - metrics.totalIssuedInvoiced) * 100) / 100;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <KpiCard icon={TrendingUp} iconBg="bg-info-soft" iconColor="text-info" label="Contracted Revenue" value={contractedRevenue} sub={`Across ${activeProjectCount} active project${activeProjectCount === 1 ? "" : "s"}`} />
        <KpiCard icon={Receipt} iconBg="bg-primary-soft" iconColor="text-primary" label="Invoiced" value={metrics.totalIssuedInvoiced} sub={`${metrics.totalInvoices} invoice${metrics.totalInvoices === 1 ? "" : "s"}`} />
        <KpiCard icon={CheckCircle2} iconBg="bg-success-soft" iconColor="text-success" label="Collected This Month" value={metrics.collectedThisMonth} sub={metrics.collectedThisMonthCount === 0 ? "No payments yet" : `${metrics.collectedThisMonthCount} payment${metrics.collectedThisMonthCount === 1 ? "" : "s"}`} />
        <KpiCard icon={AlertCircle} iconBg="bg-warning-soft" iconColor="text-warning-soft-foreground" label="Outstanding Receivables" value={metrics.outstandingAmount} sub={metrics.outstandingCount === 0 ? "No open invoices" : `${metrics.outstandingCount} open invoice${metrics.outstandingCount === 1 ? "" : "s"}`} />
        <KpiCard icon={Clock} iconBg="bg-destructive-soft" iconColor="text-destructive" label="Overdue" value={metrics.overdueAmount} sub={metrics.overdueCount === 0 ? "No overdue invoices" : `${metrics.overdueCount} invoice${metrics.overdueCount === 1 ? "" : "s"}`} />
      </div>

      {/* Revenue Pipeline (Part 25) — operational funnel, not accounting revenue. */}
      <Card className="p-4">
        <p className="mb-3 text-sm font-semibold">Revenue Pipeline</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[
            { label: "Contracted", value: contractedRevenue, color: "text-info" },
            { label: "Invoiced", value: metrics.totalIssuedInvoiced, color: "text-primary" },
            { label: "Collected", value: metrics.paidAmount, color: "text-success" },
          ].map((step) => (
            <div key={step.label} className="rounded-lg border border-border bg-secondary/30 p-3">
              <p className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{step.label}</p>
              <p className={cn("mt-1 text-lg font-semibold tabular-nums", step.color)}>{formatCompactMoney(step.value)}</p>
            </div>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-3 text-[12px]">
          <div className="flex items-center justify-between"><span className="text-muted-foreground">Remaining to Invoice</span><span className="font-semibold tabular-nums">{formatMoney(Math.max(0, remainingToInvoice))}</span></div>
          <div className="flex items-center justify-between"><span className="text-muted-foreground">Outstanding to Collect</span><span className="font-semibold tabular-nums">{formatMoney(metrics.outstandingAmount)}</span></div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.6fr_1fr]">
        <Card className="p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-info" />
              <span className="text-sm font-semibold">Invoiced vs Collected</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex gap-1">
                {(["cumulative", "activity"] as const).map((m) => (
                  <button key={m} onClick={() => setChartMode(m)} className={cn("h-7 rounded-md px-2.5 text-[11px] font-medium capitalize", chartMode === m ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/60")}>{m}</button>
                ))}
              </div>
              <div className="flex gap-1">
                {(["30d", "90d", "12m"] as const).map((t) => (
                  <button key={t} onClick={() => setRange(t)} className={cn("h-7 rounded-md px-2.5 text-[11px] font-medium", range === t ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/60")}>{t}</button>
                ))}
              </div>
            </div>
          </div>
          <div className={cn("relative mt-4 -mx-2", loading || hasTrendActivity ? "h-56" : "h-36")}>
            {loading ? <div className="h-full animate-pulse rounded bg-secondary/40" /> : !hasTrendActivity ? (
              <div className="mx-2 flex h-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border text-center">
                <TrendingUp className="h-5 w-5 text-muted-foreground/30" />
                <p className="text-[13px] font-medium text-muted-foreground">No invoice or payment activity in this period.</p>
              </div>
            ) : chartMode === "cumulative" ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 5, right: 12, bottom: 0, left: 4 }}>
                  <defs>
                    <linearGradient id="invoicedG" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={CHART_COLORS.invoiced} stopOpacity={0.22} />
                      <stop offset="100%" stopColor={CHART_COLORS.invoiced} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="collectedG" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={CHART_COLORS.collected} stopOpacity={0.3} />
                      <stop offset="100%" stopColor={CHART_COLORS.collected} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} minTickGap={20} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={(v) => formatCompactMoney(v)} width={48} />
                  <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid hsl(var(--border))" }} formatter={(v: any, name: any) => [formatMoney(v), name === "invoiced" ? "Invoiced" : "Collected"]} />
                  <Legend verticalAlign="top" align="right" height={20} iconType="circle" iconSize={7} wrapperStyle={{ fontSize: 11 }} formatter={(value) => (value === "invoiced" ? "Invoiced" : "Collected")} />
                  <Area type="monotone" dataKey="invoiced" stroke={CHART_COLORS.invoiced} strokeWidth={2} fill="url(#invoicedG)" />
                  <Area type="monotone" dataKey="collected" stroke={CHART_COLORS.collected} strokeWidth={2} fill="url(#collectedG)" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 5, right: 12, bottom: 0, left: 4 }}>
                  <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} minTickGap={20} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={(v) => formatCompactMoney(v)} width={48} />
                  <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid hsl(var(--border))" }} formatter={(v: any, name: any) => [formatMoney(v), name === "invoiced" ? "Invoiced" : "Collected"]} />
                  <Legend verticalAlign="top" align="right" height={20} iconType="circle" iconSize={7} wrapperStyle={{ fontSize: 11 }} formatter={(value) => (value === "invoiced" ? "Invoiced" : "Collected")} />
                  <Bar dataKey="invoiced" fill={CHART_COLORS.invoiced} radius={[2, 2, 0, 0]} />
                  <Bar dataKey="collected" fill={CHART_COLORS.collected} radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        {/* A/R Aging (Part 24) — replaces the Paid/Open donut; only unpaid, non-draft balances, one bucket per invoice by remaining balance. */}
        <Card className="p-5">
          <div className="mb-1 flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-info" />
            <span className="text-sm font-semibold">Receivables Aging</span>
          </div>
          <p className="mb-3 text-[11px] text-muted-foreground">Remaining balance on issued, unpaid invoices — never the same invoice in two buckets.</p>
          {agingTotal <= 0 ? (
            <div className="flex h-40 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border text-center">
              <DollarSign className="h-5 w-5 text-muted-foreground/30" />
              <p className="text-xs text-muted-foreground">No outstanding receivables.</p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {AGING_BUCKETS.map((b) => {
                const value = aging[b.key];
                const pct = agingTotal > 0 ? Math.round((value / agingTotal) * 100) : 0;
                return (
                  <div key={b.key}>
                    <div className="mb-1 flex items-center justify-between text-[12px]">
                      <span className="flex items-center gap-1.5 font-medium text-foreground/80"><span className="h-2 w-2 rounded-full" style={{ background: b.color }} />{b.label}</span>
                      <span className="font-semibold tabular-nums">{formatMoney(value)} · {pct}%</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full" style={{ width: `${pct}%`, background: b.color }} /></div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-3.5">
            <div>
              <div className="text-[10.5px] uppercase tracking-wider text-muted-foreground">Collection Rate</div>
              <div className="mt-0.5 text-[16px] font-semibold tabular-nums text-success">{Math.round(metrics.collectionRate * 100)}%</div>
            </div>
            <div>
              <div className="text-[10.5px] uppercase tracking-wider text-muted-foreground">Total Outstanding</div>
              <div className="mt-0.5 text-[16px] font-semibold tabular-nums">{formatMoney(agingTotal)}</div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function KpiCard({ icon: Icon, iconBg, iconColor, label, value, sub }: {
  icon: React.ComponentType<{ className?: string }>; iconBg: string; iconColor: string;
  label: string; value: number; sub: string;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2">
        <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-md", iconBg, iconColor)}><Icon className="h-3.5 w-3.5" /></span>
        <p className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      </div>
      <p className="mt-2 text-xl font-semibold tabular-nums">{formatCompactMoney(value)}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>
    </Card>
  );
}
