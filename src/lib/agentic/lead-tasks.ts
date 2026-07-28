// src/lib/agentic/lead-tasks.ts
//
// Phase 10.1 — shared helper for creating a REAL lead-linked task on
// behalf of an agent action, mirroring lead-notes.ts's
// createLeadInternalNote() pattern (verify the lead's org, insert one row,
// return its id, throw rather than invent a success). This replaces the
// Phase 9.6 create_follow_up_task stand-in, which wrote a tagged note into
// `notes` because `tasks` had no way to link to a lead without a project
// (see the Phase 10.1 migration, 20260803_generic_crm_task_linkage.sql,
// which added tasks.org_id/entity_type/entity_id and made project_id
// optional).
//
// This is the ONE place that inserts an agent-created lead task — never
// duplicated inline in a handler.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Actor } from "./types";

export type CreateLeadLinkedTaskInput = {
  orgId: string;
  leadId: string;
  title: string;
  dueDate?: string | null;
  priority?: "low" | "medium" | "high" | "urgent";
  assignedTo?: string | null;
  actor: Actor;
};

const PRIORITY_TO_DB: Record<NonNullable<CreateLeadLinkedTaskInput["priority"]>, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  // `tasks.priority` has no dedicated "urgent" tier in this schema today —
  // map to "high" rather than inventing/storing an unsupported value.
  urgent: "high",
};

/**
 * Verifies the lead belongs to orgId, inserts one real row into `tasks`
 * with entity_type="lead"/entity_id=leadId (no project_id — the DB
 * validation trigger only requires org_id to match the lead, not a
 * project), and returns its id. Throws on any failure — never invents a
 * success result, same contract as createLeadInternalNote.
 */
export async function createLeadLinkedTask(
  supabase: SupabaseClient,
  input: CreateLeadLinkedTaskInput,
): Promise<{ taskId: string }> {
  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("id")
    .eq("id", input.leadId)
    .eq("org_id", input.orgId)
    .maybeSingle();

  if (leadError) throw new Error(`Could not verify the lead: ${leadError.message}`);
  if (!lead) throw new Error("Lead not found in this organization.");

  const dbPriority = input.priority ? PRIORITY_TO_DB[input.priority] : "medium";

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      org_id: input.orgId,
      entity_type: "lead",
      entity_id: input.leadId,
      title: input.title,
      status: "not_started",
      priority: dbPriority,
      due_date: input.dueDate ?? null,
      assigned_to: input.assignedTo ?? null,
      created_by: input.actor.actorType === "user" ? input.actor.actorId : null,
      stage: "planning",
      stage_position: 0,
    })
    .select("id")
    .single();

  if (error || !data) throw new Error(`Could not create the task: ${error?.message ?? "no row returned"}`);
  return { taskId: data.id as string };
}
