// Cross-route in-memory log of reminders sent for scheduled payments.
import { useSyncExternalStore } from "react";

export type ReminderEntry = {
  paymentId: string;
  sentAt: string; // ISO
  actor: string;
};

const listeners = new Set<() => void>();
let log: ReminderEntry[] = [];

function emit() {
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const EMPTY: ReminderEntry[] = [];

export function getReminders(): ReminderEntry[] {
  return log;
}

export function useReminders(): ReminderEntry[] {
  return useSyncExternalStore(
    subscribe,
    () => log,
    () => EMPTY,
  );
}

export function getRemindersFor(paymentId: string): ReminderEntry[] {
  return log.filter((r) => r.paymentId === paymentId);
}

export function logReminder(paymentId: string, actor = "Alex Romero") {
  log = [...log, { paymentId, sentAt: new Date().toISOString(), actor }];
  emit();
}
