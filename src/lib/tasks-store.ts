// src/lib/tasks-store.ts
import { useEffect, useSyncExternalStore } from "react";
import { supabase } from "@/lib/supabase";
import type { Task, TaskEntityType } from "@/lib/mock-data";

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

function toAppStatus(status: string | null): Task["status"] {
  switch (status) {
    case "in_progress":
    case "in-progress":
      return "in_progress";
    case "review":
      return "review";
    case "done":
    case "completed":
      return "done";
    default:
      return "todo";
  }
}

function toDbStatus(status: Task["status"]): string {
  switch (status) {
    case "in_progress":
      return "in_progress";
    case "review":
      return "review";
    case "done":
      return "done";
    default:
      return "not_started";
  }
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
    status: toAppStatus(row.status),
    priority: toAppPriority(row.priority),
    recurrence: "none",
    entityType: isTaskEntityType(row.entity_type) ? row.entity_type : undefined,
    entityId: row.entity_id ?? undefined,
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

  const insertPayload: Record<string, any> = {
    title: task.title,
    status: toDbStatus(task.status),
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

export async function updateTask(id: string, patch: TaskPatch) {
  const update: Record<string, any> = {
    updated_at: new Date().toISOString(),
  };

  if (patch.title !== undefined) update.title = patch.title;
  if (patch.status !== undefined) {
    update.status = toDbStatus(patch.status);
    update.completed_at = patch.status === "done" ? new Date().toISOString() : null;
  }
  if (patch.priority !== undefined) update.priority = toDbPriority(patch.priority);
  if (patch.due !== undefined) update.due_date = patch.due ? patch.due.slice(0, 10) : null;
  if (patch.assignedTo !== undefined) update.assigned_to = patch.assignedTo;

  // entityType/entityId are only ever changed together — clearing one
  // without the other would violate the DB's paired-null check constraint.
  if (patch.entityType !== undefined || patch.entityId !== undefined) {
    const typeIsNull = (patch.entityType ?? null) === null;
    const idIsNull = (patch.entityId ?? null) === null;
    if (typeIsNull !== idIsNull) {
      console.error("[tasks-store] updateTask: entityType and entityId must be cleared/set together");
      return;
    }
    update.entity_type = patch.entityType ?? null;
    update.entity_id = patch.entityId ?? null;
  }

  const { error } = await supabase.from("tasks").update(update).eq("id", id);

  if (error) {
    console.error("[tasks-store] update failed:", error);
    return;
  }

  tasks = tasks.map((task) => {
    if (task.id !== id) return task;
    const { entityType, entityId, ...rest } = patch;
    const next: Task = { ...task, ...rest };
    if (entityType !== undefined) next.entityType = entityType ?? undefined;
    if (entityId !== undefined) next.entityId = entityId ?? undefined;
    return next;
  });
  emit();
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

export async function completeTask(id: string): Promise<Task | null> {
  await updateTask(id, { status: "done" });
  return null;
}
