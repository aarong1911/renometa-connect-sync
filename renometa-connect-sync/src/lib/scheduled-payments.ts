// Cross-route in-memory store for scheduled payments.
// Populated when a draft invoice is "Sent" — one row per milestone.
import { useSyncExternalStore } from "react";
import type { Payment } from "@/lib/mock-data";
import type { DraftSchedule } from "@/lib/draft-invoices";

const listeners = new Set<() => void>();

function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const DEMO_SEEDS: Array<{ invoice: string; client: string; milestones: Array<{ id: string; label: string; amount: number; days: number }> }> = [
  {
    invoice: "INV-7901",
    client: "Sarah Jenkins",
    milestones: [
      { id: "m1", label: "Deposit", amount: 9800, days: 7 },
      { id: "m2", label: "Progress", amount: 14700, days: 28 },
      { id: "m3", label: "Final", amount: 9800, days: 56 },
    ],
  },
  {
    invoice: "INV-7902",
    client: "Mark Thompson",
    milestones: [
      { id: "m1", label: "Deposit", amount: 6200, days: 14 },
      { id: "m2", label: "Final", amount: 18600, days: 42 },
    ],
  },
  {
    invoice: "INV-7903",
    client: "Emily Carter",
    milestones: [
      { id: "m1", label: "Deposit", amount: 4500, days: 21 },
      { id: "m2", label: "Progress", amount: 9000, days: 49 },
      { id: "m3", label: "Final", amount: 4500, days: 77 },
    ],
  },
];

let scheduled: Payment[] = DEMO_SEEDS.flatMap((s) =>
  s.milestones.map((m) => ({
    id: `pay-sched-${s.invoice}-${m.id}`,
    invoice: s.invoice,
    client: s.client,
    amount: m.amount,
    method: "ACH" as const,
    receivedAt: isoDaysFromNow(m.days),
    status: "Scheduled" as const,
    dueDate: isoDaysFromNow(m.days),
    milestoneLabel: m.label,
  })),
);

function emit() {
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const EMPTY: Payment[] = [];

export function getScheduledPayments(): Payment[] {
  return scheduled;
}

export function useScheduledPayments(): Payment[] {
  return useSyncExternalStore(
    subscribe,
    () => scheduled,
    () => EMPTY,
  );
}

/** Idempotent per (invoiceNumber, milestoneId) — calling twice for the same invoice replaces prior schedule rows. */
export function scheduleFromInvoice(args: {
  invoiceNumber: string;
  client: string;
  total: number;
  schedule: DraftSchedule;
  defaultMethod?: Payment["method"];
}) {
  const { invoiceNumber, client, total, schedule, defaultMethod = "ACH" } = args;
  // Drop any existing scheduled rows for this invoice (re-send case).
  scheduled = scheduled.filter((p) => p.invoice !== invoiceNumber);
  const next: Payment[] = schedule.milestones.map((m, idx) => ({
    id: `pay-sched-${invoiceNumber}-${m.id}`,
    invoice: invoiceNumber,
    client,
    amount: Math.round((total * (Number(m.percent) || 0)) / 100),
    method: defaultMethod,
    receivedAt: m.dueDate, // sort/display by expected date
    status: "Scheduled",
    dueDate: m.dueDate,
    milestoneLabel: m.label || `Milestone ${idx + 1}`,
  }));
  scheduled = [...next, ...scheduled];
  emit();
}

export function clearScheduledForInvoice(invoiceNumber: string) {
  scheduled = scheduled.filter((p) => p.invoice !== invoiceNumber);
  emit();
}
