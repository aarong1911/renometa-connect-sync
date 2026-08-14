import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { type Payment } from "@/lib/mock-data";
import { useScheduledPayments } from "@/lib/scheduled-payments";
import { fetchReceivedPayments, fetchOutstandingInvoices, fetchInvoicedTotal, paymentNetAmount, type OutstandingInvoice } from "@/lib/received-payments";
import { formatMoney } from "@/lib/format";
import { formatPaymentMethod } from "@/lib/payment-method";
import { TrendingUp, TrendingDown, ArrowUpRight, Wallet, CalendarClock } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useDeals } from "@/lib/deals-store";

type Bucket = "weekly" | "monthly";
type Horizon = 30 | 90 | 180;

export const Route = createFileRoute("/financials/reports")({
  component: ReportsPage,
});

const PRIMARY = "oklch(0.55 0.205 262)";
const SUCCESS = "oklch(0.62 0.16 152)";
const WARNING = "oklch(0.74 0.16 70)";
const DESTRUCTIVE = "oklch(0.577 0.245 27)";
const CHART2 = "oklch(0.65 0.16 220)";
const CHART5 = "oklch(0.55 0.18 300)";

function ReportsPage() {
  const scheduled = useScheduledPayments();
  const deals = useDeals();
  const [received, setReceived] = useState<Payment[]>([]);
  const [outstandingInvoices, setOutstandingInvoices] = useState<OutstandingInvoice[]>([]);
  const [invoicedTotal, setInvoicedTotal] = useState(0);

  useEffect(() => {
    fetchReceivedPayments().then(setReceived);
    fetchOutstandingInvoices().then(setOutstandingInvoices);
    fetchInvoicedTotal().then(setInvoicedTotal);
  }, []);

  // Reversal rows (source==='reversal') net negative here so a reversed
  // payment doesn't inflate Received/Revenue — see paymentNetAmount().
  const collected = received.reduce((s, p) => s + paymentNetAmount(p), 0);
  const outstanding = outstandingInvoices.reduce((s, i) => s + Math.max(0, i.total_amount - i.amount_paid - i.credits_total), 0);
  const collectionRate = invoicedTotal > 0 ? Math.round((collected / invoicedTotal) * 100) : 0;

  // Phase 13.7B — grouped by each row's own canonical payment_method
  // (lowercase, from invoice_payments), humanized only at render time.
  const methodTotals = received.reduce<Record<string, number>>((acc, p) => {
    const key = (p.method ?? "other").toLowerCase();
    acc[key] = (acc[key] ?? 0) + paymentNetAmount(p);
    return acc;
  }, {});
  const methodData = Object.entries(methodTotals).map(([name, value]) => ({ name: formatPaymentMethod(name), value }));
  const methodColors = [PRIMARY, CHART2, SUCCESS, CHART5];

  const aging = useMemo(() => {
    const buckets = { current: 0, d1_30: 0, d31_60: 0, d60plus: 0 };
    const now = Date.now();
    for (const inv of outstandingInvoices) {
      const balance = inv.total_amount - inv.amount_paid - inv.credits_total;
      if (balance <= 0) continue;
      const daysOverdue = inv.due_date ? Math.floor((now - new Date(inv.due_date).getTime()) / 86_400_000) : -1;
      if (daysOverdue <= 0) buckets.current += balance;
      else if (daysOverdue <= 30) buckets.d1_30 += balance;
      else if (daysOverdue <= 60) buckets.d31_60 += balance;
      else buckets.d60plus += balance;
    }
    return [
      { label: "Current", amount: buckets.current, color: SUCCESS },
      { label: "1–30 days", amount: buckets.d1_30, color: PRIMARY },
      { label: "31–60 days", amount: buckets.d31_60, color: WARNING },
      { label: "60+ days", amount: buckets.d60plus, color: DESTRUCTIVE },
    ];
  }, [outstandingInvoices]);
  const agingMax = Math.max(1, ...aging.map((a) => a.amount));

  const dealsByStage = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of deals) map.set(d.stage, (map.get(d.stage) ?? 0) + 1);
    return Array.from(map.entries()).map(([stage, count]) => ({ stage, count }));
  }, [deals]);

  // ----- bucketed cashflow forecast -----
  const [bucket, setBucket] = useState<Bucket>("weekly");
  const [horizon, setHorizon] = useState<Horizon>(90);
  const cashflow = useMemo(
    () => buildCashflow(received, scheduled, bucket, horizon),
    [received, scheduled, bucket, horizon],
  );
  const cashflowTotals = useMemo(() => {
    const receivedTotal = cashflow.reduce((s, w) => s + w.received, 0);
    const expected = cashflow.reduce((s, w) => s + w.scheduled, 0);
    return { received: receivedTotal, expected, total: receivedTotal + expected };
  }, [cashflow]);

  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <SummaryCard label="Revenue" value={formatMoney(collected)} icon={Wallet} />
        <SummaryCard label="Invoiced" value={formatMoney(invoicedTotal)} icon={ArrowUpRight} />
        <SummaryCard label="Outstanding" value={formatMoney(outstanding)} icon={TrendingDown} />
        <SummaryCard label="Collection rate" value={`${collectionRate}%`} icon={TrendingUp} />
      </div>

      {/* Cashflow forecast — Received vs Scheduled by week, next 90 days */}
      <Card className="mb-4 p-4">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <CalendarClock className="h-4 w-4 text-primary" />
              <div className="text-sm font-semibold">Cashflow forecast · next {horizon} days</div>
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {bucket === "weekly" ? "Weekly" : "Monthly"} inflows from received payments and scheduled milestones
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <ToggleGroup
              type="single"
              size="sm"
              value={bucket}
              onValueChange={(v) => v && setBucket(v as Bucket)}
              className="rounded-md border border-border bg-secondary/40 p-0.5"
            >
              <ToggleGroupItem value="weekly" className="h-7 px-2 text-xs">Weekly</ToggleGroupItem>
              <ToggleGroupItem value="monthly" className="h-7 px-2 text-xs">Monthly</ToggleGroupItem>
            </ToggleGroup>
            <ToggleGroup
              type="single"
              size="sm"
              value={String(horizon)}
              onValueChange={(v) => v && setHorizon(Number(v) as Horizon)}
              className="rounded-md border border-border bg-secondary/40 p-0.5"
            >
              <ToggleGroupItem value="30" className="h-7 px-2 text-xs">30d</ToggleGroupItem>
              <ToggleGroupItem value="90" className="h-7 px-2 text-xs">90d</ToggleGroupItem>
              <ToggleGroupItem value="180" className="h-7 px-2 text-xs">180d</ToggleGroupItem>
            </ToggleGroup>
            <div className="flex items-center gap-4">
              <Legendish color={SUCCESS} label="Received" value={formatMoney(cashflowTotals.received)} />
              <Legendish color={PRIMARY} label="Scheduled" value={formatMoney(cashflowTotals.expected)} />
            </div>
            <div className="border-l border-border pl-4">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Total</div>
              <div className="text-sm font-semibold tabular-nums">{formatMoney(cashflowTotals.total)}</div>
            </div>
          </div>
        </div>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={cashflow} margin={{ top: 8, right: 8, bottom: 0, left: -8 }} barCategoryGap="20%">
              <defs>
                <linearGradient id="schedFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={PRIMARY} stopOpacity={0.85} />
                  <stop offset="100%" stopColor={PRIMARY} stopOpacity={0.55} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.92 0.005 250)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval={0} />
              <YAxis
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`}
              />
              <Tooltip
                contentStyle={{ fontSize: 12, borderRadius: 8 }}
                formatter={(v) => [formatMoney(Number(v ?? 0))]}
                labelFormatter={(l) => `${bucket === "weekly" ? "Week of" : "Month of"} ${l}`}
              />
              <Legend
                verticalAlign="top"
                height={0}
                wrapperStyle={{ display: "none" }}
              />
              <Bar dataKey="received" stackId="cash" name="Received" fill={SUCCESS} radius={[0, 0, 0, 0]} />
              <Bar dataKey="scheduled" stackId="cash" name="Scheduled" fill="url(#schedFill)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        {cashflowTotals.expected === 0 && (
          <div className="mt-2 rounded-md border border-dashed border-border bg-secondary/30 px-3 py-2 text-[11px] text-muted-foreground">
            No scheduled milestones yet. Send a draft invoice from <span className="font-medium text-foreground">/financials/invoices</span> to populate the forecast.
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold">Revenue trend</div>
              <div className="text-xs text-muted-foreground">Collected payments by week</div>
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <span className="h-2 w-2 rounded-full" style={{ background: PRIMARY }} />
              <span className="text-muted-foreground">Revenue</span>
            </div>
          </div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={cashflow} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
                <defs>
                  <linearGradient id="rev" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={PRIMARY} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={PRIMARY} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.92 0.005 250)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`}
                />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  formatter={(v) => formatMoney(Number(v))}
                />
                <Area type="monotone" dataKey="received" stroke={PRIMARY} fill="url(#rev)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-4">
          <div className="mb-3">
            <div className="text-sm font-semibold">Payments by method</div>
            <div className="text-xs text-muted-foreground">Share of received funds</div>
          </div>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={methodData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={36}
                  outerRadius={64}
                  paddingAngle={2}
                  stroke="none"
                >
                  {methodData.map((_, i) => (
                    <Cell key={i} fill={methodColors[i % methodColors.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  formatter={(v) => formatMoney(Number(v))}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-1.5 text-xs">
            {methodData.map((m, i) => (
              <div key={m.name} className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: methodColors[i % methodColors.length] }} />
                <span className="text-muted-foreground">{m.name}</span>
                <span className="ml-auto font-medium tabular-nums">{formatMoney(m.value)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold">Aging summary</div>
              <div className="text-xs text-muted-foreground">Outstanding by bucket</div>
            </div>
            <div className="text-xs font-semibold tabular-nums">
              {formatMoney(aging.reduce((s, a) => s + a.amount, 0))}
            </div>
          </div>
          <div className="space-y-3">
            {aging.map((a) => (
              <div key={a.label}>
                <div className="mb-1 flex justify-between text-xs">
                  <span className="text-muted-foreground">{a.label}</span>
                  <span className="font-medium tabular-nums">{formatMoney(a.amount)}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${(a.amount / agingMax) * 100}%`, background: a.color }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-4">
          <div className="mb-3">
            <div className="text-sm font-semibold">Deals by stage</div>
            <div className="text-xs text-muted-foreground">Current pipeline distribution</div>
          </div>
          {dealsByStage.length === 0 ? (
            <div className="flex h-48 items-center justify-center text-center text-xs text-muted-foreground">
              No deals yet.
            </div>
          ) : (
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dealsByStage} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.92 0.005 250)" vertical={false} />
                  <XAxis dataKey="stage" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                  <Bar dataKey="count" fill={CHART2} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

function SummaryCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
        </div>
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary-soft text-primary">
          <Icon className="h-4 w-4" />
        </div>
      </div>
    </Card>
  );
}

function Legendish({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

type CashflowWeek = {
  weekStart: string;
  label: string;
  received: number;
  scheduled: number;
};

/**
 * Bucketed cashflow series from today, sized by horizon (days) and bucket (weekly|monthly).
 * Received: real received payments (status omitted/"Received").
 * Scheduled: cross-route scheduled-payments store, bucketed by dueDate.
 */
function buildCashflow(
  received: Payment[],
  scheduled: Payment[],
  bucket: "weekly" | "monthly",
  horizonDays: 30 | 90 | 180,
): CashflowWeek[] {
  const dayMs = 86_400_000;

  let bucketStarts: Date[];
  if (bucket === "weekly") {
    const start = startOfWeek(new Date());
    const count = Math.max(1, Math.ceil(horizonDays / 7));
    bucketStarts = Array.from({ length: count }, (_, i) => new Date(start.getTime() + i * 7 * dayMs));
  } else {
    const start = startOfMonth(new Date());
    const count = Math.max(1, Math.ceil(horizonDays / 30));
    bucketStarts = Array.from({ length: count }, (_, i) => {
      const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
      return d;
    });
  }
  const end =
    bucket === "weekly"
      ? new Date(bucketStarts[bucketStarts.length - 1].getTime() + 7 * dayMs)
      : new Date(Date.UTC(
          bucketStarts[bucketStarts.length - 1].getUTCFullYear(),
          bucketStarts[bucketStarts.length - 1].getUTCMonth() + 1,
          1,
        ));

  const buckets: CashflowWeek[] = bucketStarts.map((d) => ({
    weekStart: d.toISOString().slice(0, 10),
    label:
      bucket === "weekly"
        ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
        : d.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }),
    received: 0,
    scheduled: 0,
  }));

  const indexOf = (iso: string): number => {
    const t = new Date(iso).getTime();
    if (Number.isNaN(t) || t < bucketStarts[0].getTime() || t >= end.getTime()) return -1;
    if (bucket === "weekly") {
      return Math.floor((t - bucketStarts[0].getTime()) / (7 * dayMs));
    }
    // monthly: find last bucket whose start <= t
    for (let i = bucketStarts.length - 1; i >= 0; i--) {
      if (t >= bucketStarts[i].getTime()) return i;
    }
    return -1;
  };

  for (const p of received) {
    if ((p.status ?? "Received") !== "Received") continue;
    const idx = indexOf(p.receivedAt);
    // Reversal rows net negative — see paymentNetAmount().
    if (idx >= 0) buckets[idx].received += paymentNetAmount(p);
  }
  for (const p of scheduled) {
    if (p.status !== "Scheduled") continue;
    const idx = indexOf(p.dueDate ?? p.receivedAt);
    if (idx >= 0) buckets[idx].scheduled += p.amount;
  }
  return buckets;
}

function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function startOfWeek(d: Date): Date {
  // UTC Monday-start week to keep SSR/CSR aligned.
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = utc.getUTCDay();
  const diff = (dow + 6) % 7;
  utc.setUTCDate(utc.getUTCDate() - diff);
  return utc;
}
