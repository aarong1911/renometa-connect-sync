// Cross-route in-memory draft invoices store.
// Used to ship draft invoices created from accepted estimates over to /financials/invoices.
import { useSyncExternalStore } from "react";
import type { Invoice } from "@/lib/mock-data";

export type PaymentMilestone = {
  id: string;
  label: string;
  /** Percentage of invoice total, 0-100 */
  percent: number;
  /** ISO yyyy-mm-dd */
  dueDate: string;
};

export type DraftSchedule = {
  milestones: PaymentMilestone[];
};

const listeners = new Set<() => void>();
let drafts: Invoice[] = [];
const schedules = new Map<string, DraftSchedule>();

function emit() {
  for (const l of listeners) l();
}

export function addDraftInvoice(invoice: Invoice, schedule?: DraftSchedule) {
  drafts = [invoice, ...drafts];
  if (schedule) schedules.set(invoice.id, schedule);
  emit();
}

export function getDraftInvoices(): Invoice[] {
  return drafts;
}

export function getDraftSchedule(id: string): DraftSchedule | undefined {
  return schedules.get(id);
}

export function updateDraftInvoice(id: string, patch: Partial<Invoice>) {
  drafts = drafts.map((d) => (d.id === id ? { ...d, ...patch } : d));
  emit();
}

export function updateDraftSchedule(id: string, schedule: DraftSchedule) {
  schedules.set(id, schedule);
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const EMPTY: Invoice[] = [];

export function useDraftInvoices(): Invoice[] {
  // Use a stable empty array on the server snapshot to satisfy SSR + avoid loops.
  return useSyncExternalStore(
    subscribe,
    () => drafts,
    () => EMPTY,
  );
}

export function useDraftInvoice(id: string | undefined): {
  invoice: Invoice | undefined;
  schedule: DraftSchedule | undefined;
} {
  const list = useSyncExternalStore(
    subscribe,
    () => drafts,
    () => EMPTY,
  );
  if (!id) return { invoice: undefined, schedule: undefined };
  return { invoice: list.find((d) => d.id === id), schedule: schedules.get(id) };
}

export function nextDraftInvoiceNumber(existingCount: number): string {
  return `INV-${String(8000 + existingCount + drafts.length + 1).padStart(4, "0")}`;
}

/** Build a sensible default schedule: 30% deposit, 40% progress, 30% final. */
export function defaultSchedule(startISO: string): DraftSchedule {
  const start = new Date(startISO);
  const day = 86_400_000;
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return {
    milestones: [
      { id: "m1", label: "Deposit", percent: 30, dueDate: fmt(start) },
      { id: "m2", label: "Progress payment", percent: 40, dueDate: fmt(new Date(start.getTime() + 14 * day)) },
      { id: "m3", label: "Final payment", percent: 30, dueDate: fmt(new Date(start.getTime() + 30 * day)) },
    ],
  };
}
