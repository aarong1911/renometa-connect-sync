import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DragDropContext,
  Droppable,
  Draggable,
  type DropResult,
} from "@hello-pangea/dnd";
import {
  Plus,
  Search,
  LayoutGrid,
  List as ListIcon,
  MoreHorizontal,
  Trash2,
  Calendar as CalendarIcon,
  CheckSquare,
  ListChecks,
  CircleCheck,
  CircleAlert,
  UserRound,
  Handshake,
  FolderKanban,
  Link2Off,
  Ban,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  AlertCircle,
} from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/lib/supabase";
import {
  parseDateOnlySafe, differenceInCalendarDaysSafe, todayDateOnly, formatDateOnly, formatDelay,
} from "@/lib/schedule-health";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { cn } from "@/lib/utils";
import type { Task } from "@/lib/mock-data";
import { useProjects } from "@/lib/projects-store";
import {
  useTasks,
  updateTask,
  deleteTask,
  completeTask,
  reopenTask,
  cancelTask,
  restoreTask,
} from "@/lib/tasks-store";
import { useLeads } from "@/lib/leads-store";
import { useDeals } from "@/lib/deals-store";
import { useTeam, type TeamMember } from "@/lib/organization";
import {
  TASK_STATUS_ORDER, TASK_STATUS_LABELS, TASK_STATUS_ICONS, TASK_STATUS_TINT,
  isActiveStatus, type TaskStatus,
} from "@/lib/task-status";
// Canonical Task drawer/edit dialog — shared with Calendar (Phase 13.2C) so
// both pages open the exact same component instead of Calendar navigating
// away or forking its own copy. See that file for the full dependency list.
import {
  TaskDetailSheet, TaskFormDialog, RelatedToCell,
  fmtDue, fmtDueOrNone, projectName, resolveAssigneeName, handleStatusMutation,
  PRIORITIES, type Priority,
} from "@/components/tasks/task-detail-drawer";
import { projectDetailLink } from "@/lib/routes";

export const Route = createFileRoute("/tasks")({
  component: TasksPage,
});

type View = "board" | "list";
type RelatedFilter = "all" | "unlinked" | "lead" | "deal" | "project";

const PRIORITY_TINT: Record<Priority, string> = {
  low: "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-800 dark:bg-slate-500/10 dark:text-slate-400",
  med: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/40 dark:bg-amber-500/10 dark:text-amber-400",
  high: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/40 dark:bg-rose-500/10 dark:text-rose-400",
};

// Audit finding: Task.due (from tasks-store.ts) is NEVER actually empty —
// it silently falls back to created_at when no due_date was set, so the
// previous isOverdue(task.due, ...)/isDueToday(task.due, ...) calls marked
// every undated task "overdue" (created_at is always in the past). These
// now take the real, nullable due date (task.dueDateRaw) and use the
// shared date-safety helpers from schedule-health.ts — no dated task is
// ever misclassified, and undated tasks are simply never overdue/due
// soon/due today.
function isOverdue(dueRaw: string | null | undefined, status: TaskStatus) {
  if (!isActiveStatus(status)) return false;
  const d = parseDateOnlySafe(dueRaw);
  if (!d) return false;
  const diff = differenceInCalendarDaysSafe(todayDateOnly(), d);
  return diff !== null && diff > 0;
}

function isDueToday(dueRaw: string | null | undefined) {
  const d = parseDateOnlySafe(dueRaw);
  if (!d) return false;
  return d.getTime() === todayDateOnly().getTime();
}

function isDueWithinDays(dueRaw: string | null | undefined, status: TaskStatus, days: number) {
  if (!isActiveStatus(status)) return false;
  const d = parseDateOnlySafe(dueRaw);
  if (!d) return false;
  const diff = differenceInCalendarDaysSafe(d, todayDateOnly());
  return diff !== null && diff >= 0 && diff <= days;
}

function isProjectTask(task: Task): boolean {
  return Boolean(task.projectId || task.phaseId || task.milestoneId);
}

/** Full-wording form for cards/drawer: "Assigned to X" or "Unassigned". */
function getTaskAssigneeDisplay(task: Task, assigneesById: Map<string, TeamMember>): string {
  const name = resolveAssigneeName(task, assigneesById);
  return name ? `Assigned to ${name}` : "Unassigned";
}

function initialsFromName(name: string): string {
  const initials = name.trim().split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  return initials || "—";
}

function priorityClass(p: Priority) {
  return PRIORITY_TINT[p];
}

type TopView = "my" | "due_soon" | "overdue" | "all";
type GroupBy = "status" | "project";
type DueFilter = "any" | "overdue" | "today" | "7d" | "14d" | "none";

const TOP_VIEWS: { id: TopView; label: string }[] = [
  { id: "my", label: "My Tasks" },
  { id: "due_soon", label: "Due Soon" },
  { id: "overdue", label: "Overdue" },
  { id: "all", label: "All Tasks" },
];

const DEFAULT_COLUMN_LIMIT = 8;
const COLUMN_LIMIT_STEP = 10;
const PROJECT_GROUP_COLLAPSE_THRESHOLD = 5;

// Part 10 priority order: overdue > due today > due within 14 days >
// (blocked — omitted; task_dependencies aren't loaded on this page and
// fetching them broadly would be an N+1 risk, see final report) > assigned
// to current user > any other dated task > undated tasks. Within a rank,
// soonest due date first. Task has no client-exposed created_at, so the
// final, stable tie-breaker is task id — arbitrary but deterministic.
function compareTasks(a: Task, b: Task, currentUserId: string | null): number {
  const rank = (t: Task) => {
    if (isOverdue(t.dueDateRaw, t.status)) return 0;
    if (isDueToday(t.dueDateRaw) && isActiveStatus(t.status)) return 1;
    if (isDueWithinDays(t.dueDateRaw, t.status, 14)) return 2;
    if (currentUserId && t.assignedTo === currentUserId) return 3;
    if (t.dueDateRaw) return 4;
    return 5;
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;

  if (a.dueDateRaw && b.dueDateRaw) {
    const da = parseDateOnlySafe(a.dueDateRaw);
    const db = parseDateOnlySafe(b.dueDateRaw);
    if (da && db && da.getTime() !== db.getTime()) return da.getTime() - db.getTime();
  }

  return a.id.localeCompare(b.id);
}

function groupSummary(groupTasks: Task[]) {
  const open = groupTasks.filter((t) => isActiveStatus(t.status)).length;
  const overdue = groupTasks.filter((t) => isOverdue(t.dueDateRaw, t.status)).length;
  const dueThisWeek = groupTasks.filter((t) => isDueWithinDays(t.dueDateRaw, t.status, 7)).length;
  return { open, overdue, dueThisWeek };
}

function TasksPage() {
  const { projects } = useProjects();
  const tasks = useTasks();
  const allTeamMembers = useTeam();
  const teamMembers = allTeamMembers.filter((m) => m.status === "active");
  // Unfiltered-by-status map (a deactivated assignee should still resolve a
  // real name) — the single source every card/row/drawer resolves assignee
  // display from. Built once per team-store update, not per card.
  const assigneesById = useMemo(() => new Map(allTeamMembers.map((m) => [m.id, m])), [allTeamMembers]);

  // Canonical current-user identity for "My Tasks" / the Assignee "Me"
  // filter — resolved once from the authenticated session, not guessed from
  // name/email. assigned_to stores the same profiles/auth id this compares
  // against (see validate_task_assignee trigger).
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void supabase.auth.getUser().then(({ data }) => {
      if (active) setCurrentUserId(data.user?.id ?? null);
    });
    return () => { active = false; };
  }, []);

  const [view, setView] = useState<View>("board");
  const [topView, setTopView] = useState<TopView>("my");
  const [groupBy, setGroupBy] = useState<GroupBy>("project");
  const [query, setQuery] = useState("");
  const [ownerFilter, setOwnerFilter] = useState<string>("all");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");
  const [relatedFilter, setRelatedFilter] = useState<RelatedFilter>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | TaskStatus>("all");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [dueFilter, setDueFilter] = useState<DueFilter>("any");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [viewing, setViewing] = useState<Task | null>(null);

  // The drawer holds a copied snapshot of the Task it's showing, so an edit
  // made elsewhere (e.g. via the Edit dialog opened from this same drawer)
  // wouldn't otherwise be reflected until the drawer was closed and
  // reopened. Re-sync it to the live store on every tasks update so it
  // never renders stale fields (assignee, due date, status, ...).
  useEffect(() => {
    if (!viewing) return;
    const fresh = tasks.find((t) => t.id === viewing.id);
    if (fresh && fresh !== viewing) setViewing(fresh);
  }, [tasks, viewing]);

  // Session-only expand/collapse overrides for Project groups (Part 8) and
  // per-status-column "show more" counts (Part 9) — reset whenever the
  // active scope changes so a stale expanded/limit state from one view
  // doesn't leak into another.
  const [expandOverrides, setExpandOverrides] = useState<Record<string, boolean>>({});
  const [columnLimits, setColumnLimits] = useState<Record<string, number>>({});
  useEffect(() => {
    setExpandOverrides({});
    setColumnLimits({});
  }, [topView, groupBy, query, ownerFilter, priorityFilter, relatedFilter, statusFilter, projectFilter, dueFilter]);

  const topViewTasks = useMemo(() => {
    switch (topView) {
      case "my":
        return currentUserId ? tasks.filter((t) => t.assignedTo === currentUserId) : [];
      case "due_soon":
        return tasks.filter((t) => isDueWithinDays(t.dueDateRaw, t.status, 14));
      case "overdue":
        return tasks.filter((t) => isOverdue(t.dueDateRaw, t.status));
      case "all":
      default:
        return tasks;
    }
  }, [tasks, topView, currentUserId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();

    return topViewTasks.filter((t) => {
      const matchesSearch =
        !q ||
        t.title.toLowerCase().includes(q) ||
        t.assignee.toLowerCase().includes(q) ||
        (t.projectId ? projectName(t.projectId).toLowerCase().includes(q) : false);

      if (!matchesSearch) return false;
      if (ownerFilter === "me") { if (!currentUserId || t.assignedTo !== currentUserId) return false; }
      else if (ownerFilter === "unassigned" && t.assignedTo) return false;
      else if (ownerFilter !== "all" && t.assignedTo !== ownerFilter) return false;
      if (priorityFilter !== "all" && t.priority !== priorityFilter) return false;
      if (statusFilter !== "all" && t.status !== statusFilter) return false;
      if (relatedFilter === "unlinked" && (t.entityType || isProjectTask(t))) return false;
      if (relatedFilter === "lead" && t.entityType !== "lead") return false;
      if (relatedFilter === "deal" && t.entityType !== "deal") return false;
      if (relatedFilter === "project" && (!t.projectId || t.entityType)) return false;
      if (projectFilter === "none" && t.projectId) return false;
      else if (projectFilter !== "all" && projectFilter !== "none" && t.projectId !== projectFilter) return false;
      if (dueFilter === "overdue" && !isOverdue(t.dueDateRaw, t.status)) return false;
      else if (dueFilter === "today" && !(isDueToday(t.dueDateRaw) && isActiveStatus(t.status))) return false;
      else if (dueFilter === "7d" && !isDueWithinDays(t.dueDateRaw, t.status, 7)) return false;
      else if (dueFilter === "14d" && !isDueWithinDays(t.dueDateRaw, t.status, 14)) return false;
      else if (dueFilter === "none" && t.dueDateRaw) return false;

      return true;
    });
  }, [topViewTasks, query, ownerFilter, priorityFilter, relatedFilter, statusFilter, projectFilter, dueFilter, currentUserId]);

  // KPI cards reflect the currently selected scope (Part 16) — never show a
  // full-org "Total Tasks" count while only My Tasks is rendered.
  const scopedStats = useMemo(() => {
    const total = filtered.length;
    const completed = filtered.filter((t) => t.status === "completed").length;
    const inProgress = filtered.filter((t) => t.status === "in_progress").length;
    const overdue = filtered.filter((t) => isOverdue(t.dueDateRaw, t.status)).length;
    return { total, completed, inProgress, overdue };
  }, [filtered]);

  const grouped = useMemo(() => {
    const map = new Map<TaskStatus, Task[]>(TASK_STATUS_ORDER.map((s) => [s, []]));
    for (const task of filtered) map.get(task.status)?.push(task);
    for (const list of map.values()) list.sort((a, b) => compareTasks(a, b, currentUserId));
    return map;
  }, [filtered, currentUserId]);

  const projectGroups = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of filtered) {
      const key = t.projectId ?? "__none__";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    }
    return Array.from(map.entries())
      .map(([projectId, groupTasks]) => ({
        projectId,
        tasks: [...groupTasks].sort((a, b) => compareTasks(a, b, currentUserId)),
      }))
      .sort((a, b) => {
        if (a.projectId === "__none__") return 1;
        if (b.projectId === "__none__") return -1;
        return projectName(a.projectId).localeCompare(projectName(b.projectId));
      });
  }, [filtered, currentUserId]);

  const onDragEnd = (result: DropResult) => {
    const { destination, source, draggableId } = result;

    if (!destination) return;
    if (destination.droppableId === source.droppableId && destination.index === source.index) return;

    const newStatus = destination.droppableId as TaskStatus;
    // One shared lifecycle path for every transition (Mark complete / Reopen
    // / Cancel / Restore / drag) — updateTask() resolves completed_at via
    // getTaskStatusPatch() (src/lib/task-status.ts) regardless of which UI
    // action triggered it, so this never needs its own special-casing.
    // Note (Part 10): the column re-sorts by priority right after a drag
    // rather than preserving raw drop position — the app has never had a
    // persisted manual-order field (drag only ever changed status), so
    // this matches pre-existing behavior rather than introducing a new
    // "silent reorder" regression.
    void handleStatusMutation(() => updateTask(draggableId, { status: newStatus }), "Could not update task status");
  };

  const hasActiveFilters = query.trim() !== "" || ownerFilter !== "all" || priorityFilter !== "all" || relatedFilter !== "all" || statusFilter !== "all" || projectFilter !== "all" || dueFilter !== "any";
  const clearFilters = () => {
    setQuery(""); setOwnerFilter("all"); setPriorityFilter("all"); setRelatedFilter("all"); setStatusFilter("all"); setProjectFilter("all"); setDueFilter("any");
  };

  const isGroupExpanded = (key: string, defaultExpanded: boolean) => expandOverrides[key] ?? defaultExpanded;
  const toggleGroup = (key: string, current: boolean) => setExpandOverrides((prev) => ({ ...prev, [key]: !current }));
  const getColumnLimit = (key: string) => columnLimits[key] ?? DEFAULT_COLUMN_LIMIT;
  const showMoreInColumn = (key: string) => setColumnLimits((prev) => ({ ...prev, [key]: (prev[key] ?? DEFAULT_COLUMN_LIMIT) + COLUMN_LIMIT_STEP }));

  // Single-project context (an explicit Project filter, or a Project group
  // in the grouped All Tasks view) — the repeated "Project: X" line on
  // every card becomes noise once it's already obvious from context (Part 11).
  const singleProjectContext = projectFilter !== "all" && projectFilter !== "none";
  const showKanban = view === "board" && (topView !== "all" || groupBy === "status");
  const showProjectGroups = view === "board" && topView === "all" && groupBy === "project";

  const emptyStateCopy = hasActiveFilters
    ? { title: "No tasks match your filters.", hint: "Try clearing filters to see more." }
    : topView === "my"
      ? { title: "You have no tasks assigned right now.", hint: "Tasks assigned to you will show up here." }
      : topView === "due_soon"
        ? { title: "Nothing due in the next 14 days.", hint: "You're clear for now." }
        : topView === "overdue"
          ? { title: "No overdue tasks. Nice work.", hint: "" }
          : { title: "No tasks yet.", hint: "Create a task to get started." };

  return (
    // Bounded to the app shell's <main> content box (h-full/min-h-0 inherit
    // its already-viewport-constrained height) so only the task-content
    // region below scrolls — everything else here is flex-none. Without
    // this, header/tabs/KPI/filters + an unbounded Kanban/grouped list all
    // stack naturally and overflow <main>'s own overflow-y-auto, producing
    // a page-level scrollbar that also scrolls the title/tabs/filters out
    // of view (the regression this fixes).
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex-none">
        <PageHeader
          icon={CheckSquare}
          iconBg="bg-violet-soft"
          iconColor="text-violet"
          title="Tasks"
          subtitle="Plan, assign, and track work across your entire organization."
          actions={
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" /> New Task
            </Button>
          }
        />
      </div>

      <Tabs value={topView} onValueChange={(v) => setTopView(v as TopView)} className="mb-3 flex-none">
        <TabsList className="h-auto flex-wrap justify-start gap-1.5 bg-transparent p-0">
          {TOP_VIEWS.map((v) => {
            const count =
              v.id === "my" ? (currentUserId ? tasks.filter((t) => t.assignedTo === currentUserId).length : 0)
              : v.id === "due_soon" ? tasks.filter((t) => isDueWithinDays(t.dueDateRaw, t.status, 14)).length
              : v.id === "overdue" ? tasks.filter((t) => isOverdue(t.dueDateRaw, t.status)).length
              : tasks.length;
            return (
              <TabsTrigger
                key={v.id}
                value={v.id}
                className="h-9 gap-1.5 rounded-md border border-border bg-white px-3 text-xs font-medium shadow-none hover:bg-muted/50 data-[state=active]:border-[#EADFC8] data-[state=active]:bg-[#FAF3E4] data-[state=active]:shadow-sm"
              >
                {v.label}
                <Badge variant="secondary" className="h-4.5 rounded px-1.5 text-[10px] font-medium">{count}</Badge>
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>

      <div className="mb-3 grid flex-none grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard
          label={TOP_VIEWS.find((v) => v.id === topView)!.label}
          value={scopedStats.total}
          icon={ListChecks}
          tone="muted"
          sub={topView !== "all" || hasActiveFilters ? `${tasks.length} total organization tasks` : undefined}
        />
        <MetricCard label="In progress" value={scopedStats.inProgress} icon={TASK_STATUS_ICONS.in_progress} tone="warning" />
        <MetricCard label="Completed" value={scopedStats.completed} icon={CircleCheck} tone="success" />
        <MetricCard label="Overdue" value={scopedStats.overdue} icon={CircleAlert} tone="danger" />
      </div>

      <div className="mb-3 flex flex-none flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tasks, projects…"
            className="h-9 pl-8"
          />
        </div>

        <Select value={ownerFilter} onValueChange={setOwnerFilter}>
          <SelectTrigger className="h-9 w-32 text-xs"><SelectValue placeholder="Assignee" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All assignees</SelectItem>
            {currentUserId && <SelectItem value="me">Me</SelectItem>}
            <SelectItem value="unassigned">Unassigned</SelectItem>
            {teamMembers.map((member) => (
              <SelectItem key={member.id} value={member.id}>{member.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={priorityFilter} onValueChange={setPriorityFilter}>
          <SelectTrigger className="h-9 w-32 text-xs"><SelectValue placeholder="Priority" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All priorities</SelectItem>
            {PRIORITIES.map((priority) => (
              <SelectItem key={priority.id} value={priority.id}>{priority.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={projectFilter} onValueChange={setProjectFilter}>
          <SelectTrigger className="h-9 w-36 text-xs"><SelectValue placeholder="Project" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All projects</SelectItem>
            <SelectItem value="none">No project</SelectItem>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={dueFilter} onValueChange={(v) => setDueFilter(v as DueFilter)}>
          <SelectTrigger className="h-9 w-32 text-xs"><SelectValue placeholder="Due" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any due date</SelectItem>
            <SelectItem value="overdue">Overdue</SelectItem>
            <SelectItem value="today">Due today</SelectItem>
            <SelectItem value="7d">Next 7 days</SelectItem>
            <SelectItem value="14d">Next 14 days</SelectItem>
            <SelectItem value="none">No due date</SelectItem>
          </SelectContent>
        </Select>

        <Select value={relatedFilter} onValueChange={(v) => setRelatedFilter(v as RelatedFilter)}>
          <SelectTrigger className="h-9 w-40 text-xs"><SelectValue placeholder="Related to" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All related records</SelectItem>
            <SelectItem value="unlinked">Unlinked</SelectItem>
            <SelectItem value="lead">Lead</SelectItem>
            <SelectItem value="deal">Deal</SelectItem>
            <SelectItem value="project">Project</SelectItem>
          </SelectContent>
        </Select>

        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as "all" | TaskStatus)}>
          <SelectTrigger className="h-9 w-36 text-xs"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {TASK_STATUS_ORDER.map((s) => (
              <SelectItem key={s} value={s}>{TASK_STATUS_LABELS[s]}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {topView === "all" && view === "board" && (
          <Select value={groupBy} onValueChange={(v) => setGroupBy(v as GroupBy)}>
            <SelectTrigger className="h-9 w-36 text-xs"><SelectValue placeholder="Group by" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="project">Group: Project</SelectItem>
              <SelectItem value="status">Group: Status</SelectItem>
            </SelectContent>
          </Select>
        )}

        {hasActiveFilters && (
          <Button size="sm" variant="ghost" className="h-9 text-xs" onClick={clearFilters}>Clear filters</Button>
        )}

        <div className="ml-auto flex h-9 items-center rounded-md border bg-card p-0.5">
          <Button
            size="sm"
            variant="ghost"
            className={view === "board" ? "h-7 bg-primary-soft px-2 text-primary hover:bg-primary-soft" : "h-7 px-2"}
            onClick={() => setView("board")}
            aria-label="Board view"
          >
            <LayoutGrid className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className={view === "list" ? "h-7 bg-primary-soft px-2 text-primary hover:bg-primary-soft" : "h-7 px-2"}
            onClick={() => setView("list")}
            aria-label="List view"
          >
            <ListIcon className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
      {filtered.length === 0 ? (
        <Card className="flex h-full min-h-40 flex-col items-center justify-center gap-1 border-dashed p-8 text-center">
          <p className="text-sm font-medium text-foreground">{emptyStateCopy.title}</p>
          {emptyStateCopy.hint && <p className="text-xs text-muted-foreground">{emptyStateCopy.hint}</p>}
          {hasActiveFilters && (
            <Button size="sm" variant="outline" className="mt-2 h-8 text-xs" onClick={clearFilters}>Clear Filters</Button>
          )}
        </Card>
      ) : showProjectGroups ? (
        <div className="h-full min-h-0 space-y-2 overflow-y-auto overscroll-contain pb-1 pr-1">
          {projectGroups.map(({ projectId, tasks: groupTasks }) => {
            const key = `proj:${projectId}`;
            const summary = groupSummary(groupTasks);
            const defaultExpanded = groupTasks.length <= PROJECT_GROUP_COLLAPSE_THRESHOLD || query.trim() !== "";
            const expanded = isGroupExpanded(key, defaultExpanded);
            const name = projectId === "__none__" ? "No project" : projectName(projectId);

            return (
              <Card key={key} className="overflow-hidden p-0">
                <button
                  type="button"
                  className="flex w-full flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2 text-left hover:bg-muted/50"
                  onClick={() => toggleGroup(key, expanded)}
                  aria-expanded={expanded}
                >
                  {expanded ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                  <FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate text-sm font-semibold">{name}</span>
                  <span className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <Badge variant="secondary" className="h-5 rounded px-1.5 text-[10px] font-medium">
                      {summary.open} open
                    </Badge>
                    {summary.overdue > 0 && (
                      <Badge variant="outline" className="h-5 gap-1 rounded border-destructive/30 bg-destructive/10 px-1.5 text-[10px] font-medium text-destructive">
                        <AlertCircle className="h-3 w-3" /> {summary.overdue} overdue
                      </Badge>
                    )}
                    {summary.dueThisWeek > 0 && (
                      <Badge variant="outline" className="h-5 rounded px-1.5 text-[10px] font-medium">
                        {summary.dueThisWeek} due this week
                      </Badge>
                    )}
                  </span>
                  {projectId !== "__none__" && (
                    <Link
                      {...projectDetailLink(projectId)}
                      onClick={(e) => e.stopPropagation()}
                      className="ml-auto shrink-0 text-[11px] font-medium text-primary hover:underline"
                    >
                      View Project Plan
                    </Link>
                  )}
                </button>

                {expanded && (
                  <div className="divide-y">
                    {groupTasks.map((task) => {
                      const tint = TASK_STATUS_TINT[task.status];
                      const StatusIcon = TASK_STATUS_ICONS[task.status];
                      const overdue = isOverdue(task.dueDateRaw, task.status);
                      const dueToday = isDueToday(task.dueDateRaw) && isActiveStatus(task.status) && !overdue;
                      const assigneeName = resolveAssigneeName(task, assigneesById);
                      return (
                        <div
                          key={task.id}
                          className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 hover:bg-muted/30"
                          onClick={() => setViewing(task)}
                        >
                          <span className={cn("min-w-0 flex-1 truncate text-sm", (task.status === "completed" || task.status === "cancelled") && "text-muted-foreground line-through")}>
                            {task.title}
                          </span>
                          <Badge variant="outline" className={cn("h-5 gap-1 shrink-0 rounded px-1.5 text-[10px]", tint.badge)}>
                            <StatusIcon className="h-3 w-3" /> {TASK_STATUS_LABELS[task.status]}
                          </Badge>
                          <span
                            className={cn(
                              "shrink-0 text-[11px]",
                              overdue ? "font-medium text-destructive" : dueToday ? "font-medium text-warning" : "text-muted-foreground",
                            )}
                          >
                            {fmtDueOrNone(task.dueDateRaw)}
                          </span>
                          {/* Dense grouped row — name-only wording (still the canonical resolver), full "Assigned to X" phrasing lives in the tooltip/accessible label. */}
                          <span
                            className="flex max-w-[140px] shrink-0 items-center gap-1 truncate text-[11px] text-muted-foreground"
                            title={assigneeName ? `Assigned to ${assigneeName}` : "Unassigned"}
                          >
                            <UserRound className="h-3 w-3 shrink-0" />
                            <span className="truncate">{assigneeName ?? "Unassigned"}</span>
                          </span>
                          <div onClick={(e) => e.stopPropagation()}>
                            <TaskRowMenu
                              task={task}
                              onEdit={() => setEditing(task)}
                              onDelete={() => { void deleteTask(task.id); toast.success("Task deleted"); }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      ) : view === "board" ? (
        <DragDropContext onDragEnd={onDragEnd}>
          <div className="h-full min-h-0 min-w-0 overflow-hidden">
            <div
              className="grid h-full min-h-0 w-full max-w-full auto-cols-[minmax(240px,1fr)] grid-flow-col gap-3
                overflow-x-auto pb-1
                2xl:grid-flow-row 2xl:auto-cols-auto 2xl:grid-cols-[repeat(5,minmax(0,1fr))] 2xl:overflow-x-hidden"
            >
              {TASK_STATUS_ORDER.map((statusId) => {
                const allItems = grouped.get(statusId) ?? [];
                const limit = getColumnLimit(statusId);
                const items = allItems.slice(0, limit);
                const remaining = allItems.length - items.length;
                const Icon = TASK_STATUS_ICONS[statusId];
                const tint = TASK_STATUS_TINT[statusId];

                return (
                  <Droppable droppableId={statusId} key={statusId}>
                    {(dropProvided, snapshot) => (
                      <div className={cn("flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-card", tint.border)}>
                        <div className={cn("flex shrink-0 items-center gap-2 border-b px-3 py-2", tint.headerBg, tint.border)}>
                          <div className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded", tint.iconBg)}>
                            <Icon className={cn("h-3.5 w-3.5", tint.icon)} />
                          </div>
                          <h2 className="text-[13px] font-semibold text-foreground">{TASK_STATUS_LABELS[statusId]}</h2>
                          <Badge variant="secondary" className="ml-auto h-4.5 rounded px-1.5 text-[10px] font-medium">
                            {allItems.length}
                          </Badge>
                        </div>

                        <div
                          ref={dropProvided.innerRef}
                          {...dropProvided.droppableProps}
                          className={cn(
                            "flex-1 min-h-0 space-y-2 overflow-y-auto overflow-x-hidden overscroll-contain p-2 transition-colors",
                            snapshot.isDraggingOver && "bg-secondary/40",
                          )}
                        >
                          {items.map((task, index) => (
                            <Draggable draggableId={task.id} index={index} key={task.id}>
                              {(dragProvided, snap) => (
                                <div
                                  ref={dragProvided.innerRef}
                                  {...dragProvided.draggableProps}
                                  {...dragProvided.dragHandleProps}
                                >
                                  <TaskCard
                                    task={task}
                                    dragging={snap.isDragging}
                                    hideProject={singleProjectContext}
                                    assigneesById={assigneesById}
                                    onView={() => setViewing(task)}
                                    onEdit={() => setEditing(task)}
                                    onDelete={() => {
                                      void deleteTask(task.id);
                                      toast.success("Task deleted");
                                    }}
                                  />
                                </div>
                              )}
                            </Draggable>
                          ))}

                          {dropProvided.placeholder}

                          {items.length === 0 && (
                            <div className="flex min-h-20 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border text-center text-[11px] text-muted-foreground">
                              <p>No tasks</p>
                              <p>Drop a task here</p>
                            </div>
                          )}

                          {remaining > 0 && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 w-full text-[11px]"
                              onClick={() => showMoreInColumn(statusId)}
                            >
                              Show {Math.min(remaining, COLUMN_LIMIT_STEP)} more {TASK_STATUS_LABELS[statusId]} tasks (showing {items.length} of {allItems.length})
                            </Button>
                          )}
                        </div>
                      </div>
                    )}
                  </Droppable>
                );
              })}
            </div>
          </div>
        </DragDropContext>
      ) : (
        <Card className="flex h-full min-h-0 flex-col overflow-hidden p-0">
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <Table>
            <TableHeader className="sticky top-0 z-10">
              <TableRow>
                <TableHead>Task</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Assignee</TableHead>
                <TableHead>Related to</TableHead>
                <TableHead>Due</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((task) => {
                const tint = TASK_STATUS_TINT[task.status];
                const StatusIcon = TASK_STATUS_ICONS[task.status];
                return (
                  <TableRow
                    key={task.id}
                    className="cursor-pointer"
                    onClick={() => setViewing(task)}
                  >
                    <TableCell className={cn("font-medium", task.status === "completed" && "text-muted-foreground line-through", task.status === "cancelled" && "text-muted-foreground line-through")}>
                      {task.title}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn("h-5 gap-1 rounded px-1.5 text-[10px]", tint.badge)}>
                        <StatusIcon className="h-3 w-3" /> {TASK_STATUS_LABELS[task.status]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn("h-5 rounded px-1.5 text-[10px]", priorityClass(task.priority))}>
                        {PRIORITIES.find((priority) => priority.id === task.priority)?.label}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {(() => {
                        const assigneeName = resolveAssigneeName(task, assigneesById);
                        return (
                          <div className="flex items-center gap-2">
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[10px] font-semibold text-primary">
                              {assigneeName ? initialsFromName(assigneeName) : "—"}
                            </span>
                            <span className="truncate text-sm">{assigneeName ?? "Unassigned"}</span>
                          </div>
                        );
                      })()}
                    </TableCell>
                    <TableCell className="max-w-[180px] truncate text-sm" onClick={(e) => e.stopPropagation()}>
                      <RelatedToCell task={task} hideProject={singleProjectContext} />
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "text-sm",
                          isOverdue(task.dueDateRaw, task.status) && "font-medium text-destructive",
                          isDueToday(task.dueDateRaw) && isActiveStatus(task.status) && !isOverdue(task.dueDateRaw, task.status) && "font-medium text-warning",
                        )}
                      >
                        {fmtDueOrNone(task.dueDateRaw)}
                      </span>
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <TaskRowMenu
                        task={task}
                        onEdit={() => setEditing(task)}
                        onDelete={() => { void deleteTask(task.id); toast.success("Task deleted"); }}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          </div>
        </Card>
      )}
      </div>

      <TaskFormDialog
        key={editing?.id ?? (createOpen ? "new" : "closed")}
        open={createOpen || editing !== null}
        task={editing}
        projects={projects}
        onClose={() => {
          setCreateOpen(false);
          setEditing(null);
        }}
      />

      <TaskDetailSheet
        task={viewing}
        assigneesById={assigneesById}
        onClose={() => setViewing(null)}
        onEdit={(t) => setEditing(t)}
      />
    </div>
  );
}

function TaskRowMenu({ task, onEdit, onDelete }: { task: Task; onEdit: () => void; onDelete: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Actions for ${task.title}`}>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onEdit}>Edit</DropdownMenuItem>
        {task.status !== "cancelled" && task.status !== "completed" && (
          <DropdownMenuItem onClick={() => void handleStatusMutation(() => completeTask(task.id), "Could not complete task", "Task marked complete")}>
            Mark complete
          </DropdownMenuItem>
        )}
        {task.status === "completed" && (
          <DropdownMenuItem onClick={() => void handleStatusMutation(() => reopenTask(task.id), "Could not reopen task", "Task reopened")}>
            Reopen task
          </DropdownMenuItem>
        )}
        {task.status === "cancelled" ? (
          <DropdownMenuItem onClick={() => void handleStatusMutation(() => restoreTask(task.id), "Could not restore task", "Task restored")}>
            <RotateCcw className="h-4 w-4" /> Restore task
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onClick={() => void handleStatusMutation(() => cancelTask(task.id), "Could not cancel task", "Task cancelled")}>
            <Ban className="h-4 w-4" /> Cancel task
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={onDelete}>
          <Trash2 className="h-4 w-4" /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TaskCard({
  task,
  dragging,
  onView,
  onEdit,
  onDelete,
  hideProject = false,
  assigneesById,
}: {
  task: Task;
  dragging: boolean;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
  hideProject?: boolean;
  assigneesById: Map<string, TeamMember>;
}) {
  const overdue = isOverdue(task.dueDateRaw, task.status);
  const dueToday = isDueToday(task.dueDateRaw) && isActiveStatus(task.status) && !overdue;
  const isCompleted = task.status === "completed";
  const isCancelled = task.status === "cancelled";
  const assigneeName = resolveAssigneeName(task, assigneesById);
  const assigneeDisplay = getTaskAssigneeDisplay(task, assigneesById);

  return (
    <Card
      className={cn(
        "w-full min-w-0 max-w-full cursor-grab p-2.5 transition-shadow hover:shadow-md active:cursor-grabbing",
        dragging && "shadow-lg ring-1 ring-primary/40",
        isCompleted && "border-emerald-200/70 bg-emerald-50/30 dark:border-emerald-900/30 dark:bg-emerald-500/5",
        isCancelled && "opacity-70",
      )}
      onClick={onView}
    >
      <div className="flex items-start justify-between gap-2">
        <div className={cn("min-w-0 flex-1 truncate text-[13px] font-semibold leading-snug", (isCompleted || isCancelled) && "text-muted-foreground line-through")}>
          {task.title}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="-mr-1 -mt-1 h-6 w-6 shrink-0"
              onClick={(e) => e.stopPropagation()}
              aria-label={`Actions for ${task.title}`}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem onClick={onEdit}>Edit</DropdownMenuItem>
            {task.status !== "cancelled" && task.status !== "completed" && (
              <DropdownMenuItem onClick={() => void handleStatusMutation(() => completeTask(task.id), "Could not complete task", "Task marked complete")}>
                Mark complete
              </DropdownMenuItem>
            )}
            {task.status === "completed" && (
              <DropdownMenuItem onClick={() => void handleStatusMutation(() => reopenTask(task.id), "Could not reopen task", "Task reopened")}>
                Reopen task
              </DropdownMenuItem>
            )}
            {task.status === "cancelled" ? (
              <DropdownMenuItem onClick={() => void handleStatusMutation(() => restoreTask(task.id), "Could not restore task", "Task restored")}>
                Restore task
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => void handleStatusMutation(() => cancelTask(task.id), "Could not cancel task", "Task cancelled")}>
                Cancel task
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={onDelete}>
              <Trash2 className="h-4 w-4" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="mt-1 truncate text-[11px]">
        <RelatedToCell task={task} hideProject={hideProject} />
      </div>

      <div
        className="mt-1 flex items-center gap-1 truncate text-[11px] text-muted-foreground"
        title={assigneeName ? assigneeDisplay : undefined}
      >
        <UserRound className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{assigneeDisplay}</span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className={cn("h-4.5 shrink-0 rounded px-1.5 text-[9.5px]", priorityClass(task.priority))}>
          {PRIORITIES.find((priority) => priority.id === task.priority)?.label}
        </Badge>

        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 text-[10.5px]",
            overdue ? "font-medium text-destructive" : dueToday ? "font-medium text-warning" : "text-muted-foreground",
          )}
        >
          <CalendarIcon className="h-3 w-3" /> {fmtDueOrNone(task.dueDateRaw)}
        </span>
      </div>
    </Card>
  );
}
