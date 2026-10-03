// netlify/functions/lib/ai/lead-qualification-background.ts
//
// Live Lead Qualification — Phase AI-3C. The durable BACKGROUND path for
// `lead_created`, mirroring exactly the pattern
// meta-whatsapp-background.ts / ai-whatsapp-orchestrate-background.ts
// already established for WhatsApp: a thin Netlify handler
// (netlify/functions/lead-qualification-background.ts) does only
// internal-secret verification + payload shape validation; this file is the
// injectable, unit-testable core.
//
// WHY THIS EXISTS: a provider-facing webhook (Meta Lead Ads, Vapi) must
// return promptly — it cannot wait on a policy lookup, a model call, and a
// possible approval creation. Before this pass, lib/ai/lead-created-hook.ts
// awaited dispatchLeadQualification() directly, inline in the webhook's own
// request/response cycle. Now it only makes ONE fast HTTP call to this
// background function (see lead-created-hook.ts's own header) and returns —
// the actual policy/context/model/approval work happens here, in a
// function Netlify gives up to 15 minutes to run, entirely decoupled from
// the provider's own request.
//
// TRUST BOUNDARY: reachable at a public URL like any Netlify function, so
// the handler requires a shared secret (X-Internal-Secret, timing-safe
// compare) — see the real handler file. orgId/leadId in the payload are
// UNTRUSTED on arrival here (same status as any webhook-originated value)
// and are independently RE-VERIFIED against the database below before any
// AI work runs — never assumed correct just because they came from our own
// webhook.
//
// IDEMPOTENCY: unchanged from before this pass. dispatchLeadQualification()
// still claims the SAME deterministic buildLeadCreatedIdempotencyKey(leadId)
// via agent_executions' existing unique (org_id, idempotency_key)
// constraint — a provider retry simply triggers this background function
// again with the same payload, and the claim converges to exactly one run,
// with or without background dispatch. This file adds no new idempotency
// mechanism; it only moves WHERE the existing one runs.

import type { SupabaseClient } from "@supabase/supabase-js";
import { dispatchLeadQualification, type DispatchLeadQualificationResult, type LeadQualificationTriggerSource } from "./lead-qualification-dispatch";
import type { orchestrateAI } from "./orchestrator";
import { LIVE_TRIGGER_CHANNELS, type InboundTriggerCandidate } from "./lead-trigger";
import type { AIChannel } from "./types";

/** AI-3I addition (live inbound-SMS Lead Qualification). The SAME shape
 * DispatchLeadQualificationParams.inboundEvent already defines in
 * lead-qualification-dispatch.ts — mirrored here field-for-field (not
 * imported as a re-export, since that file's param type isn't exported
 * standalone) rather than introducing a second, divergent shape. */
export type LeadQualificationBackgroundInboundEvent = {
  channel: AIChannel;
  messageRowId: string;
  text: string;
  externalMessageId?: string;
  candidate: InboundTriggerCandidate;
};

export type LeadQualificationBackgroundPayload = {
  orgId: string;
  leadId: string;
  contactId?: string;
  associatedWithInboundMessage?: boolean;
  actorId?: string;
  /** AI-3I addition. Defaults to "lead_created" when omitted — every
   * existing caller (lead-created-hook.ts's fireLeadCreatedTrigger, used by
   * Meta Lead Ads/Google Ads/Vapi/Instagram/Messenger) never sets this and
   * is completely unaffected by its addition. Only a caller that explicitly
   * sets `source: "inbound_lead_message"` (ai-twilio-sms-inbound.ts) needs
   * `inboundEvent` populated too — see below. */
  source?: LeadQualificationTriggerSource;
  /** AI-3I addition. REQUIRED when source is "inbound_lead_message";
   * ignored (and must be absent) otherwise. Passed straight through to
   * dispatchLeadQualification()'s own `inboundEvent` param — no new
   * eligibility/candidate logic is introduced here; the EXISTING
   * isLiveTriggerEligible() gate inside lead-qualification-dispatch.ts
   * still applies unchanged. */
  inboundEvent?: LeadQualificationBackgroundInboundEvent;
};

function isValidInboundTriggerCandidate(value: unknown): value is InboundTriggerCandidate {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.channel !== "string" || !(LIVE_TRIGGER_CHANNELS as ReadonlySet<string>).has(v.channel)) return false;
  if (v.direction !== "in" && v.direction !== "out") return false;
  if (v.authoredByBusiness !== undefined && typeof v.authoredByBusiness !== "boolean") return false;
  if (v.syncOrigin !== "live" && v.syncOrigin !== "backfill" && v.syncOrigin !== undefined) return false;
  return true;
}

function isValidInboundEvent(value: unknown): value is LeadQualificationBackgroundInboundEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.channel !== "string") return false;
  if (typeof v.messageRowId !== "string" || !v.messageRowId) return false;
  if (typeof v.text !== "string") return false;
  if (v.externalMessageId !== undefined && typeof v.externalMessageId !== "string") return false;
  if (!isValidInboundTriggerCandidate(v.candidate)) return false;
  return true;
}

export function isValidLeadQualificationBackgroundPayload(value: unknown): value is LeadQualificationBackgroundPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.orgId !== "string" || !v.orgId) return false;
  if (typeof v.leadId !== "string" || !v.leadId) return false;
  if (v.contactId !== undefined && typeof v.contactId !== "string") return false;
  if (v.associatedWithInboundMessage !== undefined && typeof v.associatedWithInboundMessage !== "boolean") return false;
  if (v.actorId !== undefined && typeof v.actorId !== "string") return false;
  if (v.source !== undefined && v.source !== "lead_created" && v.source !== "inbound_lead_message" && v.source !== "manual_run") return false;
  // inbound_lead_message REQUIRES a well-shaped inboundEvent — a malformed
  // or missing one for this source is rejected here (400), never silently
  // downgraded to a lead_created-shaped dispatch. Every other source must
  // NOT carry one (keeps the two shapes from being accidentally mixed).
  if (v.source === "inbound_lead_message") {
    if (!isValidInboundEvent(v.inboundEvent)) return false;
  } else if (v.inboundEvent !== undefined) {
    return false;
  }
  return true;
}

export type ProcessLeadQualificationBackgroundDeps = {
  supabase: SupabaseClient;
  /** Injected for testability — defaults to the real orchestrateAI. */
  orchestrate?: typeof orchestrateAI;
};

export type ProcessLeadQualificationBackgroundResult = {
  /** What the Netlify background-function handler returns — the handler is the only thing that cares. */
  statusCode: number;
  /** For tests/observability only. */
  revalidated: boolean;
  dispatch?: DispatchLeadQualificationResult;
};

/**
 * Re-verifies orgId/leadId server-side (defense in depth — same reasoning
 * as meta-whatsapp-background.ts's contactBelongsToOrg), then runs the SAME
 * dispatchLeadQualification() core every other lead_created path uses — no
 * second dispatcher implementation.
 */
export async function processLeadQualificationBackground(
  payload: LeadQualificationBackgroundPayload,
  deps: ProcessLeadQualificationBackgroundDeps,
): Promise<ProcessLeadQualificationBackgroundResult> {
  const { supabase } = deps;
  const { orgId, leadId } = payload;

  const { data: lead, error } = await supabase.from("leads").select("id, contact_id").eq("id", leadId).eq("org_id", orgId).maybeSingle();
  if (error) {
    console.error("[lead-qualification-background] lead revalidation query failed:", error.message);
    return { statusCode: 200, revalidated: false };
  }
  if (!lead) {
    console.error("[lead-qualification-background] leadId does not belong to orgId — dropping.", { orgId, leadId });
    return { statusCode: 200, revalidated: false };
  }

  const contactId = payload.contactId ?? lead.contact_id ?? undefined;
  const result = await dispatchLeadQualification({
    supabase,
    orgId,
    // AI-3I: defaults to "lead_created" — unchanged for every existing
    // caller, which never sets payload.source at all.
    source: payload.source ?? "lead_created",
    leadId,
    contactId,
    inboundEvent: payload.inboundEvent,
    associatedWithInboundMessage: payload.associatedWithInboundMessage,
    actorId: payload.actorId,
    orchestrate: deps.orchestrate,
  });

  console.log("[lead-qualification-background] dispatch result:", { orgId, leadId, status: result.status });
  return { statusCode: 200, revalidated: true, dispatch: result };
}
