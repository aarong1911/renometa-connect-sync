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
  AIAgentKey,
  AIChannelEvent,
  AIResolvedContext,
  AIRunResult,
  AITrustedContext,
} from "./types";
import { createAnthropicProvider } from "./providers/anthropic";
import type { ModelProvider, ModelRequest } from "./providers/model-provider";

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

/**
 * Temporary default model for AI-1F. This is the exact alias already
 * smoke-tested against the real Anthropic API in AI-1A/AI-1B
 * ("claude-haiku-4-5", confirmed to resolve server-side to
 * claude-haiku-4-5-20251001 — see anthropic.ts / the AI-1A smoke test).
 * Model choice belongs to agent versioning/configuration once that exists
 * (see the ai-center skill's "Model Provider Architecture" section: "do
 * not hard-code model IDs throughout agent implementations") — this is
 * the ONE named constant standing in for that until then, not a pattern
 * to repeat elsewhere in this file.
 */
const AI_CENTER_DEFAULT_MODEL = "claude-haiku-4-5";

/** Bounded reply length for AI-1F's conversational responses — an
 * AI-1F-specific default, not an architectural constant. */
const AI_CENTER_MAX_TOKENS = 400;

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
      "Use ONLY the lead/contact/conversation context provided below — never invent job details, budget, or timeline.",
      "Ask one or two concise qualification questions when key information (project type, timeline, budget range) is missing.",
      "You have not updated any CRM record and cannot book an appointment right now — never claim otherwise.",
      "Respond briefly and naturally, as if speaking directly to the customer.",
    ].join(" "),
  },
  // "scheduling" intentionally has no entry — it must not run in AI-1F.
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

    const agentConfig = SYSTEM_AGENTS[route.agentKey];
    if (!agentConfig) {
      const message = `Agent "${route.agentKey}" has no AI-1 runtime behavior yet.`;
      await finalizeExecution(supabase, executionId, { agentKey: route.agentKey, status: "failed", error: message });
      return { executionId, status: "failed", agentKey: route.agentKey, error: message };
    }

    const modelRequest = buildModelRequest(agentConfig, context, event);

    let modelResponse;
    try {
      modelResponse = await modelProvider.run(modelRequest);
    } catch (err) {
      console.error(`[ai/orchestrator] modelProvider.run failed (execution ${executionId}):`, err);
      const message = "The AI model could not generate a response.";
      await finalizeExecution(supabase, executionId, { agentKey: route.agentKey, status: "failed", error: message });
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
    try {
      await finalizeExecution(supabase, executionId, { agentKey: UNROUTED_AGENT_KEY, status: "failed", error: message });
    } catch (finalizeErr) {
      console.error(`[ai/orchestrator] finalizeExecution ALSO failed after an earlier error (execution ${executionId}):`, finalizeErr);
    }
    return { executionId, status: "failed", agentKey: UNROUTED_AGENT_KEY, error: message };
  }
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
  status: "succeeded" | "failed";
  error?: string;
  outputSummary?: Record<string, unknown>;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
};

/** Updates the execution row to a terminal status. Never throws — a
 * failure here is logged and reported back via its boolean return so
 * callers can decide (per this task's EXECUTION FAILURE FINALIZATION
 * section) whether that changes what they return, without risking an
 * unhandled rejection on top of whatever already went wrong. */
async function finalizeExecution(
  supabase: SupabaseClient,
  executionId: string,
  patch: FinalizePatch,
): Promise<boolean> {
  const update: Record<string, unknown> = {
    agent_key: patch.agentKey,
    status: patch.status,
    completed_at: new Date().toISOString(),
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
  const system = `${agentConfig.instructions}\n\nOrganization: ${context.organization.name}.`;

  const contextLines: string[] = [];
  if (context.contact) {
    contextLines.push(`Contact: ${context.contact.name}${context.contact.phone ? ` (${context.contact.phone})` : ""}`);
  }
  if (context.lead) {
    contextLines.push(
      `Lead status: ${context.lead.status}${context.lead.source ? `, source: ${context.lead.source}` : ""}`,
    );
  }
  if (context.project) {
    contextLines.push(`Project: ${context.project.name} (${context.project.status})`);
  }
  if (context.conversation?.recentMessages?.length) {
    // Already bounded by context-builder.ts's RECENT_MESSAGE_LIMIT (10) —
    // formatted compactly as plain text lines, not a JSON dump.
    const formatted = context.conversation.recentMessages
      .map((m) => `${m.direction === "in" ? "Customer" : "Us"}: ${m.text}`)
      .join("\n");
    contextLines.push(`Recent conversation:\n${formatted}`);
  }

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
