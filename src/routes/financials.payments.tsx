import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import { StatusBadge, type BadgeTone } from "@/components/ui/status-badge";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, DollarSign, Building2, CreditCard as CardIcon, Banknote, MoreHorizontal, CalendarClock, AlertTriangle, BellRing } from "lucide-react";
import { type Payment } from "@/lib/mock-data";
import { useScheduledPayments } from "@/lib/scheduled-payments";
import { logReminder, useReminders, type ReminderEntry } from "@/lib/payment-reminders";
import { formatDate, formatMoney, daysFromNow } from "@/lib/format";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PaymentDetailDrawer } from "@/components/financials/payment-detail-drawer";
import { toast } from "sonner";
import { fetchReceivedPayments, paymentNetAmount } from "@/lib/received-payments";
import { formatPaymentMethod, PAYMENT_METHOD_FILTERS } from "@/lib/payment-method";

export const Route = createFileRoute("/financials/payments")({
  component: PaymentsPage,
});

// Phase 13.7B — canonical lowercase invoice_payments.payment_method
// vocabulary (includes Cash, previously missing — Part 13), formatted for
// display via formatPaymentMethod(). Filter comparisons match the raw
// canonical value stored on each Payment row, not the display label.
const METHODS = PAYMENT_METHOD_FILTERS;
type StatusFilter = "All" | "Received" | "Scheduled" | "Past due";

function isPastDue(p: Payment): boolean {
  if (p.status !== "Scheduled") return false;
  return daysFromNow(p.dueDate ?? p.receivedAt) < 0;
}

function PaymentsPage() {
  const [query, setQuery] = useState("");
  const [method, setMethod] = useState<string>("All");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("All");
  const [selected, setSelected] = useState<Payment | null>(null);
  const scheduled = useScheduledPayments();
  const [received, setReceived] = useState<Payment[]>([]);
  const loadReceived = useCallback(() => { fetchReceivedPayments().then(setReceived); }, []);
  useEffect(() => { loadReceived(); }, [loadReceived]);
  const reminders = useReminders();
  const lastReminderByPayment = useMemo(() => {
    const map = new Map<string, ReminderEntry>();
    for (const r of reminders) {
      const prev = map.get(r.paymentId);
      if (!prev || new Date(r.sentAt).getTime() > new Date(prev.sentAt).getTime()) {
        map.set(r.paymentId, r);
      }
    }
    return map;
  }, [reminders]);

  const allPayments = useMemo<Payment[]>(
    () => [...scheduled, ...received],
    [scheduled, received],
  );

  const stats = useMemo(() => {
    const received = allPayments.filter((p) => (p.status ?? "Received") === "Received");
    const sched = allPayments.filter((p) => p.status === "Scheduled");
    const pastDue = sched.filter(isPastDue);
    // Reversal rows (source==='reversal') net negative here so a reversed
    // payment doesn't inflate the Received total — see paymentNetAmount().
    const total = received.reduce((s, p) => s + paymentNetAmount(p), 0);
    const upcoming = sched.reduce((s, p) => s + p.amount, 0);
    const pastDueAmount = pastDue.reduce((s, p) => s + p.amount, 0);
    // Part 12 — grouped strictly by each row's own stored payment_method
    // (canonical, lowercased), never inferred from the invoice.
    const byMethod: Record<string, number> = {};
    received.forEach((p) => {
      const key = (p.method ?? "other").toLowerCase();
      byMethod[key] = (byMethod[key] ?? 0) + paymentNetAmount(p);
    });
    const top = Object.entries(byMethod).sort((a, b) => b[1] - a[1])[0];
    return {
      total,
      upcoming,
      pastDueAmount,
      pastDueCount: pastDue.length,
      top,
      receivedCount: received.length,
      scheduledCount: sched.length,
    };
  }, [allPayments]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allPayments
      .filter((p) => {
        const status = p.status ?? "Received";
        if (statusFilter === "Past due") {
          if (!isPastDue(p)) return false;
        } else if (statusFilter !== "All" && status !== statusFilter) {
          return false;
        }
        if (method !== "All" && (p.method ?? "").toLowerCase() !== method) return false;
        if (!q) return true;
        return (
          p.client.toLowerCase().includes(q) ||
          p.invoice.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        // Scheduled first (soonest), then received (most recent)
        const aSched = a.status === "Scheduled";
        const bSched = b.status === "Scheduled";
        if (aSched !== bSched) return aSched ? -1 : 1;
        return new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime();
      });
  }, [allPayments, query, method, statusFilter]);

  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard label="Received" value={formatMoney(stats.total)} sub={`${stats.receivedCount} payments`} icon={DollarSign} tone="success" />
        <MetricCard
          label="Scheduled"
          value={formatMoney(stats.upcoming)}
          sub={`${stats.scheduledCount} milestones`}
          icon={CalendarClock}
          tone="primary"
        />
        <MetricCard
          label="Past due"
          value={formatMoney(stats.pastDueAmount)}
          sub={`${stats.pastDueCount} milestone${stats.pastDueCount === 1 ? "" : "s"}`}
          icon={AlertTriangle}
          tone="danger"
        />
        <MetricCard label="Top method" value={stats.top ? formatPaymentMethod(stats.top[0]) : "—"} sub={stats.top ? formatMoney(stats.top[1]) : ""} icon={CardIcon} tone="muted" />
      </div>

      <Card className="overflow-hidden p-0 shadow-sm">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search invoice or client…"
              className="h-8 pl-8 text-sm"
            />
          </div>
          <div className="flex flex-wrap gap-1">
            <FilterChip active={statusFilter === "All"} onClick={() => setStatusFilter("All")}>
              All
            </FilterChip>
            <FilterChip active={statusFilter === "Received"} onClick={() => setStatusFilter("Received")}>
              Received
            </FilterChip>
            <FilterChip active={statusFilter === "Scheduled"} onClick={() => setStatusFilter("Scheduled")}>
              Scheduled
            </FilterChip>
            <FilterChip active={statusFilter === "Past due"} onClick={() => setStatusFilter("Past due")}>
              Past due{stats.pastDueCount > 0 ? ` (${stats.pastDueCount})` : ""}
            </FilterChip>
          </div>
          <div className="ml-auto flex flex-wrap gap-1">
            <FilterChip active={method === "All"} onClick={() => setMethod("All")}>
              All methods
            </FilterChip>
            {METHODS.map((m) => (
              <FilterChip key={m} active={method === m} onClick={() => setMethod(m)}>
                {formatPaymentMethod(m)}
              </FilterChip>
            ))}
          </div>
        </div>
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-secondary/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Invoice</th>
              <th className="px-4 py-2 text-left font-medium">Client</th>
              <th className="px-4 py-2 text-left font-medium">Status</th>
              <th className="px-4 py-2 text-left font-medium">Method</th>
              <th className="px-4 py-2 text-right font-medium">Amount</th>
              <th className="px-4 py-2 text-left font-medium">Date</th>
              <th className="w-10 px-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const isScheduled = p.status === "Scheduled";
              // A reversal row (source==='reversal', append-only model — see
              // paymentNetAmount()) is a real, distinct invoice_payments row
              // and must stay visible in history, but it is not itself a
              // positive receipt — it must never render as a normal
              // "Received +$amount" row.
              const isReversal = p.source === "reversal";
              const overdue = isPastDue(p);
              const lastReminder = overdue ? lastReminderByPayment.get(p.id) : undefined;
              const dateLabel = isScheduled
                ? scheduledDateLabel(p.dueDate ?? p.receivedAt)
                : formatDate(p.receivedAt);
              return (
                <tr
                  key={p.id}
                  onClick={() => setSelected(p)}
                  className={
                    "h-12 cursor-pointer border-b border-border last:border-b-0 hover:bg-secondary/30 " +
                    (isScheduled ? "bg-primary-soft/20" : "")
                  }
                >
                  <td className="px-4 font-mono text-xs">{p.invoice}</td>
                  <td className="px-4">
                    <div className="font-medium">{p.client}</div>
                    {isScheduled && p.milestoneLabel && (
                      <div className="text-[10px] text-muted-foreground">{p.milestoneLabel}</div>
                    )}
                  </td>
                  <td className="px-4">
                    <div className="flex items-center gap-1.5">
                      {isReversal ? (
                        <StatusBadge tone="warning">Reversal</StatusBadge>
                      ) : (
                        <StatusBadge tone={PAYMENT_STATUS_TONE[overdue ? "Past due" : (p.status ?? "Received")]}>
                          {overdue ? "Past due" : (p.status ?? "Received")}
                        </StatusBadge>
                      )}
                      {lastReminder && (
                        <span
                          className="inline-flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground"
                          title={`Last reminder ${formatDate(lastReminder.sentAt)} by ${lastReminder.actor}`}
                        >
                          <BellRing className="h-2.5 w-2.5" />
                          Reminded {timeAgo(lastReminder.sentAt)}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4">
                    <MethodBadge method={p.method} />
                  </td>
                  <td
                    className={
                      "px-4 text-right font-semibold tabular-nums " +
                      (isReversal ? "text-destructive" : isScheduled ? "text-primary" : "text-success")
                    }
                  >
                    {isScheduled ? "" : isReversal ? "-" : "+"}
                    {formatMoney(p.amount)}
                  </td>
                  <td className="px-4 text-xs text-muted-foreground">{dateLabel}</td>
                  <td className="px-2 text-right" onClick={(e) => e.stopPropagation()}>
                    {overdue ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1 px-2 text-[11px]"
                        onClick={() => {
                          logReminder(p.id);
                          toast.success(`Reminder sent to ${p.client}`, {
                            description: `${p.milestoneLabel ?? "Milestone"} · ${formatMoney(p.amount)}`,
                          });
                        }}
                      >
                        <BellRing className="h-3 w-3" />
                        {lastReminder ? "Remind again" : "Remind"}
                      </Button>
                    ) : (
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                  No payments match your filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <PaymentDetailDrawer
        payment={selected}
        onOpenChange={(open) => !open && setSelected(null)}
      />
    </>
  );
}

function scheduledDateLabel(iso: string): string {
  const d = daysFromNow(iso);
  if (d === 0) return `Due today · ${formatDate(iso)}`;
  if (d > 0) return `In ${d}d · ${formatDate(iso)}`;
  return `${Math.abs(d)}d overdue · ${formatDate(iso)}`;
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.max(0, Math.round(diffMs / 1000));
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.round(day / 7);
  return `${wk}w ago`;
}

const PAYMENT_STATUS_TONE: Record<"Received" | "Scheduled" | "Past due", BadgeTone> = {
  Received: "success",
  Scheduled: "primary",
  "Past due": "danger",
};

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "h-7 rounded-full border px-2.5 text-[11px] font-medium transition-colors " +
        (active
          ? "border-primary bg-primary-soft text-primary"
          : "border-border bg-background text-muted-foreground hover:bg-secondary")
      }
    >
      {children}
    </button>
  );
}


function MethodBadge({ method }: { method: string }) {
  const key = (method ?? "").toLowerCase();
  const map: Record<string, string> = {
    cash: "bg-success/15 text-success",
    card: "bg-primary-soft text-primary",
    ach: "bg-chart-2/15 text-chart-2",
    bank_transfer: "bg-chart-2/15 text-chart-2",
    check: "bg-secondary text-secondary-foreground",
    wire: "bg-chart-5/15 text-chart-5",
    other: "bg-muted text-muted-foreground",
  };
  return (
    <Badge variant="secondary" className={`h-5 rounded px-1.5 text-[10px] ${map[key] ?? map.other}`}>
      {formatPaymentMethod(method)}
    </Badge>
  );
}
