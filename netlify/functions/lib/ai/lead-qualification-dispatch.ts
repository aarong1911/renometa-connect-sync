// netlify/functions/lib/ai/lead-qualification-dispatch.ts
//
// Live Lead Qualification — Phase AI-3A. The first REAL production
// dispatcher for a specialist agent, mirroring the same shape
// meta-whatsapp-background.ts already established for WhatsApp (auth/
// idempotency/policy in the thin Netlify handler's caller, the actual
// orchestration logic here as an injectable, unit-testable core — no
// network, no live Anthropic call unless a real ModelProvider is passed):
//
//   real lead / inbound message
//     -> isLiveTriggerEligible() / policy gate (lib/ai/lead-trigger.ts,
//        src/lib/agentic/policy-resolver.ts)
//     -> idempotency claim (agent_executions.idempotency_key, unique)
//     -> buildAIContext() (already resolves lead/contact/conversation)
//     -> orchestrateAI() (routes to Lead Qualification via the existing
//        deterministic router — see ai/router.ts's routeByCrmContext)
//     -> autonomy-gated outcome:
//          Level 1 -> recommendation only, no outbound action
//          Level 2 -> propose send_sms/send_whatsapp via the EXISTING
//                     executeStep()/approval system (the same one
//                     WhatsApp's own background dispatcher already uses)
//     -> claim row finalized for observability/idempotency audit
//
// NOT built here: a new approval system (reuses agent_approval_requests),
// a new send path (reuses handlers.ts's sendSms/sendWhatsapp via
// executeStep), a new agent_executions schema (the idempotency_key column
// and unique (org_id, idempotency_key) constraint already exist — see
// 20260731_agentic_foundation.sql).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AIChannel, AIChannelEvent, AITrustedContext } from "./types";
import type { ModelProvider } from "./providers/model-provider";
import { orchestrateAI } from "./orchestrator";
import { buildAIContext } from "./context-builder";
import { executeStep, type ExecuteStepResult } from "../../../../src/lib/agentic/action-executor";
import { resolveExecutionPolicy } from "../../../../src/lib/agentic/policy-resolver";
import type { AgentPolicy } from "../../../../src/lib/agentic/policies";
import {
  buildInboundMessageIdempotencyKey,
  buildLeadCreatedIdempotencyKey,
  buildManualRunIdempotencyKey,
  isLiveTriggerEligible,
  isValidInvocationId,
  type InboundTriggerCandidate,
} from "./lead-trigger";

const AGENT_KEY = "lead_qualification";

/** Channels this phase can actually EXECUTE an approved reply for (real,
 * isExecutable:true handlers in action-registry.ts). Messenger/Instagram/
 * email are intentionally excluded — see this module's own report for why:
 * they either have no handler yet (email) or no registered send action at
 * all yet (messenger/instagram). A run for one of those channels still
 * completes normally (Level 1 recommendation, or a "handoff to human"
 * outcome) — it simply never reaches the propose-a-send step. */
const EXECUTABLE_REPLY_CHANNELS: Partial<Record<AIChannel, string>> = {
  sms: "send_sms",
  whatsapp: "send_whatsapp",
};

export type LeadQualificationTriggerSource = "lead_created" | "inbound_lead_message" | "manual_run";

export type DispatchLeadQualificationParams = {
  supabase: SupabaseClient;
  orgId: string;
  source: LeadQualificationTriggerSource;
  /** The trusted lead this run concerns — always required; Lead
   * Qualification has nothing to do without a lead. */
  leadId: string;
  contactId?: string;
  /** Required for `inbound_lead_message`; unused otherwise. */
  inboundEvent?: {
    channel: AIChannel;
    messageRowId: string;
    text: string;
    externalMessageId?: string;
    candidate: InboundTriggerCandidate;
  };
  actorId?: string;
  modelProvider?: ModelProvider;
  /**
   * `source: "lead_created"` ONLY. True when this lead was created as a
   * direct byproduct of persisting a real inbound customer message (e.g.
   * Instagram/Messenger's "first DM creates the lead" resolvers) — see this
   * module's own report for why: a channel that has (or will have) its own
   * live inbound_lead_message trigger must be the ONE thing that responds to
   * that customer event, never a second, competing lead_created run for the
   * exact same message. When true, dispatch is skipped
   * (`associated_with_inbound_message`) unconditionally, before any policy
   * lookup — this is a structural precedence rule, not a policy choice.
   */
  associatedWithInboundMessage?: boolean;
  /**
   * `source: "manual_run"` ONLY, REQUIRED. A client-generated id, one per
   * intentional "Run Lead Qualification" click, resent unchanged on any
   * retry of that same click — see buildManualRunIdempotencyKey's own doc
   * comment. Validated for shape only (isValidInvocationId), never trusted
   * as identity or authorization.
   */
  invocationId?: string;
  /** Test seam only — defaults to the real orchestrateAI. */
  orchestrate?: typeof orchestrateAI;
};

export type DispatchLeadQualificationResult =
  | { status: "skipped"; reason: "duplicate" | "not_live_eligible" | "disabled" | "emergency_paused" | "channel_not_supported" | "associated_with_inbound_message" }
  | { status: "recommendation"; claimId: string; executionId: string; responseText?: string }
  | { status: "awaiting_approval"; claimId: string; executionId: string; approvalRequestId: string }
  | { status: "failed"; claimId?: string; executionId?: string; error: string; reason?: "invalid_invocation_id" };

/**
 * `ai_center_settings.agents.lead_qualification.enabled` — a DEDICATED gate,
 * deliberately separate from AgentPolicy.agentsEnabled (which defaults to
 * `true` org-wide and, before this phase, was read by nothing at all — see
 * policies.ts's own "No UI reads or writes real per-org values yet"
 * comment). Live-triggering a real production agent for the first time
 * must default to OFF for every existing org until explicitly turned on —
 * defaulting to the pre-existing `agentsEnabled: true` would have silently
 * switched every org's leads on the moment this code deployed. Only a
 * literal boolean `true` enables it; anything else (missing, malformed,
 * a stray string) fails closed to disabled, same spirit as
 * resolveAgentPolicy()'s own `emergencyPaused === true` check.
 */
async function isLeadQualificationEnabled(supabase: SupabaseClient, orgId: string): Promise<boolean> {
  const { data, error } = await supabase.from("organizations").select("ai_center_settings").eq("id", orgId).maybeSingle();
  if (error) {
    console.error("[lead-qualification-dispatch] enabled-flag lookup failed — failing closed (disabled):", error.message);
    return false;
  }
  const settings = (data?.ai_center_settings ?? {}) as { agents?: Record<string, { enabled?: unknown }> };
  return settings.agents?.[AGENT_KEY]?.enabled === true;
}

type Claim = { id: string; idempotencyKey: string };

/** Conditional insert on the existing unique (org_id, idempotency_key) constraint — a 23505 means a run for this exact trigger already exists. */
async function claimTrigger(
  supabase: SupabaseClient,
  orgId: string,
  idempotencyKey: string,
  source: LeadQualificationTriggerSource,
  leadId: string,
  actorId: string,
): Promise<Claim | null> {
  const { data, error } = await supabase
    .from("agent_executions")
    .insert({
      org_id: orgId,
      agent_key: AGENT_KEY,
      actor_type: "workflow",
      actor_id: actorId,
      source,
      trigger_event: source,
      status: "running",
      autonomy_level: 1,
      target_entity_type: "lead",
      target_entity_id: leadId,
      idempotency_key: idempotencyKey,
      input_summary: { phase: "AI-3A", source },
    })
    .select("id")
    .maybeSingle();
  if (error) {
    if ((error as any).code === "23505") return null; // duplicate trigger — safe no-op
    console.error("[lead-qualification-dispatch] claim insert failed:", error.message);
    throw new Error("Could not claim trigger for Lead Qualification.");
  }
  if (!data) return null;
  return { id: data.id, idempotencyKey };
}

async function finalizeClaim(supabase: SupabaseClient, claimId: string, status: "succeeded" | "failed", extra: Record<string, unknown>) {
  await supabase.from("agent_executions").update({ status, output_summary: extra, completed_at: new Date().toISOString() }).eq("id", claimId);
}

/**
 * Runs one Lead Qualification trigger end to end. Never throws for an
 * ordinary policy/eligibility/duplicate outcome (those are normal `status:
 * "skipped"` results); a genuine infrastructure failure (claim insert,
 * context build) is returned as `status: "failed"`, never thrown past this
 * function, matching orchestrateAI's own "never throws" contract one layer
 * up.
 */
export async function dispatchLeadQualification(params: DispatchLeadQualificationParams): Promise<DispatchLeadQualificationResult> {
  const { supabase, orgId, source, leadId, contactId, inboundEvent } = params;
  const orchestrate = params.orchestrate ?? orchestrateAI;
  const actorId = params.actorId ?? `lead_qualification_${source}`;

  // Structural precedence, checked before anything else (no policy lookup,
  // no claim, no DB write): a lead created as a byproduct of a real inbound
  // message never gets its own competing lead_created run — see this
  // param's own doc comment.
  if (source === "lead_created" && params.associatedWithInboundMessage) {
    return { status: "skipped", reason: "associated_with_inbound_message" };
  }

  if (source === "inbound_lead_message") {
    if (!inboundEvent || !isLiveTriggerEligible(inboundEvent.candidate)) {
      return { status: "skipped", reason: "not_live_eligible" };
    }
  }

  // Shape-validated before anything else — an invalid/missing invocation id
  // is a caller bug, never silently coerced into some other key.
  if (source === "manual_run" && !isValidInvocationId(params.invocationId)) {
    return { status: "failed", error: "A valid invocationId is required for a manual run.", reason: "invalid_invocation_id" };
  }

  // Policy: emergency pause overrides everything (fail-safe on lookup
  // error, per resolveExecutionPolicy's own contract), then the dedicated
  // enabled gate, then per-agent autonomy/channel settings.
  const [policy, enabled] = await Promise.all([
    resolveExecutionPolicy({ supabase, orgId, agentKey: AGENT_KEY }),
    isLeadQualificationEnabled(supabase, orgId),
  ]);
  if (policy.emergencyPaused) return { status: "skipped", reason: "emergency_paused" };
  if (!enabled) return { status: "skipped", reason: "disabled" };

  // Three distinct idempotency regimes — see buildManualRunIdempotencyKey's
  // own doc comment for why manual_run cannot share lead_created's
  // permanent per-lead key.
  const idempotencyKey =
    source === "inbound_lead_message" && inboundEvent
      ? buildInboundMessageIdempotencyKey(inboundEvent.messageRowId)
      : source === "manual_run"
        ? buildManualRunIdempotencyKey(leadId, params.invocationId!)
        : buildLeadCreatedIdempotencyKey(leadId);

  let claim: Claim | null;
  try {
    claim = await claimTrigger(supabase, orgId, idempotencyKey, source, leadId, actorId);
  } catch (err: any) {
    return { status: "failed", error: err.message };
  }
  if (!claim) return { status: "skipped", reason: "duplicate" };

  try {
    const channel: AIChannel = inboundEvent?.channel ?? "internal";
    const event: AIChannelEvent = {
      eventId: inboundEvent?.externalMessageId ?? `${source}:${leadId}`,
      channel,
      eventType: source === "inbound_lead_message" ? "message_received" : "new_lead",
      externalMessageId: inboundEvent?.externalMessageId,
      content: { type: "text", text: inboundEvent?.text ?? "" },
      occurredAt: new Date().toISOString(),
    };
    const trustedContext: AITrustedContext = {
      orgId,
      actor: { actorType: "workflow", actorId, source },
      leadId,
      contactId,
      conversationKey: contactId ? `${contactId}::${channel}` : undefined,
      autonomyLevel: 2, // ceiling only — send_sms/send_whatsapp still force approval regardless (see action-registry.ts)
    };

    const result = await orchestrate({ supabase, event, trustedContext, modelProvider: params.modelProvider });

    if (result.status === "failed" || !result.responseText) {
      await finalizeClaim(supabase, claim.id, "failed", { executionId: result.executionId, error: result.error ?? "No response produced." });
      return { status: "failed", claimId: claim.id, executionId: result.executionId, error: result.error ?? "No response produced." };
    }

    if (policy.defaultAutonomyLevel < 2) {
      await finalizeClaim(supabase, claim.id, "succeeded", { executionId: result.executionId, mode: "recommendation" });
      return { status: "recommendation", claimId: claim.id, executionId: result.executionId, responseText: result.responseText };
    }

    const sendActionKey = EXECUTABLE_REPLY_CHANNELS[channel];
    if (!sendActionKey || !contactId) {
      // Level 2 requested, but this channel has no wired send action yet
      // (or there's no contact to send to) — falls back to a recommendation
      // rather than silently dropping the run or pretending to propose
      // something that can't execute.
      await finalizeClaim(supabase, claim.id, "succeeded", { executionId: result.executionId, mode: "recommendation", reason: "channel_not_supported" });
      return { status: "recommendation", claimId: claim.id, executionId: result.executionId, responseText: result.responseText };
    }

    const truncated = result.responseText.slice(0, 1600);
    const proposeResult: ExecuteStepResult = await executeStep({
      supabase,
      orgId,
      actor: { actorType: "workflow", actorId, source },
      executionId: result.executionId,
      sequence: 1,
      actionKey: sendActionKey,
      rawInput: { contactId, body: truncated },
      autonomyLevel: 2,
      trustedProposal: true,
      idempotencyKey: `lead_qualification_reply:${result.executionId}`,
      targetEntityType: "lead",
      targetEntityId: leadId,
      approvalSummary: `Lead Qualification drafted a reply to ${source === "inbound_lead_message" ? "an inbound message from" : "a new lead,"} this lead.`,
      approvalMetadata: { agentKey: AGENT_KEY, source, leadId, channel },
    });

    if (proposeResult.status === "awaiting_approval" && proposeResult.approvalRequestId) {
      await finalizeClaim(supabase, claim.id, "succeeded", { executionId: result.executionId, mode: "approval", approvalRequestId: proposeResult.approvalRequestId });
      return { status: "awaiting_approval", claimId: claim.id, executionId: result.executionId, approvalRequestId: proposeResult.approvalRequestId };
    }

    // Proposal failed/blocked (e.g. consent check) — the run still
    // produced a real recommendation; report that rather than a bare
    // failure, since the AI's own output is still valid CRM-facing
    // information even though the auto-proposed send didn't go through.
    await finalizeClaim(supabase, claim.id, "succeeded", { executionId: result.executionId, mode: "recommendation", proposeStatus: proposeResult.status });
    return { status: "recommendation", claimId: claim.id, executionId: result.executionId, responseText: result.responseText };
  } catch (err: any) {
    console.error("[lead-qualification-dispatch] dispatch failed:", err.message);
    await finalizeClaim(supabase, claim.id, "failed", { error: "Dispatch failed." }).catch(() => {});
    return { status: "failed", claimId: claim.id, error: err.message };
  }
}
