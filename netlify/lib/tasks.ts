// netlify/lib/tasks.ts
//
// Phase 10.2 — canonical SERVER-SIDE task creation helper. The one place
// every Netlify function (workflow engine, agentic actions, any future
// server-originated task writer) creates a task, instead of each one
// hand-rolling its own `.from("tasks").insert(...)` with a different guess
// at column names (the Phase 10.1/10.2 audit found three mutually-
// inconsistent shapes: tasks-store.ts's own, and two different wrong ones
// in execute-workflow.ts and run-agent.ts).
//
// Server-only: this file uses a service-role SupabaseClient passed in by
// the caller and must never be imported from browser code. It deliberately
// does NOT import src/lib/tasks-store.ts (browser-only, anon-client,
// React-hook-based) — browser and server task-write layers stay separate,
// per Phase 10.2's explicit instruction.
//
// Validates same-org entity link and same-org assignee itself (in
// addition to the DB-level validate_task_entity_link/validate_task_assignee
// triggers from the 20260803/20260805 migrations) so a caller gets a clear,
// actionable error instead of a raw Postgres exception.

import type { SupabaseClient } from "@supabase/supabase-js";

// Canonical live DB values (tasks_status_check) — "review"/"done" were
// never valid and caused every completion write to fail with Postgres
// error 23514. See src/lib/task-status.ts for the browser-side equivalent.
export type ServerTaskStatus = "not_started" | "in_progress" | "on_hold" | "completed" | "cancelled";
export type ServerTaskPriority = "low" | "medium" | "high";
export type ServerTaskEntityType = "lead" | "deal";

export type ServerCreateTaskInput = {
  orgId: string;
  title: string;
  description?: string | null;
  status?: ServerTaskStatus;
  priority?: ServerTaskPriority;
  dueDate?: string | null;
  assignedTo?: string | null;
  createdBy?: string | null;
  projectId?: string | null;
  entityType?: ServerTaskEntityType | null;
  entityId?: string | null;
};

const SUPPORTED_ENTITY_TYPES: ServerTaskEntityType[] = ["lead", "deal"];

/**
 * Creates one real task row. Throws (never returns a fake success) on any
 * validation or insert failure — mirrors src/lib/agentic/lead-notes.ts's
 * and lead-tasks.ts's "verify, insert, throw" contract.
 */
export async function createServerTask(
  supabase: SupabaseClient,
  input: ServerCreateTaskInput,
): Promise<{ taskId: string }> {
  if (!input.orgId) throw new Error("orgId is required to create a task.");
  if (!input.title || !input.title.trim()) throw new Error("Task title is required.");

  const entityType = input.entityType ?? null;
  const entityId = input.entityId ?? null;
  if ((entityType === null) !== (entityId === null)) {
    throw new Error("entityType and entityId must be provided together.");
  }
  if (entityType !== null && !SUPPORTED_ENTITY_TYPES.includes(entityType)) {
    throw new Error(`Unsupported task entity type: ${entityType}`);
  }

  if (entityType === "lead") {
    const { data: lead, error } = await supabase
      .from("leads")
      .select("id")
      .eq("id", entityId)
      .eq("org_id", input.orgId)
      .maybeSingle();
    if (error) throw new Error(`Could not verify the linked lead: ${error.message}`);
    if (!lead) throw new Error("Linked lead not found in this organization.");
  } else if (entityType === "deal") {
    const { data: deal, error } = await supabase
      .from("deals")
      .select("id")
      .eq("id", entityId)
      .eq("org_id", input.orgId)
      .maybeSingle();
    if (error) throw new Error(`Could not verify the linked deal: ${error.message}`);
    if (!deal) throw new Error("Linked deal not found in this organization.");
  }

  if (input.assignedTo) {
    const { data: membership } = await supabase
      .from("org_memberships")
      .select("member_id")
      .eq("member_id", input.assignedTo)
      .eq("org_id", input.orgId)
      .maybeSingle();
    if (!membership) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("id")
        .eq("id", input.assignedTo)
        .eq("organization_id", input.orgId)
        .maybeSingle();
      if (!profile) throw new Error("Assignee is not a member of this organization.");
    }
  }

  const insertPayload: Record<string, unknown> = {
    org_id: input.orgId,
    title: input.title.trim(),
    status: input.status ?? "not_started",
    priority: input.priority ?? "medium",
    due_date: input.dueDate ?? null,
    assigned_to: input.assignedTo ?? null,
    created_by: input.createdBy ?? null,
  };
  if (input.description != null) insertPayload.description = input.description;
  if (input.projectId) insertPayload.project_id = input.projectId;
  if (entityType && entityId) {
    insertPayload.entity_type = entityType;
    insertPayload.entity_id = entityId;
  }

  const { data, error } = await supabase
    .from("tasks")
    .insert(insertPayload)
    .select("id")
    .single();

  if (error || !data) throw new Error(`Could not create the task: ${error?.message ?? "no row returned"}`);
  return { taskId: data.id as string };
}
