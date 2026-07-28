// src/lib/agentic/lead-follow-up-spec.ts
//
// Phase 9.6, Priority 16/17 — typed specifications only. Neither of these
// is implemented as a running agent this phase. `LEAD_FOLLOW_UP_POC_SPEC`
// documents exactly what netlify/functions/agent-execute.ts's proof-of-
// concept flow does (and does not do). `LEAD_CONVERSION_AGENT_SPEC` is the
// forward-looking design for the first real production agent, to be
// built after Phase 10.

export const LEAD_FOLLOW_UP_POC_SPEC = {
  key: "lead_follow_up_prep_poc",
  name: "Manual Lead Follow-Up Preparation (proof of concept)",
  purpose: "Demonstrate the full registered-action → validation → autonomy/approval → idempotency → execution → audit → usage pipeline against one real, narrow, safe flow.",
  flow: [
    "User opens a lead and requests 'Prepare follow-up.'",
    "Server creates an agent_executions row (actor_type='user', agent_key=this key).",
    "Step 1 (read): get_lead_context — bounded lead + contact + last 5 notes.",
    "Step 2 (write, no approval): draft_customer_reply — deterministic stub text, never sent.",
    "Step 3 (propose): create_follow_up_task — always requires approval in this proof of concept.",
    "Execution status becomes 'awaiting_approval' until a human approves/rejects step 3.",
  ],
  constraints: [
    "Uses real records (real lead/contact ids), never fabricated ones.",
    "No automatic customer messaging — draft_customer_reply never calls send_sms/send_email.",
    "No automatic stage/status changes.",
    "No contact/deal/lead deletion or merge.",
    "No broad scheduled scanning — one manual lead, one manual request at a time.",
    "Organization-scoped at every query.",
    "Bounded context only — last 5 notes, no full conversation dump.",
    "draft_customer_reply is a deterministic stub (isStub:true in its output) — explicitly NOT a production AI draft.",
  ],
} as const;

export const LEAD_CONVERSION_AGENT_SPEC = {
  key: "lead_conversion_agent",
  name: "Lead Conversion Agent",
  status: "specification_only" as const,
  purpose: [
    "Assess new leads.",
    "Identify missing information.",
    "Recommend next action.",
    "Prepare an initial response.",
    "Create an internal follow-up task.",
    "Escalate urgent/high-value leads.",
  ],
  inputs: [
    "lead", "linked contact", "source", "budget", "project type", "owner",
    "recent conversations (bounded)", "open tasks", "existing deal state", "consent/opt-out status",
  ],
  allowedTools: ["get_lead_context", "draft_customer_reply", "create_follow_up_task", "add_internal_note", "flag_lead_for_review"],
  approvalRequiredTools: ["assign_lead_owner", "update_lead_status", "send_email", "send_sms", "schedule_appointment", "create_deal"],
  prohibited: [
    "delete records",
    "merge contacts/companies",
    "mark a deal won/lost",
    "change financial values",
    "bypass consent",
    "contact opted-out customers",
  ],
  successMetrics: [
    "time to first prepared response",
    "approved action rate",
    "task completion rate",
    "appointment conversion",
    "lead qualification rate",
    "human override rate",
    "duplicate outreach prevented",
    "cost per execution",
  ],
} as const;

/**
 * Priority 18 — Workflows vs Agents boundary, documented once here so it
 * doesn't drift across future agent specs.
 *
 * Workflows: deterministic. A fixed trigger → condition → action graph
 * (see src/lib/workflow-types.ts). No reasoning. The same input always
 * produces the same path. Good for "always do X when Y happens."
 *
 * Agents: evaluate context, choose among the ACTION_REGISTRY's allowed
 * actions, handle incomplete/ambiguous information, and produce
 * recommendations or proposed actions bounded by organization policy
 * (see policies.ts) and autonomy level (see autonomy.ts).
 *
 * An agent MAY decide a workflow template should run and trigger it (or
 * propose triggering it) — it must NOT reimplement delay/send/branch
 * logic that the workflow engine already owns. Example: an agent decides
 * a lead needs a 3-step nurture sequence; it proposes/triggers the
 * existing approved "3-step nurture" workflow template rather than
 * independently scheduling three sends itself.
 */
export const WORKFLOWS_VS_AGENTS_BOUNDARY = {
  workflows: "deterministic trigger/condition/action graphs, no reasoning, predictable repeatability",
  agents: "evaluate context, choose among registered actions, operate within policy/autonomy, may trigger workflows but never reimplement them",
} as const;

/**
 * Phase 10+ integration guardrails (Phase 9.6 closure pass, Priority 10).
 * Binding rules for whoever builds the next phase's Pipeline/Sales
 * Operations agent-capable features on top of this foundation:
 *
 * 1. Every agent-callable business action is added to action-registry.ts.
 *    No route/component may implement its own ad hoc AI-driven mutation
 *    logic — that duplicates (and bypasses) the validation/approval/
 *    idempotency/audit pipeline in action-executor.ts.
 * 2. High-risk Pipeline actions (move_deal_stage, especially to a Won/Lost
 *    equivalent stage, schedule_appointment, any send) stay
 *    `requiresApproval: true` regardless of an org's configured autonomy
 *    level — see action-registry.ts's existing entries for the pattern.
 *    A Won/Lost transition is never auto-executed at any autonomy level.
 * 3. send_sms/send_email remain `isExecutable: false` (proposal-only)
 *    until a phase explicitly scopes building the send path — do not flip
 *    `isExecutable`/add a handler for either without a dedicated review of
 *    consent/opt-out enforcement first.
 * 4. create_follow_up_task must be migrated off its notes-table stand-in
 *    (see handlers.ts's header comment) the moment Phase 10/11 introduces
 *    a real lead-scoped task/reminder relationship — this is a tracked
 *    migration, not a permanent design choice.
 * 5. Do not build a background queue worker (a poller/consumer for
 *    agent_executions rows with status='queued') until a real, non-manual
 *    trigger actually needs one. Introducing polling infrastructure before
 *    anything produces queued work is exactly the kind of premature
 *    infrastructure this phase was scoped to avoid.
 * 6. workflow_trigger_queue is NOT an approved queue for agent jobs — it
 *    has no organization column, no consumer, and (pre-2026-08-01) had a
 *    real cross-org RLS hole. agent_executions is the only queue-shaped
 *    table agentic code should ever read/write.
 */
export const PHASE_10_INTEGRATION_GUARDRAILS = [
  "All agent-callable actions are added to action-registry.ts — no route-level arbitrary AI mutation logic.",
  "High-risk Pipeline actions (deal stage moves, especially Won/Lost, appointments, any send) require approval regardless of autonomy level.",
  "send_sms/send_email remain proposal-only until a phase explicitly scopes real sending, with consent/opt-out enforcement reviewed first.",
  "create_follow_up_task moves off the notes-table stand-in once a real lead-scoped task relationship exists.",
  "No background queue worker until a real non-manual trigger needs one.",
  "workflow_trigger_queue is not an approved agent queue — agent_executions is.",
] as const;
