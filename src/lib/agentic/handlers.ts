// src/lib/agentic/handlers.ts
//
// Phase 9.6 proof-of-concept action handlers — the ONLY four actions that
// are actually executable this phase (per action-registry.ts). Every
// handler:
//   - takes the org id from ActionContext (server-resolved), never from
//     its own input — every query is `.eq("org_id", ctx.orgId)`.
//   - is bounded (small selects, small limits) — no full-table scans, no
//     full conversation dumps.
//   - returns { ok, output } or { ok:false, error } — never throws past
//     action-executor.ts, which is what turns a thrown/returned error into
//     a recorded execution-step failure.
//
// These are plain functions, not React hooks and not tied to any specific
// Supabase client instance — action-executor.ts (running inside a Netlify
// function, using the service-role client) calls them directly. Nothing
// here is called from a React component.

import type { ActionHandler } from "./types";
import { createLeadLinkedTask } from "./lead-tasks";

type LeadContextInput = { leadId: string };
type LeadContextOutput = {
  lead: { id: string; status: string; source: string | null; assignedTo: string | null; createdAt: string };
  contact: { id: string; name: string; email: string | null; phone: string | null } | null;
  recentNotes: { id: string; content: string; createdAt: string }[];
};

export const getLeadContext: ActionHandler<LeadContextInput, LeadContextOutput> = async (ctx, input) => {
  const { data: lead, error: leadError } = await ctx.supabase
    .from("leads")
    .select("id, status, source, assigned_to, contact_id, created_at")
    .eq("id", input.leadId)
    .eq("org_id", ctx.orgId)
    .maybeSingle();

  if (leadError) return { ok: false, error: "Could not load lead." };
  if (!lead) return { ok: false, error: "Lead not found in this organization." };

  let contact: LeadContextOutput["contact"] = null;
  if (lead.contact_id) {
    const { data: contactRow } = await ctx.supabase
      .from("contacts")
      .select("id, full_name, email, phone")
      .eq("id", lead.contact_id)
      .eq("org_id", ctx.orgId)
      .maybeSingle();
    if (contactRow) {
      contact = { id: contactRow.id, name: contactRow.full_name ?? "Unknown", email: contactRow.email, phone: contactRow.phone };
    }
  }

  // Bounded — last 5 notes only, never a full history dump.
  const { data: notes } = await ctx.supabase
    .from("notes")
    .select("id, content, created_at")
    .eq("org_id", ctx.orgId)
    .eq("entity_type", "lead")
    .eq("entity_id", input.leadId)
    .order("created_at", { ascending: false })
    .limit(5);

  return {
    ok: true,
    output: {
      lead: {
        id: lead.id,
        status: lead.status ?? "new",
        source: lead.source,
        assignedTo: lead.assigned_to,
        createdAt: lead.created_at,
      },
      contact,
      recentNotes: (notes ?? []).map((n: any) => ({ id: n.id, content: n.content, createdAt: n.created_at })),
    },
  };
};

type CreateFollowUpTaskInput = {
  leadId: string;
  title: string;
  dueDate?: string;
  priority?: "low" | "medium" | "high" | "urgent";
  assignedTo?: string | null;
};
type CreateFollowUpTaskOutput = { taskId: string };

/**
 * Phase 10.1 — creates a REAL task linked to the lead (tasks.entity_type
 * = "lead", entity_id = leadId), replacing the Phase 9.6 tagged-note
 * stand-in now that a lead can have a task without a project (see
 * lead-tasks.ts / the Phase 10.1 migration). Does not also write the old
 * note.
 */
export const createFollowUpTask: ActionHandler<CreateFollowUpTaskInput, CreateFollowUpTaskOutput> = async (ctx, input) => {
  try {
    const { taskId } = await createLeadLinkedTask(ctx.supabase, {
      orgId: ctx.orgId,
      leadId: input.leadId,
      title: input.title,
      dueDate: input.dueDate ?? null,
      priority: input.priority,
      assignedTo: input.assignedTo,
      actor: ctx.actor,
    });
    return { ok: true, output: { taskId } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not create the follow-up task." };
  }
};

type AddInternalNoteInput = { targetEntityType: "lead" | "contact" | "deal" | "company"; targetEntityId: string; content: string };
type AddInternalNoteOutput = { noteId: string };

export const addInternalNote: ActionHandler<AddInternalNoteInput, AddInternalNoteOutput> = async (ctx, input) => {
  // Content is always tagged so a human reading the Notes tab later can
  // tell this wasn't organically typed by a person (Priority 2 — never
  // represent an automated action as if a human performed it).
  const tag = ctx.actor.actorType === "agent" ? "[Agent]" : ctx.actor.actorType === "user" ? "[Agent draft, added by user]" : `[${ctx.actor.actorType}]`;
  const content = `${tag} ${input.content}`;

  const { data, error } = await ctx.supabase
    .from("notes")
    .insert({
      org_id: ctx.orgId,
      entity_type: input.targetEntityType,
      entity_id: input.targetEntityId,
      content,
      created_by: ctx.actor.actorType === "user" ? ctx.actor.actorId : null,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: "Could not add the note." };
  return { ok: true, output: { noteId: data.id } };
};

type DraftCustomerReplyInput = { leadId: string; tone: "friendly" | "formal" };
type DraftCustomerReplyOutput = { draft: string; isStub: true };

/**
 * Deterministic, provider-free draft — Phase 9.6 is architecture proof
 * only (Priority 16 explicitly permits a stub here rather than a real
 * model call). This NEVER sends anything; it only produces text for a
 * human to review as a proposed_input on an approval request, or for
 * direct display in the proof-of-concept UI. `isStub: true` is always
 * returned so no caller can mistake this for a production AI draft.
 */
export const draftCustomerReply: ActionHandler<DraftCustomerReplyInput, DraftCustomerReplyOutput> = async (ctx, input) => {
  const { data: lead } = await ctx.supabase
    .from("leads")
    .select("id, contact_id")
    .eq("id", input.leadId)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (!lead) return { ok: false, error: "Lead not found in this organization." };

  let name = "there";
  if (lead.contact_id) {
    const { data: contact } = await ctx.supabase
      .from("contacts")
      .select("full_name")
      .eq("id", lead.contact_id)
      .eq("org_id", ctx.orgId)
      .maybeSingle();
    if (contact?.full_name) name = contact.full_name.split(" ")[0];
  }

  const draft = input.tone === "formal"
    ? `Dear ${name}, thank you for your interest — a member of our team will follow up shortly to discuss your project in more detail.`
    : `Hi ${name}, thanks for reaching out! We'd love to learn more about your project — a member of our team will be in touch soon.`;

  return { ok: true, output: { draft, isStub: true } };
};
