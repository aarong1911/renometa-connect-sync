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
import { dispatchLeadQualification, type DispatchLeadQualificationResult } from "./lead-qualification-dispatch";
import type { orchestrateAI } from "./orchestrator";

export type LeadQualificationBackgroundPayload = {
  orgId: string;
  leadId: string;
  contactId?: string;
  associatedWithInboundMessage?: boolean;
  actorId?: string;
};

export function isValidLeadQualificationBackgroundPayload(value: unknown): value is LeadQualificationBackgroundPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.orgId !== "string" || !v.orgId) return false;
  if (typeof v.leadId !== "string" || !v.leadId) return false;
  if (v.contactId !== undefined && typeof v.contactId !== "string") return false;
  if (v.associatedWithInboundMessage !== undefined && typeof v.associatedWithInboundMessage !== "boolean") return false;
  if (v.actorId !== undefined && typeof v.actorId !== "string") return false;
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
    source: "lead_created",
    leadId,
    contactId,
    associatedWithInboundMessage: payload.associatedWithInboundMessage,
    actorId: payload.actorId,
    orchestrate: deps.orchestrate,
  });

  console.log("[lead-qualification-background] dispatch result:", { orgId, leadId, status: result.status });
  return { statusCode: 200, revalidated: true, dispatch: result };
}
