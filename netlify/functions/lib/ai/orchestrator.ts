// netlify/functions/lib/ai/orchestrator.ts
//
// AI Center — Phase AI-1F. The first integration: proves the full basic
// execution lifecycle end to end, using every component built in AI-1A–E.
// Deliberately narrow — no dynamic tool execution, no handoff execution,
// no Scheduling behavior, no outbound communication.
//
//   trusted invocation
//         -> create agent_executions row
//         -> buildAIContext()      (AI-1D)
//         -> routeAIEvent()        (AI-1E)
//         -> load system-agent behavior (temporary AI-1 config, see below)
//         -> ModelProvider.run()   (AI-1A)
//         -> recordUsageEvent()    (existing Gen-2 usage system)
//         -> finalize execution
//         -> AIRunResult
//
// ── TRUST BOUNDARY ──────────────────────────────────────────────────────
//
// orchestrateAI() receives two structurally separate inputs, and the
// distinction must never blur:
//
//   - `event: AIChannelEvent` — normalized but still UNTRUSTED. Only
//     `event.channel`, `event.eventType`, and `event.content.text` are
//     ever read here (for routing and prompt text). `event.metadata` is
//     never serialized into a prompt or a database write.
//     `event.claimedOrganizationId` is NEVER read by this file — see
//     ai/types.ts's own warning on that field. If diagnostics ever need
//     it, log it separately, never use it for scoping or authorization.
//
//   - `trustedContext: AITrustedContext` — SERVER-OWNED. orgId, actor,
//     and any of contactId/leadId/projectId/conversationKey/autonomyLevel
//     must already have been resolved by trusted code before this
//     function is called (e.g. resolve-org.ts, or a webhook's own
//     verified tenant mapping) — never derived from `event` or from any
//     model output. `trustedContext.executionId` is ignored on input:
//     this file always creates its own fresh agent_executions row rather
//     than reusing a caller-supplied id (see EXECUTION LIFECYCLE below).
//
// READ/WRITE SCOPE: this file writes exactly one table —
// agent_executions (one INSERT, one UPDATE, both scoped by the row's own
// id after creation). It calls the existing, unmodified
// src/lib/agentic/usage.ts for agent_usage_events. It does NOT create
// agent_execution_steps or agent_events — see the "OBSERVABILITY SCOPE"
// note below for why. It performs NO outbound communication (no SMS,
// email, Messenger, Instagram, WhatsApp, or Vapi speech) — it only
// returns response text; a channel adapter owns actually sending it.

import type { SupabaseClient } from "@supabase/supabase-js";
import { recordUsageEvent } from "../../../../src/lib/agentic/usage";
import { buildAIContext } from "./context-builder";
import { routeAIEvent } from "./router";
import type {
  AIAgentHandoff,
  AIAgentKey,
  AIChannel,
  AIChannelEvent,
  AIResolvedContext,
  AIRouteDecision,
  AIRunResult,
  AITrustedContext,
} from "./types";
import { createAnthropicProvider } from "./providers/anthropic";
import type { ModelProvider, ModelRequest } from "./providers/model-provider";
import { AI_CENTER_DEFAULT_MODEL, AI_CENTER_MAX_TOKENS, buildContextLines, channelGuidance } from "./prompting";
import { executeAITool } from "./tools/registry";
import type { AIToolExecutionResult } from "./tools/types";
import {
  LEAD_QUALIFICATION_TOOL_ALLOWLIST,
  buildLeadQualificationDecisionRequest,
  buildLeadQualificationFinalRequest,
  buildTrustedToolInput,
  parseLeadQualificationDecision,
  summarizeToolSuccess,
  type LeadQualificationToolDecision,
} from "./agents/lead-qualification";
import {
  GENERIC_FALLBACK_RESPONSE as RECEPTION_GENERIC_FALLBACK_RESPONSE,
  RECEPTION_HANDOFF_ALLOWLIST,
  buildReceptionDecisionRequest,
  parseReceptionDecision,
} from "./agents/reception";

// ── OBSERVABILITY SCOPE (why no agent_execution_steps / agent_events) ───
//
// agent_execution_steps.action_key is NOT NULL and the table's only
// writer today (src/lib/agentic/action-executor.ts's executeStep()) ties
// every row to a real, registered action-registry key with a matching
// step_type derived from that action's own risk/approval shape. This
// orchestrator does not invoke the action-executor pipeline at all in
// AI-1F (no tool execution yet — see TOOLS in this task's scope), so
// writing "fake" steps here (e.g. one for "context load", one for "model
// call") would misuse a table whose semantics are specifically
// action-execution-oriented, not a general orchestration timeline.
//
// agent_events (src/lib/agentic/events.ts) is similarly not a fit: its
// own file header explicitly warns "do not wire the rest up without a
// matching consumer," its `AgentEventType` union is a fixed,
// TypeScript-enforced domain-event vocabulary (lead.created,
// deal.stage_changed, etc.), and there is no existing event type or
// consumer for an AI orchestration lifecycle event like
// "ai.context_built". Adding one would mean editing that file's
// vocabulary for an as-yet-unconsumed event stream — exactly what its own
// header says not to do. Per this task's own instructions ("ONLY if... a
// clear existing write pattern" exists, "otherwise defer"), orchestration
// timeline instrumentation is deferred rather than forced into either
// table.
//
// AI-1I-A ADDENDUM (persistent observability): the reasoning above still
// holds — this file still writes to exactly one table. What changed is
// that `agent_executions.input_summary` (a real, NOT NULL, default-'{}'
// jsonb column from the original Phase 9.6 migration, previously never
// written by anything in this codebase — confirmed by a full-repo grep
// before this addendum was written) is now used to persist a compact
// routing + context-presence summary alongside the response summary
// already stored in `output_summary`. This required NO migration: the
// column already existed, sized and typed exactly for this purpose, and
// nothing else in the codebase reads or writes it, so there was nothing
// to reconcile. `agent_events` was reconsidered for a finer-grained
// lifecycle trace (execution.started/context.built/route.selected/etc.)
// and rejected again: a full-repo grep found `emitAgentEvent`/
// `AgentEventType` referenced nowhere outside their own defining file
// (events.ts) — so there is genuinely no consumer today, but there is
// also no requirement in AI-1I-A's own stated GOAL that isn't already
// satisfiable by a single execution row's input_summary/output_summary
// plus its existing agent_key/status/started_at/completed_at/
// input_tokens/output_tokens/cost_usd_estimated columns. Adding
// lifecycle-event production now would be observability beyond what this
// task's GOAL actually requires — deferred, not ruled out for later.
//
// AI-1J ADDENDUM (first tool-enabled flow): Lead Qualification (and ONLY
// Lead Qualification — Reception's flow below is byte-for-byte unchanged
// from AI-1F) may now request at most ONE of two allowlisted Gen-2
// actions per run: get_lead_context (read) and add_internal_note (low
// risk, no approval). The actual tool call always goes through the
// existing path this architecture requires:
//
//   this file -> executeAITool() (tools/registry.ts, AI-1B)
//             -> getActionDefinition()/executeStep() (src/lib/agentic/
//                action-registry.ts + action-executor.ts, Gen-2,
//                UNMODIFIED) -> handler
//
// This file never calls a handler or the action registry directly, and
// never writes any table other than agent_executions itself — the tool
// call's own agent_execution_steps row (and, if it ever needs one, an
// agent_approval_requests row) is created by executeStep(), not by this
// file, exactly as it already is for every other executeStep() caller
// (agent-execute.ts). See runLeadQualificationTurn() below for the full
// two-model-call, one-tool-maximum flow, and
// agents/lead-qualification.ts for the structured-decision contract that
// makes tool selection safe (strict schema, per-agent allowlist, and
// trusted-only argument binding — the model can choose a tool name and
// add_internal_note's note text, and NOTHING else).
//
// AI-1K ADDENDUM (first agent-to-agent handoff): Reception now gets its
// own structured-decision call too (see runReceptionTurn() below), and
// may hand off to Lead Qualification exactly once per run. A handoff
// stays inside the SAME agent_executions row created at the top of
// orchestrateAI() — there is no second execution row, no child-run table,
// and no new handoff-execution table. runLeadQualificationTurn() (still
// the one and only place this file calls executeAITool()) is reused
// as-is for the post-handoff turn, extended with two new optional
// parameters (`handoff`, `seedUsage`) rather than duplicated into a
// second function — see its own updated doc comment. Loop prevention is
// structural, not a runtime counter: agents/reception.ts's decision
// schema has no "tool" variant (Reception can't call a tool) and
// agents/lead-qualification.ts's decision schema has no "handoff" variant
// (Lead Qualification can't hand off again, including back to
// Reception) — a second hop is not merely disallowed by convention, there
// is no JSON shape either agent could produce that would parse into one.

/**
 * Placeholder value written to agent_executions.agent_key at INSERT time.
 * The column is NOT NULL, but this file's lifecycle (matching this task's
 * own diagram) creates the execution row before routing has run — routing
 * needs the built AIResolvedContext, not the execution id, so nothing
 * about the ordering requires knowing the agent key first. The real
 * routed key replaces this in the same UPDATE call that finalizes the
 * execution. This value is deliberately NOT one of KNOWN_AI_AGENT_KEYS,
 * so a row can never be mistaken for a real routing decision if read
 * mid-flight (e.g. by an operator dashboard) before finalization
 * completes.
 */
const UNROUTED_AGENT_KEY: AIAgentKey = "unrouted";

// AI_CENTER_DEFAULT_MODEL / AI_CENTER_MAX_TOKENS moved to ./prompting.ts
// in AI-1J so agents/lead-qualification.ts's prompt builders can share
// them without importing this file (which would create a circular
// dependency — this file imports the lead-qualification flow to run it).
// Still exactly the same values/meaning as AI-1F: the one smoke-tested
// model alias, and one bounded reply-length default.

// ── Temporary AI-1 system-agent configuration ───────────────────────────
//
// THIS IS TEMPORARY AI-1 SYSTEM-AGENT CONFIGURATION. It is NOT the
// authoritative agent runtime — that is versioned/DB-backed configuration
// (conceptually ai_agents/ai_agent_versions, per the ai-center skill),
// which does not exist yet. This map exists so AI-1F can prove the
// execution lifecycle without waiting on that schema work, and is
// designed to be trivially replaceable: nothing outside this file reads
// SYSTEM_AGENTS directly. It does NOT read, extend, or depend on the
// legacy `agent_definitions.system_prompt` table — that system remains
// completely untouched. The instructions below were written fresh for
// this architecture (only the general tone of the legacy prompts was
// glanced at for reference, nothing copied verbatim).
type SystemAgentConfig = {
  agentKey: AIAgentKey;
  instructions: string;
};

const SYSTEM_AGENTS: Partial<Record<AIAgentKey, SystemAgentConfig>> = {
  reception: {
    agentKey: "reception",
    instructions: [
      "You are Reception, the first point of contact for a home improvement contractor's customers.",
      "Greet the customer professionally and identify what they need.",
      "Use ONLY the CRM context provided below — never invent facts about the customer, their project, or the company.",
      "You have not booked, sent, or updated anything, and you cannot perform any action right now — never claim otherwise.",
      "If a handoff to a specialist would help, say only that you'll make sure the right person follows up — do not claim a handoff has already happened.",
      "If you need more information to help, ask one concise, specific question.",
      "Respond briefly and naturally, as if speaking directly to the customer.",
    ].join(" "),
  },
  lead_qualification: {
    agentKey: "lead_qualification",
    instructions: [
      "You are Lead Qualification, responsible for understanding a sales lead's project needs for a home improvement contractor.",
      // Behavior correction (live-test finding): the model asked "Are you
      // looking to work with a specific contractor, or are you exploring
      // options?" — treating itself as a neutral third party rather than
      // this business's own sales representative. The two sentences below
      // are the fix; everything else in this instruction set is
      // unchanged.
      "The business using RenoMeta Connect is the contractor/service provider the lead is contacting — you represent THAT business, not a marketplace, referral service, or neutral third party. Assume the customer is considering hiring this business for the project. Do not ask whether the customer is looking for another contractor, comparing contractors, already has a contractor, or needs help finding one, unless the customer explicitly brings that up first.",
      "Your goal is to move this opportunity forward for this business — choose whichever single most useful next question fits what's already known, focusing on whichever of these is not already known: project scope, location/service area, timeline, approximate budget, property/job details, decision-maker readiness, or a next step such as a consultation, estimate, or scheduling.",
      // Follow-up correction (live-test finding): a test lead had a known
      // $50,000 estimated budget, and the agent still asked "what's your
      // approximate budget range for this project?" The two sentences
      // below are the fix — everything else in this instruction set is
      // unchanged.
      "Use known CRM context before asking qualification questions — do not ask the customer for information (such as budget, project type, location, or timeline) that is already present in the lead, contact, project, or recent conversation context provided below, unless the value is ambiguous, stale, contradicted, or explicit confirmation is genuinely needed. You may acknowledge a known value naturally instead of asking about it again — for example, \"A $50,000 budget gives us a good starting point,\" not \"What is your budget?\"",
      "When the customer's first name is known from the trusted CRM context below (a \"Contact:\" or \"Lead name:\" line), use it naturally where it fits, especially in a greeting or acknowledgment — but do not repeat it in every sentence. If only a full name is given, use just its first word as the first name. Never guess a name from an email address, phone number, or username, and if no name is provided below, respond normally without one.",
      "Use ONLY the lead/contact/conversation context provided below — never invent job details, budget, or timeline.",
      // Follow-up correction (live-test finding): the prior wording here
      // ("ask one or two concise qualification questions") directly
      // conflicted with the "choose the single most useful next question"
      // rule above, and produced a response bundling two questions into
      // one turn ("What's the address of the property, and roughly which
      // kitchen elements are you prioritizing..."). Replaced with a rule
      // that resolves the conflict in favor of one question at a time —
      // everything else in this instruction set is unchanged.
      "Ask only ONE primary qualification question per response — choose the single most useful missing piece of information based on the CRM context and conversation, and never bundle multiple unrelated questions into the same turn (e.g. do not ask for the address, the timeline, and which kitchen elements are being replaced all at once). A small clarification within that same topic is fine — e.g. \"What area is the property located in — just the city or ZIP code is fine\" is still one question with one objective — but the response must not have more than one primary qualification objective.",
      "You have not updated any CRM record and cannot book an appointment right now — never claim otherwise.",
      "Respond briefly and naturally, as if speaking directly to the customer.",
    ].join(" "),
  },
  // "scheduling" intentionally has no entry — it must not run in AI-1F.
};

// ── Observability summaries (AI-1I-A) ────────────────────────────────────
//
// The shape of agent_executions.input_summary as written by this file.
// This is NOT a shared cross-module contract — a future Run Inspector
// reads this jsonb column directly via Supabase, not through a TS import
// of this type — so it stays local to this file rather than being added
// to ai/types.ts, per this task's "make the smallest changes necessary"
// scope. Deliberately excludes anything privacy-sensitive: no raw
// inbound text, no full contact/lead/project rows, no recent-message
// bodies — only booleans/counts/short strings already safe to persist
// (see this file's header and context-builder.ts's own scoping).

/** Which context CLASSES were available, not their contents. */
type AIContextPresenceSummary = {
  organization: boolean;
  contact: boolean;
  lead: boolean;
  project: boolean;
  /** Count only — never the message text itself. */
  recentMessageCount: number;
};

function summarizeContextPresence(context: AIResolvedContext): AIContextPresenceSummary {
  return {
    organization: !!context.organization,
    contact: !!context.contact,
    lead: !!context.lead,
    project: !!context.project,
    recentMessageCount: context.conversation?.recentMessages?.length ?? 0,
  };
}

/** The routing decision, safe to persist in full — AIRouteDecision.reason
 * is already a short, human-readable, non-sensitive string by contract
 * (see router.ts), never raw event content. `agentKey` is intentionally
 * repeated here even though it's also the row's top-level `agent_key`
 * column — this keeps the persisted routing snapshot self-contained for
 * a reader who only looks at input_summary. */
type AIRouteSummary = {
  agentKey: AIAgentKey;
  source: AIRouteDecision["source"];
  reason: string;
  confidence?: number;
};

function summarizeRoute(route: AIRouteDecision): AIRouteSummary {
  return { agentKey: route.agentKey, source: route.source, reason: route.reason, confidence: route.confidence };
}

/** AI-1J addition: whether a tool was attempted for this run, and which
 * one — never the note body, customer text, or raw model decision (see
 * this file's AI-1J header addendum). `attempted: false` with a
 * `skippedReason` records that the model asked for a tool but a trust
 * safeguard (e.g. no trusted leadId) blocked it before executeAITool()
 * was ever called. */
type AIToolingSummary = {
  attempted: boolean;
  toolName: string;
  skippedReason?: string;
};

/** AI-1K addition: a compact, audit-only record that a handoff happened —
 * never the full knownFacts/openQuestions (which may contain customer
 * content the task explicitly says not to persist here) and never the
 * raw model JSON. The full validated AIAgentHandoff still reaches the
 * caller via AIRunResult.handoff (see runReceptionTurn()) — this is only
 * what gets written into agent_executions.input_summary for the Run
 * Inspector. */
type AIHandoffSummary = {
  fromAgent: AIAgentKey;
  toAgent: AIAgentKey;
  reason: string;
};

/** Full shape written to agent_executions.input_summary. `route`/`context`
 * are omitted (not merely empty) when execution failed before routing/
 * context-building completed — an absent key means "never computed,"
 * distinct from a context summary that computed to all-false. */
type AIExecutionInputSummary = {
  channel: AIChannel;
  route?: AIRouteSummary;
  context?: AIContextPresenceSummary;
  tooling?: AIToolingSummary;
  handoff?: AIHandoffSummary;
};

export type OrchestrateAIParams = {
  /** Server-side (service-role or equivalent) Supabase client. */
  supabase: SupabaseClient;
  /** Normalized, still-untrusted inbound event. */
  event: AIChannelEvent;
  /** Server-resolved trusted context. See this file's header — the model
   * can never supply any field on this type. */
  trustedContext: AITrustedContext;
  /** Injected for testability (a mock provider needs no live Anthropic
   * call). Defaults to the real Anthropic provider via AI-1A's factory
   * when omitted. */
  modelProvider?: ModelProvider;
};

/**
 * Runs one AI Center execution end to end: creates an audit row, builds
 * scoped CRM context, deterministically routes to a system agent, calls
 * the model, records usage, and finalizes the execution — returning a
 * sanitized AIRunResult either way. Never throws: every failure mode this
 * task specifies (context-builder failure, unsupported agent, model
 * provider failure, execution insert/update failure, usage-logging
 * failure) is caught and converted into a `status: "failed"` result with
 * a safe, generic message. Real errors are always logged server-side
 * first (see the individual catch blocks below) — never included in the
 * returned error string, never a raw Supabase error, stack trace, or
 * provider response body.
 */
export async function orchestrateAI(params: OrchestrateAIParams): Promise<AIRunResult> {
  const { supabase, event, trustedContext } = params;
  const modelProvider = params.modelProvider ?? createAnthropicProvider();

  let executionId: string;
  try {
    executionId = await createExecutionRow(supabase, trustedContext, event);
  } catch (err) {
    console.error("[ai/orchestrator] createExecutionRow failed:", err);
    return {
      executionId: "unavailable",
      status: "failed",
      agentKey: UNROUTED_AGENT_KEY,
      error: "Could not start AI Center execution.",
    };
  }

  try {
    const context = await buildAIContext({
      supabase,
      orgId: trustedContext.orgId,
      channel: event.channel,
      contactId: trustedContext.contactId,
      leadId: trustedContext.leadId,
      projectId: trustedContext.projectId,
      conversationKey: trustedContext.conversationKey,
    });

    const route = routeAIEvent(event, context);

    // Computed once route+context both exist, reused by every finalize
    // call below (including the failure branches) so a Run Inspector can
    // later show "why did this land on Reception" even for a run that
    // failed after routing succeeded.
    const inputSummary: AIExecutionInputSummary = {
      channel: event.channel,
      route: summarizeRoute(route),
      context: summarizeContextPresence(context),
    };

    const agentConfig = SYSTEM_AGENTS[route.agentKey];
    if (!agentConfig) {
      const message = `Agent "${route.agentKey}" has no AI-1 runtime behavior yet.`;
      await finalizeExecution(supabase, executionId, { agentKey: route.agentKey, status: "failed", error: message, inputSummary });
      return { executionId, status: "failed", agentKey: route.agentKey, error: message };
    }

    // AI-1J: Lead Qualification ONLY gets the tool-enabled, two-model-call
    // flow.
    if (route.agentKey === "lead_qualification") {
      return await runLeadQualificationTurn({
        supabase, trustedContext, event, context, activeAgentKey: route.agentKey, modelProvider, executionId, agentConfig, inputSummary,
      });
    }

    // AI-1K: Reception gets its own structured-decision flow (may hand off
    // to Lead Qualification exactly once — see runReceptionTurn()). Any
    // OTHER future SYSTEM_AGENTS entry (none exist today besides these
    // two) falls through to the original AI-1F plain-response flow below,
    // unchanged.
    if (route.agentKey === "reception") {
      return await runReceptionTurn({
        supabase, trustedContext, event, context, modelProvider, executionId, agentConfig, inputSummary,
      });
    }

    const modelRequest = buildModelRequest(agentConfig, context, event);

    let modelResponse;
    try {
      modelResponse = await modelProvider.run(modelRequest);
    } catch (err) {
      console.error(`[ai/orchestrator] modelProvider.run failed (execution ${executionId}):`, err);
      const message = "The AI model could not generate a response.";
      await finalizeExecution(supabase, executionId, { agentKey: route.agentKey, status: "failed", error: message, inputSummary });
      return { executionId, status: "failed", agentKey: route.agentKey, error: message };
    }

    // recordUsageEvent() (src/lib/agentic/usage.ts) already implements the
    // exact "best-effort telemetry, never lose a real model success"
    // behavior this task asks for: it logs a failed insert server-side
    // and always resolves with the computed cost estimate regardless — it
    // does not throw. Called as-is, not re-wrapped.
    const costUsd = await recordUsageEvent(supabase, {
      orgId: trustedContext.orgId,
      executionId,
      provider: modelResponse.provider,
      model: modelResponse.model,
      inputTokens: modelResponse.usage.inputTokens,
      outputTokens: modelResponse.usage.outputTokens,
    });

    const finalized = await finalizeExecution(supabase, executionId, {
      agentKey: route.agentKey,
      status: "succeeded",
      outputSummary: { responseText: modelResponse.text },
      inputTokens: modelResponse.usage.inputTokens,
      outputTokens: modelResponse.usage.outputTokens,
      costUsd,
      inputSummary,
    });
    if (!finalized) {
      // A DB bookkeeping failure after a real model success does not
      // downgrade the result the caller receives — they already have a
      // valid answer. The execution row may be left in a stale "running"
      // state until an operator notices the logged error; that is a
      // lesser problem than discarding a real, already-generated
      // response. See finalizeExecution()'s own logging.
      console.error(`[ai/orchestrator] execution ${executionId} succeeded but could not be finalized in the database.`);
    }

    return {
      executionId,
      status: "completed",
      agentKey: route.agentKey,
      responseText: modelResponse.text,
    };
  } catch (err) {
    console.error(`[ai/orchestrator] orchestrateAI failed unexpectedly (execution ${executionId}):`, err);
    const message = "AI Center could not process this event.";
    // route/context are declared inside the inner try block above and are
    // not in scope here — this branch is reached only when the failure
    // happened before or during context building (e.g. buildAIContext()
    // itself threw), so there is no route/context summary to persist yet.
    // channel is always safe: `event` is a function parameter, in scope
    // for this entire function.
    const inputSummary: AIExecutionInputSummary = { channel: event.channel };
    try {
      await finalizeExecution(supabase, executionId, { agentKey: UNROUTED_AGENT_KEY, status: "failed", error: message, inputSummary });
    } catch (finalizeErr) {
      console.error(`[ai/orchestrator] finalizeExecution ALSO failed after an earlier error (execution ${executionId}):`, finalizeErr);
    }
    return { executionId, status: "failed", agentKey: UNROUTED_AGENT_KEY, error: message };
  }
}

// ── Lead Qualification tool-enabled turn (AI-1J, extended AI-1K) ─────────
//
// The only path in this file that ever calls executeAITool(). Sequence:
//
//   model call (structured decision)
//     -> "respond"            -> finalize, done (no tool)
//     -> "tool" + no leadId   -> finalize, done (no tool — see ENTITY
//                                BINDING below; the agent still answers
//                                normally, it just can't use the tool)
//     -> "tool" (bound input) -> executeAITool()
//          -> completed         -> one more model call (response only) -> finalize
//          -> approval_required -> finalize as "awaiting_approval", done
//          -> denied/failed     -> finalize as "failed", done
//
// At most one tool call, at most two of ITS OWN model calls, no loops —
// the function has no path that could ask for a second decision or a
// second tool. (AI-1K: when reached via a Reception handoff, one
// additional model call already happened in runReceptionTurn() before
// this function was even called — see `seedUsage` below, which folds
// that prior call's usage into this function's own running totals so the
// execution row's totals cover the whole run, not just this function's
// share of it.)
//
// AI-1K reuse, not duplication: this same function now serves both entry
// points — routed directly (activeAgentKey passed as the router's own
// pick, no `handoff`/`seedUsage`) and reached via a Reception handoff
// (activeAgentKey is always "lead_qualification" in that case, `handoff`
// carries the validated AIAgentHandoff for prompt continuity, `seedUsage`
// carries Reception's own decision-call usage so far). No second
// "runLeadQualificationFromHandoff()" implementation exists.
async function runLeadQualificationTurn(params: {
  supabase: SupabaseClient;
  trustedContext: AITrustedContext;
  event: AIChannelEvent;
  context: AIResolvedContext;
  /** Who is actually driving this turn — NOT necessarily who the router
   * originally picked. Always "lead_qualification" when `handoff` is set. */
  activeAgentKey: AIAgentKey;
  modelProvider: ModelProvider;
  executionId: string;
  agentConfig: SystemAgentConfig;
  inputSummary: AIExecutionInputSummary;
  /** Set only when this turn was reached via a Reception handoff — passed
   * straight through to both Lead Qualification prompt builders for
   * continuity (see agents/lead-qualification.ts's HANDOFF_CONTINUITY_
   * INSTRUCTION) and attached to the returned AIRunResult by the caller
   * (runReceptionTurn()), not by this function itself. */
  handoff?: AIAgentHandoff;
  /** Usage already incurred by a prior model call before this function was
   * invoked (Reception's own decision call, when reached via handoff).
   * Folded into this function's own running totals so
   * agent_executions.input_tokens/output_tokens/cost_usd_estimated always
   * reflect the ENTIRE execution — never just this function's share. */
  seedUsage?: { inputTokens: number; outputTokens: number; costUsd: number };
}): Promise<AIRunResult> {
  const { supabase, trustedContext, event, context, activeAgentKey, modelProvider, executionId, agentConfig, inputSummary, handoff, seedUsage } = params;

  // ── Model call: structured decision ──────────────────────────────────
  const decisionRequest = buildLeadQualificationDecisionRequest(agentConfig.instructions, context, event, handoff);

  let decisionResponse;
  try {
    decisionResponse = await modelProvider.run(decisionRequest);
  } catch (err) {
    console.error(`[ai/orchestrator] lead_qualification decision call failed (execution ${executionId}):`, err);
    const message = "The AI model could not generate a response.";
    await finalizeExecution(supabase, executionId, { agentKey: activeAgentKey, status: "failed", error: message, inputSummary });
    return { executionId, status: "failed", agentKey: activeAgentKey, error: message };
  }

  // Running totals across every model call THIS EXECUTION makes —
  // agent_executions must reflect the entire run, never just one
  // function's share of it. Seeded from a prior Reception call when
  // reached via handoff (see `seedUsage` above); every number here is
  // either a direct ModelResponse.usage value or a direct
  // recordUsageEvent() return value — no token/price math is performed by
  // this file.
  let totalInputTokens = (seedUsage?.inputTokens ?? 0) + decisionResponse.usage.inputTokens;
  let totalOutputTokens = (seedUsage?.outputTokens ?? 0) + decisionResponse.usage.outputTokens;
  let totalCostUsd =
    (seedUsage?.costUsd ?? 0) +
    (await recordUsageEvent(supabase, {
      orgId: trustedContext.orgId,
      executionId,
      provider: decisionResponse.provider,
      model: decisionResponse.model,
      inputTokens: decisionResponse.usage.inputTokens,
      outputTokens: decisionResponse.usage.outputTokens,
    }));

  const parsed = parseLeadQualificationDecision(decisionResponse.text);

  // Parse/validation failed — respond safely, no tool ever considered.
  // See agents/lead-qualification.ts's parseLeadQualificationDecision()
  // for why this is a plain response rather than any kind of retry.
  if (parsed.kind === "fallback") {
    return await finalizeLeadQualificationRun(supabase, executionId, activeAgentKey, {
      status: "succeeded",
      responseText: parsed.responseText,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      costUsd: totalCostUsd,
      inputSummary,
    });
  }

  const decision = parsed.decision;

  if (decision.type === "respond") {
    return await finalizeLeadQualificationRun(supabase, executionId, activeAgentKey, {
      status: "succeeded",
      responseText: decision.response,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      costUsd: totalCostUsd,
      inputSummary,
    });
  }

  // decision.type === "tool" from here on.

  // Defense in depth, per this task's explicit instruction: even though
  // the Zod schema already restricts `decision.tool` to exactly these two
  // literal values, and the AI Tool Registry has its own separate
  // allowlist, this file applies a THIRD, agent-level check before ever
  // calling executeAITool(). Should be unreachable given the schema, but
  // never trusted to be unreachable.
  if (!LEAD_QUALIFICATION_TOOL_ALLOWLIST.has(decision.tool)) {
    return await finalizeLeadQualificationRun(supabase, executionId, activeAgentKey, {
      status: "succeeded",
      responseText: GENERIC_FALLBACK_RESPONSE_LOCAL,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      costUsd: totalCostUsd,
      inputSummary: { ...inputSummary, tooling: { attempted: false, toolName: decision.tool, skippedReason: "not_in_agent_allowlist" } },
    });
  }

  // ── ENTITY BINDING: both allowlisted tools are lead-scoped in AI-1J
  // (add_internal_note is always bound to the current lead — see
  // buildTrustedToolInput()). Without a trusted leadId there is nothing
  // safe to bind to, and the model's own output is NEVER used to supply
  // one (see this file's header trust boundary). The agent still answers
  // normally; it simply cannot use a tool this turn.
  if (!trustedContext.leadId) {
    const message =
      "I don't have a specific lead on file for this conversation yet, so I can't pull up or update any records — could you tell me a bit more about the project in the meantime?";
    return await finalizeLeadQualificationRun(supabase, executionId, activeAgentKey, {
      status: "succeeded",
      responseText: message,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      costUsd: totalCostUsd,
      inputSummary: { ...inputSummary, tooling: { attempted: false, toolName: decision.tool, skippedReason: "no_trusted_lead_id" } },
    });
  }

  const toolInput = buildTrustedToolInput(decision as LeadQualificationToolDecision, trustedContext.leadId);
  const autonomyLevel = trustedContext.autonomyLevel ?? 1;

  // ── Tool execution — the ONLY call site of executeAITool() in this
  // file. Routes through the AI Tool Registry (AI-1B), which itself only
  // ever calls the existing, unmodified Gen-2 executeStep() — never a
  // handler or Supabase mutation directly from here. `sequence` is
  // hardcoded to 1: AI-1J permits at most one tool call per execution, so
  // there is never a second step to number.
  const toolResult: AIToolExecutionResult = await executeAITool(
    { toolName: decision.tool, input: toolInput },
    {
      supabase,
      orgId: trustedContext.orgId,
      actor: trustedContext.actor,
      executionId,
      sequence: 1,
      autonomyLevel,
      targetEntityType: "lead",
      targetEntityId: trustedContext.leadId,
      approvalSummary: decision.tool === "add_internal_note" ? "Lead Qualification requested adding an internal note to this lead." : undefined,
    },
  );

  const toolingSummary: AIToolingSummary = { attempted: true, toolName: decision.tool };

  if (toolResult.status === "approval_required") {
    // Do NOT pretend the action occurred. AIRunResult's existing
    // "awaiting_approval" status covers exactly this case — no new
    // status invented.
    const message = "I've prepared that for a teammate to review before it's added — I haven't made any changes yet.";
    await finalizeExecution(supabase, executionId, {
      agentKey: activeAgentKey,
      status: "awaiting_approval",
      outputSummary: { responseText: message },
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      costUsd: totalCostUsd,
      inputSummary: { ...inputSummary, tooling: toolingSummary },
    });
    return { executionId, status: "awaiting_approval", agentKey: activeAgentKey, responseText: message, toolResults: [toolResult] };
  }

  if (toolResult.status === "denied" || toolResult.status === "failed") {
    // Never claim success. "denied" (blocked before executeStep — e.g. an
    // allowlist mismatch inside the registry itself) and "failed" (the
    // handler/executor genuinely failed) are both reported as a failed
    // run — see this task's TOOL RESULT HANDLING: "do not conceal a
    // failed CRM mutation as a successful tool action." toolResult.error
    // is already sanitized by the Tool Registry (see tools/registry.ts's
    // sanitizeError()) — never a raw DB error.
    const message = "I wasn't able to complete that just now — let's continue, and a teammate can follow up on the details.";
    return await finalizeLeadQualificationRun(supabase, executionId, activeAgentKey, {
      status: "failed",
      responseText: undefined,
      errorMessage: message,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      costUsd: totalCostUsd,
      inputSummary: { ...inputSummary, tooling: toolingSummary },
      toolResults: [toolResult],
    });
  }

  // toolResult.status === "completed" — the ONLY case that proceeds to a
  // second model call. That call is response-generation ONLY: no tool
  // decision is requested, and its output is never parsed as one.
  const finalRequest = buildLeadQualificationFinalRequest(
    agentConfig.instructions,
    context,
    event,
    summarizeToolSuccess(decision.tool),
    handoff,
  );

  let finalResponse;
  try {
    finalResponse = await modelProvider.run(finalRequest);
  } catch (err) {
    console.error(`[ai/orchestrator] lead_qualification final response call failed (execution ${executionId}):`, err);
    // The tool itself already succeeded (e.g. a real internal note now
    // exists) — that must never be concealed as if nothing happened, but
    // a customer-facing response cannot be fabricated either. Reported as
    // failed, with the real tool outcome still attached via toolResults
    // so this isn't mistaken for "nothing happened."
    const message = "The AI model could not generate a final response.";
    return await finalizeLeadQualificationRun(supabase, executionId, activeAgentKey, {
      status: "failed",
      responseText: undefined,
      errorMessage: message,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      costUsd: totalCostUsd,
      inputSummary: { ...inputSummary, tooling: toolingSummary },
      toolResults: [toolResult],
    });
  }

  totalInputTokens += finalResponse.usage.inputTokens;
  totalOutputTokens += finalResponse.usage.outputTokens;
  totalCostUsd += await recordUsageEvent(supabase, {
    orgId: trustedContext.orgId,
    executionId,
    provider: finalResponse.provider,
    model: finalResponse.model,
    inputTokens: finalResponse.usage.inputTokens,
    outputTokens: finalResponse.usage.outputTokens,
  });

  return await finalizeLeadQualificationRun(supabase, executionId, activeAgentKey, {
    status: "succeeded",
    responseText: finalResponse.text,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    costUsd: totalCostUsd,
    inputSummary: { ...inputSummary, tooling: toolingSummary },
    toolResults: [toolResult],
  });
}

/** A safe, generic response the AI Tool Registry / trust checks fall back
 * to — distinct from (but equivalent in spirit to) GENERIC_FALLBACK_RESPONSE
 * in agents/lead-qualification.ts, which covers the JSON-parsing fallback
 * specifically. Kept as a separate local constant so this file doesn't
 * need to import a name whose doc comment is about parsing, for a case
 * that isn't about parsing (the schema-level allowlist defense above). */
const GENERIC_FALLBACK_RESPONSE_LOCAL =
  "Thanks for reaching out — let me gather a bit more information to help with your request.";

/** Shared finalize+return helper for every Lead Qualification exit path
 * that reaches a terminal ("succeeded"/"failed") status — keeps the
 * "finalize the row, then build the matching AIRunResult" pairing in one
 * place rather than repeated at each call site above. Not used for the
 * "awaiting_approval" exit, which has its own small inline block (its
 * AIRunResult shape differs enough — no error, a required responseText —
 * that sharing this helper would need more branching than it saves). */
async function finalizeLeadQualificationRun(
  supabase: SupabaseClient,
  executionId: string,
  agentKey: AIAgentKey,
  params: {
    status: "succeeded" | "failed";
    responseText?: string;
    errorMessage?: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    inputSummary: AIExecutionInputSummary;
    toolResults?: AIToolExecutionResult[];
  },
): Promise<AIRunResult> {
  const finalized = await finalizeExecution(supabase, executionId, {
    agentKey,
    status: params.status,
    error: params.errorMessage,
    outputSummary: params.responseText !== undefined ? { responseText: params.responseText } : undefined,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    costUsd: params.costUsd,
    inputSummary: params.inputSummary,
  });
  if (!finalized) {
    console.error(`[ai/orchestrator] lead_qualification execution ${executionId} (${params.status}) could not be finalized in the database.`);
  }

  return {
    executionId,
    status: params.status === "succeeded" ? "completed" : "failed",
    agentKey,
    responseText: params.responseText,
    error: params.errorMessage,
    toolResults: params.toolResults,
  };
}

// ── Reception turn (AI-1K) ────────────────────────────────────────────────
//
// One structured-decision model call. Sequence:
//
//   model call (structured decision)
//     -> "respond"                          -> finalize, done
//     -> "handoff" (disallowed destination) -> finalize as a plain
//                                               response, done (defense
//                                               in depth — see below;
//                                               should be unreachable)
//     -> "handoff" to lead_qualification     -> build AIAgentHandoff
//                                               -> runLeadQualificationTurn()
//                                               (SAME execution row,
//                                               SAME trustedContext,
//                                               unmodified)
//
// Reception has NO tool access and NO path to hand off more than once —
// see agents/reception.ts's header for why that's structural, not just
// conventional. This function never calls executeAITool() itself; if a
// handoff happens, the tool call (if any) happens entirely inside the
// reused runLeadQualificationTurn().
async function runReceptionTurn(params: {
  supabase: SupabaseClient;
  trustedContext: AITrustedContext;
  event: AIChannelEvent;
  context: AIResolvedContext;
  modelProvider: ModelProvider;
  executionId: string;
  agentConfig: SystemAgentConfig;
  inputSummary: AIExecutionInputSummary;
}): Promise<AIRunResult> {
  const { supabase, trustedContext, event, context, modelProvider, executionId, agentConfig, inputSummary } = params;

  const decisionRequest = buildReceptionDecisionRequest(agentConfig.instructions, context, event);

  let decisionResponse;
  try {
    decisionResponse = await modelProvider.run(decisionRequest);
  } catch (err) {
    console.error(`[ai/orchestrator] reception decision call failed (execution ${executionId}):`, err);
    const message = "The AI model could not generate a response.";
    await finalizeExecution(supabase, executionId, { agentKey: "reception", status: "failed", error: message, inputSummary });
    return { executionId, status: "failed", agentKey: "reception", error: message };
  }

  const receptionInputTokens = decisionResponse.usage.inputTokens;
  const receptionOutputTokens = decisionResponse.usage.outputTokens;
  const receptionCostUsd = await recordUsageEvent(supabase, {
    orgId: trustedContext.orgId,
    executionId,
    provider: decisionResponse.provider,
    model: decisionResponse.model,
    inputTokens: decisionResponse.usage.inputTokens,
    outputTokens: decisionResponse.usage.outputTokens,
  });

  const parsed = parseReceptionDecision(decisionResponse.text);

  // Parse/validation failed — respond safely, no handoff ever considered.
  // Same reasoning as Lead Qualification's own fallback handling.
  if (parsed.kind === "fallback") {
    return await finalizeReceptionRun(supabase, executionId, {
      responseText: parsed.responseText,
      inputTokens: receptionInputTokens,
      outputTokens: receptionOutputTokens,
      costUsd: receptionCostUsd,
      inputSummary,
    });
  }

  const decision = parsed.decision;

  if (decision.type === "respond") {
    return await finalizeReceptionRun(supabase, executionId, {
      responseText: decision.response,
      inputTokens: receptionInputTokens,
      outputTokens: receptionOutputTokens,
      costUsd: receptionCostUsd,
      inputSummary,
    });
  }

  // decision.type === "handoff" from here on.

  // Defense in depth, per this task's explicit instruction: even though
  // the Zod schema already restricts `toAgent` to the single literal
  // "lead_qualification", this file applies a SECOND, explicit allowlist
  // check before ever building an AIAgentHandoff or calling Lead
  // Qualification. Should be unreachable given the schema, but never
  // trusted to be unreachable — same pattern as
  // LEAD_QUALIFICATION_TOOL_ALLOWLIST one layer down.
  if (!RECEPTION_HANDOFF_ALLOWLIST.has(decision.toAgent)) {
    return await finalizeReceptionRun(supabase, executionId, {
      responseText: RECEPTION_GENERIC_FALLBACK_RESPONSE,
      inputTokens: receptionInputTokens,
      outputTokens: receptionOutputTokens,
      costUsd: receptionCostUsd,
      inputSummary,
    });
  }

  // The handoff is a CONTENT decision only — it never touches trust. No
  // field below can come from trustedContext, and nothing downstream
  // reads orgId/actor/autonomyLevel/executionId/contactId/leadId/
  // projectId from it (see this file's AI-1K header addendum and
  // agents/reception.ts's own trust-boundary note).
  const handoff: AIAgentHandoff = {
    fromAgent: "reception",
    toAgent: decision.toAgent,
    reason: decision.reason,
    summary: decision.summary,
    knownFacts: decision.knownFacts,
    openQuestions: decision.openQuestions,
  };
  const handoffSummary: AIHandoffSummary = { fromAgent: "reception", toAgent: decision.toAgent, reason: decision.reason };

  const leadQualificationConfig = SYSTEM_AGENTS.lead_qualification;
  if (!leadQualificationConfig) {
    // Defensive only — both agents are defined together above; this
    // should never actually happen.
    const message = "Lead Qualification is not available right now.";
    await finalizeExecution(supabase, executionId, {
      agentKey: "reception",
      status: "failed",
      error: message,
      inputTokens: receptionInputTokens,
      outputTokens: receptionOutputTokens,
      costUsd: receptionCostUsd,
      inputSummary: { ...inputSummary, handoff: handoffSummary },
    });
    return { executionId, status: "failed", agentKey: "reception", error: message, handoff };
  }

  // Reuse the existing tool-enabled Lead Qualification turn — SAME
  // execution row (`executionId` passed straight through, never a new
  // insert), SAME trustedContext (passed straight through, completely
  // unmodified — a handoff cannot widen what Lead Qualification is
  // allowed to do). Reception's own usage is folded in via `seedUsage` so
  // the execution's totals cover this entire run, not just Lead
  // Qualification's share of it.
  const result = await runLeadQualificationTurn({
    supabase,
    trustedContext,
    event,
    context,
    activeAgentKey: "lead_qualification",
    modelProvider,
    executionId,
    agentConfig: leadQualificationConfig,
    inputSummary: { ...inputSummary, handoff: handoffSummary },
    handoff,
    seedUsage: { inputTokens: receptionInputTokens, outputTokens: receptionOutputTokens, costUsd: receptionCostUsd },
  });

  // Attach the full validated handoff to the result regardless of how
  // runLeadQualificationTurn's own turn concluded (completed, failed, or
  // awaiting_approval) — per this task's explicit instruction: "Do not
  // lose the fact that a handoff occurred if a later stage fails."
  return { ...result, handoff };
}

/** Shared finalize+return helper for every Reception exit path that
 * simply responds (no handoff) — mirrors
 * finalizeLeadQualificationRun()'s role for Lead Qualification. Always
 * "succeeded"/"completed": every path that reaches this helper already
 * has a safe response to give (a real decision, or a fallback), so there
 * is nothing else to report as failed here — a genuine Reception model
 * failure is handled earlier, before this helper is ever called. */
async function finalizeReceptionRun(
  supabase: SupabaseClient,
  executionId: string,
  params: {
    responseText: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    inputSummary: AIExecutionInputSummary;
  },
): Promise<AIRunResult> {
  const finalized = await finalizeExecution(supabase, executionId, {
    agentKey: "reception",
    status: "succeeded",
    outputSummary: { responseText: params.responseText },
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    costUsd: params.costUsd,
    inputSummary: params.inputSummary,
  });
  if (!finalized) {
    console.error(`[ai/orchestrator] reception execution ${executionId} succeeded but could not be finalized in the database.`);
  }

  return { executionId, status: "completed", agentKey: "reception", responseText: params.responseText };
}

// ── agent_executions lifecycle ──────────────────────────────────────────

/** Picks the single most specific entity to record as the execution's
 * target — lead first (the most actionable entity for reception/lead
 * qualification), then project, then contact. Matches the
 * target_entity_type/target_entity_id shape already used by
 * agent-execute.ts (which always records exactly one target). */
function primaryTargetEntity(trustedContext: AITrustedContext): { targetEntityType: string | null; targetEntityId: string | null } {
  if (trustedContext.leadId) return { targetEntityType: "lead", targetEntityId: trustedContext.leadId };
  if (trustedContext.projectId) return { targetEntityType: "project", targetEntityId: trustedContext.projectId };
  if (trustedContext.contactId) return { targetEntityType: "contact", targetEntityId: trustedContext.contactId };
  return { targetEntityType: null, targetEntityId: null };
}

async function createExecutionRow(
  supabase: SupabaseClient,
  trustedContext: AITrustedContext,
  event: AIChannelEvent,
): Promise<string> {
  const { targetEntityType, targetEntityId } = primaryTargetEntity(trustedContext);

  const { data, error } = await supabase
    .from("agent_executions")
    .insert({
      org_id: trustedContext.orgId,
      agent_key: UNROUTED_AGENT_KEY,
      actor_type: trustedContext.actor.actorType,
      actor_id: trustedContext.actor.actorId,
      source: trustedContext.actor.source ?? null,
      trigger_event: event.eventType,
      status: "running",
      // Never read from event/model input — see this file's header.
      // Defaults to 1 ("Recommend"), the safest level, matching that
      // AI-1F performs no tool execution regardless of the value passed.
      autonomy_level: trustedContext.autonomyLevel ?? 1,
      target_entity_type: targetEntityType,
      target_entity_id: targetEntityId,
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error("Could not create agent_executions row.");
  }
  return data.id as string;
}

type FinalizePatch = {
  agentKey: AIAgentKey;
  /** AI-1J adds "awaiting_approval" — a real agent_executions.status
   * value (see the Phase 9.6 migration's CHECK constraint), used only
   * when a Lead Qualification tool call itself comes back
   * approval_required. Matches the existing convention already
   * established by agent-execute.ts (see finalizeExecution() below on
   * completed_at). */
  status: "succeeded" | "failed" | "awaiting_approval";
  error?: string;
  outputSummary?: Record<string, unknown>;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** Always provided by every call site (at minimum {channel}) — see
   * AIExecutionInputSummary and orchestrateAI()'s own comments on why a
   * partial summary is still written even on early failure. */
  inputSummary: AIExecutionInputSummary;
};

/** Updates the execution row to a terminal (or awaiting-approval) status.
 * Never throws — a failure here is logged and reported back via its
 * boolean return so callers can decide (per this task's EXECUTION
 * FAILURE FINALIZATION section) whether that changes what they return,
 * without risking an unhandled rejection on top of whatever already went
 * wrong. */
async function finalizeExecution(
  supabase: SupabaseClient,
  executionId: string,
  patch: FinalizePatch,
): Promise<boolean> {
  const update: Record<string, unknown> = {
    agent_key: patch.agentKey,
    status: patch.status,
    // Matches agent-execute.ts's own convention: an execution awaiting a
    // human decision is not yet "completed" — completed_at stays null
    // until the approval is acted on (a future phase's concern; AI-1J
    // does not implement approval execution itself, see this file's
    // AI-1J header addendum).
    completed_at: patch.status === "awaiting_approval" ? null : new Date().toISOString(),
    input_summary: patch.inputSummary,
  };
  if (patch.error !== undefined) update.error = patch.error;
  if (patch.outputSummary !== undefined) update.output_summary = patch.outputSummary;
  if (patch.inputTokens !== undefined) update.input_tokens = patch.inputTokens;
  if (patch.outputTokens !== undefined) update.output_tokens = patch.outputTokens;
  if (patch.costUsd !== undefined) update.cost_usd_estimated = patch.costUsd;

  const { error } = await supabase.from("agent_executions").update(update).eq("id", executionId);
  if (error) {
    console.error(`[ai/orchestrator] finalizeExecution(${executionId}) failed to persist status="${patch.status}":`, error);
    return false;
  }
  return true;
}

// ── Prompt construction ──────────────────────────────────────────────────
//
// Bounded and compact by construction: only the selected agent's own
// instructions, the organization's name, small CRM summaries already
// scoped by context-builder.ts, and the inbound event's own text are
// used. event.metadata is never read here. No secrets, OAuth data,
// service-role details, or unrelated CRM rows are reachable from any of
// these inputs in the first place (see context-builder.ts's own scoping).
function buildModelRequest(
  agentConfig: SystemAgentConfig,
  context: AIResolvedContext,
  event: AIChannelEvent,
): ModelRequest {
  const guidance = channelGuidance(context.channel);
  const system = `${agentConfig.instructions}${guidance ? `\n\n${guidance}` : ""}\n\nOrganization: ${context.organization.name}.`;
  const contextLines = buildContextLines(context);
  const inboundText = event.content.text?.trim() || "(no message text provided)";

  const userMessage = [
    `Current inbound event:\n${inboundText}`,
    contextLines.length > 0
      ? `Known CRM context:\n${contextLines.join("\n")}`
      : "Known CRM context: none available.",
    "Respond as the selected agent.",
  ].join("\n\n");

  return {
    model: AI_CENTER_DEFAULT_MODEL,
    system,
    messages: [{ role: "user", content: userMessage }],
    maxTokens: AI_CENTER_MAX_TOKENS,
  };
}
