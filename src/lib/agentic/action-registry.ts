// src/lib/agentic/action-registry.ts
//
// Phase 9.6 — the central, shared registry of every business action an
// agent, workflow, integration, or scheduled job is allowed to invoke.
// This is the ONLY place new agent-callable actions get defined. Nothing
// outside this file (and the handler modules it references) should ever
// let a model-driven caller touch Supabase directly — see
// action-executor.ts, which is the only code path allowed to call a
// handler.
//
// Per Priority 1: only a small executable subset exists this phase
// (isExecutable: true, handler present). Everything else is registered as
// metadata only (isExecutable: false, no handler) so the shape of the
// full future action set is real and typed, without pretending those
// actions can run yet.
//
// SCHEMA NOTE (Phase 10.1 resolved): `tasks` used to be project-scoped
// only, so a pre-conversion lead had nowhere real to attach a task row —
// create_follow_up_task worked around this by writing a tagged note
// instead. The Phase 10.1 migration (20260803_generic_crm_task_linkage.sql)
// added tasks.org_id/entity_type/entity_id and made project_id optional,
// so create_follow_up_task now creates a REAL tasks row
// (entity_type="lead") via createLeadLinkedTask (./lead-tasks.ts) — see
// handlers.ts. The old note-based path (lead-notes.ts) is deprecated, not
// deleted, pending live verification.

import { z } from "zod";
import type { ActionDefinition } from "./types";
import {
  getLeadContext, createFollowUpTask, addInternalNote, draftCustomerReply,
} from "./handlers";

// ── Zod input schemas ────────────────────────────────────────────────────

const getLeadContextInput = z.object({
  leadId: z.string().uuid(),
});

const createFollowUpTaskInput = z.object({
  leadId: z.string().uuid(),
  title: z.string().min(1).max(200),
  dueDate: z.string().date().optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  assignedTo: z.string().uuid().nullable().optional(),
});

const addInternalNoteInput = z.object({
  targetEntityType: z.enum(["lead", "contact", "deal", "company"]),
  targetEntityId: z.string().uuid(),
  content: z.string().min(1).max(4000),
});

const draftCustomerReplyInput = z.object({
  leadId: z.string().uuid(),
  tone: z.enum(["friendly", "formal"]).default("friendly"),
});

const assignLeadOwnerInput = z.object({
  leadId: z.string().uuid(),
  memberId: z.string().uuid().nullable(),
});

const updateLeadStatusInput = z.object({
  leadId: z.string().uuid(),
  status: z.enum(["new", "contacted", "qualified", "converted", "lost"]),
});

const moveDealStageInput = z.object({
  dealId: z.string().uuid(),
  toStageId: z.string().uuid(),
  expectedFromStageId: z.string().uuid().optional(),
});

const sendSmsInput = z.object({
  contactId: z.string().uuid(),
  body: z.string().min(1).max(1600),
});

const sendEmailInput = z.object({
  contactId: z.string().uuid(),
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(20000),
});

const scheduleAppointmentInput = z.object({
  contactId: z.string().uuid(),
  startsAt: z.string().datetime(),
  durationMinutes: z.number().int().positive().max(480),
  title: z.string().min(1).max(200),
});

// ── Registry ─────────────────────────────────────────────────────────────

const DEFAULT_RETRY = { maxAttempts: 1, backoffSeconds: 0 };

export const ACTION_REGISTRY: Record<string, ActionDefinition<any, any>> = {
  // ── Read-only ──────────────────────────────────────────────────────────
  get_lead_context: {
    key: "get_lead_context",
    displayName: "Get lead context",
    description: "Loads a bounded snapshot of a lead: the lead record, its linked contact, and its most recent internal notes.",
    category: "context",
    riskLevel: "read",
    supportedActorTypes: ["user", "agent", "workflow", "system"],
    inputSchema: getLeadContextInput,
    requiresApproval: false,
    minimumAutonomyLevel: 1,
    idempotent: true,
    timeoutMs: 8000,
    retryPolicy: DEFAULT_RETRY,
    isExecutable: true,
    handler: getLeadContext,
  },
  get_contact_context: {
    key: "get_contact_context",
    displayName: "Get contact context",
    description: "Loads a bounded snapshot of a contact and its linked account.",
    category: "context",
    riskLevel: "read",
    supportedActorTypes: ["user", "agent", "workflow", "system"],
    inputSchema: z.object({ contactId: z.string().uuid() }),
    requiresApproval: false,
    minimumAutonomyLevel: 1,
    idempotent: true,
    timeoutMs: 8000,
    retryPolicy: DEFAULT_RETRY,
    isExecutable: false,
  },
  get_deal_context: {
    key: "get_deal_context",
    displayName: "Get deal context",
    description: "Loads a bounded snapshot of a deal and its pipeline stage.",
    category: "context",
    riskLevel: "read",
    supportedActorTypes: ["user", "agent", "workflow", "system"],
    inputSchema: z.object({ dealId: z.string().uuid() }),
    requiresApproval: false,
    minimumAutonomyLevel: 1,
    idempotent: true,
    timeoutMs: 8000,
    retryPolicy: DEFAULT_RETRY,
    isExecutable: false,
  },
  get_recent_conversations: {
    key: "get_recent_conversations",
    displayName: "Get recent conversations",
    description: "Loads a bounded, metadata-only summary of recent conversation activity for a contact (never a full transcript dump).",
    category: "context",
    riskLevel: "read",
    supportedActorTypes: ["user", "agent", "workflow", "system"],
    inputSchema: z.object({ contactId: z.string().uuid(), limit: z.number().int().min(1).max(20).default(5) }),
    requiresApproval: false,
    minimumAutonomyLevel: 1,
    idempotent: true,
    timeoutMs: 8000,
    retryPolicy: DEFAULT_RETRY,
    isExecutable: false,
  },
  get_open_tasks: {
    key: "get_open_tasks",
    displayName: "Get open tasks",
    description: "Loads open tasks linked to a project.",
    category: "context",
    riskLevel: "read",
    supportedActorTypes: ["user", "agent", "workflow", "system"],
    inputSchema: z.object({ projectId: z.string().uuid() }),
    requiresApproval: false,
    minimumAutonomyLevel: 1,
    idempotent: true,
    timeoutMs: 8000,
    retryPolicy: DEFAULT_RETRY,
    isExecutable: false,
  },
  get_upcoming_appointments: {
    key: "get_upcoming_appointments",
    displayName: "Get upcoming appointments",
    description: "Loads upcoming appointments for a contact.",
    category: "context",
    riskLevel: "read",
    supportedActorTypes: ["user", "agent", "workflow", "system"],
    inputSchema: z.object({ contactId: z.string().uuid() }),
    requiresApproval: false,
    minimumAutonomyLevel: 1,
    idempotent: true,
    timeoutMs: 8000,
    retryPolicy: DEFAULT_RETRY,
    isExecutable: false,
  },
  get_estimate_status: {
    key: "get_estimate_status",
    displayName: "Get estimate status",
    description: "Loads the status of estimates linked to a contact.",
    category: "context",
    riskLevel: "read",
    supportedActorTypes: ["user", "agent", "workflow", "system"],
    inputSchema: z.object({ contactId: z.string().uuid() }),
    requiresApproval: false,
    minimumAutonomyLevel: 1,
    idempotent: true,
    timeoutMs: 8000,
    retryPolicy: DEFAULT_RETRY,
    isExecutable: false,
  },

  // ── Low-risk writes ──────────────────────────────────────────────────────
  create_follow_up_task: {
    key: "create_follow_up_task",
    displayName: "Create follow-up task",
    description: "Creates a real task linked to the lead (Phase 10.1 — see file header).",
    category: "task",
    riskLevel: "low",
    supportedActorTypes: ["user", "agent", "workflow"],
    inputSchema: createFollowUpTaskInput,
    requiresApproval: true, // Level 2 default — see autonomy.ts for how Level 3 policy can allow auto-execution.
    minimumAutonomyLevel: 2,
    idempotent: true,
    timeoutMs: 8000,
    retryPolicy: DEFAULT_RETRY,
    isExecutable: true,
    handler: createFollowUpTask,
  },
  update_next_touch_date: {
    key: "update_next_touch_date",
    displayName: "Update next-touch date",
    description: "Updates the internally-tracked next-touch date for a lead.",
    category: "task",
    riskLevel: "low",
    supportedActorTypes: ["user", "agent", "workflow"],
    inputSchema: z.object({ leadId: z.string().uuid(), nextTouchDate: z.string().date() }),
    requiresApproval: false,
    minimumAutonomyLevel: 2,
    idempotent: true,
    timeoutMs: 8000,
    retryPolicy: DEFAULT_RETRY,
    isExecutable: false,
  },
  add_internal_note: {
    key: "add_internal_note",
    displayName: "Add internal note",
    description: "Adds an internal, staff-only note to a lead/contact/deal/company. Never customer-facing.",
    category: "note",
    riskLevel: "low",
    supportedActorTypes: ["user", "agent", "workflow"],
    inputSchema: addInternalNoteInput,
    requiresApproval: false,
    minimumAutonomyLevel: 2,
    idempotent: false,
    timeoutMs: 8000,
    retryPolicy: DEFAULT_RETRY,
    isExecutable: true,
    handler: addInternalNote,
  },
  draft_customer_reply: {
    key: "draft_customer_reply",
    displayName: "Draft customer reply",
    description: "Produces a DRAFT customer-facing reply for human review. Never sends anything — see send_email/send_sms for the (proposal-only) send actions.",
    category: "communication",
    riskLevel: "low",
    supportedActorTypes: ["user", "agent", "workflow"],
    inputSchema: draftCustomerReplyInput,
    requiresApproval: false,
    minimumAutonomyLevel: 1,
    idempotent: true,
    timeoutMs: 8000,
    retryPolicy: DEFAULT_RETRY,
    isExecutable: true,
    handler: draftCustomerReply,
  },
  flag_lead_for_review: {
    key: "flag_lead_for_review",
    displayName: "Flag lead for review",
    description: "Flags a lead for human review (e.g. urgent/high-value/ambiguous).",
    category: "lead",
    riskLevel: "low",
    supportedActorTypes: ["user", "agent", "workflow"],
    inputSchema: z.object({ leadId: z.string().uuid(), reason: z.string().min(1).max(500) }),
    requiresApproval: false,
    minimumAutonomyLevel: 2,
    idempotent: false,
    timeoutMs: 8000,
    retryPolicy: DEFAULT_RETRY,
    isExecutable: false,
  },

  // ── Higher-risk, proposal-only (Priority 1: not executable this phase) ──
  assign_lead_owner: {
    key: "assign_lead_owner",
    displayName: "Assign lead owner",
    description: "Proposes reassigning a lead's owner to a same-org team member.",
    category: "lead",
    riskLevel: "medium",
    requiredPermission: "org_member",
    supportedActorTypes: ["user", "agent", "workflow"],
    inputSchema: assignLeadOwnerInput,
    requiresApproval: true,
    minimumAutonomyLevel: 3,
    idempotent: true,
    timeoutMs: 8000,
    retryPolicy: DEFAULT_RETRY,
    isExecutable: false,
  },
  update_lead_status: {
    key: "update_lead_status",
    displayName: "Update lead status",
    description: "Proposes changing a lead's status.",
    category: "lead",
    riskLevel: "medium",
    supportedActorTypes: ["user", "agent", "workflow"],
    inputSchema: updateLeadStatusInput,
    requiresApproval: true,
    minimumAutonomyLevel: 3,
    idempotent: true,
    timeoutMs: 8000,
    retryPolicy: DEFAULT_RETRY,
    isExecutable: false,
  },
  move_deal_stage: {
    key: "move_deal_stage",
    displayName: "Move deal stage",
    description: "Proposes moving a deal to a different pipeline stage. Moving to a Won/Lost-equivalent stage is treated as high risk (see Phase 9.6 report).",
    category: "deal",
    riskLevel: "high",
    supportedActorTypes: ["user", "agent", "workflow"],
    inputSchema: moveDealStageInput,
    requiresApproval: true,
    minimumAutonomyLevel: 3,
    idempotent: true,
    timeoutMs: 8000,
    retryPolicy: DEFAULT_RETRY,
    isExecutable: false,
  },
  schedule_appointment: {
    key: "schedule_appointment",
    displayName: "Schedule appointment",
    description: "Proposes booking an appointment with a contact.",
    category: "scheduling",
    riskLevel: "high",
    supportedActorTypes: ["user", "agent", "workflow"],
    inputSchema: scheduleAppointmentInput,
    requiresApproval: true,
    minimumAutonomyLevel: 3,
    idempotent: true,
    timeoutMs: 8000,
    retryPolicy: DEFAULT_RETRY,
    isExecutable: false,
  },
  send_sms: {
    key: "send_sms",
    displayName: "Send SMS",
    description: "Proposes sending a customer-facing SMS. Never auto-sent in Phase 9.6 — always requires approval regardless of autonomy level.",
    category: "communication",
    riskLevel: "high",
    supportedActorTypes: ["user", "agent", "workflow"],
    inputSchema: sendSmsInput,
    requiresApproval: true,
    minimumAutonomyLevel: 4,
    idempotent: true,
    timeoutMs: 15000,
    retryPolicy: DEFAULT_RETRY,
    isExecutable: false,
  },
  send_email: {
    key: "send_email",
    displayName: "Send email",
    description: "Proposes sending a customer-facing email. Never auto-sent in Phase 9.6 — always requires approval regardless of autonomy level.",
    category: "communication",
    riskLevel: "high",
    supportedActorTypes: ["user", "agent", "workflow"],
    inputSchema: sendEmailInput,
    requiresApproval: true,
    minimumAutonomyLevel: 4,
    idempotent: true,
    timeoutMs: 15000,
    retryPolicy: DEFAULT_RETRY,
    isExecutable: false,
  },
};

export function getActionDefinition(actionKey: string): ActionDefinition<any, any> | undefined {
  return ACTION_REGISTRY[actionKey];
}

export function listActionDefinitions(): ActionDefinition<any, any>[] {
  return Object.values(ACTION_REGISTRY);
}
