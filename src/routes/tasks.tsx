import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ComponentType } from "react";
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
  AlertCircle,
  CheckCircle2,
  Clock,
  Loader2,
  Eye,
  MoreHorizontal,
  Trash2,
  Calendar as CalendarIcon,
  Repeat,
  CheckSquare,
} from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/layout/app-shell";
import { useTopbarAction } from "@/lib/topbar-action";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
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
import type { Task } from "@/lib/mock-data";
import { useProjects, getProjectName } from "@/lib/projects-store";
import {
  useTasks,
  addTask,
  updateTask,
  deleteTask,
  completeTask,
} from "@/lib/tasks-store";
import { useLeads } from "@/lib/leads-store";
import { useDeals } from "@/lib/deals-store";
import { leadDetailLink, dealDetailLink } from "@/lib/routes";

export const Route = createFileRoute("/tasks")({
  component: TasksPage,
});

type Status = Task["status"];
type Priority = Task["priority"];
type Recurrence = NonNullable<Task["recurrence"]>;
type View = "board" | "list";

const STATUS_COLUMNS: {
  id: Status;
  label: string;
  icon: ComponentType<{ className?: string }>;
}[] = [
  { id: "todo", label: "To Do", icon: Clock },
  { id: "in_progress", label: "In Progress", icon: Loader2 },
  { id: "review", label: "Review", icon: Eye },
  { id: "done", label: "Done", icon: CheckCircle2 },
];

const PRIORITIES: { id: Priority; label: string }[] = [
  { id: "low", label: "Low" },
  { id: "med", label: "Medium" },
  { id: "high", label: "High" },
];

const RECURRENCES: { id: Recurrence; label: string; short: string }[] = [
  { id: "none", label: "Does not repeat", short: "One-time" },
  { id: "daily", label: "Daily", short: "Daily" },
  { id: "weekly", label: "Weekly", short: "Weekly" },
  { id: "biweekly", label: "Every 2 weeks", short: "Bi-weekly" },
  { id: "monthly", label: "Monthly", short: "Monthly" },
];

const OWNERS = [
  { name: "Alex Romero", initials: "AR" },
  { name: "Priya Shah", initials: "PS" },
  { name: "Jamal Burke", initials: "JB" },
  { name: "Mei Lin", initials: "ML" },
  { name: "Sara Holt", initials: "SH" },
];

function recurrenceLabel(r: Recurrence | undefined) {
  return RECURRENCES.find((x) => x.id === (r ?? "none"))?.short ?? "One-time";
}

function fmtDue(iso: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));
}

function isOverdue(iso: string, status: Status) {
  if (status === "done") return false;
  return new Date(iso).getTime() < Date.UTC(2026, 3, 18);
}

function projectName(id: string | undefined) {
  return id ? getProjectName(id) : "No project";
}

/**
 * Phase 10.1 — "Related to" cell. Resolves a task's linked project OR
 * lead/deal (mutually exclusive today) from the already-loaded shared
 * stores — no extra query per row. Missing/deleted targets degrade to a
 * plain, non-clickable label rather than erroring.
 */
function RelatedToCell({ task }: { task: Task }) {
  const leads = useLeads();
  const deals = useDeals();

  if (task.entityType === "lead") {
    const lead = leads.find((l) => l.id === task.entityId);
    if (!lead) return <span className="text-muted-foreground">Lead (unavailable)</span>;
    return (
      <Link
        {...leadDetailLink(lead.id)}
        onClick={(e) => e.stopPropagation()}
        className="truncate text-primary hover:underline"
      >
        Lead: {lead.name}
      </Link>
    );
  }

  if (task.entityType === "deal") {
    const deal = deals.find((d) => d.id === task.entityId);
    if (!deal) return <span className="text-muted-foreground">Deal (unavailable)</span>;
    return (
      <Link
        {...dealDetailLink(deal.id)}
        onClick={(e) => e.stopPropagation()}
        className="truncate text-primary hover:underline"
      >
        Deal: {deal.name}
      </Link>
    );
  }

  if (task.projectId) return <span className="text-muted-foreground">{projectName(task.projectId)}</span>;
  return <span className="text-muted-foreground">Unlinked</span>;
}

function priorityClass(p: Priority) {
  if (p === "high") {
    return "bg-destructive/10 text-destructive border-destructive/20";
  }

  if (p === "med") {
    return "bg-warning/10 text-warning border-warning/20";
  }

  return "bg-muted text-muted-foreground border-border";
}

function statusClass(s: Status) {
  if (s === "done") {
    return "bg-success/10 text-success border-success/20";
  }

  if (s === "review") {
    return "bg-primary/10 text-primary border-primary/20";
  }

  if (s === "in_progress") {
    return "bg-warning/10 text-warning border-warning/20";
  }

  return "bg-muted text-muted-foreground border-border";
}

async function handleComplete(id: string) {
  const next = await completeTask(id);

  if (next) {
    toast.success("Task complete — next instance scheduled", {
      description: `Due ${fmtDue(next.due)}`,
    });
  } else {
    toast.success("Task marked complete");
  }
}

function TasksPage() {
  const { projects } = useProjects();
  const tasks = useTasks();

  const [view, setView] = useState<View>("board");
  const [query, setQuery] = useState("");
  const [ownerFilter, setOwnerFilter] = useState<string>("all");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");
  const [projectFilter, setProjectFilter] = useState<string>("all");
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
      if (ownerFilter !== "all" && t.assignee !== ownerFilter) return false;
      if (priorityFilter !== "all" && t.priority !== priorityFilter) return false;
      if (projectFilter !== "all" && t.projectId !== projectFilter) return false;

      return true;
    });
  }, [tasks, query, ownerFilter, priorityFilter, projectFilter]);

  const stats = useMemo(() => {
    const total = tasks.length;
    const done = tasks.filter((t) => t.status === "done").length;
    const inProgress = tasks.filter((t) => t.status === "in_progress").length;
    const overdue = tasks.filter((t) => isOverdue(t.due, t.status)).length;

    return { total, done, inProgress, overdue };
  }, [tasks]);

  const grouped = useMemo(() => {
    const map: Record<Status, Task[]> = {
      todo: [],
      in_progress: [],
      review: [],
      done: [],
    };

    for (const task of filtered) {
      map[task.status].push(task);
    }

    return map;
  }, [filtered]);

  const onDragEnd = (result: DropResult) => {
    const { destination, source, draggableId } = result;

    if (!destination) return;
    if (
      destination.droppableId === source.droppableId &&
      destination.index === source.index
    ) {
      return;
    }

    const newStatus = destination.droppableId as Status;

    if (newStatus === "done") {
      void handleComplete(draggableId);
    } else {
      void updateTask(draggableId, { status: newStatus });
    }
  };

  useTopbarAction(
    <Button size="sm" onClick={() => setCreateOpen(true)}>
      <Plus className="h-4 w-4" /> New Task
    </Button>,
  );

  return (
    <>
      <PageHeader
        icon={CheckSquare}
        iconBg="bg-violet-soft"
        iconColor="text-violet"
        title="Tasks"
        subtitle="Track work across every project — drag to update status."
      />

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard label="Total" value={stats.total} icon={ListIcon} tone="muted" />
        <MetricCard label="In Progress" value={stats.inProgress} icon={Loader2} tone="warning" />
        <MetricCard label="Completed" value={stats.done} icon={CheckCircle2} tone="success" />
        <MetricCard label="Overdue" value={stats.overdue} icon={AlertCircle} tone="danger" />
      </div>

      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <div className="relative max-w-xs flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tasks…"
              className="pl-8"
            />
          </div>

          <Select value={ownerFilter} onValueChange={setOwnerFilter}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Owner" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All owners</SelectItem>
              {OWNERS.map((owner) => (
                <SelectItem key={owner.name} value={owner.name}>
                  {owner.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={priorityFilter} onValueChange={setPriorityFilter}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Priority" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All priorities</SelectItem>
              {PRIORITIES.map((priority) => (
                <SelectItem key={priority.id} value={priority.id}>
                  {priority.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={projectFilter} onValueChange={setProjectFilter}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Project" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All projects</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-1 rounded-md border border-border bg-background p-0.5">
          <Button
            variant={view === "board" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setView("board")}
          >
            <LayoutGrid className="h-4 w-4" /> Board
          </Button>
          <Button
            variant={view === "list" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setView("list")}
          >
            <ListIcon className="h-4 w-4" /> List
          </Button>
        </div>
      </div>

      {view === "board" ? (
        <DragDropContext onDragEnd={onDragEnd}>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            {STATUS_COLUMNS.map((column) => {
              const items = grouped[column.id];
              const Icon = column.icon;

              return (
                <Droppable droppableId={column.id} key={column.id}>
                  {(dropProvided, snapshot) => (
                    <div
                      ref={dropProvided.innerRef}
                      {...dropProvided.droppableProps}
                      className={cn(
                        "rounded-lg border border-border bg-secondary/40 p-2 transition-colors",
                        snapshot.isDraggingOver && "border-primary/40 bg-primary-soft/40",
                      )}
                    >
                      <div className="mb-2 flex items-center justify-between px-1.5 py-1">
                        <div className="flex items-center gap-1.5 text-sm font-medium">
                          <Icon className="h-4 w-4 text-muted-foreground" />
                          {column.label}
                          <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
                            {items.length}
                          </Badge>
                        </div>
                      </div>

                      <div className="space-y-2">
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
                          <div className="rounded-md border border-dashed border-border px-2 py-6 text-center text-xs text-muted-foreground">
                            Drop tasks here
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </Droppable>
              );
            })}
          </div>
        </DragDropContext>
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Task</TableHead>
                <TableHead>Related to</TableHead>
                <TableHead>Assignee</TableHead>
                <TableHead>Due</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((task) => (
                <TableRow
                  key={task.id}
                  className="cursor-pointer"
                  onClick={() => setViewing(task)}
                >
                  <TableCell className="font-medium">{task.title}</TableCell>
                  <TableCell className="max-w-[180px] truncate text-sm">
                    <RelatedToCell task={task} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary-soft text-[10px] font-semibold text-primary">
                        {task.assigneeInitials}
                      </span>
                      <span className="text-sm">{task.assignee}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        "text-sm",
                        isOverdue(task.due, task.status) && "font-medium text-destructive",
                      )}
                    >
                      {fmtDue(task.due)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={priorityClass(task.priority)}>
                      {PRIORITIES.find((priority) => priority.id === task.priority)?.label}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={statusClass(task.status)}>
                      {STATUS_COLUMNS.find((status) => status.id === task.status)?.label}
                    </Badge>
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setEditing(task)}>
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => void handleComplete(task.id)}>
                          Mark complete
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => {
                            void deleteTask(task.id);
                            toast.success("Task deleted");
                          }}
                        >
                          <Trash2 className="h-4 w-4" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}

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
        open={createOpen || editing !== null}
        task={editing}
        projects={projects}
        onClose={() => {
          setCreateOpen(false);
          setEditing(null);
        }}
      />

      <Sheet open={viewing !== null} onOpenChange={(open) => !open && setViewing(null)}>
        <SheetContent className="w-full sm:max-w-md">
          {viewing && (
            <>
              <SheetHeader>
                <SheetTitle>{viewing.title}</SheetTitle>
                <SheetDescription><RelatedToCell task={viewing} /></SheetDescription>
              </SheetHeader>

              <div className="mt-6 space-y-4 text-sm">
                <Fact label="Assignee" value={`${viewing.assignee} (${viewing.assigneeInitials})`} />
                <Fact label="Due" value={fmtDue(viewing.due)} />
                <Fact
                  label="Priority"
                  value={PRIORITIES.find((priority) => priority.id === viewing.priority)?.label ?? ""}
                />
                <Fact
                  label="Status"
                  value={STATUS_COLUMNS.find((status) => status.id === viewing.status)?.label ?? ""}
                />
                <Fact label="Repeats" value={recurrenceLabel(viewing.recurrence)} />

                {viewing.recurrence &&
                  viewing.recurrence !== "none" &&
                  (viewing.recurrenceEndDate || viewing.recurrenceCount) && (
                    <RecurrenceProgress task={viewing} />
                  )}

                <div className="flex gap-2 pt-4">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => {
                      const current = viewing;
                      setViewing(null);
                      setEditing(current);
                    }}
                  >
                    Edit
                  </Button>

                  {viewing.status !== "done" && (
                    <Button
                      className="flex-1"
                      onClick={() => {
                        void handleComplete(viewing.id);
                        setViewing(null);
                      }}
                    >
                      Mark complete
                    </Button>
                  )}
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border pb-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function RecurrenceProgress({ task }: { task: Task }) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  if (task.recurrenceCount) {
    const current = Math.min(task.recurrenceIndex ?? 1, task.recurrenceCount);
    const pct = Math.round((current / task.recurrenceCount) * 100);
    const remaining = Math.max(task.recurrenceCount - current, 0);

    return (
      <div className="space-y-2 border-b border-border pb-3">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Progress</span>
          <span className="font-medium">
            {current} of {task.recurrenceCount} ({remaining} left)
          </span>
        </div>
        <Progress value={pct} className="h-1.5" />
      </div>
    );
  }

  if (task.recurrenceEndDate) {
    const start = new Date(task.due);
    start.setUTCHours(0, 0, 0, 0);

    const end = new Date(task.recurrenceEndDate);
    end.setUTCHours(0, 0, 0, 0);

    const totalMs = end.getTime() - start.getTime();
    const elapsedMs = today.getTime() - start.getTime();
    const dayMs = 24 * 60 * 60 * 1000;
    const daysRemaining = Math.max(Math.ceil((end.getTime() - today.getTime()) / dayMs), 0);

    const pct =
      totalMs <= 0
        ? 100
        : Math.min(Math.max(Math.round((elapsedMs / totalMs) * 100), 0), 100);

    const ended = today.getTime() > end.getTime();

    return (
      <div className="space-y-2 border-b border-border pb-3">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Ends {fmtDue(task.recurrenceEndDate)}</span>
          <span className="font-medium">
            {ended ? "Series ended" : `${daysRemaining} day${daysRemaining === 1 ? "" : "s"} left`}
          </span>
        </div>
        <Progress value={pct} className="h-1.5" />
      </div>
    );
  }

  return null;
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

  return (
    <Card
      className={cn(
        "cursor-grab p-3 transition-shadow hover:shadow-md active:cursor-grabbing",
        dragging && "shadow-lg ring-1 ring-primary/40",
      )}
      onClick={onView}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 text-sm font-medium leading-snug">{task.title}</div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="-mr-1 -mt-1 h-6 w-6 shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem onClick={onEdit}>Edit</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={onDelete}>
              <Trash2 className="h-4 w-4" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="mt-1.5 truncate text-xs">
        <RelatedToCell task={task} />
      </div>

      <div className="mt-3 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Badge
            variant="outline"
            className={cn("h-5 px-1.5 text-[10px]", priorityClass(task.priority))}
          >
            {PRIORITIES.find((priority) => priority.id === task.priority)?.label}
          </Badge>

          <span
            className={cn(
              "inline-flex items-center gap-1 text-[11px]",
              overdue ? "font-medium text-destructive" : "text-muted-foreground",
            )}
          >
            <CalendarIcon className="h-3 w-3" /> {fmtDue(task.due)}
          </span>

          {task.recurrence && task.recurrence !== "none" && (
            <span
              className="inline-flex items-center gap-1 rounded-md bg-primary-soft px-1.5 py-0.5 text-[10px] font-medium text-primary"
              title={`Repeats ${recurrenceLabel(task.recurrence).toLowerCase()}`}
            >
              <Repeat className="h-3 w-3" /> {recurrenceLabel(task.recurrence)}
            </span>
          )}
        </div>

        <span
          className="flex h-6 w-6 items-center justify-center rounded-full bg-primary-soft text-[10px] font-semibold text-primary"
          title={task.assignee}
        >
          {task.assigneeInitials}
        </span>
      </div>
    </Card>
  );
}

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

  const [title, setTitle] = useState(task?.title ?? "");
  const [projectId, setProjectId] = useState(task?.projectId ?? projects[0]?.id ?? "");
  const [assignee, setAssignee] = useState(task?.assignee ?? OWNERS[0].name);
  const [priority, setPriority] = useState<Priority>(task?.priority ?? "med");
  const [status, setStatus] = useState<Status>(task?.status ?? "todo");
  const [due, setDue] = useState(
    task ? task.due.slice(0, 10) : new Date().toISOString().slice(0, 10),
  );
  const [recurrence, setRecurrence] = useState<Recurrence>(task?.recurrence ?? "none");

  type EndMode = "never" | "on" | "after";

  const [endMode, setEndMode] = useState<EndMode>(
    task?.recurrenceEndDate ? "on" : task?.recurrenceCount ? "after" : "never",
  );
  const [endDate, setEndDate] = useState<string>(
    task?.recurrenceEndDate?.slice(0, 10) ?? "",
  );
  const [occurrences, setOccurrences] = useState<string>(
    task?.recurrenceCount ? String(task.recurrenceCount) : "5",
  );
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) return;

    setTitle(task?.title ?? "");
    setProjectId(task?.projectId ?? projects[0]?.id ?? "");
    setAssignee(task?.assignee ?? OWNERS[0].name);
    setPriority(task?.priority ?? "med");
    setStatus(task?.status ?? "todo");
    setDue(task ? task.due.slice(0, 10) : new Date().toISOString().slice(0, 10));
    setRecurrence(task?.recurrence ?? "none");
    setEndMode(task?.recurrenceEndDate ? "on" : task?.recurrenceCount ? "after" : "never");
    setEndDate(task?.recurrenceEndDate?.slice(0, 10) ?? "");
    setOccurrences(task?.recurrenceCount ? String(task.recurrenceCount) : "5");
    setNotes("");
  }, [open, task, projects]);

  const handleSubmit = async () => {
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }

    if (!projectId) {
      toast.error("Please select a real project before creating a task.");
      return;
    }

    const owner = OWNERS.find((o) => o.name === assignee) ?? OWNERS[0];

    let recurrenceEndDate: string | undefined;
    let recurrenceCount: number | undefined;

    if (recurrence !== "none") {
      if (endMode === "on" && endDate) {
        recurrenceEndDate = new Date(endDate).toISOString();
      } else if (endMode === "after") {
        const parsedOccurrences = Number.parseInt(occurrences, 10);

        if (!Number.isFinite(parsedOccurrences) || parsedOccurrences < 1) {
          toast.error("Occurrences must be at least 1");
          return;
        }

        recurrenceCount = parsedOccurrences;
      }
    }

    const payload: Omit<Task, "id"> = {
      title: title.trim(),
      projectId,
      assignee: owner.name,
      assigneeInitials: owner.initials,
      due: new Date(due).toISOString(),
      priority,
      status,
      recurrence,
      recurrenceEndDate,
      recurrenceCount,
      recurrenceIndex: task?.recurrenceIndex ?? (recurrence !== "none" ? 1 : undefined),
    };

    if (isEdit && task) {
      await updateTask(task.id, payload);
      toast.success("Task updated");
    } else {
      const created = await addTask(payload);

      if (!created) {
        toast.error("Task could not be created. Check the console for details.");
        return;
      }

      toast.success("Task created");
    }

    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(dialogOpen) => !dialogOpen && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Task" : "New Task"}</DialogTitle>
          <DialogDescription>
            {isEdit ? "Update the task details." : "Add a new task to a project."}
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
              <Select value={assignee} onValueChange={setAssignee}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OWNERS.map((owner) => (
                    <SelectItem key={owner.name} value={owner.name}>
                      {owner.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
              <Select value={status} onValueChange={(value) => setStatus(value as Status)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_COLUMNS.map((statusOption) => (
                    <SelectItem key={statusOption.id} value={statusOption.id}>
                      {statusOption.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Repeats</Label>
            <Select value={recurrence} onValueChange={(value) => setRecurrence(value as Recurrence)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RECURRENCES.map((recurrenceOption) => (
                  <SelectItem key={recurrenceOption.id} value={recurrenceOption.id}>
                    {recurrenceOption.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {recurrence !== "none" && (
              <p className="text-[11px] text-muted-foreground">
                When marked complete, the next instance will be created automatically.
              </p>
            )}

            {recurrence !== "none" && (
              <div className="mt-2 space-y-2 rounded-md border border-border bg-secondary/40 p-3">
                <Label className="text-xs">Ends</Label>

                <Select
                  value={endMode}
                  onValueChange={(value) => setEndMode(value as EndMode)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="never">Never</SelectItem>
                    <SelectItem value="on">On date</SelectItem>
                    <SelectItem value="after">After N occurrences</SelectItem>
                  </SelectContent>
                </Select>

                {endMode === "on" && (
                  <Input
                    type="date"
                    value={endDate}
                    min={due}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                )}

                {endMode === "after" && (
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={1}
                      value={occurrences}
                      onChange={(e) => setOccurrences(e.target.value)}
                      className="w-24"
                    />
                    <span className="text-xs text-muted-foreground">occurrences total</span>
                  </div>
                )}
              </div>
            )}
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