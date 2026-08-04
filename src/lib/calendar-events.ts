// src/lib/calendar-events.ts
//
// Phase 13.2B — Calendar integration of Project planning data (Part 15/16).
// Derives normalized, read-only "planning events" from already-loaded
// Projects/phases/milestones/Tasks at render time — nothing is written to
// the database, so there is no duplicate-record risk and no new table.
// Appointments remain on their own existing model/query path
// (src/lib/appointments-store.ts) — this module only covers the
// derived-from-planning-data side of the Calendar.
import {
  parseDateOnlySafe, differenceInCalendarDaysSafe, todayDateOnly,
} from "@/lib/schedule-health";
import type { ProjectPhase, ProjectMilestone } from "@/lib/project-planning";
import type { Task } from "@/lib/mock-data";
import type { Project } from "@/lib/projects-store";

export type PlanningEventSourceType =
  | "project_start" | "project_end" | "phase_start" | "phase_end" | "milestone" | "task_due";

export type PlanningEventColor = "amber" | "purple" | "indigo" | "teal";

/**
 * One normalized planning event. Deliberately date-only (no time-of-day) —
 * Project/phase/milestone/Task dates are date columns, never timestamps,
 * so this never carries a synthetic midnight-UTC time that could shift a
 * day depending on the viewer's offset (Part 6/30).
 */
export type PlanningCalendarEvent = {
  /** Stable id: sourceType:recordId — used for both React keys and de-duplication (Part 36). */
  id: string;
  sourceType: PlanningEventSourceType;
  title: string;
  /** Local-midnight Date (from parseDateOnlySafe) — never derived via new Date(str)/toISOString(). */
  date: Date;
  colorKey: PlanningEventColor;
  projectId: string;
  projectName: string;
  taskId?: string;
  milestoneId?: string;
  phaseId?: string;
  status?: string;
  isCompleted: boolean;
  isCancelled: boolean;
  isOverdue: boolean;
  assigneeId?: string | null;
};

export type PlanningEventTypeFilter = "project_dates" | "phase_dates" | "milestones" | "tasks";

/** Default-on/off visibility — Tasks/Project target dates on by default; Milestones and individual phase start/end bars off by default (too crowded on Calendar), user can enable either from Event Types. */
export const DEFAULT_PLANNING_VISIBILITY: Record<PlanningEventTypeFilter, boolean> = {
  project_dates: true,
  phase_dates: false,
  milestones: false,
  tasks: true,
};

function eventTypeFilterFor(sourceType: PlanningEventSourceType): PlanningEventTypeFilter {
  if (sourceType === "project_start" || sourceType === "project_end") return "project_dates";
  if (sourceType === "phase_start" || sourceType === "phase_end") return "phase_dates";
  if (sourceType === "milestone") return "milestones";
  return "tasks";
}

/**
 * Builds every planning event from already-loaded org-wide data (Part 35 —
 * no per-Project/per-record queries). Pure/synchronous — callers memoize
 * the result against their loaded projects/phases/milestones/tasks.
 */
export function buildPlanningEvents(params: {
  projects: Project[];
  phases: ProjectPhase[];
  milestones: ProjectMilestone[];
  tasks: Task[];
}): PlanningCalendarEvent[] {
  const { projects, phases, milestones, tasks } = params;
  const today = todayDateOnly();
  const projectsById = new Map(projects.map((p) => [p.id, p]));
  const events: PlanningCalendarEvent[] = [];

  for (const p of projects) {
    const isDone = p.status === "completed";
    const start = parseDateOnlySafe(p.start_date);
    if (start) {
      events.push({
        id: `project_start:${p.id}`, sourceType: "project_start", title: `${p.name} — Start`,
        date: start, colorKey: "teal", projectId: p.id, projectName: p.name,
        isCompleted: false, isCancelled: false, isOverdue: false,
      });
    }
    const end = parseDateOnlySafe(p.end_date);
    if (end) {
      const overdue = !isDone && (differenceInCalendarDaysSafe(today, end) ?? -1) > 0;
      events.push({
        id: `project_end:${p.id}`, sourceType: "project_end", title: `${p.name} — Target Completion`,
        date: end, colorKey: "teal", projectId: p.id, projectName: p.name,
        isCompleted: isDone, isCancelled: false, isOverdue: overdue,
      });
    }
  }

  for (const ph of phases) {
    const project = projectsById.get(ph.projectId);
    if (!project) continue; // Phase belongs to a Project outside the caller's accessible/loaded set — RLS already prevented the row from existing here in practice, this is just defensive.
    const isDone = ph.status === "completed" || ph.status === "skipped";
    const s = parseDateOnlySafe(ph.plannedStartDate);
    if (s) {
      events.push({
        id: `phase_start:${ph.id}`, sourceType: "phase_start", title: `${ph.name} — Starts`,
        date: s, colorKey: "indigo", projectId: ph.projectId, projectName: project.name, phaseId: ph.id,
        status: ph.status, isCompleted: isDone, isCancelled: ph.status === "skipped", isOverdue: false,
      });
    }
    const e = parseDateOnlySafe(ph.plannedEndDate);
    if (e) {
      const overdue = !isDone && (differenceInCalendarDaysSafe(today, e) ?? -1) > 0;
      events.push({
        id: `phase_end:${ph.id}`, sourceType: "phase_end", title: `${ph.name} — Ends`,
        date: e, colorKey: "indigo", projectId: ph.projectId, projectName: project.name, phaseId: ph.id,
        status: ph.status, isCompleted: ph.status === "completed", isCancelled: ph.status === "skipped", isOverdue: overdue,
      });
    }
  }

  for (const m of milestones) {
    const project = projectsById.get(m.projectId);
    if (!project) continue;
    const d = parseDateOnlySafe(m.plannedDate);
    if (!d) continue;
    const overdue = m.status === "pending" && (differenceInCalendarDaysSafe(today, d) ?? -1) > 0;
    events.push({
      id: `milestone:${m.id}`, sourceType: "milestone", title: m.name,
      date: d, colorKey: "purple", projectId: m.projectId, projectName: project.name, milestoneId: m.id,
      status: m.status, isCompleted: m.status === "achieved", isCancelled: m.status === "cancelled", isOverdue: overdue,
    });
  }

  for (const t of tasks) {
    const d = parseDateOnlySafe(t.dueDateRaw);
    if (!d) continue;
    const isDone = t.status === "completed";
    const isCancelled = t.status === "cancelled";
    const overdue = !isDone && !isCancelled && (differenceInCalendarDaysSafe(today, d) ?? -1) > 0;
    const project = t.projectId ? projectsById.get(t.projectId) : undefined;
    events.push({
      id: `task_due:${t.id}`, sourceType: "task_due", title: t.title,
      date: d, colorKey: "amber", projectId: t.projectId ?? "", projectName: project?.name ?? "",
      taskId: t.id, status: t.status, isCompleted: isDone, isCancelled, isOverdue: overdue,
      assigneeId: t.assignedTo ?? null,
    });
  }

  return events;
}

export type PlanningEventTemporalState = "upcoming" | "today" | "overdue" | "completed" | "cancelled";

/**
 * Single shared rule for whether a planning event reads as overdue/
 * warning-worthy — every renderer (Month cell, Week all-day row, Agenda,
 * selected-day panel) calls this instead of separately re-deciding
 * whether to show an AlertTriangle. Recomputes directly from the event's
 * own `date` + a freshly-resolved `today` (date-only, local-midnight —
 * never a UTC timestamp comparison) rather than trusting a boolean that
 * was baked in whenever buildPlanningEvents() last ran, so it can never
 * drift out of sync with "now" or disagree between views (Part 8/9/10).
 * Completed/achieved/cancelled/skipped items are never overdue, no matter
 * how far in the past their date is — an incomplete item is only overdue
 * when its date is strictly before today.
 */
export function getPlanningEventTemporalState(event: PlanningCalendarEvent, today: Date = todayDateOnly()): PlanningEventTemporalState {
  if (event.isCancelled) return "cancelled";
  if (event.isCompleted) return "completed";
  const diff = differenceInCalendarDaysSafe(today, event.date);
  if (diff === null) return "upcoming"; // an unparseable date fails safe — never rendered as a warning
  if (diff > 0) return "overdue";
  if (diff === 0) return "today";
  return "upcoming";
}

/** yyyy-mm-dd key for grouping planning events by day — matches the Calendar page's own `ymd()` convention for appointments so both event families bucket onto the exact same day cells. */
export function planningEventDateKey(e: PlanningCalendarEvent): string {
  return `${e.date.getFullYear()}-${String(e.date.getMonth() + 1).padStart(2, "0")}-${String(e.date.getDate()).padStart(2, "0")}`;
}

export function filterPlanningEvents(
  events: PlanningCalendarEvent[],
  visibility: Record<PlanningEventTypeFilter, boolean>,
  opts: { showCancelled: boolean; assigneeFilter: string; currentUserId: string | null; projectFilter: string },
): PlanningCalendarEvent[] {
  return events.filter((e) => {
    if (!visibility[eventTypeFilterFor(e.sourceType)]) return false;
    if (!opts.showCancelled && e.isCancelled) return false;
    if (opts.projectFilter !== "all" && e.projectId !== opts.projectFilter) return false;
    if (opts.assigneeFilter === "me") {
      if (!opts.currentUserId || e.assigneeId !== opts.currentUserId) return false;
    } else if (opts.assigneeFilter === "unassigned") {
      if (e.sourceType === "task_due" && e.assigneeId) return false;
    } else if (opts.assigneeFilter !== "all") {
      if (e.sourceType === "task_due" && e.assigneeId !== opts.assigneeFilter) return false;
    }
    return true;
  });
}
