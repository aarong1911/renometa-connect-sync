// src/lib/timeline-scale.ts
//
// Phase 13.2B — shared date-scale math for the horizontal Project Timeline.
// One place computing "how many pixels from the left edge is this date" so
// every row (phase bars, task bars, milestone markers, Project markers,
// the Today line) agrees, instead of each row doing its own pixel math.
//
// Deliberately NOT a general-purpose charting library — just enough scale
// logic for a bounded, zoomable operational timeline (Week/Month/Quarter).
import {
  parseDateOnlySafe, differenceInCalendarDaysSafe, todayDateOnly,
} from "@/lib/schedule-health";
import type { ProjectPhase, ProjectMilestone } from "@/lib/project-planning";
import type { Task } from "@/lib/mock-data";
import type { Project } from "@/lib/projects-store";

export type TimelineZoom = "week" | "month" | "quarter";

/** Pixel width of one day at each zoom level — the single source every bar/marker/tick reads from. */
export const DAY_WIDTH_PX: Record<TimelineZoom, number> = {
  week: 64,
  month: 22,
  quarter: 7,
};

/** How many calendar days of padding to show before/after the resolved data range, per zoom (roughly "one visible interval"). */
const PADDING_DAYS: Record<TimelineZoom, number> = {
  week: 7,
  month: 14,
  quarter: 30,
};

function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * Resolves the Timeline's visible [start, end] range from real planning
 * data per the documented precedence (phases → tasks → Project dates →
 * milestones → today), then pads by one visible interval on each side.
 * Returns null when there is truly no scheduled data anywhere — the
 * caller renders the "No scheduled dates yet" empty state instead of an
 * unbounded/empty grid.
 */
export function resolveTimelineRange(params: {
  project: Project;
  phases: ProjectPhase[];
  milestones: ProjectMilestone[];
  tasks: Task[];
  zoom: TimelineZoom;
}): { start: Date; end: Date } | null {
  const { project, phases, milestones, tasks, zoom } = params;
  const dates: Date[] = [];

  for (const p of phases) {
    const s = parseDateOnlySafe(p.plannedStartDate);
    const e = parseDateOnlySafe(p.plannedEndDate);
    if (s) dates.push(s);
    if (e) dates.push(e);
  }
  for (const t of tasks) {
    const s = parseDateOnlySafe(t.startDateRaw);
    const d = parseDateOnlySafe(t.dueDateRaw);
    if (s) dates.push(s);
    if (d) dates.push(d);
  }
  const projStart = parseDateOnlySafe(project.start_date);
  const projEnd = parseDateOnlySafe(project.end_date);
  if (projStart) dates.push(projStart);
  if (projEnd) dates.push(projEnd);
  for (const m of milestones) {
    const d = parseDateOnlySafe(m.plannedDate);
    if (d) dates.push(d);
  }

  if (dates.length === 0) return null;

  let start = dates[0];
  let end = dates[0];
  for (const d of dates) {
    if (d.getTime() < start.getTime()) start = d;
    if (d.getTime() > end.getTime()) end = d;
  }

  // A single-date range (e.g. only one milestone) still needs a visible
  // span — fall back to a minimum window before padding.
  if (start.getTime() === end.getTime()) {
    end = addDays(start, 7);
  }

  const pad = PADDING_DAYS[zoom];
  return { start: addDays(start, -pad), end: addDays(end, pad) };
}

/** Total day count spanned by a resolved range (inclusive), used to size the scrollable track. */
export function rangeDayCount(range: { start: Date; end: Date }): number {
  return Math.max(1, (differenceInCalendarDaysSafe(range.end, range.start) ?? 0) + 1);
}

/** Pixel offset of `date` from the left edge of the track. Dates outside the range clamp to the nearest edge rather than producing a negative/overflowing bar. */
export function dateToX(date: Date, range: { start: Date; end: Date }, zoom: TimelineZoom): number {
  const dayWidth = DAY_WIDTH_PX[zoom];
  const days = differenceInCalendarDaysSafe(date, range.start) ?? 0;
  return Math.max(0, days) * dayWidth;
}

export type TimelineTick = { x: number; label: string; isPeriodStart: boolean };

/**
 * Date-axis ticks for the header row — day labels at Week zoom, week
 * labels at Month zoom, month labels at Quarter zoom. Every row's bars
 * share this same tick geometry, so nothing computes its own labels.
 */
export function buildTimelineTicks(range: { start: Date; end: Date }, zoom: TimelineZoom): TimelineTick[] {
  const dayWidth = DAY_WIDTH_PX[zoom];
  const totalDays = rangeDayCount(range);
  const ticks: TimelineTick[] = [];

  if (zoom === "week") {
    for (let i = 0; i < totalDays; i++) {
      const d = addDays(range.start, i);
      ticks.push({
        x: i * dayWidth,
        label: d.toLocaleDateString("en-US", { weekday: "short", day: "numeric" }),
        isPeriodStart: d.getDate() === 1,
      });
    }
  } else if (zoom === "month") {
    // One tick per week (Monday-anchored) — matches the rest of the app's Mon-start week convention.
    let cursor = new Date(range.start);
    const dow = (cursor.getDay() + 6) % 7;
    cursor = addDays(cursor, -dow);
    while (cursor.getTime() <= range.end.getTime()) {
      const days = differenceInCalendarDaysSafe(cursor, range.start) ?? 0;
      ticks.push({
        x: days * dayWidth,
        label: cursor.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        isPeriodStart: cursor.getDate() <= 7,
      });
      cursor = addDays(cursor, 7);
    }
  } else {
    // Quarter — one tick per month.
    let cursor = new Date(range.start.getFullYear(), range.start.getMonth(), 1);
    while (cursor.getTime() <= range.end.getTime()) {
      const days = differenceInCalendarDaysSafe(cursor, range.start) ?? 0;
      ticks.push({
        x: Math.max(0, days) * dayWidth,
        label: cursor.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
        isPeriodStart: cursor.getMonth() === 0,
      });
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    }
  }
  return ticks;
}

/** Today-line x position, or null when Today falls outside the visible range (the caller simply omits the line). */
export function todayX(range: { start: Date; end: Date }, zoom: TimelineZoom): number | null {
  const today = todayDateOnly();
  if (today.getTime() < range.start.getTime() || today.getTime() > range.end.getTime()) return null;
  return dateToX(today, range, zoom);
}

/** Bar geometry for a [start, end] span — end-before-start swaps safely (Part 6), zero/negative-day spans get a minimum visible width instead of disappearing. */
export function barGeometry(start: Date, end: Date, range: { start: Date; end: Date }, zoom: TimelineZoom): { left: number; width: number } {
  const [s, e] = start.getTime() <= end.getTime() ? [start, end] : [end, start];
  const left = dateToX(s, range, zoom);
  const right = dateToX(e, range, zoom) + DAY_WIDTH_PX[zoom];
  return { left, width: Math.max(right - left, DAY_WIDTH_PX[zoom]) };
}
