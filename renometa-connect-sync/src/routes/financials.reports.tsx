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
import { mockInvoices, mockPayments, pipelineVelocityData, type Payment } from "@/lib/mock-data";
import { useScheduledPayments } from "@/lib/scheduled-payments";
import { formatMoney } from "@/lib/format";
import { TrendingUp, TrendingDown, ArrowUpRight, Wallet, CalendarClock } from "lucide-react";
import { useMemo, useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

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
  const collected = mockPayments.reduce((s, p) => s + p.amount, 0);
  const invoiced = mockInvoices.reduce((s, i) => s + i.amount, 0);
  const outstanding = mockInvoices
    .filter((i) => i.status !== "Paid" && i.status !== "Draft")
    .reduce((s, i) => s + i.amount, 0);
  const collectionRate = Math.round((collected / Math.max(1, invoiced)) * 100);

  const methodTotals = mockPayments.reduce<Record<string, number>>((acc, p) => {
    acc[p.method] = (acc[p.method] ?? 0) + p.amount;
    return acc;
  }, {});
  const methodData = Object.entries(methodTotals).map(([name, value]) => ({ name, value }));
  const methodColors = [PRIMARY, CHART2, SUCCESS, CHART5];

  const aging: { label: string; amount: number; color: string }[] = [
    { label: "Current", amount: 48200, color: SUCCESS },
    { label: "1–30 days", amount: 18400, color: PRIMARY },
    { label: "31–60 days", amount: 7200, color: WARNING },
    { label: "60+ days", amount: 3100, color: DESTRUCTIVE },
  ];
  const agingMax = Math.max(...aging.map((a) => a.amount));

  // ----- bucketed cashflow forecast -----
  const [bucket, setBucket] = useState<Bucket>("weekly");
  const [horizon, setHorizon] = useState<Horizon>(90);
  const cashflow = useMemo(
    () => buildCashflow(mockPayments, scheduled, bucket, horizon),
    [scheduled, bucket, horizon],
  );
  const cashflowTotals = useMemo(() => {
    const received = cashflow.reduce((s, w) => s + w.received, 0);
    const expected = cashflow.reduce((s, w) => s + w.scheduled, 0);
    return { received, expected, total: received + expected };
  }, [cashflow]);

  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <SummaryCard label="Revenue (12w)" value={formatMoney(collected)} delta="+18%" tone="up" icon={Wallet} />
        <SummaryCard label="Invoiced (12w)" value={formatMoney(invoiced)} delta="+9%" tone="up" icon={ArrowUpRight} />
        <SummaryCard label="Outstanding" value={formatMoney(outstanding)} delta="-4%" tone="down" icon={TrendingDown} />
        <SummaryCard label="Collection rate" value={`${collectionRate}%`} delta="+3pp" tone="up" icon={TrendingUp} />
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
              <AreaChart data={pipelineVelocityData} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
                <defs>
                  <linearGradient id="rev" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={PRIMARY} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={PRIMARY} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.92 0.005 250)" vertical={false} />
                <XAxis dataKey="week" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
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
                <Area type="monotone" dataKey="value" stroke={PRIMARY} fill="url(#rev)" strokeWidth={2} />
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
            <div className="text-sm font-semibold">Deals closed per week</div>
            <div className="text-xs text-muted-foreground">Volume of won deals</div>
          </div>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={pipelineVelocityData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.92 0.005 250)" vertical={false} />
                <XAxis dataKey="week" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Bar dataKey="deals" fill={CHART2} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>
    </>
  );
}

function SummaryCard({
  label,
  value,
  delta,
  tone,
  icon: Icon,
}: {
  label: string;
  value: string;
  delta: string;
  tone: "up" | "down";
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
          <div className={"mt-0.5 text-[11px] font-medium " + (tone === "up" ? "text-success" : "text-destructive")}>
            {delta} vs prior
          </div>
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
 * Received: mockPayments with status omitted/"Received".
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
    if (idx >= 0) buckets[idx].received += p.amount;
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
