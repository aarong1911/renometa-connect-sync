// src/routes/calendar.tsx
//
// Phase 10.3 — Calendar and Appointments Completion. Reads/writes the
// canonical public.appointments table via src/lib/appointments-store.ts.
// New appointment / Edit / Delete are now real (see appointment-dialog.tsx
// and appointment-detail-sheet.tsx) — the old page had all three wired to
// nothing but toasts (New event had no handler at all; Edit showed "coming
// soon"; Delete showed "Event deleted" without ever calling Supabase).
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PageHeader } from "@/components/layout/app-shell";
import {
  ChevronLeft, ChevronRight, RefreshCw, Plus, CheckCircle2,
  Calendar as CalendarIcon, Loader2, Clock, AlertTriangle, ListChecks,
  Flag, CalendarRange, Diamond, SlidersHorizontal, FolderKanban,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useOrganization, useTeam, type TeamMember } from "@/lib/organization";
import { supabase } from "@/lib/supabase";
import { useProjects, type Project } from "@/lib/projects-store";
import { useTasks } from "@/lib/tasks-store";
import type { Task } from "@/lib/mock-data";
// Canonical Task drawer/edit dialog — the same component the global Tasks
// page uses (Phase 13.2C), so a Task event opens in place on Calendar
// instead of navigating away to /tasks.
import { TaskDetailSheet, TaskFormDialog } from "@/components/tasks/task-detail-drawer";
// Canonical Project detail drawer (Phase 13.2D, Part 3) — same component
// the Projects page uses, reused directly (exported from that route file
// rather than extracted, given its size) so milestone/phase/Project-date
// clicks open in place on Calendar instead of navigating to /projects.
import { ProjectDetailSheet } from "@/routes/projects.index";
import { fetchOrgPhases, fetchOrgMilestones, type ProjectPhase, type ProjectMilestone } from "@/lib/project-planning";
import {
  buildPlanningEvents, filterPlanningEvents, planningEventDateKey, getPlanningEventTemporalState, DEFAULT_PLANNING_VISIBILITY,
  type PlanningCalendarEvent, type PlanningEventSourceType, type PlanningEventTypeFilter,
} from "@/lib/calendar-events";
import {
  listAppointments, getAppointment, type Appointment,
} from "@/lib/appointments-store";
import {
  APPOINTMENT_STATUS_ORDER, APPOINTMENT_STATUS_LABELS, APPOINTMENT_STATUS_TINT,
  APPOINTMENT_TYPE_ORDER, APPOINTMENT_TYPE_LABELS, APPOINTMENT_TYPE_ICONS,
  APPOINTMENT_ENTITY_TYPE_LABELS, isActiveAppointmentStatus,
  type AppointmentStatus, type AppointmentType, type AppointmentEntityType,
} from "@/lib/appointment-status";
import { AppointmentDialog } from "@/components/calendar/appointment-dialog";
import { AppointmentDetailSheet } from "@/components/calendar/appointment-detail-sheet";

export const Route = createFileRoute("/calendar")({
  component: CalendarPage,
});

// ── date helpers ──

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function buildWeekDays(anchor: Date): Date[] {
  const day = anchor.getDay();
  const offset = (day + 6) % 7;
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - offset);
  return Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
}
function buildMonthGrid(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const startOffset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - startOffset);
  return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
}
function formatRelative(d: Date, now: Date): string {
  const diff = Math.floor((now.getTime() - d.getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`;
  return `${Math.floor(diff / 86400)} d ago`;
}
function apptDateKey(a: Appointment): string {
  return new Date(a.scheduledAt).toLocaleDateString("en-CA", { timeZone: a.timeZone });
}
function apptTimeLabel(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
}
function apptMinutes(iso: string, tz: string): number {
  const [h, m] = apptTimeLabel(iso, tz).split(":").map(Number);
  return h * 60 + m;
}
/** Never "0 ev"/"0 events" — an empty day shows no count at all. */
function formatDayEventCount(count: number): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? "event" : "events"}`;
}

type ViewMode = "month" | "week" | "day" | "agenda";
type EntityFilter = "all" | "unlinked" | AppointmentEntityType;

// ── Phase 13.2B — planning-event visual registry (Part 26/27) ──
// One place mapping a planning event's sourceType to its icon + restrained
// color accent — every render site (Month cell, Week/Day all-day row,
// Agenda, day panel) reads from here instead of re-deciding per call site.
const PLANNING_EVENT_ICON: Record<PlanningEventSourceType, typeof CalendarIcon> = {
  project_start: Flag, project_end: Flag,
  phase_start: CalendarRange, phase_end: CalendarRange,
  milestone: Diamond,
  task_due: ListChecks,
};
const PLANNING_EVENT_CHIP_TONE: Record<PlanningCalendarEvent["colorKey"], string> = {
  teal: "border-teal-300 bg-teal-50 text-teal-800 dark:border-teal-800 dark:bg-teal-500/10 dark:text-teal-300",
  indigo: "border-indigo-300 bg-indigo-50 text-indigo-800 dark:border-indigo-800 dark:bg-indigo-500/10 dark:text-indigo-300",
  purple: "border-purple-300 bg-purple-50 text-purple-800 dark:border-purple-800 dark:bg-purple-500/10 dark:text-purple-300",
  amber: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-500/10 dark:text-amber-300",
};
/** Accessible source-type prefix (Part 18) — "Milestone: Contract Signed", not just a purple square. Color alone is never the only identifier. */
const PLANNING_EVENT_SOURCE_LABEL: Record<PlanningEventSourceType, string> = {
  project_start: "Project Start", project_end: "Project Target Completion",
  phase_start: "Phase Start", phase_end: "Phase End",
  milestone: "Milestone",
  task_due: "Task",
};
const PLANNING_EVENT_TYPE_LABELS: Record<PlanningEventTypeFilter, string> = {
  project_dates: "Project Dates",
  phase_dates: "Project Phases",
  milestones: "Milestones",
  tasks: "Tasks",
};

/** Friendly status wording for the Agenda/day-panel badge (Part 9) — a
    future pending milestone/task reads "Upcoming", never its raw internal
    status string ("pending"), which could otherwise look like an
    unresolved/warning state even though the temporal rule already treats
    it as normal. */
function temporalStateLabel(event: PlanningCalendarEvent, state: ReturnType<typeof getPlanningEventTemporalState>): string {
  if (state === "overdue") return "Overdue";
  if (state === "today") return "Due Today";
  if (state === "upcoming") return "Upcoming";
  if (state === "cancelled") return "Cancelled";
  // completed — milestone-specific wording reads better than a generic "Completed".
  return event.sourceType === "milestone" ? "Achieved" : "Completed";
}

function PlanningEventChip({ event, onOpen, compact = false }: { event: PlanningCalendarEvent; onOpen: (e: PlanningCalendarEvent) => void; compact?: boolean }) {
  const Icon = PLANNING_EVENT_ICON[event.sourceType];
  // One shared rule decides "overdue" (Part 6/8) — a future or today-dated
  // incomplete item is upcoming, never a warning, regardless of status/color.
  const state = getPlanningEventTemporalState(event);
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onOpen(event); }}
      className={cn(
        "flex w-full items-center gap-1 truncate rounded border px-1 py-0.5 text-left text-[10px] font-medium",
        PLANNING_EVENT_CHIP_TONE[event.colorKey],
        state === "completed" && "opacity-60 line-through",
        state === "cancelled" && "opacity-50",
      )}
      title={`${event.title}${event.projectName ? ` — ${event.projectName}` : ""}${state === "overdue" ? " · Overdue" : ""}`}
      aria-label={`${PLANNING_EVENT_SOURCE_LABEL[event.sourceType]}: ${event.title}${state === "overdue" ? ", Overdue" : ""}`}
    >
      <Icon className="h-2.5 w-2.5 shrink-0" />
      <span className="truncate">{compact ? event.title : event.title}</span>
      {state === "overdue" && <AlertTriangle className="h-2.5 w-2.5 shrink-0 text-destructive" />}
    </button>
  );
}

// ── main page ──

function CalendarPage() {
  const org = useOrganization();
  const teamMembers = useTeam().filter((m) => m.status === "active");

  const today = useMemo(() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), now.getDate()); }, []);
  const [cursor, setCursor] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [view, setView] = useState<ViewMode>("week");
  const [selectedDay, setSelectedDay] = useState<string>(() => ymd(new Date()));
  const [nowTick, setNowTick] = useState<Date | null>(null);

  const [statusFilter, setStatusFilter] = useState<AppointmentStatus | "all">("all");
  const [typeFilter, setTypeFilter] = useState<AppointmentType | "all">("all");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("all");
  const [entityFilter, setEntityFilter] = useState<EntityFilter>("all");
  const [hideCancelled, setHideCancelled] = useState(true);

  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [editingAppointment, setEditingAppointment] = useState<Appointment | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  // Phase 13.2B — Project planning data integration (Part 15/35). Projects
  // and Tasks are already-loaded shared reactive stores (no new query);
  // phases/milestones have no such store yet, so they're fetched once,
  // org-wide, here — matching the "fetch once, filter in memory" shape
  // rather than one query per visible Project.
  const { projects, reload: reloadProjects } = useProjects();
  const projectsById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const allTasks = useTasks();
  const tasksById = useMemo(() => new Map(allTasks.map((t) => [t.id, t])), [allTasks]);
  const allTeamMembers = useTeam();
  const assigneesById = useMemo(() => new Map(allTeamMembers.map((m) => [m.id, m])), [allTeamMembers]);
  const [phases, setPhases] = useState<ProjectPhase[]>([]);
  const [milestones, setMilestones] = useState<ProjectMilestone[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [eventTypeVisibility, setEventTypeVisibility] = useState<Record<PlanningEventTypeFilter, boolean>>(DEFAULT_PLANNING_VISIBILITY);
  const [showAppointments, setShowAppointments] = useState(true);
  // Canonical Task drawer state (Part 2) — Calendar owns these directly
  // instead of navigating away, so a Task event opens in place.
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  // Canonical Project drawer state (Phase 13.2D, Part 2) — same pattern as
  // the Task drawer above: milestone/phase/Project-date events open this
  // in place instead of navigating to /projects.
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [projectDeepLink, setProjectDeepLink] = useState<{
    tab?: "overview" | "financials" | "schedule" | "communications" | "photos";
    subview?: "plan" | "timeline" | "milestones" | "tasks";
    taskId?: string; milestoneId?: string; phaseId?: string;
  } | null>(null);

  useEffect(() => {
    void fetchOrgPhases().then(({ phases: rows }) => setPhases(rows));
    void fetchOrgMilestones().then(({ milestones: rows }) => setMilestones(rows));
    void supabase.auth.getUser().then(({ data }) => setCurrentUserId(data.user?.id ?? null));
  }, []);

  // Keep an open Task drawer in sync with the live tasks-store (Part 11/12)
  // — the same staleness fix used on the Tasks page, so a status/
  // assignment/date change made from the drawer, from the Tasks page, or
  // from drag-and-drop anywhere else is reflected immediately instead of
  // showing whatever the task looked like at click-time. If the task was
  // deleted (from this drawer or elsewhere), it's gone from tasksById —
  // close the drawer rather than keep showing a ghost task (Part 23).
  useEffect(() => {
    if (!selectedTask) return;
    const fresh = tasksById.get(selectedTask.id);
    if (!fresh) { setSelectedTask(null); return; }
    if (fresh !== selectedTask) setSelectedTask(fresh);
  }, [tasksById, selectedTask]);

  // Same reconciliation for an open Project drawer (Part 16/17) — a
  // milestone marked achieved, a date changed, or the Project itself
  // becoming inaccessible all reflect immediately instead of needing a
  // manual refresh; a Project that's gone closes the drawer rather than
  // showing stale data.
  useEffect(() => {
    if (!selectedProject) return;
    const fresh = projectsById.get(selectedProject.id);
    if (!fresh) { setSelectedProject(null); return; }
    if (fresh !== selectedProject) setSelectedProject(fresh);
  }, [projectsById, selectedProject]);

  const planningEvents = useMemo(
    () => buildPlanningEvents({ projects, phases, milestones, tasks: allTasks }),
    [projects, phases, milestones, allTasks],
  );

  const fetchAppointments = useCallback(async () => {
    const rangeStart = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1);
    const rangeEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 2, 0);
    const rows = await listAppointments(rangeStart, rangeEnd);
    setAppointments(rows);
    setLoading(false);
    setLastSynced(new Date());
  }, [cursor]);

  useEffect(() => { void fetchAppointments(); }, [fetchAppointments]);

  useEffect(() => {
    const update = () => setNowTick(new Date());
    update();
    const id = setInterval(update, 60_000);
    return () => clearInterval(id);
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    await fetchAppointments();
    setSyncing(false);
    toast.success("Calendar refreshed", { description: `${appointments.length} appointments loaded` });
  };

  const filtered = useMemo(() => {
    return appointments.filter((a) => {
      if (hideCancelled && a.status === "cancelled") return false;
      if (statusFilter !== "all" && a.status !== statusFilter) return false;
      if (typeFilter !== "all" && a.appointmentType !== typeFilter) return false;
      if (assigneeFilter !== "all") {
        if (assigneeFilter === "unassigned" ? a.assignedTo !== null : a.assignedTo !== assigneeFilter) return false;
      }
      if (entityFilter === "unlinked" && a.entityType !== null) return false;
      if (entityFilter !== "all" && entityFilter !== "unlinked" && a.entityType !== entityFilter) return false;
      return true;
    });
  }, [appointments, hideCancelled, statusFilter, typeFilter, assigneeFilter, entityFilter]);

  const eventsByDay = useMemo(() => {
    const m = new Map<string, Appointment[]>();
    if (!showAppointments) return m;
    filtered.forEach((a) => { const key = apptDateKey(a); const arr = m.get(key) ?? []; arr.push(a); m.set(key, arr); });
    return m;
  }, [filtered, showAppointments]);

  const filteredPlanningEvents = useMemo(
    () => filterPlanningEvents(planningEvents, eventTypeVisibility, {
      showCancelled: !hideCancelled, assigneeFilter, currentUserId, projectFilter: "all",
    }),
    [planningEvents, eventTypeVisibility, hideCancelled, assigneeFilter, currentUserId],
  );

  const planningEventsByDay = useMemo(() => {
    const m = new Map<string, PlanningCalendarEvent[]>();
    filteredPlanningEvents.forEach((e) => { const key = planningEventDateKey(e); const arr = m.get(key) ?? []; arr.push(e); m.set(key, arr); });
    return m;
  }, [filteredPlanningEvents]);

  // The one shared Task-open entry point (Part 2) — every Calendar render
  // site that can produce a task_due click (Month cell, Week/Day all-day
  // chip, Agenda row, selected-day panel card) routes through this same
  // function via openPlanningEvent below, so there is exactly one place
  // that decides how a Task click behaves — never a per-renderer route/
  // navigate call. Looks the task up fresh from tasksById (derived from
  // useTasks(), the shared reactive store) rather than trusting anything
  // cached on the event, so it always reflects the task's current status.
  const openCalendarTask = useCallback((taskId: string) => {
    const task = tasksById.get(taskId);
    if (!task) { toast.error("Task could not be opened"); return; }
    setSelectedTask(task);
  }, [tasksById]);

  // Same pattern as openCalendarTask above, for milestone/phase/Project-date
  // clicks (Phase 13.2D, Part 2/9) — opens the canonical ProjectDetailSheet
  // in place, pre-selecting Schedule & Tasks and the relevant subview,
  // instead of navigating to /projects.
  const openCalendarProject = useCallback((projectId: string, deepLink: NonNullable<typeof projectDeepLink>) => {
    const project = projectsById.get(projectId);
    if (!project) { toast.error("Project could not be opened"); return; }
    setProjectDeepLink(deepLink);
    setSelectedProject(project);
  }, [projectsById]);

  // Task events open the canonical Task drawer in place (Part 2/13); every
  // other planning-event source (milestone/phase/Project date) opens the
  // canonical Project drawer in place (Part 9) — neither ever navigates
  // away from Calendar.
  const openPlanningEvent = useCallback((e: PlanningCalendarEvent) => {
    if (e.sourceType === "task_due") {
      if (!e.taskId) { toast.error("Task could not be opened"); return; }
      openCalendarTask(e.taskId);
      return;
    }
    if (!e.projectId) { toast.error("Project could not be opened"); return; }
    const subview: "timeline" | "milestones" = e.sourceType === "milestone" ? "milestones" : "timeline";
    openCalendarProject(e.projectId, { tab: "schedule", subview, taskId: e.taskId, milestoneId: e.milestoneId, phaseId: e.phaseId });
  }, [openCalendarTask, openCalendarProject]);

  const selectedDate = useMemo(() => parseYmd(selectedDay), [selectedDay]);
  const weekDays = useMemo(() => buildWeekDays(selectedDate), [selectedDate]);
  const daysGrid = useMemo(() => buildMonthGrid(cursor), [cursor]);

  const headerLabel = useMemo(() => {
    if (view === "month") return cursor.toLocaleString("default", { month: "long", year: "numeric" });
    if (view === "day") return selectedDate.toLocaleDateString("default", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    if (view === "agenda") return "Agenda";
    const last = weekDays[6];
    const sameMonth = weekDays[0].getMonth() === last.getMonth();
    const left = weekDays[0].toLocaleDateString("default", { month: "short", day: "numeric" });
    const right = sameMonth ? `${last.getDate()}, ${last.getFullYear()}` : last.toLocaleDateString("default", { month: "short", day: "numeric", year: "numeric" });
    return `${left} – ${right}`;
  }, [view, cursor, selectedDate, weekDays]);

  const shift = (dir: -1 | 1) => {
    if (view === "month" || view === "agenda") {
      setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1));
    } else if (view === "week") {
      const d = new Date(selectedDate); d.setDate(d.getDate() + dir * 7);
      setSelectedDay(ymd(d)); setCursor(new Date(d.getFullYear(), d.getMonth(), 1));
    } else {
      const d = new Date(selectedDate); d.setDate(d.getDate() + dir);
      setSelectedDay(ymd(d)); setCursor(new Date(d.getFullYear(), d.getMonth(), 1));
    }
  };
  const goToday = () => { setSelectedDay(ymd(today)); setCursor(new Date(today.getFullYear(), today.getMonth(), 1)); };

  const openDetail = (id: string) => setDetailId(id);
  const openEdit = async (id: string) => {
    const appt = await getAppointment(id);
    if (!appt) { toast.error("Could not load this appointment"); return; }
    setDetailId(null);
    setEditingAppointment(appt);
  };
  const handleSaved = () => { void fetchAppointments(); };

  // ── KPI cards (Part 16 / 38) — computed over the loaded 3-month window,
  // same range the page already queries; "Today"/"Upcoming"/"Confirmed" are
  // effectively exact since that window always covers the current month.
  const kpis = useMemo(() => {
    const now = nowTick ?? new Date();
    const todayKey = ymd(now);
    const todayCount = appointments.filter((a) => a.status !== "cancelled" && apptDateKey(a) === todayKey).length;
    const upcoming = appointments.filter((a) => isActiveAppointmentStatus(a.status) && new Date(a.scheduledAt).getTime() >= now.getTime());
    const confirmed = appointments.filter((a) => a.status === "confirmed" && new Date(a.scheduledAt).getTime() >= new Date(todayKey).getTime());
    const needsAttention = appointments.filter((a) =>
      a.googleSyncStatus === "failed" ||
      (isActiveAppointmentStatus(a.status) && !a.assignedTo && new Date(a.scheduledAt).getTime() >= now.getTime()),
    );
    return { today: todayCount, upcoming: upcoming.length, confirmed: confirmed.length, needsAttention: needsAttention.length };
  }, [appointments, nowTick]);

  const selectedEvents = (eventsByDay.get(selectedDay) ?? []).slice().sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  // Day panel sections (Part 24) — split the day's planning events into the
  // same Tasks/Milestones/Project Events groupings the filter row uses.
  const selectedDayPlanning = planningEventsByDay.get(selectedDay) ?? [];
  const selectedTasks = selectedDayPlanning.filter((e) => e.sourceType === "task_due");
  const selectedMilestones = selectedDayPlanning.filter((e) => e.sourceType === "milestone");
  const selectedProjectEvents = selectedDayPlanning.filter((e) => e.sourceType !== "task_due" && e.sourceType !== "milestone");
  const totalSelectedCount = selectedEvents.length + selectedDayPlanning.length;

  if (loading) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5 overflow-hidden">
      <div className="flex-none">
        <PageHeader
          title="Calendar"
          subtitle="Schedule appointments, tasks, milestones, and Project dates."
          icon={CalendarIcon}
          iconBg="bg-cyan-soft"
          iconColor="text-cyan-soft-foreground"
          actions={
            <Button size="sm" className="h-8" onClick={() => setCreateOpen(true)}>
              <Plus className="h-3.5 w-3.5" /><span className="text-xs">New Appointment</span>
            </Button>
          }
        />
      </div>

      {/* Compact summary strip (Part 20) — same metrics, ~35% shorter than the previous KPI cards. */}
      <div className="grid flex-none grid-cols-2 gap-2 sm:grid-cols-4">
        <KpiCard label="Today" value={kpis.today} icon={CalendarIcon} tint="text-blue-600 bg-blue-50 dark:text-blue-400 dark:bg-blue-500/10" />
        <KpiCard label="Upcoming" value={kpis.upcoming} icon={Clock} tint="text-cyan-600 bg-cyan-50 dark:text-cyan-400 dark:bg-cyan-500/10" />
        <KpiCard label="Confirmed" value={kpis.confirmed} icon={CheckCircle2} tint="text-emerald-600 bg-emerald-50 dark:text-emerald-400 dark:bg-emerald-500/10" />
        <KpiCard label="Needs Attention" value={kpis.needsAttention} icon={AlertTriangle} tint="text-amber-600 bg-amber-50 dark:text-amber-400 dark:bg-amber-500/10" />
      </div>

      {/* Navigation + view toolbar (Part 21) — a distinct platform control
          surface. bg-secondary/40 (previous attempt) was invisible: the
          page canvas (--background: #F7F8FA) and --secondary (slate-100,
          oklch 0.967) are nearly the same lightness, so a 40%-opacity
          secondary tint barely showed. bg-primary-soft (the platform's
          "blue-50" token, already used for icon tiles elsewhere) is a
          distinctly different hue/lightness from both the page and the
          white Card-based filter row/grid below, at full opacity so it
          reads as one solid, intentional bar edge to edge. Each
          interactive cluster (nav group, view switcher) keeps its own
          bg-background pill so it visibly "floats" on that surface. */}
      <div className="grid flex-none grid-cols-1 items-center gap-2 rounded-lg border border-border bg-primary-soft px-3 py-2 sm:grid-cols-[1fr_auto_1fr]">
        <div className="flex min-w-0 items-center gap-2.5 justify-self-start">
          <Button variant="outline" size="sm" className="h-8 shrink-0 bg-background text-xs shadow-sm" onClick={goToday}>Today</Button>
          <div className="flex shrink-0 items-center overflow-hidden rounded-md border border-border bg-background shadow-sm">
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-none hover:bg-muted" onClick={() => shift(-1)} aria-label="Previous"><ChevronLeft className="h-4 w-4" /></Button>
            <div className="h-5 w-px bg-border" />
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-none hover:bg-muted" onClick={() => shift(1)} aria-label="Next"><ChevronRight className="h-4 w-4" /></Button>
          </div>
          <h2 className="truncate text-[15px] font-semibold leading-none text-foreground">{headerLabel}</h2>
        </div>

        {/* View switcher — centered on the FULL toolbar width (grid center
            column), not just in whatever space happens to be left over
            after the nav group. No parent border/bg/shadow around the
            group anymore — the toolbar's own bg-primary-soft surface is
            the containing element now; only the active button itself gets
            a visible state, using the same warm-cream active-tab language
            as the Tasks page top-level views and the Project Schedule &
            Tasks subview tabs (data-[state=active]:bg-[#FAF3E4]), adapted
            to ToggleGroup's on/off state attribute. */}
        <ToggleGroup type="single" value={view} onValueChange={(v) => v && setView(v as ViewMode)} className="flex items-center gap-1 justify-self-center">
          <ToggleGroupItem value="month" className="h-8 rounded-md px-3 text-xs font-medium text-muted-foreground hover:bg-background/70 hover:text-foreground data-[state=on]:border data-[state=on]:border-[#EADFC8] data-[state=on]:bg-[#FAF3E4] data-[state=on]:font-semibold data-[state=on]:text-foreground data-[state=on]:shadow-sm">Month</ToggleGroupItem>
          <ToggleGroupItem value="week" className="h-8 rounded-md px-3 text-xs font-medium text-muted-foreground hover:bg-background/70 hover:text-foreground data-[state=on]:border data-[state=on]:border-[#EADFC8] data-[state=on]:bg-[#FAF3E4] data-[state=on]:font-semibold data-[state=on]:text-foreground data-[state=on]:shadow-sm">Week</ToggleGroupItem>
          <ToggleGroupItem value="day" className="h-8 rounded-md px-3 text-xs font-medium text-muted-foreground hover:bg-background/70 hover:text-foreground data-[state=on]:border data-[state=on]:border-[#EADFC8] data-[state=on]:bg-[#FAF3E4] data-[state=on]:font-semibold data-[state=on]:text-foreground data-[state=on]:shadow-sm">Day</ToggleGroupItem>
          <ToggleGroupItem value="agenda" className="h-8 rounded-md px-3 text-xs font-medium text-muted-foreground hover:bg-background/70 hover:text-foreground data-[state=on]:border data-[state=on]:border-[#EADFC8] data-[state=on]:bg-[#FAF3E4] data-[state=on]:font-semibold data-[state=on]:text-foreground data-[state=on]:shadow-sm">Agenda</ToggleGroupItem>
        </ToggleGroup>

        <div className="flex items-center justify-self-start sm:justify-self-end">
          <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground hover:bg-background hover:text-foreground" onClick={handleSync} disabled={syncing}>
            <RefreshCw className={cn("h-3.5 w-3.5", syncing && "animate-spin")} />
            <span className="text-xs">{syncing ? "Syncing…" : "Refresh"}</span>
          </Button>
        </div>
      </div>

      {/* Filters (Part 17/22) — Event Types first (Appointments/Tasks/Milestones/Project Phases/Project Dates), then the existing appointment-specific filters. */}
      <div className="flex flex-none flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 text-xs">
              <SlidersHorizontal className="h-3.5 w-3.5" /> Event Types
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-56 space-y-2 p-3">
            <label className="flex items-center justify-between gap-2 text-xs">
              <span>Appointments</span>
              <Checkbox checked={showAppointments} onCheckedChange={(v) => setShowAppointments(!!v)} />
            </label>
            {(Object.keys(PLANNING_EVENT_TYPE_LABELS) as PlanningEventTypeFilter[]).map((key) => (
              <label key={key} className="flex items-center justify-between gap-2 text-xs">
                <span>{PLANNING_EVENT_TYPE_LABELS[key]}</span>
                <Checkbox
                  checked={eventTypeVisibility[key]}
                  onCheckedChange={(v) => setEventTypeVisibility((prev) => ({ ...prev, [key]: !!v }))}
                />
              </label>
            ))}
          </PopoverContent>
        </Popover>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as AppointmentStatus | "all")}>
          <SelectTrigger className="h-8 w-[140px] text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {APPOINTMENT_STATUS_ORDER.map((s) => <SelectItem key={s} value={s}>{APPOINTMENT_STATUS_LABELS[s]}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as AppointmentType | "all")}>
          <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {APPOINTMENT_TYPE_ORDER.map((t) => <SelectItem key={t} value={t}>{APPOINTMENT_TYPE_LABELS[t]}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={assigneeFilter} onValueChange={setAssigneeFilter}>
          <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All assignees</SelectItem>
            <SelectItem value="unassigned">Unassigned</SelectItem>
            {teamMembers.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={entityFilter} onValueChange={(v) => setEntityFilter(v as EntityFilter)}>
          <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All related records</SelectItem>
            <SelectItem value="unlinked">Unlinked</SelectItem>
            {(Object.keys(APPOINTMENT_ENTITY_TYPE_LABELS) as AppointmentEntityType[]).map((e) => (
              <SelectItem key={e} value={e}>{APPOINTMENT_ENTITY_TYPE_LABELS[e]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox checked={!hideCancelled} onCheckedChange={(v) => setHideCancelled(!v)} /> Show cancelled
        </label>

        {/* Milestone legend (Part 10/11) — explains what the purple planning
            events mean without requiring a click. Source-type color only;
            never implies overdue/warning on its own (Part 14). */}
        <span
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
          title="Purple events are Project milestones"
        >
          <Diamond className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" aria-hidden="true" />
          Milestone
        </span>

        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <CheckCircle2 className="h-3.5 w-3.5 text-success" />
          {lastSynced ? `Last refreshed ${nowTick ? formatRelative(lastSynced, nowTick) : "recently"}` : "Loading…"} · {filtered.length} appointments
        </span>
      </div>

      {/* Main grid */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[1fr_320px]">
        {view === "month" && (
          <Card className="flex flex-col overflow-hidden p-0">
            <div className="grid flex-shrink-0 grid-cols-7 border-b border-border bg-secondary/40">
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
                <div key={d} className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{d}</div>
              ))}
            </div>
            <div className="grid flex-1 grid-cols-7 auto-rows-fr overflow-y-auto">
              {daysGrid.map((cell, i) => {
                const inMonth = cell.getMonth() === cursor.getMonth();
                const key = ymd(cell);
                const dayAppts = eventsByDay.get(key) ?? [];
                const dayPlanning = planningEventsByDay.get(key) ?? [];
                const totalCount = dayAppts.length + dayPlanning.length;
                const isWeekend = cell.getDay() === 0 || cell.getDay() === 6;
                const isToday = ymd(today) === key;
                const isSelected = selectedDay === key;
                const visibleAppts = dayAppts.slice(0, 3);
                const visiblePlanning = dayPlanning.slice(0, Math.max(0, 3 - visibleAppts.length));
                const overflow = totalCount - visibleAppts.length - visiblePlanning.length;
                const monthCellCountLabel = formatDayEventCount(totalCount);
                return (
                  <button key={i} onClick={() => setSelectedDay(key)}
                    aria-label={monthCellCountLabel ? `${cell.toLocaleDateString("default", { weekday: "long", month: "long", day: "numeric" })}, ${monthCellCountLabel}` : cell.toLocaleDateString("default", { weekday: "long", month: "long", day: "numeric" })}
                    aria-pressed={isSelected}
                    className={cn(
                      "min-h-0 border-b border-r border-border p-1.5 text-left transition-colors hover:bg-secondary/40",
                      !inMonth && "bg-muted/30 text-muted-foreground",
                      isWeekend && inMonth && "bg-muted/10",
                      isSelected && "bg-primary/5 ring-1 ring-inset ring-primary/40",
                      (i + 1) % 7 === 0 && "border-r-0",
                      i >= daysGrid.length - 7 && "border-b-0",
                    )}
                  >
                    <div className="mb-1 flex items-center justify-between">
                      <span className={cn("inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-medium", isToday && "bg-primary text-primary-foreground")}>
                        {cell.getDate()}
                      </span>
                      {totalCount > 0 && <span className="text-[10px] text-muted-foreground">{totalCount}</span>}
                    </div>
                    <div className="space-y-0.5">
                      {visibleAppts.map((a) => (
                        <div key={a.id} onClick={(e) => { e.stopPropagation(); openDetail(a.id); }}
                          className={cn("truncate rounded border px-1 py-0.5 text-[10px] font-medium", APPOINTMENT_STATUS_TINT[a.status].chip)}>
                          {apptTimeLabel(a.scheduledAt, a.timeZone)} {a.title}
                        </div>
                      ))}
                      {visiblePlanning.map((e) => <PlanningEventChip key={e.id} event={e} onOpen={openPlanningEvent} compact />)}
                      {overflow > 0 && <div className="px-1 text-[10px] text-muted-foreground">+{overflow} more</div>}
                    </div>
                  </button>
                );
              })}
            </div>
          </Card>
        )}

        {view === "week" && (
          <TimeGrid days={weekDays} today={today} now={nowTick} selectedDay={selectedDay} onSelectDay={setSelectedDay} eventsByDay={eventsByDay} planningEventsByDay={planningEventsByDay} onOpen={openDetail} onOpenPlanning={openPlanningEvent} />
        )}
        {view === "day" && (
          <TimeGrid days={[selectedDate]} today={today} now={nowTick} selectedDay={selectedDay} onSelectDay={setSelectedDay} eventsByDay={eventsByDay} planningEventsByDay={planningEventsByDay} onOpen={openDetail} onOpenPlanning={openPlanningEvent} />
        )}
        {view === "agenda" && (
          <AgendaView appointments={showAppointments ? filtered : []} planningEvents={filteredPlanningEvents} onOpen={openDetail} onOpenPlanning={openPlanningEvent} />
        )}

        {/* Side card — day detail (Month/Week/Day views only; Agenda already shows everything) */}
        {view !== "agenda" && (
          <Card className="flex min-h-0 flex-col overflow-hidden p-0">
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5">
              <CalendarIcon className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">
                {parseYmd(selectedDay).toLocaleDateString("default", { weekday: "long", month: "short", day: "numeric" })}
              </h3>
              <span className="ml-auto text-[11px] text-muted-foreground">
                {totalSelectedCount === 0 ? "No events" : `${totalSelectedCount} event${totalSelectedCount !== 1 ? "s" : ""}`}
              </span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
              {totalSelectedCount === 0 ? (
                <div className="flex flex-col items-center gap-2 py-10 text-center">
                  <CalendarIcon className="h-7 w-7 text-muted-foreground/40" />
                  <p className="text-xs text-muted-foreground">Nothing scheduled for this day</p>
                  <p className="text-[11px] text-muted-foreground">Appointments, tasks, milestones, and Project dates for this day will appear here.</p>
                  <Button size="sm" variant="outline" className="mt-1 h-7 text-xs" onClick={() => setCreateOpen(true)}>
                    <Plus className="h-3 w-3" /> New appointment
                  </Button>
                </div>
              ) : (
                <div className="space-y-4">
                  {selectedEvents.length > 0 && (
                    <DayPanelSection label="Appointments" count={selectedEvents.length}>
                      {selectedEvents.map((a) => <AppointmentCard key={a.id} appointment={a} onOpen={() => openDetail(a.id)} />)}
                    </DayPanelSection>
                  )}
                  {selectedTasks.length > 0 && (
                    <DayPanelSection label="Tasks" count={selectedTasks.length}>
                      {selectedTasks.map((e) => <DayPanelPlanningCard key={e.id} event={e} onOpen={() => openPlanningEvent(e)} />)}
                    </DayPanelSection>
                  )}
                  {selectedMilestones.length > 0 && (
                    <DayPanelSection label="Milestones" count={selectedMilestones.length}>
                      {selectedMilestones.map((e) => <DayPanelPlanningCard key={e.id} event={e} onOpen={() => openPlanningEvent(e)} />)}
                    </DayPanelSection>
                  )}
                  {selectedProjectEvents.length > 0 && (
                    <DayPanelSection label="Project Events" count={selectedProjectEvents.length}>
                      {selectedProjectEvents.map((e) => <DayPanelPlanningCard key={e.id} event={e} onOpen={() => openPlanningEvent(e)} />)}
                    </DayPanelSection>
                  )}
                </div>
              )}
            </div>
          </Card>
        )}
      </div>

      <AppointmentDialog open={createOpen} onOpenChange={setCreateOpen} onSaved={handleSaved} />
      <AppointmentDialog
        open={!!editingAppointment}
        onOpenChange={(o) => { if (!o) setEditingAppointment(null); }}
        appointment={editingAppointment}
        onSaved={handleSaved}
      />
      <AppointmentDetailSheet
        open={!!detailId}
        onOpenChange={(o) => { if (!o) setDetailId(null); }}
        appointmentId={detailId}
        onEdit={() => detailId && void openEdit(detailId)}
        onChanged={handleSaved}
      />

      {/* Canonical Task drawer/edit dialog (Part 2/3/7) — same component the
          global Tasks page uses. Calendar itself never navigates away;
          updateTask()/completeTask()/etc. update the shared tasks-store,
          which re-renders every planning event (Month/Week/Agenda/day
          panel) derived from it immediately. */}
      <TaskDetailSheet
        task={selectedTask}
        assigneesById={assigneesById}
        onClose={() => setSelectedTask(null)}
        onEdit={(t) => { setSelectedTask(null); setEditingTask(t); }}
      />
      <TaskFormDialog
        key={editingTask?.id ?? "closed"}
        open={editingTask !== null}
        task={editingTask}
        projects={projects}
        onClose={() => setEditingTask(null)}
      />

      {/* Canonical Project drawer (Part 3/15) — same component the
          Projects page uses. Milestone/phase/Project-date clicks land here
          pre-selected to Schedule & Tasks → Milestones/Timeline; closing
          just clears local state, no navigation, so Calendar's view/date/
          filters/selected day are never touched. */}
      <ProjectDetailSheet
        project={selectedProject}
        open={selectedProject !== null}
        onClose={() => { setSelectedProject(null); setProjectDeepLink(null); }}
        onReload={reloadProjects}
        onProjectUpdated={setSelectedProject}
        deepLink={projectDeepLink}
        onDeepLinkConsumed={() => setProjectDeepLink(null)}
      />
    </div>
  );
}

// ── KPI card ──

function KpiCard({ label, value, icon: Icon, tint }: { label: string; value: number; icon: typeof CalendarIcon; tint: string }) {
  return (
    <Card className="flex items-center gap-2 px-2.5 py-1.5">
      <div className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-md", tint)}>
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className="text-sm font-semibold leading-tight">{value}</span>
        <span className="truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      </div>
    </Card>
  );
}

// ── day panel sections (Part 24) ──

function DayPanelSection({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  return (
    <div>
      <h4 className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label} <span className="text-muted-foreground/70">· {count}</span>
      </h4>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function DayPanelPlanningCard({ event, onOpen }: { event: PlanningCalendarEvent; onOpen: () => void }) {
  const Icon = PLANNING_EVENT_ICON[event.sourceType];
  const state = getPlanningEventTemporalState(event);
  return (
    <button onClick={onOpen} className="w-full rounded-lg border border-border bg-background p-3 text-left space-y-1.5 hover:bg-secondary/30 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className={cn("truncate text-xs font-semibold leading-snug", state === "completed" && "text-muted-foreground line-through")}>{event.title}</span>
        </div>
        <Badge variant="outline" className={cn("h-5 shrink-0 rounded border px-1.5 text-[10px]", PLANNING_EVENT_CHIP_TONE[event.colorKey])}>
          {temporalStateLabel(event, state)}
        </Badge>
      </div>
      {event.projectName && (
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <FolderKanban className="h-3 w-3" /> {event.projectName}
        </div>
      )}
    </button>
  );
}

// ── appointment side card ──

function AppointmentCard({ appointment: a, onOpen }: { appointment: Appointment; onOpen: () => void }) {
  const TypeIcon = APPOINTMENT_TYPE_ICONS[a.appointmentType];
  const tint = APPOINTMENT_STATUS_TINT[a.status];
  return (
    <button onClick={onOpen} className="w-full rounded-lg border border-border bg-background p-3 text-left space-y-2 hover:bg-secondary/30 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold leading-snug">{a.contactName || a.title}</div>
          <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
            <TypeIcon className="h-3 w-3" /> {APPOINTMENT_TYPE_LABELS[a.appointmentType]}
          </div>
        </div>
        <Badge variant="outline" className={cn("h-5 shrink-0 rounded border px-1.5 text-[10px]", tint.badge)}>
          {APPOINTMENT_STATUS_LABELS[a.status]}
        </Badge>
      </div>
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Clock className="h-3 w-3" />
        <span className="font-medium tabular-nums text-foreground">{apptTimeLabel(a.scheduledAt, a.timeZone)}–{apptTimeLabel(a.endsAt, a.timeZone)}</span>
        {a.assigneeName && <><span>·</span><span className="truncate">{a.assigneeName}</span></>}
      </div>
    </button>
  );
}

// ── time grid (Week/Day) ──

const HOUR_PX = 44;
const HOURS = Array.from({ length: 24 }, (_, i) => i);
/** Single source of truth for the time gutter + seven day columns — the
    header, all-day row, and timed grid all read this same value so they
    can never drift out of alignment with each other (Part 5/6). */
const CALENDAR_TIME_GUTTER_PX = 48;
const WEEK_HEADER_H = 52;

function weekGridTemplate(dayCount: number): string {
  return `${CALENDAR_TIME_GUTTER_PX}px repeat(${dayCount}, minmax(0, 1fr))`;
}

function TimeGrid({
  days, today, now, selectedDay, onSelectDay, eventsByDay, planningEventsByDay, onOpen, onOpenPlanning,
}: {
  days: Date[]; today: Date; now: Date | null;
  selectedDay: string; onSelectDay: (d: string) => void;
  eventsByDay: Map<string, Appointment[]>;
  planningEventsByDay: Map<string, PlanningCalendarEvent[]>;
  onOpen: (id: string) => void;
  onOpenPlanning: (e: PlanningCalendarEvent) => void;
}) {
  const todayKey = ymd(today);
  const nowMinutes = now ? now.getHours() * 60 + now.getMinutes() : null;
  const nowTop = nowMinutes !== null ? (nowMinutes / 60) * HOUR_PX : 0;
  const nowLabel = now ? now.toLocaleTimeString("default", { hour: "numeric", minute: "2-digit" }) : "";
  const hasAllDay = days.some((d) => (planningEventsByDay.get(ymd(d)) ?? []).length > 0);
  const gridTemplate = weekGridTemplate(days.length);

  return (
    <Card className="flex flex-col overflow-hidden p-0">
      {/* Header, all-day row, and the timed grid all live inside this one
          overflow-y-auto container (Part 7/8) — a scrollbar reduces the
          content width of whatever box it's attached to, so keeping the
          header as a separate, non-scrolling sibling (the previous
          structure) meant it stayed full-width while the timed grid below
          it got squeezed by the scrollbar, drifting the day columns out of
          alignment. Sharing one scroll container means both the sticky
          header and the grid are squeezed identically, so the seven
          columns always line up regardless of scrollbar width. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className="sticky top-0 z-20 grid border-b border-border bg-secondary/40"
          style={{ gridTemplateColumns: gridTemplate, height: WEEK_HEADER_H }}
        >
          <div className="border-r border-border" />
          {days.map((d) => {
            const key = ymd(d);
            const isToday = ymd(today) === key;
            const isSelected = selectedDay === key;
            const dayCount = (eventsByDay.get(key) ?? []).length + (planningEventsByDay.get(key) ?? []).length;
            const countLabel = formatDayEventCount(dayCount);
            const weekdayFull = d.toLocaleDateString("default", { weekday: "long", month: "long", day: "numeric" });
            return (
              <button
                key={key}
                onClick={() => onSelectDay(key)}
                aria-label={countLabel ? `${weekdayFull}, ${countLabel}` : weekdayFull}
                aria-pressed={isSelected}
                className={cn("border-l border-border px-2 py-1.5 text-left transition-colors hover:bg-secondary", isSelected && "bg-primary/5")}
              >
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{d.toLocaleDateString("default", { weekday: "short" })}</div>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <span className={cn("inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-medium", isToday && "bg-primary text-primary-foreground")}>{d.getDate()}</span>
                  {countLabel && <span className="truncate text-[10px] text-muted-foreground">{countLabel}</span>}
                </div>
              </button>
            );
          })}
        </div>
        {/* All-day row — Project planning events (date-only, never placed on the hour grid). Part 23/26/30. */}
        {hasAllDay && (
          <div className="grid shrink-0 gap-px border-b border-border bg-border/50" style={{ gridTemplateColumns: gridTemplate }}>
            <div className="bg-card px-1 py-1 text-[9px] font-medium uppercase text-muted-foreground">All day</div>
            {days.map((d) => {
              const key = ymd(d);
              const dayPlanning = planningEventsByDay.get(key) ?? [];
              return (
                <div key={key} className="space-y-0.5 bg-card p-1">
                  {dayPlanning.slice(0, 3).map((e) => <PlanningEventChip key={e.id} event={e} onOpen={onOpenPlanning} />)}
                  {dayPlanning.length > 3 && <div className="px-1 text-[10px] text-muted-foreground">+{dayPlanning.length - 3} more</div>}
                </div>
              );
            })}
          </div>
        )}
        <div className="grid" style={{ gridTemplateColumns: gridTemplate }}>
          <div className="relative border-r border-border" style={{ height: HOUR_PX * 24 }}>
            {HOURS.map((h) => (
              <div key={h} className="absolute right-1 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground" style={{ top: h * HOUR_PX }}>
                {h === 0 ? "" : `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`}
              </div>
            ))}
          </div>
          {days.map((d) => {
            const key = ymd(d);
            const dayEvents = (eventsByDay.get(key) ?? []).slice().sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
            const showNow = nowMinutes !== null && key === todayKey;
            return (
              <div key={key} className="relative border-l border-border" style={{ height: HOUR_PX * 24 }}>
                {HOURS.map((h) => (<div key={h} className="absolute inset-x-0 border-t border-border/60" style={{ top: h * HOUR_PX }} />))}
                {dayEvents.map((a) => {
                  const startMin = apptMinutes(a.scheduledAt, a.timeZone);
                  const endMin = Math.max(apptMinutes(a.endsAt, a.timeZone), startMin + 30);
                  const top = (startMin / 60) * HOUR_PX;
                  const height = ((endMin - startMin) / 60) * HOUR_PX - 2;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => onOpen(a.id)}
                      className={cn("absolute left-1 right-1 cursor-pointer overflow-hidden rounded border px-1.5 py-1 text-left text-[10px] shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40", APPOINTMENT_STATUS_TINT[a.status].chip)}
                      style={{ top, height }}
                    >
                      <div className="truncate font-semibold">{a.contactName || a.title}</div>
                      <div className="truncate opacity-80">{apptTimeLabel(a.scheduledAt, a.timeZone)}–{apptTimeLabel(a.endsAt, a.timeZone)} · {a.title}</div>
                    </button>
                  );
                })}
                {showNow && (
                  <div className="pointer-events-none absolute inset-x-0 z-10 flex items-center" style={{ top: nowTop }}>
                    <span className="-ml-1 h-2 w-2 rounded-full bg-destructive shadow-[0_0_0_2px_var(--background)]" />
                    <span className="h-px flex-1 bg-destructive" />
                    <span className="ml-1 rounded bg-destructive px-1 py-0.5 text-[9px] font-semibold text-destructive-foreground">{nowLabel}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

// ── agenda view ──

function AgendaView({
  appointments, planningEvents, onOpen, onOpenPlanning,
}: {
  appointments: Appointment[];
  planningEvents: PlanningCalendarEvent[];
  onOpen: (id: string) => void;
  onOpenPlanning: (e: PlanningCalendarEvent) => void;
}) {
  const grouped = useMemo(() => {
    const apptMap = new Map<string, Appointment[]>();
    appointments.forEach((a) => { const key = apptDateKey(a); const arr = apptMap.get(key) ?? []; arr.push(a); apptMap.set(key, arr); });
    const planMap = new Map<string, PlanningCalendarEvent[]>();
    planningEvents.forEach((e) => { const key = planningEventDateKey(e); const arr = planMap.get(key) ?? []; arr.push(e); planMap.set(key, arr); });

    const allKeys = new Set([...apptMap.keys(), ...planMap.keys()]);
    return Array.from(allKeys).sort().map((date) => ({
      date,
      appts: (apptMap.get(date) ?? []).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)),
      planning: planMap.get(date) ?? [],
    }));
  }, [appointments, planningEvents]);

  if (grouped.length === 0) {
    return (
      <Card className="flex flex-col items-center justify-center gap-2 p-10 text-center">
        <CalendarIcon className="h-7 w-7 text-muted-foreground/40" />
        <p className="text-xs text-muted-foreground">Nothing scheduled</p>
        <p className="text-[11px] text-muted-foreground">Appointments, tasks, milestones, and Project dates will appear here.</p>
      </Card>
    );
  }

  return (
    <Card className="min-h-0 overflow-y-auto p-0">
      <div className="divide-y divide-border">
        {grouped.map(({ date, appts, planning }) => (
          <div key={date} className="p-3">
            <h4 className="mb-2 text-xs font-semibold text-muted-foreground">
              {parseYmd(date).toLocaleDateString("default", { weekday: "long", month: "short", day: "numeric" })}
            </h4>
            <div className="space-y-1.5">
              {planning.map((e) => {
                const Icon = PLANNING_EVENT_ICON[e.sourceType];
                const state = getPlanningEventTemporalState(e);
                return (
                  <button
                    key={e.id}
                    onClick={() => onOpenPlanning(e)}
                    className="flex w-full items-center gap-3 rounded-md border border-border p-2 text-left hover:bg-secondary/30 transition-colors"
                  >
                    <span className="w-16 shrink-0 text-[11px] font-medium text-muted-foreground">All day</span>
                    <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className={cn("min-w-0 flex-1 truncate text-xs font-medium", state === "completed" && "text-muted-foreground line-through")}>{e.title}</span>
                    {e.projectName && <span className="hidden shrink-0 truncate text-[11px] text-muted-foreground sm:inline">{e.projectName}</span>}
                    <Badge variant="outline" className={cn("h-5 shrink-0 rounded border px-1.5 text-[10px]", PLANNING_EVENT_CHIP_TONE[e.colorKey])}>
                      {temporalStateLabel(e, state)}
                    </Badge>
                  </button>
                );
              })}
              {appts.map((a) => {
                const TypeIcon = APPOINTMENT_TYPE_ICONS[a.appointmentType];
                const tint = APPOINTMENT_STATUS_TINT[a.status];
                return (
                  <button
                    key={a.id}
                    onClick={() => onOpen(a.id)}
                    className="flex w-full items-center gap-3 rounded-md border border-border p-2 text-left hover:bg-secondary/30 transition-colors"
                  >
                    <span className="w-16 shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">
                      {apptTimeLabel(a.scheduledAt, a.timeZone)}–{apptTimeLabel(a.endsAt, a.timeZone)}
                    </span>
                    <TypeIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">{a.title}</span>
                    {a.assigneeName && <span className="hidden shrink-0 truncate text-[11px] text-muted-foreground sm:inline">{a.assigneeName}</span>}
                    {a.address && <span className="hidden shrink-0 max-w-[160px] truncate text-[11px] text-muted-foreground md:inline">{a.address}</span>}
                    <Badge variant="outline" className={cn("h-5 shrink-0 rounded border px-1.5 text-[10px]", tint.badge)}>
                      {APPOINTMENT_STATUS_LABELS[a.status]}
                    </Badge>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
