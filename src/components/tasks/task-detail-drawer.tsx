// src/components/tasks/task-detail-drawer.tsx
//
// Canonical Task detail drawer + edit dialog — extracted from
// src/routes/tasks.tsx (Phase 13.2C — Calendar Task-drawer reuse) so both
// the global Tasks page and the Calendar page open the exact same
// component, with the exact same assignment/status/activity behavior,
// instead of Calendar navigating away to /tasks or forking its own copy.
import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Ban, FolderKanban, Handshake, Link2Off, Trash2, UserRound } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";

import { cn } from "@/lib/utils";
import type { Task, TaskActivity } from "@/lib/mock-data";
import { getProjectName } from "@/lib/projects-store";
import {
  addTask, updateTask, deleteTask, completeTask, reopenTask, cancelTask, restoreTask, useTaskActivity,
} from "@/lib/tasks-store";
import { useLeads } from "@/lib/leads-store";
import { useDeals } from "@/lib/deals-store";
import { leadDetailLink, dealDetailLink } from "@/lib/routes";
import { useTeam, type TeamMember } from "@/lib/organization";
import { EntityPicker } from "@/components/tasks/entity-picker";
import {
  TASK_STATUS_ORDER, TASK_STATUS_LABELS, TASK_STATUS_ICONS, TASK_STATUS_TINT, type TaskStatus,
} from "@/lib/task-status";

export type Priority = Task["priority"];

export const PRIORITIES: { id: Priority; label: string }[] = [
  { id: "low", label: "Low" },
  { id: "med", label: "Medium" },
  { id: "high", label: "High" },
];

export const NO_PROJECT = "__none__";

export function fmtDue(iso: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));
}

/** For the visible due-date chip — "No due date" instead of silently showing task.due's created_at fallback as if it were a real date. */
export function fmtDueOrNone(dueRaw: string | null | undefined) {
  return dueRaw ? fmtDue(dueRaw) : "No due date";
}

/** "HH:MM" (24h wall-clock) -> "10:30 AM". Returns "" for anything unparseable. */
export function fmtDueTimeLabel(hhmm: string | null | undefined) {
  const m = (hhmm ?? "").match(/^(\d{1,2}):(\d{2})/);
  if (!m) return "";
  let h = parseInt(m[1], 10);
  if (Number.isNaN(h) || h > 23) return "";
  const suffix = h < 12 ? "AM" : "PM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m[2]} ${suffix}`;
}

/**
 * Due-date detail line. With a time: "Sep 3, 10:30 AM". Date only: "Sep 3"
 * (never a spurious "12:00 AM"). No due date: "No due date". The time is a
 * plain org-local wall-clock string — rendered as-is, never shifted by the
 * viewer's timezone.
 */
export function fmtDueDetail(dueRaw: string | null | undefined, dueTime: string | null | undefined) {
  if (!dueRaw) return "No due date";
  const time = fmtDueTimeLabel(dueTime);
  return time ? `${fmtDue(dueRaw)}, ${time}` : fmtDue(dueRaw);
}

export function projectName(id: string | undefined) {
  return id ? getProjectName(id) : "No project";
}

/**
 * Single canonical assignee resolver — keyed by the same assigned_to id
 * updateTask()'s local merge (src/lib/tasks-store.ts) uses, resolved from
 * the already-loaded team store (no query per card/drawer). assigneesById
 * is unfiltered by member status so a deactivated assignee still resolves
 * a real name rather than falling back unnecessarily.
 */
export function resolveAssigneeName(task: Task, assigneesById: Map<string, TeamMember>): string | null {
  if (!task.assignedTo) return null;
  const assignee = assigneesById.get(task.assignedTo);
  if (assignee?.name?.trim()) return assignee.name.trim();
  if (assignee?.email?.trim()) return assignee.email.trim();
  return "Assigned team member";
}

export async function handleStatusMutation(
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

/**
 * "Related to" cell — resolves a task's linked project OR Lead/Deal
 * (mutually exclusive today) from the already-loaded shared stores — no
 * extra query per row. Missing/deleted targets degrade to a plain,
 * non-clickable label rather than erroring.
 */
export function RelatedToCell({ task, showIcon = true, hideProject = false }: { task: Task; showIcon?: boolean; hideProject?: boolean }) {
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
    // Part 11: the Project name is redundant (and adds noise) once cards are
    // already grouped by, or filtered to, that single Project — keep it in
    // the accessible label so context isn't lost for assistive tech, but
    // hide the visible text.
    if (hideProject) {
      return (
        <span className="flex min-w-0 items-center gap-1 truncate text-muted-foreground" title={`Project: ${projectName(task.projectId)}`}>
          {showIcon && <FolderKanban className="h-3 w-3 shrink-0" />}
          <span className="sr-only">Project: {projectName(task.projectId)}</span>
          <span className="truncate" aria-hidden="true">Project task</span>
        </span>
      );
    }
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

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border pb-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
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

/**
 * Canonical Task detail drawer — used by both the global Tasks page and
 * Calendar (Part 3). Mark complete/Reopen/Cancel/Restore all go through
 * the same tasks-store lifecycle helpers regardless of caller, so status
 * changes made from Calendar are indistinguishable from ones made on the
 * Tasks page.
 */
export function TaskDetailSheet({
  task,
  assigneesById,
  onClose,
  onEdit,
}: {
  task: Task | null;
  assigneesById: Map<string, TeamMember>;
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
              <Fact label="Assignee" value={resolveAssigneeName(task, assigneesById) ?? "Unassigned"} />
              <Fact label="Due" value={fmtDueDetail(task.dueDateRaw, task.dueTime)} />
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

              <Button
                variant="ghost"
                className="w-full text-destructive hover:text-destructive"
                onClick={async () => {
                  if (!window.confirm(`Delete "${task.title}"? This cannot be undone.`)) return;
                  await deleteTask(task.id);
                  toast.success("Task deleted");
                  onClose();
                }}
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete task
              </Button>

              <TaskActivitySection taskId={task.id} />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

/**
 * Canonical Task create/edit dialog — used by both the global Tasks page
 * and Calendar's "Edit" action from the drawer above (Part 7), so
 * reassigning/rescheduling/reprioritizing a Task from Calendar goes
 * through the exact same addTask/updateTask path as the Tasks page.
 */
export function TaskFormDialog({
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
  // Optional time-of-day companion to `due`. "" = date-only (the default,
  // and what clearing the field means). Native <input type="time"> value is
  // already "HH:MM", the canonical Task.dueTime shape.
  const [dueTime, setDueTime] = useState(task?.dueTime ?? "");

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
      dueTime: dueTime || null,
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
      <DialogContent className="max-w-[560px]">
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

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="grid min-w-0 gap-1.5">
              <Label htmlFor="task-project">Project</Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger id="task-project" className="w-full min-w-0">
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

            <div className="grid min-w-0 gap-1.5">
              <Label htmlFor="task-assignee">Assignee</Label>
              <Select value={assignedTo} onValueChange={setAssignedTo}>
                <SelectTrigger id="task-assignee" className="w-full min-w-0">
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

          <div className="grid gap-1.5">
            <Label htmlFor="task-related-type">Related to</Label>
            {/* Single column until a Lead/Deal type is chosen — the second
                cell only appears (and the row only splits) once the entity
                picker is actually useful, so there is no empty half-row. */}
            <div className={cn("grid gap-3", relatedTo !== "none" && "sm:grid-cols-2")}>
              <Select
                value={relatedTo}
                onValueChange={(value) => {
                  setRelatedTo(value as "none" | "lead" | "deal");
                  setRelatedEntityId(null);
                }}
              >
                <SelectTrigger id="task-related-type" className="w-full min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="lead">Lead</SelectItem>
                  <SelectItem value="deal">Deal</SelectItem>
                </SelectContent>
              </Select>

              {relatedTo !== "none" && (
                <div className="min-w-0">
                  <EntityPicker
                    entityType={relatedTo}
                    value={relatedEntityId}
                    onSelect={setRelatedEntityId}
                  />
                </div>
              )}
            </div>
          </div>

          {/* Scheduling — two balanced two-column rows matching the rest of
              the modal's rhythm. Due date / Due time keep the Appointment
              dialog's labelled-cell + bare <Input type="time"> treatment
              (same h-9 primitive, no custom icon). */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="grid min-w-0 gap-1.5">
              <Label htmlFor="task-due">Due date</Label>
              <Input
                id="task-due"
                type="date"
                value={due}
                onChange={(e) => {
                  const nextDue = e.target.value;
                  setDue(nextDue);
                  // No date → no time-only orphan (matches the store rule).
                  if (!nextDue) setDueTime("");
                }}
              />
            </div>

            <div className="grid min-w-0 gap-1.5">
              <Label htmlFor="task-due-time">Due time</Label>
              <Input
                id="task-due-time"
                type="time"
                value={dueTime}
                onChange={(e) => setDueTime(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="grid min-w-0 gap-1.5">
              <Label htmlFor="task-priority">Priority</Label>
              <Select value={priority} onValueChange={(value) => setPriority(value as Priority)}>
                <SelectTrigger id="task-priority" className="w-full min-w-0">
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

            <div className="grid min-w-0 gap-1.5">
              <Label htmlFor="task-status">Status</Label>
              <Select value={status} onValueChange={(value) => setStatus(value as TaskStatus)}>
                <SelectTrigger id="task-status" className="w-full min-w-0">
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
