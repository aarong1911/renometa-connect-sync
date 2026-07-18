// src/lib/tasks-store.ts
import { useEffect, useSyncExternalStore } from "react";
import { supabase } from "@/lib/supabase";
import type { Task } from "@/lib/mock-data";

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
    projectId: row.project_id,
    title: row.title,
    assignee: assigneeName,
    assigneeInitials: initials,
    due: row.due_date
      ? new Date(`${row.due_date}T12:00:00Z`).toISOString()
      : new Date(row.created_at ?? Date.now()).toISOString(),
    status: toAppStatus(row.status),
    priority: toAppPriority(row.priority),
    recurrence: "none",
  };
}

let tasks: Task[] = [];
let loaded = false;

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

async function fetchTasks() {
  const { orgId } = await getSessionContext();
  if (!orgId) {
    tasks = [];
    loaded = true;
    emit();
    return;
  }

  const { data, error } = await supabase
    .from("tasks")
    .select(
      `
      *,
      projects!inner(org_id),
      assignee_profile:profiles!tasks_assigned_to_fkey(first_name,last_name,email)
    `,
    )
    .eq("projects.org_id", orgId)
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

export async function addTask(task: Omit<Task, "id">): Promise<Task | null> {
  const { userId } = await getSessionContext();
  if (!userId) return null;

  const dueDate = task.due ? task.due.slice(0, 10) : null;

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      project_id: task.projectId,
      title: task.title,
      status: toDbStatus(task.status),
      priority: toDbPriority(task.priority),
      due_date: dueDate,
      created_by: userId,
      stage: "planning",
      stage_position: 0,
    })
    .select("*")
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

export async function updateTask(id: string, patch: Partial<Task>) {
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

  const { error } = await supabase.from("tasks").update(update).eq("id", id);

  if (error) {
    console.error("[tasks-store] update failed:", error);
    return;
  }

  tasks = tasks.map((task) => (task.id === id ? { ...task, ...patch } : task));
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