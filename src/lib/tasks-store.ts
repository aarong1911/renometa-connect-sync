// src/lib/tasks-store.ts
//
// Platform State Sync Phase S4C — Tasks shared server state.
//
// BEFORE S4C: a module-level `tasks` array + a listener Set + `emit()` +
// `useSyncExternalStore`, hydrated by a top-level `fetchTasks()` call at
// import time. No realtime coverage. Mutations were "persist-first" — the
// local array was only patched AFTER the DB write confirmed (the store's
// own docstring called this "optimistic" but it never applied anything
// ahead of the response, so there was no rollback path and none was
// needed).
//
// AFTER S4C: one TanStack Query per org (`queryKeys.tasks(orgId)`).
// `useTasks()` keeps its EXACT public shape — a bare `Task[]` (`[]` until
// loaded) — as a thin `useQuery` wrapper. `useTasksLoading()`,
// `useTasksForEntity()`, `useTaskActivity()`, and every imperative mutation
// (`addTask`/`updateTask`/`deleteTask`/`completeTask`/`reopenTask`/
// `cancelTask`/`restoreTask`/`refreshTasks`) keep their exact signatures.
// Every consumer (Tasks page board/list/filters/project-groups, the
// canonical Task drawer, entity Task panels on Lead/Deal, Project detail
// task panels, Command Center Today's Tasks + Needs Attention atomic tasks
// + its Projects rollup, Calendar's task overlay) reads the same cached
// list. After a confirmed DB write, mutations patch + invalidate the shared
// client (query-client.ts / getQueryClient()) instead of the singleton.
// The central RealtimeBridge now also invalidates `queryKeys.tasks(orgId)`
// on any `tasks` row change.
//
// UNCHANGED by S4C:
//  - `mapRow` normalisation (same TASK_COLUMNS select + assignee_profile
//    join, same fields incl. the legacy `due` created_at fallback that the
//    canonical overdue/due-soon rules DON'T use — they read `dueDateRaw`)
//  - `getTaskStatusPatch()` completed_at lifecycle (task-status.ts) — the
//    one place Mark complete / Reopen / Cancel / Restore / status select /
//    drag agree
//  - schedule-health.ts (pure logic, no store dependency — untouched)
//  - `getTaskActivity` / `useTaskActivity` / `getTasksForEntity` one-off
//    reads (task_activities is a separate small per-task table, never
//    folded into the shared list)
//  - Projects: Task rows carry a bare `projectId`; project NAME resolution
//    stays in the consuming components via projects-store's cache reader —
//    the Task queryFn has zero Project dependency (no circular Query dep)

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Task, TaskEntityType, TaskActivity, TaskActivityType } from "@/lib/mock-data";
import { getTaskStatusPatch, type TaskStatus } from "@/lib/task-status";
import { getTeam } from "@/lib/organization";
import { getQueryClient } from "@/lib/query-client";
import { useOrgId } from "@/lib/org-id";
import { queryKeys } from "@/lib/query-keys";

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

/**
 * Resolves the display name/initials for a canonical assignee id (the same
 * `assigned_to` value the Edit Task selector writes) from the already-loaded
 * team store (src/lib/organization.ts) — no query per task. Used to keep
 * the local optimistic merge in updateTask() in sync after an assignment
 * change, since only mapRow() (which re-joins `profiles` server-side) used
 * to recompute these; a bare `{ ...task, ...patch }` merge left the stale
 * pre-update name in place even though assigned_to itself was correct,
 * which is why the drawer kept showing "Unassigned" after a real
 * assignment. getTeam() is unfiltered by status, so a member who is no
 * longer active still resolves to their real name; only a truly deleted/
 * unknown id falls back to a generic label.
 */
function resolveAssigneeDisplay(assignedTo: string | null | undefined): { assignee: string; assigneeInitials: string } {
  if (!assignedTo) return { assignee: "Unassigned", assigneeInitials: "—" };
  const member = getTeam().find((m) => m.id === assignedTo);
  if (!member || !member.name.trim()) return { assignee: "Assigned team member", assigneeInitials: "—" };
  const initials = member.name.trim().split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  return { assignee: member.name, assigneeInitials: initials || "—" };
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
    dueDateRaw: row.due_date ?? null,
    startDateRaw: row.start_date ?? null,
  };
}

const TASK_COLUMNS = `
  *,
  assignee_profile:profiles!tasks_assigned_to_fkey(first_name,last_name,email)
`;

/**
 * The Tasks list queryFn — org-scoped, ordered by due_date then created_at,
 * with assignee display resolved via the same server-side `profiles` join
 * the pre-S4C store used. Self-contained (no React, no other query's cache)
 * so it is safe to run from `useQuery` or an imperative `refetchQueries`.
 *
 * Scoped directly by tasks.org_id (Phase 10.1) — no longer requires a
 * projects!inner(org_id) join, so a lead/deal-linked task with no project
 * still shows up. Pre-existing project-only tasks are backfilled with
 * org_id by the Phase 10.1 migration.
 */
export async function fetchTasksForOrg(orgId: string): Promise<Task[]> {
  const { data, error } = await supabase
    .from("tasks")
    .select(TASK_COLUMNS)
    .eq("org_id", orgId)
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[tasks-store] fetch failed:", error);
    throw error;
  }
  return (data ?? []).map(mapRow);
}

// ── Query cache helpers ──────────────────────────────────────────────────

const qc = () => getQueryClient();

/** Read the currently-cached Tasks list (any org key — normally exactly one). Read-only; used by updateTask() to resolve the pre-write row for completed_at lifecycle. */
function getCachedTasks(): Task[] {
  const entries = qc().getQueriesData<Task[]>({ queryKey: ["tasks"] });
  for (const [, data] of entries) {
    if (Array.isArray(data)) return data;
  }
  return [];
}

/** Immediately reflect a CONFIRMED change into the cached Tasks list(s) — only ever called AFTER a successful DB write (matching the pre-S4C "persist-first" model), never speculatively, so no rollback path is needed. */
function patchTasksCache(fn: (list: Task[]) => Task[]) {
  qc().setQueriesData<Task[]>({ queryKey: ["tasks"] }, (old) => (Array.isArray(old) ? fn(old) : old));
}

function invalidateTasks() {
  void qc().invalidateQueries({ queryKey: ["tasks"] });
}

/** A task STATUS change (complete/reopen/cancel/restore/drag/status-select) or a delete additionally affects the Command Center's Recent Activity "Task completed" feed, which is served by dashboardSummaryQuery's own `completed` sub-query — not by useTasks(). Today's Tasks + Needs Attention read useTasks() directly, so `["tasks"]` alone refreshes those. */
function invalidateTasksWithDashboard() {
  void qc().invalidateQueries({ queryKey: ["tasks"] });
  void qc().invalidateQueries({ queryKey: ["dashboard"] });
}

// ── Public hooks (unchanged shapes) ─────────────────────────────────────

function useTasksQuery() {
  const orgId = useOrgId();
  return useQuery({
    queryKey: orgId ? queryKeys.tasks(orgId) : ["tasks", "_pending"],
    queryFn: () => fetchTasksForOrg(orgId as string),
    enabled: !!orgId,
    // Tasks change frequently — realtime + mutation invalidation are the
    // primary freshness path; staleTime just caps redundant refetches on
    // remount/focus churn. refetchOnWindowFocus inherited from the shared
    // client defaults. Background refetch keeps the prior list (no blank).
    staleTime: 30_000,
  });
}

export function useTasks(): Task[] {
  return useTasksQuery().data ?? [];
}

export function useTasksLoading(): boolean {
  return useTasksQuery().isLoading;
}

export async function refreshTasks() {
  await qc().refetchQueries({ queryKey: ["tasks"] });
}

/**
 * Client-side filter of the already-loaded shared task list — no extra
 * query per entity detail view (Phase 10.1 performance requirement).
 * Reactive: re-renders whenever the shared tasks query changes (create/
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
  patchTasksCache((list) => [mapped, ...list.filter((t) => t.id !== mapped.id)]);
  invalidateTasks();
  return mapped;
}

export type TaskPatch = Omit<Partial<Task>, "entityType" | "entityId"> & {
  /** Set to null (not undefined) to explicitly clear an existing entity link. Must be paired with entityId: null in the same call. */
  entityType?: TaskEntityType | null;
  entityId?: string | null;
};

/**
 * Updates a task. Persist-first: the shared cache is only patched AFTER the
 * database write is confirmed — nothing is applied ahead of the response,
 * so there is no rollback path (and none is needed). Any status change is
 * routed through getTaskStatusPatch() (src/lib/task-status.ts) — the one
 * place completed_at lifecycle rules are decided — so Mark complete /
 * Reopen / Cancel / Restore / the status selector / drag-and-drop can never
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
    const current = getCachedTasks().find((t) => t.id === id);
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

  patchTasksCache((list) =>
    list.map((task) => {
      if (task.id !== id) return task;
      const { entityType, entityId, status, completedAt, ...rest } = patch;
      void status; void completedAt; // superseded by resolvedStatus/resolvedCompletedAt below
      const next: Task = { ...task, ...rest };
      if (resolvedStatus !== undefined) next.status = resolvedStatus;
      if (resolvedCompletedAt !== undefined) next.completedAt = resolvedCompletedAt;
      if (entityType !== undefined) next.entityType = entityType ?? undefined;
      if (entityId !== undefined) next.entityId = entityId ?? undefined;
      // assignee/assigneeInitials are cached display fields derived from
      // assigned_to — the plain spread above only updates the id, so they
      // must be recomputed here or the UI keeps showing the pre-update name.
      if (patch.assignedTo !== undefined) {
        const { assignee, assigneeInitials } = resolveAssigneeDisplay(patch.assignedTo);
        next.assignee = assignee;
        next.assigneeInitials = assigneeInitials;
      }
      return next;
    }),
  );
  // A status change also affects Command Center Recent Activity's "Task
  // completed" feed (dashboardSummaryQuery's own sub-query); a plain
  // title/priority/assignee/due/project edit does not.
  if (patch.status !== undefined) invalidateTasksWithDashboard();
  else invalidateTasks();
  return { ok: true };
}

export async function deleteTask(id: string) {
  const { error } = await supabase.from("tasks").delete().eq("id", id);

  if (error) {
    console.error("[tasks-store] delete failed:", error);
    return;
  }

  patchTasksCache((list) => list.filter((task) => task.id !== id));
  invalidateTasksWithDashboard();
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
