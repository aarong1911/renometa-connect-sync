// src/lib/agentic/lead-notes.ts
//
// Shared helper for writing a lead-scoped internal note into the
// canonical `notes` table (org_id, entity_type, entity_id, content,
// created_by — the same table/shape src/lib/contact-notes.ts's
// useEntityNotes() already reads for entity_type "contact"/"deal"/
// "project", and "lead" per its own EntityType union). This is the ONE
// place that inserts a lead note on behalf of an agent action — never
// duplicated inline in a handler.
//
// Bug-fix context (create_follow_up_task investigation): this function
// itself was already correct — it always wrote to the real `notes` table.
// The two actual defects were (1) action-executor.ts claiming the write's
// idempotency slot at PROPOSAL time instead of at approved-execution time,
// which caused the approval step to be silently treated as an already-
// duplicate no-op and skip calling this function entirely, and (2) the
// Lead drawer's "Internal Notes" tab reading from a separate, pre-existing
// localStorage store (src/lib/leads-store.ts's useLeadNotes) that never
// queries this table at all. Both are fixed alongside this extraction —
// see action-executor.ts and src/routes/leads.tsx.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Actor } from "./types";

export type CreateLeadInternalNoteInput = {
  orgId: string;
  leadId: string;
  body: string;
  actor: Actor;
};

/**
 * Verifies the lead belongs to orgId, inserts one row into the canonical
 * `notes` table, and returns its id. Throws on any failure — never
 * invents a success result (Priority 5-style "approved input executes
 * exactly once" also requires that a failed write is never silently
 * reported as done).
 */
export async function createLeadInternalNote(
  supabase: SupabaseClient,
  input: CreateLeadInternalNoteInput,
): Promise<{ noteId: string }> {
  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("id")
    .eq("id", input.leadId)
    .eq("org_id", input.orgId)
    .maybeSingle();

  if (leadError) throw new Error(`Could not verify the lead: ${leadError.message}`);
  if (!lead) throw new Error("Lead not found in this organization.");

  const { data, error } = await supabase
    .from("notes")
    .insert({
      org_id: input.orgId,
      entity_type: "lead",
      entity_id: input.leadId,
      content: input.body,
      created_by: input.actor.actorType === "user" ? input.actor.actorId : null,
    })
    .select("id")
    .single();

  if (error || !data) throw new Error(`Could not create the note: ${error?.message ?? "no row returned"}`);
  return { noteId: data.id as string };
}
