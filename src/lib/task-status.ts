// src/lib/task-status.ts
//
// Canonical task-status configuration — the ONE place status labels,
// order, icons, and lifecycle (completed_at) rules are defined. Replaces
// the old app-level vocabulary (todo/review/done), which never matched
// the live `tasks_status_check` constraint
// (`status IN ('not_started','in_progress','on_hold','completed','cancelled')`)
// and caused every "Mark complete" click to fail with Postgres error 23514
// (`toDbStatus("done")` returned the literal string "done", not a value
// the constraint accepts). The database's own values are now used
// end-to-end — see tasks-store.ts, which no longer translates at all.

import {
  Circle, LoaderCircle, PauseCircle, CircleCheck, CircleX, type LucideIcon,
} from "lucide-react";

export type TaskStatus = "not_started" | "in_progress" | "on_hold" | "completed" | "cancelled";

export const TASK_STATUS_ORDER: TaskStatus[] = [
  "not_started", "in_progress", "on_hold", "completed", "cancelled",
];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  not_started: "Not Started",
  in_progress: "In Progress",
  on_hold: "On Hold",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const TASK_STATUS_DESCRIPTIONS: Record<TaskStatus, string> = {
  not_started: "Not yet started",
  in_progress: "Actively being worked on",
  on_hold: "Temporarily paused or blocked",
  completed: "Finished",
  cancelled: "No longer needed",
};

export const TASK_STATUS_ICONS: Record<TaskStatus, LucideIcon> = {
  not_started: Circle,
  in_progress: LoaderCircle,
  on_hold: PauseCircle,
  completed: CircleCheck,
  cancelled: CircleX,
};

/** Soft-accent tint per status — icon/badge/column-header tokens, matching the Pipeline stage-tint pattern (soft background, no saturated fills, no beige). */
export const TASK_STATUS_TINT: Record<TaskStatus, { icon: string; iconBg: string; headerBg: string; border: string; badge: string }> = {
  not_started: {
    icon: "text-slate-600 dark:text-slate-400", iconBg: "bg-slate-100 dark:bg-slate-500/15",
    headerBg: "bg-slate-50/70 dark:bg-slate-500/5", border: "border-slate-200/70 dark:border-slate-800/60",
    badge: "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-800 dark:bg-slate-500/10 dark:text-slate-400",
  },
  in_progress: {
    icon: "text-amber-600 dark:text-amber-400", iconBg: "bg-amber-100 dark:bg-amber-500/15",
    headerBg: "bg-amber-50/70 dark:bg-amber-500/5", border: "border-amber-200/70 dark:border-amber-900/40",
    badge: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/40 dark:bg-amber-500/10 dark:text-amber-400",
  },
  on_hold: {
    icon: "text-violet-600 dark:text-violet-400", iconBg: "bg-violet-100 dark:bg-violet-500/15",
    headerBg: "bg-violet-50/70 dark:bg-violet-500/5", border: "border-violet-200/70 dark:border-violet-900/40",
    badge: "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900/40 dark:bg-violet-500/10 dark:text-violet-400",
  },
  completed: {
    icon: "text-emerald-600 dark:text-emerald-400", iconBg: "bg-emerald-100 dark:bg-emerald-500/15",
    headerBg: "bg-emerald-50/70 dark:bg-emerald-500/5", border: "border-emerald-200/70 dark:border-emerald-900/40",
    badge: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-500/10 dark:text-emerald-400",
  },
  cancelled: {
    icon: "text-rose-600 dark:text-rose-400", iconBg: "bg-rose-100 dark:bg-rose-500/15",
    headerBg: "bg-rose-50/70 dark:bg-rose-500/5", border: "border-rose-200/70 dark:border-rose-900/40",
    badge: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/40 dark:bg-rose-500/10 dark:text-rose-400",
  },
};

/** A task counts as "active/open" for overdue and KPI purposes. */
export function isActiveStatus(status: TaskStatus): boolean {
  return status !== "completed" && status !== "cancelled";
}

/**
 * Central lifecycle rule for completed_at — the ONE place this is decided,
 * used by Mark complete / Reopen / Cancel / Restore / the status selector /
 * drag-and-drop, so none of them duplicate or disagree on the rule.
 */
export function getTaskStatusPatch(
  nextStatus: TaskStatus,
  existingCompletedAt?: string | null,
): { status: TaskStatus; completedAt: string | null } {
  if (nextStatus === "completed") {
    return { status: nextStatus, completedAt: existingCompletedAt ?? new Date().toISOString() };
  }
  // cancelled, or any active status (not_started/in_progress/on_hold) —
  // completed_at is only ever meaningful while status === "completed".
  return { status: nextStatus, completedAt: null };
}
