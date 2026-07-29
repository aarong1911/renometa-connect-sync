import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
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
} from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/layout/app-shell";
import { useTopbarAction } from "@/lib/topbar-action";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { cn } from "@/lib/utils";
import type { Task, TaskActivity } from "@/lib/mock-data";
import { useProjects, getProjectName } from "@/lib/projects-store";
import {
  useTasks,
  addTask,
  updateTask,
  deleteTask,
  completeTask,
  reopenTask,
  cancelTask,
  restoreTask,
  useTaskActivity,
} from "@/lib/tasks-store";
import { useLeads } from "@/lib/leads-store";
import { useDeals } from "@/lib/deals-store";
import { leadDetailLink, dealDetailLink } from "@/lib/routes";
import { useTeam } from "@/lib/organization";
import { EntityPicker } from "@/components/tasks/entity-picker";
import {
  TASK_STATUS_ORDER, TASK_STATUS_LABELS, TASK_STATUS_ICONS, TASK_STATUS_TINT,
  isActiveStatus, type TaskStatus,
} from "@/lib/task-status";

export const Route = createFileRoute("/tasks")({
  component: TasksPage,
});

type Priority = Task["priority"];
type View = "board" | "list";
type RelatedFilter = "all" | "unlinked" | "lead" | "deal" | "project";

const PRIORITIES: { id: Priority; label: string }[] = [
  { id: "low", label: "Low" },
  { id: "med", label: "Medium" },
  { id: "high", label: "High" },
];

const PRIORITY_TINT: Record<Priority, string> = {
  low: "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-800 dark:bg-slate-500/10 dark:text-slate-400",
  med: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/40 dark:bg-amber-500/10 dark:text-amber-400",
  high: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/40 dark:bg-rose-500/10 dark:text-rose-400",
};

function fmtDue(iso: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));
}

function isOverdue(due: string, status: TaskStatus) {
  if (!isActiveStatus(status)) return false;
  return new Date(due).getTime() < Date.now();
}

function isDueToday(due: string) {
  const d = new Date(due);
  const now = new Date();
  return d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth() && d.getUTCDate() === now.getUTCDate();
}

function projectName(id: string | undefined) {
  return id ? getProjectName(id) : "No project";
}

/**
 * "Related to" cell — resolves a task's linked project OR Lead/Deal
 * (mutually exclusive today) from the already-loaded shared stores — no
 * extra query per row. Missing/deleted targets degrade to a plain,
 * non-clickable label rather than erroring.
 */
function RelatedToCell({ task, showIcon = true }: { task: Task; showIcon?: boolean }) {
  const leads = useLeads();
  const deals = useDeals();

  if (task.entityType === "lead") {
    const lead = leads.find((l) => l.id === task.entityId);
    if (!lead) return <span className="flex items-center gap-1 text-muted-foreground"><UserRound className="h-3 w-3 shrink-0" />Lead (unavailable)</span>;
    return (
      <Link
        {...leadDetailLink(lead.id)}
        onClick={(e) => e.stopPropagation()}
        className="flex min-w-0 items-center gap-1 truncate text-primary hover:underline"
      >
        {showIcon && <UserRound className="h-3 w-3 shrink-0" />}
        <span className="truncate">Lead: {lead.name}</span>
      </Link>
    );
  }

  if (task.entityType === "deal") {
    const deal = deals.find((d) => d.id === task.entityId);
    if (!deal) return <span className="flex items-center gap-1 text-muted-foreground"><Handshake className="h-3 w-3 shrink-0" />Deal (unavailable)</span>;
    return (
      <Link
        {...dealDetailLink(deal.id)}
        onClick={(e) => e.stopPropagation()}
        className="flex min-w-0 items-center gap-1 truncate text-primary hover:underline"
      >
        {showIcon && <Handshake className="h-3 w-3 shrink-0" />}
        <span className="truncate">Deal: {deal.name}</span>
      </Link>
    );
  }

  if (task.projectId) {
    return (
      <span className="flex min-w-0 items-center gap-1 truncate text-muted-foreground">
        {showIcon && <FolderKanban className="h-3 w-3 shrink-0" />}
        <span className="truncate">Project: {projectName(task.projectId)}</span>
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1 text-muted-foreground">
      {showIcon && <Link2Off className="h-3 w-3 shrink-0" />}
      Unlinked
    </span>
  );
}

function priorityClass(p: Priority) {
  return PRIORITY_TINT[p];
}

async function handleStatusMutation(
  action: () => Promise<{ ok: true } | { ok: false; error: string }>,
  failureMessage: string,
  successMessage?: string,
) {
  const result = await action();
  if (!result.ok) {
    console.error(`[tasks] ${failureMessage}:`, result.error);
    toast.error(failureMessage);
    return false;
  }
  if (successMessage) toast.success(successMessage);
  return true;
}

function TasksPage() {
  const { projects } = useProjects();
  const tasks = useTasks();
  const teamMembers = useTeam().filter((m) => m.status === "active");

  const [view, setView] = useState<View>("board");
  const [query, setQuery] = useState("");
  const [ownerFilter, setOwnerFilter] = useState<string>("all");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");
  const [relatedFilter, setRelatedFilter] = useState<RelatedFilter>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | TaskStatus>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [viewing, setViewing] = useState<Task | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();

    return tasks.filter((t) => {
      const matchesSearch =
        !q ||
        t.title.toLowerCase().includes(q) ||
        t.assignee.toLowerCase().includes(q);

      if (!matchesSearch) return false;
      if (ownerFilter === "unassigned" && t.assignedTo) return false;
      if (ownerFilter !== "all" && ownerFilter !== "unassigned" && t.assignedTo !== ownerFilter) return false;
      if (priorityFilter !== "all" && t.priority !== priorityFilter) return false;
      if (statusFilter !== "all" && t.status !== statusFilter) return false;
      if (relatedFilter === "unlinked" && (t.entityType || t.projectId)) return false;
      if (relatedFilter === "lead" && t.entityType !== "lead") return false;
      if (relatedFilter === "deal" && t.entityType !== "deal") return false;
      if (relatedFilter === "project" && (!t.projectId || t.entityType)) return false;

      return true;
    });
  }, [tasks, query, ownerFilter, priorityFilter, relatedFilter, statusFilter]);

  const stats = useMemo(() => {
    const total = tasks.length;
    const completed = tasks.filter((t) => t.status === "completed").length;
    const inProgress = tasks.filter((t) => t.status === "in_progress").length;
    const overdue = tasks.filter((t) => isOverdue(t.due, t.status)).length;

    return { total, completed, inProgress, overdue };
  }, [tasks]);

  const grouped = useMemo(() => {
    const map = new Map<TaskStatus, Task[]>(TASK_STATUS_ORDER.map((s) => [s, []]));
    for (const task of filtered) map.get(task.status)?.push(task);
    return map;
  }, [filtered]);

  const onDragEnd = (result: DropResult) => {
    const { destination, source, draggableId } = result;

    if (!destination) return;
    if (destination.droppableId === source.droppableId && destination.index === source.index) return;

    const newStatus = destination.droppableId as TaskStatus;
    // One shared lifecycle path for every transition (Mark complete / Reopen
    // / Cancel / Restore / drag) — updateTask() resolves completed_at via
    // getTaskStatusPatch() (src/lib/task-status.ts) regardless of which UI
    // action triggered it, so this never needs its own special-casing.
    void handleStatusMutation(() => updateTask(draggableId, { status: newStatus }), "Could not update task status");
  };

  useTopbarAction(
    <Button size="sm" onClick={() => setCreateOpen(true)}>
      <Plus className="h-4 w-4" /> New Task
    </Button>,
  );

  const hasActiveFilters = query.trim() !== "" || ownerFilter !== "all" || priorityFilter !== "all" || relatedFilter !== "all" || statusFilter !== "all";
  const clearFilters = () => {
    setQuery(""); setOwnerFilter("all"); setPriorityFilter("all"); setRelatedFilter("all"); setStatusFilter("all");
  };

  return (
    <>
      <PageHeader
        icon={CheckSquare}
        iconBg="bg-violet-soft"
        iconColor="text-violet"
        title="Tasks"
        subtitle="Plan, assign, and track work across your entire organization."
      />

      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard label="Total tasks" value={stats.total} icon={ListChecks} tone="muted" />
        <MetricCard label="In progress" value={stats.inProgress} icon={TASK_STATUS_ICONS.in_progress} tone="warning" />
        <MetricCard label="Completed" value={stats.completed} icon={CircleCheck} tone="success" />
        <MetricCard label="Overdue" value={stats.overdue} icon={CircleAlert} tone="danger" />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tasks…"
            className="h-9 pl-8"
          />
        </div>

        <Select value={ownerFilter} onValueChange={setOwnerFilter}>
          <SelectTrigger className="h-9 w-36 text-xs"><SelectValue placeholder="Assignee" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All assignees</SelectItem>
            <SelectItem value="unassigned">Unassigned</SelectItem>
            {teamMembers.map((member) => (
              <SelectItem key={member.id} value={member.id}>{member.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={priorityFilter} onValueChange={setPriorityFilter}>
          <SelectTrigger className="h-9 w-36 text-xs"><SelectValue placeholder="Priority" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All priorities</SelectItem>
            {PRIORITIES.map((priority) => (
              <SelectItem key={priority.id} value={priority.id}>{priority.label}</SelectItem>
            ))}
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

      {view === "board" ? (
        <DragDropContext onDragEnd={onDragEnd}>
          <div className="min-w-0 overflow-hidden">
            <div
              className="grid min-w-0 w-full max-w-full auto-cols-[minmax(240px,1fr)] grid-flow-col gap-3
                overflow-x-auto pb-1
                2xl:grid-flow-row 2xl:auto-cols-auto 2xl:grid-cols-[repeat(5,minmax(0,1fr))] 2xl:overflow-x-hidden"
            >
              {TASK_STATUS_ORDER.map((statusId) => {
                const items = grouped.get(statusId) ?? [];
                const Icon = TASK_STATUS_ICONS[statusId];
                const tint = TASK_STATUS_TINT[statusId];

                return (
                  <Droppable droppableId={statusId} key={statusId}>
                    {(dropProvided, snapshot) => (
                      <div className={cn("flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card", tint.border)}>
                        <div className={cn("flex shrink-0 items-center gap-2 border-b px-3 py-2", tint.headerBg, tint.border)}>
                          <div className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded", tint.iconBg)}>
                            <Icon className={cn("h-3.5 w-3.5", tint.icon)} />
                          </div>
                          <h2 className="text-[13px] font-semibold text-foreground">{TASK_STATUS_LABELS[statusId]}</h2>
                          <Badge variant="secondary" className="ml-auto h-4.5 rounded px-1.5 text-[10px] font-medium">
                            {items.length}
                          </Badge>
                        </div>

                        <div
                          ref={dropProvided.innerRef}
                          {...dropProvided.droppableProps}
                          className={cn(
                            "max-h-[65vh] min-h-28 flex-1 space-y-2 overflow-y-auto overflow-x-hidden p-2 transition-colors",
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
        <Card className="overflow-hidden p-0">
          <Table>
            <TableHeader>
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
                      <div className="flex items-center gap-2">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[10px] font-semibold text-primary">
                          {task.assigneeInitials}
                        </span>
                        <span className="text-sm">{task.assignee}</span>
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[180px] truncate text-sm" onClick={(e) => e.stopPropagation()}>
                      <RelatedToCell task={task} />
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "text-sm",
                          isOverdue(task.due, task.status) && "font-medium text-destructive",
                          isDueToday(task.due) && isActiveStatus(task.status) && !isOverdue(task.due, task.status) && "font-medium text-warning",
                        )}
                      >
                        {fmtDue(task.due)}
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

              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                    No tasks match your filters.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      )}

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
        onClose={() => setViewing(null)}
        onEdit={(t) => { setViewing(null); setEditing(t); }}
      />
    </>
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
}: {
  task: Task;
  dragging: boolean;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const overdue = isOverdue(task.due, task.status);
  const dueToday = isDueToday(task.due) && isActiveStatus(task.status) && !overdue;
  const isCompleted = task.status === "completed";
  const isCancelled = task.status === "cancelled";

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
        <RelatedToCell task={task} />
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Badge variant="outline" className={cn("h-4.5 shrink-0 rounded px-1.5 text-[9.5px]", priorityClass(task.priority))}>
            {PRIORITIES.find((priority) => priority.id === task.priority)?.label}
          </Badge>

          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 text-[10.5px]",
              overdue ? "font-medium text-destructive" : dueToday ? "font-medium text-warning" : "text-muted-foreground",
            )}
          >
            <CalendarIcon className="h-3 w-3" /> {fmtDue(task.due)}
          </span>
        </div>

        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[10px] font-semibold text-primary"
          title={task.assignee}
        >
          {task.assigneeInitials}
        </span>
      </div>
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border pb-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function TaskDetailSheet({
  task,
  onClose,
  onEdit,
}: {
  task: Task | null;
  onClose: () => void;
  onEdit: (task: Task) => void;
}) {
  return (
    <Sheet open={task !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-md">
        {task && (
          <>
            <SheetHeader>
              <SheetTitle className={cn((task.status === "completed" || task.status === "cancelled") && "line-through text-muted-foreground")}>
                {task.title}
              </SheetTitle>
              <SheetDescription><RelatedToCell task={task} /></SheetDescription>
            </SheetHeader>

            <div className="mt-6 space-y-4 text-sm">
              <Fact
                label="Status"
                value={
                  <Badge variant="outline" className={cn("h-5 gap-1 rounded px-1.5 text-[10.5px]", TASK_STATUS_TINT[task.status].badge)}>
                    {(() => { const Icon = TASK_STATUS_ICONS[task.status]; return <Icon className="h-3 w-3" />; })()}
                    {TASK_STATUS_LABELS[task.status]}
                  </Badge>
                }
              />
              <Fact label="Assignee" value={`${task.assignee}`} />
              <Fact label="Due" value={fmtDue(task.due)} />
              <Fact
                label="Priority"
                value={PRIORITIES.find((priority) => priority.id === task.priority)?.label ?? ""}
              />

              <div className="flex gap-2 pt-2">
                <Button variant="outline" className="flex-1" onClick={() => onEdit(task)}>
                  Edit
                </Button>

                {task.status === "completed" ? (
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={async () => {
                      if (await handleStatusMutation(() => reopenTask(task.id), "Could not reopen task", "Task reopened")) onClose();
                    }}
                  >
                    Reopen task
                  </Button>
                ) : task.status === "cancelled" ? (
                  <Button
                    className="flex-1"
                    onClick={async () => {
                      if (await handleStatusMutation(() => restoreTask(task.id), "Could not restore task", "Task restored")) onClose();
                    }}
                  >
                    Restore task
                  </Button>
                ) : (
                  <Button
                    className="flex-1"
                    onClick={async () => {
                      if (await handleStatusMutation(() => completeTask(task.id), "Could not complete task", "Task marked complete")) onClose();
                    }}
                  >
                    Mark complete
                  </Button>
                )}
              </div>

              {task.status !== "cancelled" && task.status !== "completed" && (
                <Button
                  variant="ghost"
                  className="w-full text-muted-foreground hover:text-destructive"
                  onClick={async () => {
                    if (await handleStatusMutation(() => cancelTask(task.id), "Could not cancel task", "Task cancelled")) onClose();
                  }}
                >
                  <Ban className="h-3.5 w-3.5" /> Cancel task
                </Button>
              )}

              <TaskActivitySection taskId={task.id} />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// Compact task activity history. Resolves actor/entity names from
// already-loaded stores (useTeam/useLeads/useDeals) rather than per-row
// queries — the metadata itself only ever stores stable ids.
function TaskActivitySection({ taskId }: { taskId: string }) {
  const { activity, loading } = useTaskActivity(taskId);
  const teamMembers = useTeam();
  const leads = useLeads();
  const deals = useDeals();

  function memberName(id: unknown): string {
    if (typeof id !== "string") return "someone";
    return teamMembers.find((m) => m.id === id)?.name ?? "a former member";
  }

  function entityLabel(type: unknown, id: unknown): string {
    if (type === "lead") return `Lead: ${leads.find((l) => l.id === id)?.name ?? "unavailable"}`;
    if (type === "deal") return `Deal: ${deals.find((d) => d.id === id)?.name ?? "unavailable"}`;
    return "Unlinked";
  }

  function describe(row: TaskActivity): string {
    const m = row.metadata as Record<string, unknown>;
    switch (row.activityType) {
      case "created": return "Task created";
      case "completed": return "Task completed";
      case "reopened": return "Task reopened";
      case "cancelled": return "Task cancelled";
      case "restored": return "Task restored";
      case "assigned":
        return m.previousAssignedTo
          ? `Reassigned from ${memberName(m.previousAssignedTo)} to ${memberName(m.assignedTo)}`
          : `Assigned to ${memberName(m.assignedTo)}`;
      case "unassigned":
        return `Unassigned (was ${memberName(m.previousAssignedTo)})`;
      case "due_date_changed":
        return m.previousDueDate
          ? `Due date changed from ${fmtDue(String(m.previousDueDate))} to ${m.dueDate ? fmtDue(String(m.dueDate)) : "none"}`
          : `Due date set to ${m.dueDate ? fmtDue(String(m.dueDate)) : "none"}`;
      case "priority_changed":
        return `Priority changed from ${m.previousPriority ?? "—"} to ${m.priority ?? "—"}`;
      case "relationship_changed":
        return `Related record changed from ${entityLabel(m.previousEntityType, m.previousEntityId)} to ${entityLabel(m.entityType, m.entityId)}`;
      default: return row.summary;
    }
  }

  return (
    <div className="border-t border-border pt-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Activity</h3>
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading activity…</p>
      ) : activity.length === 0 ? (
        <p className="text-xs text-muted-foreground">No task activity yet.</p>
      ) : (
        <div className="max-h-56 space-y-2.5 overflow-y-auto pr-1">
          {activity.map((row) => (
            <div key={row.id} className="text-xs">
              <p className="font-medium">{describe(row)}</p>
              <p className="text-muted-foreground">
                {row.actorId ? memberName(row.actorId) : "System"} · {fmtDue(row.createdAt)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const NO_PROJECT = "__none__";

function TaskFormDialog({
  open,
  task,
  projects,
  onClose,
}: {
  open: boolean;
  task: Task | null;
  projects: { id: string; name: string }[];
  onClose: () => void;
}) {
  const isEdit = task !== null;
  const teamMembers = useTeam().filter((m) => m.status === "active");
  const leads = useLeads();
  const deals = useDeals();

  const [title, setTitle] = useState(task?.title ?? "");
  const [projectId, setProjectId] = useState(task?.projectId ?? NO_PROJECT);
  const [assignedTo, setAssignedTo] = useState<string>(task?.assignedTo ?? "unassigned");
  const [priority, setPriority] = useState<Priority>(task?.priority ?? "med");
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? "not_started");
  const [due, setDue] = useState(
    task ? task.due.slice(0, 10) : new Date().toISOString().slice(0, 10),
  );

  // Global "Related to" picker. None/Lead/Deal, independent of Project — a
  // task may have a project, a Lead/Deal link, both, or neither.
  const [relatedTo, setRelatedTo] = useState<"none" | "lead" | "deal">(
    task?.entityType === "lead" ? "lead" : task?.entityType === "deal" ? "deal" : "none",
  );
  const [relatedEntityId, setRelatedEntityId] = useState<string | null>(task?.entityId ?? null);
  const [notes, setNotes] = useState("");

  const handleSubmit = async () => {
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }

    // Reject a partial relationship save — a type without a selected
    // record, never silently cleared or half-saved.
    if (relatedTo !== "none" && !relatedEntityId) {
      toast.error(`Select a ${relatedTo} before saving.`);
      return;
    }
    if (relatedTo === "lead" && relatedEntityId && !leads.some((l) => l.id === relatedEntityId)) {
      toast.error("That lead is no longer available. Choose another.");
      return;
    }
    if (relatedTo === "deal" && relatedEntityId && !deals.some((d) => d.id === relatedEntityId)) {
      toast.error("That deal is no longer available. Choose another.");
      return;
    }

    const payload = {
      title: title.trim(),
      projectId: projectId === NO_PROJECT ? undefined : projectId,
      assignedTo: assignedTo === "unassigned" ? null : assignedTo,
      due: new Date(due).toISOString(),
      priority,
      status,
      entityType: relatedTo === "none" ? null : relatedTo,
      entityId: relatedTo === "none" ? null : relatedEntityId,
    };

    if (isEdit && task) {
      // entity_type/entity_id (and status/completed_at) are always updated
      // atomically in the same updateTask call — never one field ahead of
      // the other; completed_at is resolved centrally by the store.
      const result = await updateTask(task.id, payload);
      if (!result.ok) { toast.error("Task could not be updated. Check the console for details."); return; }
      toast.success("Task updated");
    } else {
      const created = await addTask(payload as Omit<Task, "id" | "assignee" | "assigneeInitials">);

      if (!created) {
        toast.error("Task could not be created. Check the console for details.");
        return;
      }

      toast.success("Task created");
    }

    setNotes("");
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(dialogOpen) => !dialogOpen && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Task" : "New Task"}</DialogTitle>
          <DialogDescription>
            {isEdit ? "Update the task details." : "Add a new task, optionally linked to a project, Lead, or Deal."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Order quartz countertops"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Project</Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select project" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PROJECT}>No project</SelectItem>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Assignee</Label>
              <Select value={assignedTo} onValueChange={setAssignedTo}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unassigned">Unassigned</SelectItem>
                  {teamMembers.map((member) => (
                    <SelectItem key={member.id} value={member.id}>
                      {member.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Related to</Label>
            <div className="grid grid-cols-2 gap-3">
              <Select
                value={relatedTo}
                onValueChange={(value) => {
                  setRelatedTo(value as "none" | "lead" | "deal");
                  setRelatedEntityId(null);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="lead">Lead</SelectItem>
                  <SelectItem value="deal">Deal</SelectItem>
                </SelectContent>
              </Select>

              {relatedTo !== "none" && (
                <EntityPicker
                  entityType={relatedTo}
                  value={relatedEntityId}
                  onSelect={setRelatedEntityId}
                />
              )}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="task-due">Due</Label>
              <Input
                id="task-due"
                type="date"
                value={due}
                onChange={(e) => setDue(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Priority</Label>
              <Select value={priority} onValueChange={(value) => setPriority(value as Priority)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((priorityOption) => (
                    <SelectItem key={priorityOption.id} value={priorityOption.id}>
                      {priorityOption.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={status} onValueChange={(value) => setStatus(value as TaskStatus)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TASK_STATUS_ORDER.map((statusOption) => (
                    <SelectItem key={statusOption} value={statusOption}>
                      {TASK_STATUS_LABELS[statusOption]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="task-notes">Notes (optional)</Label>
            <Textarea
              id="task-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add any context or details…"
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit}>
            {isEdit ? "Save changes" : "Create task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
