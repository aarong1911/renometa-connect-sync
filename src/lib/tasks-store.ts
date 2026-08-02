// src/lib/tasks-store.ts
import { useEffect, useState, useSyncExternalStore } from "react";
import { supabase } from "@/lib/supabase";
import type { Task, TaskEntityType, TaskActivity, TaskActivityType } from "@/lib/mock-data";
import { getTaskStatusPatch, type TaskStatus } from "@/lib/task-status";

export type { TaskStatus, TaskPriority, TaskActivity, TaskActivityType } from "@/lib/mock-data";

async function getSessionContext(): Promise<{ orgId: string | null; userId: string | null }> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { orgId: null, userId: null };

  const { data: profile } = await supabase
    .from("profiles")
    .select("organization_id")
    .eq("id", user.id)
    .maybeSingle();

  if (profile?.organization_id) {
    return { orgId: profile.organization_id, userId: user.id };
  }

  const { data: membership } = await supabase
    .from("org_memberships")
    .select("org_id")
    .eq("member_id", user.id)
    .maybeSingle();

  return { orgId: membership?.org_id ?? null, userId: user.id };
}

const VALID_STATUSES: TaskStatus[] = ["not_started", "in_progress", "on_hold", "completed", "cancelled"];

function toAppStatus(status: string | null): TaskStatus {
  return (VALID_STATUSES as string[]).includes(status ?? "") ? (status as TaskStatus) : "not_started";
}

function toAppPriority(priority: string | null): Task["priority"] {
  switch (priority) {
    case "high":
      return "high";
    case "low":
      return "low";
    default:
      return "med";
  }
}

function toDbPriority(priority: Task["priority"]): string {
  if (priority === "med") return "medium";
  return priority;
}

function isTaskEntityType(value: unknown): value is TaskEntityType {
  return value === "lead" || value === "deal";
}

function mapRow(row: any): Task {
  const assigneeName =
    row.assignee_profile?.first_name || row.assignee_profile?.last_name
      ? `${row.assignee_profile?.first_name ?? ""} ${row.assignee_profile?.last_name ?? ""}`.trim()
      : "Unassigned";

  const initials =
    assigneeName !== "Unassigned"
      ? assigneeName
          .split(" ")
          .map((part) => part[0])
          .join("")
          .slice(0, 2)
          .toUpperCase()
      : "—";

  return {
    id: row.id,
    projectId: row.project_id ?? undefined,
    title: row.title,
    assignee: assigneeName,
    assigneeInitials: initials,
    assignedTo: row.assigned_to ?? null,
    due: row.due_date
      ? new Date(`${row.due_date}T12:00:00Z`).toISOString()
      : new Date(row.created_at ?? Date.now()).toISOString(),
    // Canonical DB values used directly — no app/DB translation layer.
    // See src/lib/task-status.ts for the single source of truth on
    // labels/order/icons/lifecycle. toAppStatus only guards against an
    // unrecognized live value rather than crashing the UI.
    status: toAppStatus(row.status),
    completedAt: row.completed_at ?? null,
    priority: toAppPriority(row.priority),
    recurrence: "none",
    entityType: isTaskEntityType(row.entity_type) ? row.entity_type : undefined,
    entityId: row.entity_id ?? undefined,
    phaseId: row.phase_id ?? null,
    milestoneId: row.milestone_id ?? null,
  };
}

const TASK_COLUMNS = `
  *,
  assignee_profile:profiles!tasks_assigned_to_fkey(first_name,last_name,email)
`;

let tasks: Task[] = [];
let loaded = false;
let currentOrgId: string | null = null;

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

async function fetchTasks() {
  const { orgId } = await getSessionContext();
  currentOrgId = orgId;
  if (!orgId) {
    tasks = [];
    loaded = true;
    emit();
    return;
  }

  // Scoped directly by tasks.org_id (Phase 10.1) — no longer requires a
  // projects!inner(org_id) join, so a lead/deal-linked task with no
  // project still shows up. Pre-existing project-only tasks are backfilled
  // with org_id by the Phase 10.1 migration.
  const { data, error } = await supabase
    .from("tasks")
    .select(TASK_COLUMNS)
    .eq("org_id", orgId)
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[tasks-store] fetch failed:", error);
    loaded = true;
    emit();
    return;
  }

  tasks = (data ?? []).map(mapRow);
  loaded = true;
  emit();
}

fetchTasks();

export function useTasks(): Task[] {
  useEffect(() => {
    if (!loaded) void fetchTasks();
  }, []);

  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    () => tasks,
    () => [],
  );
}

export function useTasksLoading(): boolean {
  return !loaded;
}

export async function refreshTasks() {
  await fetchTasks();
}

/**
 * Client-side filter of the already-loaded shared task list — no extra
 * query per entity detail view (Phase 10.1 performance requirement).
 * Reactive: re-renders whenever the shared `tasks` store changes (create/
 * update/delete/refresh), same as useTasks().
 */
export function useTasksForEntity(entityType: TaskEntityType, entityId: string | null | undefined): Task[] {
  const all = useTasks();
  if (!entityId) return [];
  return all.filter((t) => t.entityType === entityType && t.entityId === entityId);
}

/** One-off (non-reactive) fetch of a specific entity's tasks — for contexts outside a component render (e.g. a one-time count). Prefer useTasksForEntity in components. */
export async function getTasksForEntity(entityType: TaskEntityType, entityId: string): Promise<Task[]> {
  const { orgId } = await getSessionContext();
  if (!orgId) return [];

  const { data, error } = await supabase
    .from("tasks")
    .select(TASK_COLUMNS)
    .eq("org_id", orgId)
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .order("due_date", { ascending: true, nullsFirst: false });

  if (error) {
    console.error("[tasks-store] getTasksForEntity failed:", error);
    return [];
  }
  return (data ?? []).map(mapRow);
}

/** assignee/assigneeInitials are always derived server-side from the assigned_to profile join — never accepted on create. Pass assignedTo (a real profile UUID) instead. */
export type CreateTaskInput = Omit<Task, "id" | "assignee" | "assigneeInitials">;

export async function addTask(task: CreateTaskInput): Promise<Task | null> {
  const { userId, orgId } = await getSessionContext();
  if (!userId || !orgId) return null;

  // Type/id must travel together — never send one without the other.
  if ((task.entityType == null) !== (task.entityId == null)) {
    console.error("[tasks-store] addTask: entityType and entityId must be set together");
    return null;
  }

  const dueDate = task.due ? task.due.slice(0, 10) : null;
  const { status, completedAt } = getTaskStatusPatch(task.status ?? "not_started", task.completedAt);

  const insertPayload: Record<string, any> = {
    title: task.title,
    status,
    completed_at: completedAt,
    priority: toDbPriority(task.priority),
    due_date: dueDate,
    created_by: userId,
    org_id: orgId,
    stage: "planning",
    stage_position: 0,
  };
  if (task.projectId) insertPayload.project_id = task.projectId;
  if (task.assignedTo) insertPayload.assigned_to = task.assignedTo;
  if (task.entityType && task.entityId) {
    insertPayload.entity_type = task.entityType;
    insertPayload.entity_id = task.entityId;
  }
  if (task.phaseId) insertPayload.phase_id = task.phaseId;
  if (task.milestoneId) insertPayload.milestone_id = task.milestoneId;

  const { data, error } = await supabase
    .from("tasks")
    .insert(insertPayload)
    .select(TASK_COLUMNS)
    .single();

  if (error) {
    console.error("[tasks-store] insert failed:", JSON.stringify(error, null, 2));
    return null;
  }

  const mapped = mapRow(data);
  tasks = [mapped, ...tasks];
  emit();
  return mapped;
}

export type TaskPatch = Omit<Partial<Task>, "entityType" | "entityId"> & {
  /** Set to null (not undefined) to explicitly clear an existing entity link. Must be paired with entityId: null in the same call. */
  entityType?: TaskEntityType | null;
  entityId?: string | null;
};

/**
 * Updates a task. Optimistic: local state only changes after the database
 * write is confirmed — no rollback needed because nothing is applied
 * ahead of the response. Any status change is routed through
 * getTaskStatusPatch() (src/lib/task-status.ts) — the one place
 * completed_at lifecycle rules are decided — so Mark complete / Reopen /
 * Cancel / Restore / the status selector / drag-and-drop can never
 * disagree with each other.
 */
export async function updateTask(id: string, patch: TaskPatch): Promise<{ ok: true } | { ok: false; error: string }> {
  const update: Record<string, any> = {
    updated_at: new Date().toISOString(),
  };

  let resolvedStatus: TaskStatus | undefined;
  let resolvedCompletedAt: string | null | undefined;

  if (patch.title !== undefined) update.title = patch.title;
  if (patch.status !== undefined) {
    const current = tasks.find((t) => t.id === id);
    const resolved = getTaskStatusPatch(patch.status, current?.completedAt);
    resolvedStatus = resolved.status;
    resolvedCompletedAt = resolved.completedAt;
    update.status = resolved.status;
    update.completed_at = resolved.completedAt;
  }
  if (patch.priority !== undefined) update.priority = toDbPriority(patch.priority);
  if (patch.due !== undefined) update.due_date = patch.due ? patch.due.slice(0, 10) : null;
  if (patch.assignedTo !== undefined) update.assigned_to = patch.assignedTo;
  if (patch.phaseId !== undefined) update.phase_id = patch.phaseId;
  if (patch.milestoneId !== undefined) update.milestone_id = patch.milestoneId;

  // entityType/entityId are only ever changed together — clearing one
  // without the other would violate the DB's paired-null check constraint.
  if (patch.entityType !== undefined || patch.entityId !== undefined) {
    const typeIsNull = (patch.entityType ?? null) === null;
    const idIsNull = (patch.entityId ?? null) === null;
    if (typeIsNull !== idIsNull) {
      const message = "entityType and entityId must be cleared/set together";
      console.error(`[tasks-store] updateTask: ${message}`);
      return { ok: false, error: message };
    }
    update.entity_type = patch.entityType ?? null;
    update.entity_id = patch.entityId ?? null;
  }

  const { error } = await supabase.from("tasks").update(update).eq("id", id);

  if (error) {
    console.error("[tasks-store] update failed:", error);
    return { ok: false, error: error.message };
  }

  tasks = tasks.map((task) => {
    if (task.id !== id) return task;
    const { entityType, entityId, status, completedAt, ...rest } = patch;
    void status; void completedAt; // superseded by resolvedStatus/resolvedCompletedAt below
    const next: Task = { ...task, ...rest };
    if (resolvedStatus !== undefined) next.status = resolvedStatus;
    if (resolvedCompletedAt !== undefined) next.completedAt = resolvedCompletedAt;
    if (entityType !== undefined) next.entityType = entityType ?? undefined;
    if (entityId !== undefined) next.entityId = entityId ?? undefined;
    return next;
  });
  emit();
  return { ok: true };
}

export async function deleteTask(id: string) {
  const { error } = await supabase.from("tasks").delete().eq("id", id);

  if (error) {
    console.error("[tasks-store] delete failed:", error);
    return;
  }

  tasks = tasks.filter((task) => task.id !== id);
  emit();
}

export async function completeTask(id: string) {
  return updateTask(id, { status: "completed" });
}

/** Reverses completeTask — moves back to Not Started. The DB activity trigger records this as "reopened", not a second "completed". */
export async function reopenTask(id: string) {
  return updateTask(id, { status: "not_started" });
}

/** Cancels a task — retains all history, never deletes it. completed_at is cleared (a cancelled task was never actually finished). */
export async function cancelTask(id: string) {
  return updateTask(id, { status: "cancelled" });
}

/** Restores a cancelled task back to Not Started. */
export async function restoreTask(id: string) {
  return updateTask(id, { status: "not_started" });
}

// ── task activity (Phase 10.2, read-only from the browser) ─────────────────
// task_activities rows are written exclusively by the DB trigger
// (log_task_activity, see 20260805_task_system_completion.sql /
// 20260806_fix_task_status_lifecycle.sql) — there is no
// addTaskActivity()/insert path here on purpose, matching "choose one
// source of truth" for activity generation.

function mapActivityRow(row: any): TaskActivity {
  return {
    id: row.id,
    taskId: row.task_id,
    actorId: row.actor_id ?? null,
    activityType: row.activity_type as TaskActivityType,
    summary: row.summary,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

/** One-off fetch, newest first. */
export async function getTaskActivity(taskId: string): Promise<TaskActivity[]> {
  const { data, error } = await supabase
    .from("task_activities")
    .select("id, task_id, actor_id, activity_type, summary, metadata, created_at")
    .eq("task_id", taskId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[tasks-store] getTaskActivity failed:", error);
    return [];
  }
  return (data ?? []).map(mapActivityRow);
}

/** Reactive hook — refetches whenever taskId changes. Not wired into the shared tasks store (activity is a separate, much smaller table queried per open task detail, not per task row in a list — avoids loading every task's full history up front). */
export function useTaskActivity(taskId: string | null | undefined): { activity: TaskActivity[]; loading: boolean } {
  const [activity, setActivity] = useState<TaskActivity[]>([]);
  const [loading, setLoading] = useState(!!taskId);

  useEffect(() => {
    if (!taskId) { setActivity([]); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    getTaskActivity(taskId).then((rows) => {
      if (!cancelled) { setActivity(rows); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [taskId]);

  return { activity, loading };
}
