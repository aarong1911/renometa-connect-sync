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
// in-progress Lead Qualification run later deciding to hand off to
// Scheduling is an orchestration-time AIAgentHandoff (AI-1F/AI-2+), not a
// second call into this router. Conflating the two would make Scheduling
// reachable from routing rules this file has no trustworthy basis for
// (see routeByCrmContext's scheduling note below).

import type {
  AIAgentKey,
  AIChannelEvent,
  AIResolvedContext,
  AIRouteDecision,
} from "./types";

const RECEPTION: AIAgentKey = "reception";
const LEAD_QUALIFICATION: AIAgentKey = "lead_qualification";
// "scheduling" is a valid AIAgentKey (see types.ts's KNOWN_AI_AGENT_KEYS)
// but is intentionally never returned by this router — see
// routeByCrmContext's comment.

// Router confidence is a fixed, hand-assigned score reflecting how
// deterministic each tier is — NOT a calibrated ML probability. It exists
// so an audit log / Test Console can show relative certainty without
// implying statistical meaning it doesn't have.
const EXPLICIT_EVENT_CONFIDENCE = 1.0;
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

// ── Tier 2: conversation ownership (RESERVED, NOT ACTIVE) ───────────────
//
// AIConversationSummary.aiOwned has no backing schema anywhere in the
// repository yet (confirmed during AI-1D: conversation_states only
// tracks archive/star, no AI-vs-human-ownership column exists) and is
// therefore always undefined today. This function exists to hold this
// tier's place in the priority order the ai-center skill specifies — it
// deliberately does NOT read context.conversation?.aiOwned or branch on
// it, because doing so over a field that's always undefined would be
// dead code dressed up as a real routing tier. It always returns
// undefined until real conversation-ownership data exists; when it does,
// this function (not a new tier inserted elsewhere) is where that logic
// belongs.
function routeByConversationState(context: AIResolvedContext): AIRouteDecision | undefined {
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
