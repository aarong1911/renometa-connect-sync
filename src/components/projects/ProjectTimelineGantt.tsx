// src/components/projects/ProjectTimelineGantt.tsx
//
// Phase 13.2B — the real horizontal Project Timeline (Part 3/4). A bounded
// operational Gantt-style view, not an enterprise scheduling tool: no
// drag-resize, no dependency-line routing, no critical path. Left pane
// (row labels, fixed) + right pane (date axis + bars/markers, scrolls
// horizontally) with a synced vertical scroll between the two, one shared
// date-scale (src/lib/timeline-scale.ts) driving every row's geometry.
import { useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Flag, Diamond, CircleDashed, Ban } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { Task } from "@/lib/mock-data";
import type { Project } from "@/lib/projects-store";
import {
  type ProjectPhase, type ProjectMilestone, type TaskDependency, type PhaseStatus, type MilestoneStatus,
  PHASE_STATUS_LABELS, MILESTONE_STATUS_LABELS, getPhaseDisplayProgress, getBlockingTask,
} from "@/lib/project-planning";
import {
  parseDateOnlySafe, differenceInCalendarDaysSafe, todayDateOnly, formatDateOnly, formatDelay,
} from "@/lib/schedule-health";
import {
  type TimelineZoom, DAY_WIDTH_PX, resolveTimelineRange, rangeDayCount, dateToX, buildTimelineTicks, todayX, barGeometry,
} from "@/lib/timeline-scale";
import { TASK_STATUS_LABELS, isActiveStatus } from "@/lib/task-status";

const ZOOMS: { id: TimelineZoom; label: string }[] = [
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "quarter", label: "Quarter" },
];

const ROW_H = 32;
const AXIS_H = 28;
const BODY_MAX_H = 440;
const LEFT_PANE_W = 216;

/** Formats an already-local-midnight Date directly — never round-trips through toISOString()/UTC, which would shift date-only values by a day depending on the viewer's offset (Part 6). */
function formatDateObj(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const PHASE_BAR_TONE: Record<PhaseStatus, string> = {
  not_started: "bg-blue-100 border-blue-300 dark:bg-blue-500/15 dark:border-blue-800",
  in_progress: "bg-blue-500 border-blue-600",
  completed: "bg-emerald-500 border-emerald-600",
  on_hold: "bg-amber-400 border-amber-500",
  skipped: "bg-muted border-border",
};

const MILESTONE_TONE: Record<MilestoneStatus, string> = {
  pending: "border-2 border-purple-400 bg-white dark:bg-background",
  achieved: "bg-emerald-500 border-emerald-600",
  missed: "bg-destructive border-destructive",
  cancelled: "bg-muted border-border",
};

type Row =
  | { kind: "project" }
  | { kind: "phase"; phase: ProjectPhase }
  | { kind: "milestone"; milestone: ProjectMilestone; indent: boolean }
  | { kind: "task"; task: Task; indent: boolean }
  | { kind: "section"; label: string };

function rowKey(row: Row): string {
  if (row.kind === "project") return "project";
  if (row.kind === "phase") return `phase:${row.phase.id}`;
  if (row.kind === "milestone") return `milestone:${row.milestone.id}`;
  if (row.kind === "task") return `task:${row.task.id}`;
  return `section:${row.label}`;
}

export function ProjectTimelineGantt({
  project, phases, milestones, tasks, dependencies, onSelectSubview,
}: {
  project: Project;
  phases: ProjectPhase[];
  milestones: ProjectMilestone[];
  tasks: Task[];
  dependencies: TaskDependency[];
  onSelectSubview: (subview: "plan" | "milestones" | "tasks") => void;
}) {
  const [zoom, setZoom] = useState<TimelineZoom>("month");
  const [collapsedPhases, setCollapsedPhases] = useState<Set<string>>(new Set());
  const leftScrollRef = useRef<HTMLDivElement>(null);
  const rightScrollRef = useRef<HTMLDivElement>(null);
  const syncingRef = useRef<"left" | "right" | null>(null);

  const today = todayDateOnly();
  const tasksById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const range = useMemo(
    () => resolveTimelineRange({ project, phases, milestones, tasks, zoom }),
    [project, phases, milestones, tasks, zoom],
  );

  const rows: Row[] = useMemo(() => {
    const list: Row[] = [];
    if (project.start_date || project.end_date) list.push({ kind: "project" });

    const tasksByPhase = new Map<string, Task[]>();
    const milestonesByPhase = new Map<string, ProjectMilestone[]>();
    for (const t of tasks) if (t.phaseId) { const arr = tasksByPhase.get(t.phaseId) ?? []; arr.push(t); tasksByPhase.set(t.phaseId, arr); }
    for (const m of milestones) if (m.phaseId) { const arr = milestonesByPhase.get(m.phaseId) ?? []; arr.push(m); milestonesByPhase.set(m.phaseId, arr); }

    for (const phase of phases) {
      list.push({ kind: "phase", phase });
      if (!collapsedPhases.has(phase.id)) {
        for (const m of milestonesByPhase.get(phase.id) ?? []) list.push({ kind: "milestone", milestone: m, indent: true });
        for (const t of tasksByPhase.get(phase.id) ?? []) list.push({ kind: "task", task: t, indent: true });
      }
    }

    const unassignedTasks = tasks.filter((t) => !t.phaseId);
    const unassignedMilestones = milestones.filter((m) => !m.phaseId);
    if (unassignedTasks.length > 0 || unassignedMilestones.length > 0) {
      list.push({ kind: "section", label: "Unassigned" });
      for (const m of unassignedMilestones) list.push({ kind: "milestone", milestone: m, indent: false });
      for (const t of unassignedTasks) list.push({ kind: "task", task: t, indent: false });
    }
    return list;
  }, [project, phases, milestones, tasks, collapsedPhases]);

  if (!range) {
    return (
      <div className="rounded-lg border border-dashed border-border py-12 text-center">
        <p className="text-sm text-muted-foreground">No scheduled dates yet</p>
        <p className="mt-1 text-xs text-muted-foreground">Add dates to phases, milestones, tasks, or the Project to build the Timeline.</p>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => onSelectSubview("plan")}>Add Phase dates</Button>
          <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => onSelectSubview("milestones")}>Add Milestone</Button>
          <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => onSelectSubview("tasks")}>Add Task due date</Button>
        </div>
      </div>
    );
  }

  const trackWidth = rangeDayCount(range) * DAY_WIDTH_PX[zoom];
  const ticks = buildTimelineTicks(range, zoom);
  const todayLeft = todayX(range, zoom);
  const bodyHeight = rows.length * ROW_H;

  const syncScroll = (from: "left" | "right") => {
    if (syncingRef.current === from) return;
    const source = from === "left" ? leftScrollRef.current : rightScrollRef.current;
    const target = from === "left" ? rightScrollRef.current : leftScrollRef.current;
    if (!source || !target) return;
    syncingRef.current = from;
    target.scrollTop = source.scrollTop;
    requestAnimationFrame(() => { syncingRef.current = null; });
  };

  const toggleCollapsed = (phaseId: string) =>
    setCollapsedPhases((prev) => { const next = new Set(prev); if (next.has(phaseId)) next.delete(phaseId); else next.add(phaseId); return next; });

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {formatDateObj(range.start)} – {formatDateObj(range.end)}
        </p>
        <div
          role="radiogroup"
          aria-label="Timeline zoom"
          className="flex h-8 items-center rounded-md border border-border bg-card p-0.5"
        >
          {ZOOMS.map((z) => (
            <button
              key={z.id}
              type="button"
              role="radio"
              aria-checked={zoom === z.id}
              onClick={() => setZoom(z.id)}
              className={cn(
                "h-7 rounded px-2.5 text-xs font-medium transition-colors",
                zoom === z.id ? "bg-primary-soft text-primary" : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              {z.label}
            </button>
          ))}
        </div>
      </div>

      {/* Semantic fallback for screen readers / accessibility (Part 14) — the
          visual bar chart below is supplemented, not replaced, by a plain
          list conveying the same name/type/date-range/status information. */}
      <ul className="sr-only">
        {rows.filter((r): r is Extract<Row, { kind: "phase" | "milestone" | "task" | "project" }> => r.kind !== "section").map((row) => (
          <li key={rowKey(row)}>{describeRowForA11y(row, today, project)}</li>
        ))}
      </ul>

      <div className="flex overflow-hidden rounded-lg border border-border" aria-hidden="true">
        {/* Left fixed pane */}
        <div className="shrink-0 border-r border-border bg-card" style={{ width: LEFT_PANE_W }}>
          <div className="border-b border-border bg-secondary/40" style={{ height: AXIS_H }} />
          <div
            ref={leftScrollRef}
            className="overflow-y-auto overscroll-contain"
            style={{ maxHeight: BODY_MAX_H }}
            onScroll={() => syncScroll("left")}
          >
            {rows.map((row) => (
              <LeftLabelRow
                key={rowKey(row)}
                row={row}
                collapsed={row.kind === "phase" && collapsedPhases.has(row.phase.id)}
                onToggleCollapse={row.kind === "phase" ? () => toggleCollapsed(row.phase.id) : undefined}
                dependencies={dependencies}
                tasksById={tasksById}
              />
            ))}
          </div>
        </div>

        {/* Right scrollable pane */}
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div style={{ width: Math.max(trackWidth, 1) }}>
            <div className="relative border-b border-border bg-secondary/40" style={{ height: AXIS_H }}>
              {ticks.map((tick, i) => (
                <div
                  key={i}
                  className={cn("absolute top-0 h-full border-l text-[10px] leading-none text-muted-foreground", tick.isPeriodStart ? "border-border font-medium" : "border-border/40")}
                  style={{ left: tick.x }}
                >
                  <span className="ml-1 inline-block pt-2">{tick.label}</span>
                </div>
              ))}
              {todayLeft !== null && (
                <div className="pointer-events-none absolute top-0 h-full border-l-2 border-destructive" style={{ left: todayLeft }} />
              )}
            </div>

            <div
              ref={rightScrollRef}
              className="overflow-y-auto overscroll-contain"
              style={{ maxHeight: BODY_MAX_H }}
              onScroll={() => syncScroll("right")}
            >
              <div className="relative" style={{ width: Math.max(trackWidth, 1), height: bodyHeight }}>
                {todayLeft !== null && (
                  <div
                    className="pointer-events-none absolute top-0 z-10 border-l-2 border-destructive/70"
                    style={{ left: todayLeft, height: bodyHeight }}
                    aria-label="Today"
                  />
                )}
                {rows.map((row, i) => (
                  <div key={rowKey(row)} className="absolute left-0 right-0 border-b border-border/50" style={{ top: i * ROW_H, height: ROW_H, width: trackWidth }}>
                    <RowBar row={row} range={range} zoom={zoom} today={today} dependencies={dependencies} tasksById={tasksById} onSelectSubview={onSelectSubview} tasks={tasks} project={project} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function describeRowForA11y(row: Extract<Row, { kind: "phase" | "milestone" | "task" | "project" }>, today: Date, project: Project): string {
  if (row.kind === "project") {
    return `Project: ${project.name}, ${formatDateOnly(project.start_date)} to ${formatDateOnly(project.end_date)}`;
  }
  if (row.kind === "phase") {
    const p = row.phase;
    return `Phase: ${p.name}, ${PHASE_STATUS_LABELS[p.status]}, ${formatDateOnly(p.plannedStartDate)} to ${formatDateOnly(p.plannedEndDate)}`;
  }
  if (row.kind === "milestone") {
    const m = row.milestone;
    return `Milestone: ${m.name}, ${MILESTONE_STATUS_LABELS[m.status]}, planned ${formatDateOnly(m.plannedDate)}`;
  }
  const t = row.task;
  const overdue = t.status !== "completed" && t.status !== "cancelled" && t.dueDateRaw && (differenceInCalendarDaysSafe(today, parseDateOnlySafe(t.dueDateRaw)) ?? -1) > 0;
  return `Task: ${t.title}, ${TASK_STATUS_LABELS[t.status]}${t.dueDateRaw ? `, due ${formatDateOnly(t.dueDateRaw)}` : ", not scheduled"}${overdue ? ", overdue" : ""}`;
}

function LeftLabelRow({
  row, collapsed, onToggleCollapse, dependencies, tasksById,
}: {
  row: Row;
  collapsed: boolean;
  onToggleCollapse?: () => void;
  dependencies: TaskDependency[];
  tasksById: Map<string, Task>;
}) {
  if (row.kind === "section") {
    return (
      <div style={{ height: ROW_H }} className="flex items-center border-b border-border/50 bg-muted/20 px-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {row.label}
      </div>
    );
  }
  if (row.kind === "project") {
    return (
      <div style={{ height: ROW_H }} className="flex items-center gap-1.5 border-b border-border/50 px-2 text-xs font-semibold">
        <Flag className="h-3 w-3 shrink-0 text-teal-600" />
        <span className="truncate">Project</span>
      </div>
    );
  }
  if (row.kind === "phase") {
    return (
      <button
        type="button"
        onClick={onToggleCollapse}
        style={{ height: ROW_H }}
        className="flex w-full items-center gap-1 border-b border-border/50 px-2 text-left text-xs font-semibold hover:bg-muted/40"
      >
        {collapsed ? <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />}
        <span className="truncate">{row.phase.name}</span>
      </button>
    );
  }
  if (row.kind === "milestone") {
    return (
      <div style={{ height: ROW_H }} className={cn("flex items-center gap-1.5 border-b border-border/50 px-2 text-xs", row.indent && "pl-6")}>
        <Diamond className="h-3 w-3 shrink-0 text-purple-500" />
        <span className="truncate text-muted-foreground">{row.milestone.name}</span>
      </div>
    );
  }
  const blocker = getBlockingTask(row.task.id, dependencies, tasksById);
  return (
    <div style={{ height: ROW_H }} className={cn("flex items-center gap-1.5 border-b border-border/50 px-2 text-xs", row.indent && "pl-6")}>
      {blocker ? <Ban className="h-3 w-3 shrink-0 text-destructive" /> : <CircleDashed className="h-3 w-3 shrink-0 text-muted-foreground" />}
      <span className={cn("truncate text-muted-foreground", row.task.status === "completed" && "line-through")}>{row.task.title}</span>
    </div>
  );
}

function RowBar({
  row, range, zoom, today, dependencies, tasksById, onSelectSubview, tasks, project,
}: {
  row: Row;
  range: { start: Date; end: Date };
  zoom: TimelineZoom;
  today: Date;
  dependencies: TaskDependency[];
  tasksById: Map<string, Task>;
  onSelectSubview: (subview: "plan" | "milestones" | "tasks") => void;
  tasks: Task[];
  project: Project;
}) {
  if (row.kind === "section") return null;

  if (row.kind === "project") {
    const s = parseDateOnlySafe(project.start_date);
    const e = parseDateOnlySafe(project.end_date);
    if (!s && !e) return null;
    const anchor = s ?? e!;
    const other = e ?? s!;
    const { left, width } = barGeometry(anchor, other, range, zoom);
    const title = `${project.name} — Start ${formatDateOnly(project.start_date)} → Target completion ${formatDateOnly(project.end_date)}`;
    return (
      <div
        title={title}
        className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-full border-2 border-teal-500 bg-teal-500/20"
        style={{ left, width }}
      />
    );
  }

  if (row.kind === "phase") {
    const p = row.phase;
    const s = parseDateOnlySafe(p.plannedStartDate);
    const e = parseDateOnlySafe(p.plannedEndDate);
    if (!s && !e) return <div className="flex h-full items-center px-2 text-[11px] text-muted-foreground">Not scheduled</div>;
    const anchor = s ?? e!;
    const other = e ?? s!;
    const { left, width } = barGeometry(anchor, other, range, zoom);
    const isDelayed = p.status !== "completed" && p.status !== "skipped" && e && (differenceInCalendarDaysSafe(today, e) ?? -1) > 0;
    const progress = p.status === "in_progress" ? getPhaseDisplayProgress(p, tasks.filter((t) => t.phaseId === p.id)) : null;
    return (
      <button
        type="button"
        onClick={() => onSelectSubview("plan")}
        title={`${p.name} — ${PHASE_STATUS_LABELS[p.status]} · ${formatDateOnly(p.plannedStartDate)} → ${formatDateOnly(p.plannedEndDate)}${p.actualStartDate || p.actualEndDate ? ` · Actual: ${formatDateOnly(p.actualStartDate)} → ${formatDateOnly(p.actualEndDate)}` : ""}${isDelayed ? " · Delayed" : ""}`}
        className={cn(
          "absolute top-1/2 h-4 -translate-y-1/2 overflow-hidden rounded border text-left",
          PHASE_BAR_TONE[p.status],
          isDelayed && "ring-2 ring-destructive/60",
        )}
        style={{ left, width }}
      >
        {progress !== null && <div className="h-full bg-blue-700/70" style={{ width: `${progress}%` }} />}
      </button>
    );
  }

  if (row.kind === "milestone") {
    const m = row.milestone;
    const d = parseDateOnlySafe(m.plannedDate);
    if (!d) return <div className="flex h-full items-center px-2 text-[11px] text-muted-foreground">Not scheduled</div>;
    const x = dateToX(d, range, zoom);
    const overdue = m.status === "pending" && (differenceInCalendarDaysSafe(today, d) ?? -1) > 0;
    return (
      <button
        type="button"
        onClick={() => onSelectSubview("milestones")}
        title={`${m.name} — ${MILESTONE_STATUS_LABELS[m.status]} · Planned ${formatDateOnly(m.plannedDate)}${m.completedAt ? ` · Completed ${formatDateOnly(m.completedAt)}` : ""}${overdue ? ` · Overdue by ${formatDelay(differenceInCalendarDaysSafe(today, d) ?? 0)}` : ""}`}
        className={cn(
          "absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[2px]",
          MILESTONE_TONE[m.status],
          overdue && "ring-2 ring-destructive/60",
        )}
        style={{ left: x + DAY_WIDTH_PX[zoom] / 2 }}
      />
    );
  }

  // task
  const t = row.task;
  const s = parseDateOnlySafe(t.startDateRaw);
  const d = parseDateOnlySafe(t.dueDateRaw);
  const blocker = getBlockingTask(t.id, dependencies, tasksById);
  const overdue = t.status !== "completed" && t.status !== "cancelled" && d && (differenceInCalendarDaysSafe(today, d) ?? -1) > 0;
  const tone = t.status === "completed" ? "bg-emerald-500 border-emerald-600" : blocker ? "bg-slate-300 border-slate-400 dark:bg-slate-600 dark:border-slate-500" : "bg-amber-400 border-amber-500";

  if (!s && !d) {
    return <div className="flex h-full items-center px-2 text-[11px] text-muted-foreground">Not scheduled</div>;
  }

  const title = `${t.title} — ${TASK_STATUS_LABELS[t.status]}${t.dueDateRaw ? ` · Due ${formatDateOnly(t.dueDateRaw)}` : ""}${t.completedAt ? ` · Completed ${formatDateOnly(t.completedAt)}` : ""}${blocker ? ` · Blocked by "${blocker.title}"` : ""}${overdue ? ` · Overdue by ${formatDelay(differenceInCalendarDaysSafe(today, d!) ?? 0)}` : ""}`;

  if (s && d) {
    const { left, width } = barGeometry(s, d, range, zoom);
    return (
      <button
        type="button"
        onClick={() => onSelectSubview("tasks")}
        title={title}
        className={cn("absolute top-1/2 h-3 -translate-y-1/2 rounded border", tone, overdue && "ring-2 ring-destructive/60")}
        style={{ left, width }}
      />
    );
  }

  // deadline-only or start-only marker
  const anchor = d ?? s!;
  const x = dateToX(anchor, range, zoom);
  return (
    <button
      type="button"
      onClick={() => onSelectSubview("tasks")}
      title={title}
      className={cn("absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2", tone, overdue && "ring-2 ring-destructive/60")}
      style={{ left: x + DAY_WIDTH_PX[zoom] / 2 }}
    />
  );
}
