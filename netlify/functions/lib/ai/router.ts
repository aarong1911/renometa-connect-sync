// netlify/functions/lib/ai/router.ts
//
// AI Center — Phase AI-1E. The deterministic Router: decides which system
// agent should take initial ownership of an event, using only trusted
// normalized inputs and fixed rules — no database access, no model call,
// no tool execution, no state mutation.
//
//   AIChannelEvent + AIResolvedContext -> routeAIEvent() -> AIRouteDecision
//
// PURITY: this file has no imports besides ../ai/types.ts. No Supabase, no
// ModelProvider/Anthropic, no tools/registry, no action-executor, no
// React, no environment variables. routeAIEvent() is a plain, synchronous,
// side-effect-free function — safe to unit test with plain object
// literals, and safe to call repeatedly with the same inputs and get the
// same answer.
//
// PRIORITY ORDER (per the ai-center skill's "Routing" section — this file
// implements only the first three deterministic tiers, none of which
// involve model classification):
//   1. Explicit event routing
//   2. Existing conversation ownership (reserved — see routeByConversationState)
//   3. CRM/entity context
//   4. Safe fallback (Reception)
//
// ROUTER VS. HANDOFF: routeAIEvent() decides who takes an event FIRST. It
// never decides what happens after an agent starts working — an
// in-progress Lead Qualification run deciding to hand off to Scheduling
// is an orchestration-time AIAgentHandoff (orchestrator.ts), not a second
// call into this router. What THIS file decides, for the very NEXT
// separate inbound event, is covered by Tier 2 below (an outstanding,
// still-fresh scheduling offer routes straight back to Scheduling) — see
// routeByConversationState's own comment. Tier 3 (routeByCrmContext)
// still never selects Scheduling directly from CRM/entity context alone.

import type {
  AIAgentKey,
  AIChannelEvent,
  AIResolvedContext,
  AIRouteDecision,
} from "./types";

const RECEPTION: AIAgentKey = "reception";
const LEAD_QUALIFICATION: AIAgentKey = "lead_qualification";
const SCHEDULING: AIAgentKey = "scheduling";
// "scheduling" was a valid AIAgentKey (see types.ts's KNOWN_AI_AGENT_KEYS)
// that this router intentionally never returned, for every tier EXCEPT
// Tier 2 below — see routeByConversationState's own comment for why that
// tier (and only that tier) is now allowed to return it, and
// routeByCrmContext's comment for why Tier 3 still never does.

// Router confidence is a fixed, hand-assigned score reflecting how
// deterministic each tier is — NOT a calibrated ML probability. It exists
// so an audit log / Test Console can show relative certainty without
// implying statistical meaning it doesn't have.
const EXPLICIT_EVENT_CONFIDENCE = 1.0;
// Lead-Qualification-to-Scheduling handoff phase: a real, persisted,
// deterministic DB signal (a scheduling offer genuinely exists and is
// still fresh) — arguably MORE certain than Tier 3's heuristic lead-status
// rule, so it is scored higher, not reused at the same confidence.
const CONVERSATION_STATE_CONFIDENCE = 0.95;
const CRM_CONTEXT_CONFIDENCE = 0.9;
const FALLBACK_CONFIDENCE = 0.5;

/**
 * Lead statuses that represent a still-open sales opportunity. Verified
 * against the repository's single canonical 5-value lead-status set
 * (src/lib/lead-status.ts's LEAD_STATUSES, matching the Zod enum in
 * src/lib/agentic/action-registry.ts's updateLeadStatusInput: "new" |
 * "contacted" | "qualified" | "converted" | "lost") rather than assumed.
 * "converted" means the lead already became a deal — re-qualifying it is
 * meaningless. "lost" is a dead lead. Both are deliberately excluded here;
 * this is a real refinement over this task's minimum-acceptable fallback
 * ("route any present lead to lead_qualification"), made possible because
 * the status semantics turned out to be clear and small, not because they
 * were assumed. This list is inlined (not imported from lead-status.ts)
 * to keep this file's only dependency ai/types.ts — see this file's
 * header.
 */
const ACTIVE_LEAD_STATUSES: ReadonlySet<string> = new Set(["new", "contacted", "qualified"]);

/**
 * Decides which system agent should take initial ownership of a
 * normalized event. Deterministic and total: every valid input, including
 * an event type this file has never seen before, resolves to a decision —
 * an unrecognized event type is not an error (see ERROR HANDLING in the
 * task this file was built from), it simply falls through every tier to
 * the Reception fallback.
 */
export function routeAIEvent(event: AIChannelEvent, context: AIResolvedContext): AIRouteDecision {
  const explicit = routeByExplicitEvent(event);
  if (explicit) return explicit;

  const conversationState = routeByConversationState(context);
  if (conversationState) return conversationState;

  const crmContext = routeByCrmContext(context);
  if (crmContext) return crmContext;

  return {
    agentKey: RECEPTION,
    reason: "No deterministic specialist route matched; using Reception fallback.",
    confidence: FALLBACK_CONFIDENCE,
    source: "fallback",
  };
}

// ── Tier 1: explicit event routing ──────────────────────────────────────
//
// Rules defensible from the current architecture only — see this file's
// originating task for the reasoning behind each one. "message_received"
// deliberately returns undefined here (it falls through to CRM-context
// routing, tier 3) rather than being treated as "no rule matched."
function routeByExplicitEvent(event: AIChannelEvent): AIRouteDecision | undefined {
  switch (event.eventType) {
    case "new_lead":
      return {
        agentKey: LEAD_QUALIFICATION,
        reason: "Explicit new_lead event routes to Lead Qualification.",
        confidence: EXPLICIT_EVENT_CONFIDENCE,
        source: "deterministic",
      };

    case "missed_call":
      return {
        agentKey: RECEPTION,
        reason: "Explicit missed_call event routes to Reception.",
        confidence: EXPLICIT_EVENT_CONFIDENCE,
        source: "deterministic",
      };

    case "call_started":
      return {
        agentKey: RECEPTION,
        reason: "Explicit call_started event routes to Reception, which greets and identifies the caller first.",
        confidence: EXPLICIT_EVENT_CONFIDENCE,
        source: "deterministic",
      };

    case "call_ended":
      return {
        agentKey: RECEPTION,
        reason: "Explicit call_ended event routes to Reception; no deterministic signal yet distinguishes a qualification-ready outcome from any other call ending.",
        confidence: EXPLICIT_EVENT_CONFIDENCE,
        source: "deterministic",
      };

    case "manual_test":
      return {
        agentKey: RECEPTION,
        reason: "Test Console events default to Reception.",
        confidence: EXPLICIT_EVENT_CONFIDENCE,
        source: "deterministic",
      };

    case "internal_request":
      return {
        agentKey: RECEPTION,
        reason: "Internal requests route to Reception; no Internal Copilot agent exists yet.",
        confidence: EXPLICIT_EVENT_CONFIDENCE,
        source: "deterministic",
      };

    case "workflow_trigger":
      // Event metadata is never treated as authorization or as a trusted
      // routing hint (see ai/types.ts's "metadata is not authorization")
      // — a workflow could claim anything in its payload. Until a real,
      // structurally-typed route hint exists (not a free-form metadata
      // string), this always falls back to Reception.
      return {
        agentKey: RECEPTION,
        reason: "Workflow-triggered events route to Reception; no trusted, structurally-typed route hint exists yet.",
        confidence: EXPLICIT_EVENT_CONFIDENCE,
        source: "deterministic",
      };

    case "message_received":
      return undefined;

    default:
      // Unrecognized event type (including a future one not yet listed
      // in KNOWN_AI_EVENT_TYPES): not an error, just not decidable at
      // this tier — continue to later tiers.
      return undefined;
  }
}

// ── Tier 2: conversation ownership ───────────────────────────────────────
//
// AIConversationSummary.aiOwned (general AI-vs-human conversation
// ownership) still has no backing schema anywhere in the repository —
// that part of this tier remains reserved, exactly as before, and this
// function still does not read or branch on `aiOwned` for that reason.
//
// Lead-Qualification-to-Scheduling handoff phase ADDS one narrow,
// specific ownership signal this tier CAN now act on:
// `context.conversation.schedulingOfferActive` — computed by
// context-builder.ts from the EXISTING conversation_states.
// scheduling_offered_slots/_at columns (see that file's own
// resolveSchedulingOfferActive(), including the 24-hour freshness
// window). When true, an outstanding scheduling offer means Scheduling,
// not Lead Qualification, should continue owning this turn — otherwise a
// customer replying "11 works" to an offer Scheduling just sent would
// route straight back to Lead Qualification (which has no way to resolve
// that reply) via Tier 3's own lead-status rule. This is intentionally
// narrower than general conversation ownership: it says nothing about
// human takeover, and it is never proof the offered slot itself is still
// available (see scheduling-availability.ts's own re-validation, which
// this field has no bearing on whatsoever).
function routeByConversationState(context: AIResolvedContext): AIRouteDecision | undefined {
  if (context.conversation?.schedulingOfferActive) {
    return {
      agentKey: SCHEDULING,
      reason: "An outstanding, still-fresh (<=24h) scheduling slot offer exists for this conversation — continuing with Scheduling rather than falling back to Lead Qualification.",
      confidence: CONVERSATION_STATE_CONFIDENCE,
      source: "conversation_state",
    };
  }
  return undefined;
}

// ── Tier 3: CRM/entity context ───────────────────────────────────────────
function routeByCrmContext(context: AIResolvedContext): AIRouteDecision | undefined {
  if (context.lead && ACTIVE_LEAD_STATUSES.has(context.lead.status)) {
    return {
      agentKey: LEAD_QUALIFICATION,
      reason: "Existing open lead context routes to Lead Qualification.",
      confidence: CRM_CONTEXT_CONFIDENCE,
      source: "rule",
    };
  }

  // Project presence alone is NOT routed anywhere specialized — there is
  // no Project Support agent yet (that's AI-7 per the skill's phased
  // rollout). A project-only context falls through to the Reception
  // fallback rather than inventing a route to an agent that doesn't
  // exist.
  //
  // Scheduling is never selected by this function, on purpose. Nothing in
  // AIResolvedContext or AIChannelEvent today is a trusted, already-
  // resolved signal that this interaction is specifically about booking
  // an appointment — inferring that from raw message text, project
  // presence, or channel metadata would be semantic intent
  // classification (explicitly out of scope: see this file's "TEXT
  // ANALYSIS" ground rule), which belongs to a future model-based routing
  // tier, not this deterministic one. Scheduling becomes reachable only
  // via a Reception/Lead Qualification AIAgentHandoff during
  // orchestration (AI-1F/AI-2+), never via direct router selection in
  // AI-1E.

  return undefined;
}
