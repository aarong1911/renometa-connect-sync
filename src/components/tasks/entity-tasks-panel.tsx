// src/components/tasks/entity-tasks-panel.tsx
//
// Phase 10.1 — one compact, reusable "linked tasks" section for use inside
// the Lead detail drawer and the Deal detail drawer's Tasks tab. Reads and
// writes through the SAME shared src/lib/tasks-store.ts used by the global
// Tasks page (no separate lead-tasks/deal-tasks store) — a task created
// here is a real row, immediately visible on /tasks, and vice versa.
//
// Deliberately not a redesign of either drawer: this is one self-contained
// panel dropped into an existing tab/section, matching the app's existing
// Button/Card/Badge/Select density (h-8/h-9 controls, compact rows).

import { useState } from "react";
import { CheckCircle2, Circle, Clock3, Plus, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useTasksForEntity, addTask, updateTask, type CreateTaskInput } from "@/lib/tasks-store";
import type { Task, TaskEntityType } from "@/lib/mock-data";
import { useTeam } from "@/lib/organization";

const PRIORITY_LABEL: Record<Task["priority"], string> = { low: "Low", med: "Medium", high: "High" };

function isOverdue(due: string, status: Task["status"]): boolean {
  if (status === "done") return false;
  return new Date(due).getTime() < Date.now();
}

function fmtDue(due: string): string {
  return new Date(due).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function EntityTasksPanel({
  entityType,
  entityId,
  entityLabel,
}: {
  entityType: TaskEntityType;
  entityId: string;
  /** e.g. "lead" / "deal" — used only in the empty-state and add-task copy. */
  entityLabel: string;
}) {
  const tasks = useTasksForEntity(entityType, entityId);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);

  const open = tasks.filter((t) => t.status !== "done");
  const done = tasks.filter((t) => t.status === "done");

  const handleToggle = async (task: Task) => {
    const next = task.status === "done" ? "todo" : "done";
    await updateTask(task.id, { status: next });
  };

  const openCreate = () => { setEditing(null); setFormOpen(true); };
  const openEdit = (task: Task) => { setEditing(task); setFormOpen(true); };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Tasks</h3>
        <Popover open={formOpen} onOpenChange={setFormOpen}>
          <PopoverTrigger asChild>
            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" /> Add task
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-4">
            <TaskQuickForm
              entityType={entityType}
              entityId={entityId}
              task={editing}
              onDone={() => setFormOpen(false)}
            />
          </PopoverContent>
        </Popover>
      </div>

      {tasks.length === 0 ? (
        <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
          No tasks linked to this {entityLabel}.
        </div>
      ) : (
        <div className="space-y-1.5">
          {[...open, ...done].map((task) => (
            <TaskRow key={task.id} task={task} onToggle={() => handleToggle(task)} onEdit={() => openEdit(task)} />
          ))}
        </div>
      )}
    </div>
  );
}

function TaskRow({ task, onToggle, onEdit }: { task: Task; onToggle: () => void; onEdit: () => void }) {
  const overdue = isOverdue(task.due, task.status);
  const done = task.status === "done";

  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-md border border-border p-2.5",
        done && "opacity-60",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-label={done ? `Reopen task: ${task.title}` : `Complete task: ${task.title}`}
        className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-full"
      >
        {done ? <CheckCircle2 className="h-4 w-4 text-success" /> : <Circle className="h-4 w-4" />}
      </button>

      <button
        type="button"
        onClick={onEdit}
        className="min-w-0 flex-1 text-left focus-visible:outline-none"
      >
        <p className={cn("truncate text-[13px] font-medium", done && "line-through")}>{task.title}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="h-4.5 rounded px-1.5 text-[9.5px]">
            {PRIORITY_LABEL[task.priority]}
          </Badge>
          <span className={cn("flex items-center gap-1 text-[10.5px]", overdue ? "font-medium text-red-600" : "text-muted-foreground")}>
            {overdue ? <AlertTriangle className="h-3 w-3" /> : <Clock3 className="h-3 w-3" />}
            {fmtDue(task.due)}
          </span>
          <span className="text-[10.5px] text-muted-foreground">{task.assignee}</span>
        </div>
      </button>
    </div>
  );
}

function TaskQuickForm({
  entityType,
  entityId,
  task,
  onDone,
}: {
  entityType: TaskEntityType;
  entityId: string;
  task: Task | null;
  onDone: () => void;
}) {
  const teamMembers = useTeam().filter((m) => m.status === "active");
  const [title, setTitle] = useState(task?.title ?? "");
  const [due, setDue] = useState(task ? task.due.slice(0, 10) : new Date().toISOString().slice(0, 10));
  const [priority, setPriority] = useState<Task["priority"]>(task?.priority ?? "med");
  const [assignedTo, setAssignedTo] = useState<string>(task?.assignedTo ?? "unassigned");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!title.trim()) { toast.error("Title is required"); return; }
    setSaving(true);

    if (task) {
      await updateTask(task.id, {
        title: title.trim(),
        due: new Date(due).toISOString(),
        priority,
        assignedTo: assignedTo === "unassigned" ? null : assignedTo,
      });
      toast.success("Task updated");
    } else {
      const input: CreateTaskInput = {
        title: title.trim(),
        due: new Date(due).toISOString(),
        priority,
        status: "todo",
        assignedTo: assignedTo === "unassigned" ? null : assignedTo,
        entityType,
        entityId,
      };
      const created = await addTask(input);
      if (!created) { toast.error("Could not create task"); setSaving(false); return; }
      toast.success("Task created");
    }

    setSaving(false);
    onDone();
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-xs">Title</Label>
        <Input className="h-8 text-sm" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <Label className="text-xs">Due date</Label>
          <Input className="h-8 text-sm" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Priority</Label>
          <Select value={priority} onValueChange={(v) => setPriority(v as Task["priority"])}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="med">Medium</SelectItem>
              <SelectItem value="high">High</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Assignee</Label>
        <Select value={assignedTo} onValueChange={setAssignedTo}>
          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="unassigned">Unassigned</SelectItem>
            {teamMembers.map((m) => (
              <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button size="sm" className="h-8 w-full" disabled={saving} onClick={handleSave}>
        {task ? "Save changes" : "Create task"}
      </Button>
    </div>
  );
}
