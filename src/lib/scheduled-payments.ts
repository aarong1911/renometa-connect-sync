// Cross-route in-memory store for scheduled payments.
// Populated when a draft invoice is "Sent" — one row per milestone.
import { useSyncExternalStore } from "react";
import type { Payment } from "@/lib/mock-data";
import type { DraftSchedule } from "@/lib/draft-invoices";

const listeners = new Set<() => void>();

// Starts empty — populated only by scheduleFromInvoice() when a real
// draft invoice is sent with a payment schedule. Previously seeded with
// three hardcoded demo clients that appeared for every org on load.
let scheduled: Payment[] = [];

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
