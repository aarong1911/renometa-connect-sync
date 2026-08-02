// src/lib/schedule-health.ts
//
// Phase 13.2 continuation — shared, deterministic schedule-health and
// date-safety helpers. One place for "is this Project on track" logic so
// Project detail, board cards, list view, and (eventually) Calendar/
// Command Center never disagree with each other or duplicate unsafe
// `new Date(value)` parsing.
//
// No predictive/AI wording anywhere here — every rule is a plain
// deterministic comparison against named threshold constants below.
import type { Project } from "@/lib/projects-store";
import type { Task } from "@/lib/mock-data";
import { getPhaseDisplayProgress, getBlockingTask, type ProjectPhase, type ProjectMilestone, type TaskDependency } from "@/lib/project-planning";

// ── Date safety ────────────────────────────────────────────────────────

/** Parses a date-only (yyyy-mm-dd) string as a local-midnight Date — never via bare `new Date(value)`, which is the classic source of off-by-one/timezone-shifted date-only values. Returns null for anything falsy or unparseable instead of an Invalid Date. */
export function parseDateOnlySafe(value: string | null | undefined): Date | null {
  if (!value) return null;
  const isoDateOnly = value.length >= 10 ? value.slice(0, 10) : value;
  const d = new Date(`${isoDateOnly}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateOnly(value: string | null | undefined, fallback = "—"): string {
  const d = parseDateOnlySafe(value);
  if (!d) return fallback;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** today - a, in whole calendar days, computed via UTC epoch day numbers so local DST transitions never shift a date-only difference by one. Null if either date is missing. */
export function differenceInCalendarDaysSafe(a: Date | null, b: Date | null): number | null {
  if (!a || !b) return null;
  const msPerDay = 86_400_000;
  const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((utcA - utcB) / msPerDay);
}

export function clampDateRange(start: Date, end: Date): { start: Date; end: Date } {
  return start.getTime() <= end.getTime() ? { start, end } : { start: end, end: start };
}

export function todayDateOnly(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** "Delayed by 4 days" / "1 day" — never negative (callers only pass positive delays), singular/plural correct. */
export function formatDelay(days: number): string {
  const n = Math.max(0, Math.round(days));
  return `${n} day${n === 1 ? "" : "s"}`;
}

// ── Schedule health ───────────────────────────────────────────────────

export type ScheduleHealthStatus = "not_scheduled" | "on_track" | "at_risk" | "delayed" | "completed";

export const SCHEDULE_HEALTH_LABELS: Record<ScheduleHealthStatus, string> = {
  not_scheduled: "Not Scheduled",
  on_track: "On Track",
  at_risk: "At Risk",
  delayed: "Delayed",
  completed: "Completed",
};

/** Named thresholds — every rule in getProjectScheduleHealth() reads from here, never a bare number inline, so the rules stay documented and consistent if tuned later. */
export const SCHEDULE_HEALTH_THRESHOLDS = {
  /** A pending milestone due within this many days (inclusive) is At Risk. */
  atRiskMilestoneDueDays: 3,
  /** A phase whose planned_end_date is within this many days is At Risk. */
  atRiskPhaseDueDays: 3,
  /** Project end_date within this many days, with incomplete work, is At Risk. */
  atRiskProjectEndDays: 7,
  /** An in-progress phase is At Risk when expected-elapsed% exceeds actual progress% by this many points. */
  phaseBehindPercentPoints: 20,
  /** Phases shorter than this (days) are excluded from the elapsed-vs-progress check — too short to judge fairly. */
  minPhaseDurationForElapsedCheck: 2,
};

export type ScheduleHealthResult = {
  status: ScheduleHealthStatus;
  /** Human-readable reasons behind the status — e.g. "2 overdue tasks", "Phase "Rough-In" ends soon". Empty for on_track/completed. */
  reasons: string[];
  /** The largest overdue day-count feeding a "delayed" status; null otherwise. */
  delayDays: number | null;
};

function expectedElapsedPercent(start: Date, end: Date, today: Date): number {
  if (today.getTime() <= start.getTime()) return 0;
  if (today.getTime() >= end.getTime()) return 100;
  const total = differenceInCalendarDaysSafe(end, start) ?? 0;
  if (total <= 0) return 100;
  const elapsed = differenceInCalendarDaysSafe(today, start) ?? 0;
  return Math.min(100, Math.max(0, Math.round((elapsed / total) * 100)));
}

/**
 * Deterministic Project schedule health — see SCHEDULE_HEALTH_THRESHOLDS
 * for every numeric rule. Order of evaluation: Completed → Not Scheduled →
 * Delayed (any overdue item) → At Risk (any near-term/behind-pace item) →
 * On Track. `tasks` must already be Project-scoped (e.g. the same
 * `projectTasks` the Schedule & Tasks tab already computes) — this
 * function does no fetching of its own.
 */
export function getProjectScheduleHealth(params: {
  project: Project;
  phases: ProjectPhase[];
  milestones: ProjectMilestone[];
  tasks: Task[];
}): ScheduleHealthResult {
  const { project, phases, milestones, tasks } = params;
  const today = todayDateOnly();

  if (project.status === "completed") {
    return { status: "completed", reasons: [], delayDays: null };
  }

  const incompleteMilestones = milestones.filter((m) => m.status === "pending");
  const incompleteTasks = tasks.filter((t) => t.status !== "completed" && t.status !== "cancelled");
  const activePhases = phases.filter((p) => p.status !== "completed" && p.status !== "skipped");

  const hasAnySchedule =
    !!project.end_date ||
    phases.some((p) => p.plannedEndDate) ||
    milestones.some((m) => m.plannedDate) ||
    incompleteTasks.some((t) => t.dueDateRaw);

  if (!hasAnySchedule) {
    return { status: "not_scheduled", reasons: [], delayDays: null };
  }

  // ── Delayed — any overdue item ──
  const delayedReasons: string[] = [];
  let maxDelay = 0;

  const projectEnd = parseDateOnlySafe(project.end_date);
  if (projectEnd) {
    const d = differenceInCalendarDaysSafe(today, projectEnd);
    if (d !== null && d > 0) { delayedReasons.push(`Project target completion passed ${formatDelay(d)} ago`); maxDelay = Math.max(maxDelay, d); }
  }

  let overdueMilestoneCount = 0;
  for (const m of incompleteMilestones) {
    const d = differenceInCalendarDaysSafe(today, parseDateOnlySafe(m.plannedDate));
    if (d !== null && d > 0) { overdueMilestoneCount++; maxDelay = Math.max(maxDelay, d); }
  }
  if (overdueMilestoneCount > 0) delayedReasons.push(`${overdueMilestoneCount} overdue milestone${overdueMilestoneCount === 1 ? "" : "s"}`);

  let overdueTaskCount = 0;
  for (const t of incompleteTasks) {
    const d = differenceInCalendarDaysSafe(today, parseDateOnlySafe(t.dueDateRaw));
    if (d !== null && d > 0) { overdueTaskCount++; maxDelay = Math.max(maxDelay, d); }
  }
  if (overdueTaskCount > 0) delayedReasons.push(`${overdueTaskCount} overdue task${overdueTaskCount === 1 ? "" : "s"}`);

  let overduePhaseCount = 0;
  for (const p of activePhases) {
    const d = differenceInCalendarDaysSafe(today, parseDateOnlySafe(p.plannedEndDate));
    if (d !== null && d > 0) { overduePhaseCount++; maxDelay = Math.max(maxDelay, d); }
  }
  if (overduePhaseCount > 0) delayedReasons.push(`${overduePhaseCount} phase${overduePhaseCount === 1 ? "" : "s"} past planned end`);

  if (delayedReasons.length > 0) {
    return { status: "delayed", reasons: delayedReasons, delayDays: maxDelay };
  }

  // ── At Risk — near-term due dates or behind-pace phases ──
  const atRiskReasons: string[] = [];

  for (const m of incompleteMilestones) {
    const d = differenceInCalendarDaysSafe(parseDateOnlySafe(m.plannedDate), today);
    if (d !== null && d >= 0 && d <= SCHEDULE_HEALTH_THRESHOLDS.atRiskMilestoneDueDays) atRiskReasons.push(`Milestone "${m.name}" due soon`);
  }

  for (const p of activePhases) {
    const ps = parseDateOnlySafe(p.plannedStartDate);
    const pe = parseDateOnlySafe(p.plannedEndDate);

    if (ps && pe && p.status === "in_progress") {
      const totalDays = differenceInCalendarDaysSafe(pe, ps) ?? 0;
      if (totalDays > SCHEDULE_HEALTH_THRESHOLDS.minPhaseDurationForElapsedCheck) {
        const expected = expectedElapsedPercent(ps, pe, today);
        const actual = getPhaseDisplayProgress(p, tasks.filter((t) => t.phaseId === p.id));
        if (expected - actual >= SCHEDULE_HEALTH_THRESHOLDS.phaseBehindPercentPoints) {
          atRiskReasons.push(`Phase "${p.name}" is behind schedule`);
        }
      }
    }

    const dueSoon = differenceInCalendarDaysSafe(pe, today);
    if (dueSoon !== null && dueSoon >= 0 && dueSoon <= SCHEDULE_HEALTH_THRESHOLDS.atRiskPhaseDueDays) atRiskReasons.push(`Phase "${p.name}" ends soon`);
  }

  if (projectEnd) {
    const d = differenceInCalendarDaysSafe(projectEnd, today);
    if (d !== null && d >= 0 && d <= SCHEDULE_HEALTH_THRESHOLDS.atRiskProjectEndDays && (incompleteTasks.length > 0 || incompleteMilestones.length > 0)) {
      atRiskReasons.push("Project target completion approaching with incomplete work");
    }
  }

  if (atRiskReasons.length > 0) {
    return { status: "at_risk", reasons: atRiskReasons, delayDays: null };
  }

  return { status: "on_track", reasons: [], delayDays: null };
}

// ── Upcoming work ─────────────────────────────────────────────────────

export function getNextMilestone(milestones: ProjectMilestone[]): ProjectMilestone | null {
  const upcoming = milestones
    .filter((m) => m.status === "pending" && m.plannedDate)
    .map((m) => ({ m, d: parseDateOnlySafe(m.plannedDate) }))
    .filter((x): x is { m: ProjectMilestone; d: Date } => x.d !== null)
    .sort((a, b) => a.d.getTime() - b.d.getTime());
  return upcoming[0]?.m ?? null;
}

export function getNextTask(tasks: Task[]): Task | null {
  const upcoming = tasks
    .filter((t) => t.status !== "completed" && t.status !== "cancelled" && t.dueDateRaw)
    .map((t) => ({ t, d: parseDateOnlySafe(t.dueDateRaw) }))
    .filter((x): x is { t: Task; d: Date } => x.d !== null)
    .sort((a, b) => a.d.getTime() - b.d.getTime());
  return upcoming[0]?.t ?? null;
}

export function getOverdueCounts(milestones: ProjectMilestone[], tasks: Task[]): { milestones: number; tasks: number } {
  const today = todayDateOnly();
  const milestoneCount = milestones.filter((m) => {
    if (m.status !== "pending") return false;
    const d = differenceInCalendarDaysSafe(today, parseDateOnlySafe(m.plannedDate));
    return d !== null && d > 0;
  }).length;
  const taskCount = tasks.filter((t) => {
    if (t.status === "completed" || t.status === "cancelled") return false;
    const d = differenceInCalendarDaysSafe(today, parseDateOnlySafe(t.dueDateRaw));
    return d !== null && d > 0;
  }).length;
  return { milestones: milestoneCount, tasks: taskCount };
}

export function getBlockedTaskCount(tasks: Task[], dependencies: TaskDependency[]): number {
  const tasksById = new Map(tasks.map((t) => [t.id, t]));
  let count = 0;
  for (const t of tasks) {
    if (t.status === "completed" || t.status === "cancelled") continue;
    if (getBlockingTask(t.id, dependencies, tasksById)) count++;
  }
  return count;
}
