// netlify/functions/lib/ai/lead-created-hook.ts
//
// Live Lead Qualification — Phase AI-3C. The ONE small, reusable post-create
// hook every real server-side lead-creation path calls, instead of each
// scattering its own dispatch call and its own error handling.
//
// AI-3C HARDENING: this used to await dispatchLeadQualification() directly
// — meaning a provider webhook (Meta Lead Ads, Vapi) sat waiting on a
// policy lookup, a real model call, and a possible approval creation before
// it could return. That is not acceptable request-latency behavior for a
// provider-facing endpoint. This file now does exactly ONE fast HTTP call
// to a Netlify BACKGROUND function (lead-qualification-background.ts, same
// "-background" suffix convention as WhatsApp's own
// ai-whatsapp-orchestrate-background.ts) and returns as soon as that
// function ACCEPTS the request (HTTP 202) — never waiting for the actual
// dispatch to run. Same shape as meta-whatsapp-inbound.ts's
// dispatchWhatsAppOrchestration(): a live `fetch()`, injectable in tests via
// FireLeadCreatedOptions.dispatch so no test ever hits the network.
//
// CONTRACT: never throws, never meaningfully delays the caller. The
// caller's lead insert has ALREADY succeeded by the time this is called —
// a dispatch-request failure here (missing secret, network error, non-202
// response) is logged and swallowed, never surfaced to the caller.
//
// WHO SHOULD CALL THIS (see this phase's own audit report for the full
// source-by-source table):
//   - lib/meta-lead-ads.ts        — a real Meta Lead Ads form submission
//   - lib/google-ads-lead-ingestion.ts — a real (non-synthetic) Google Ads lead
//   - vapi-webhook.ts's upsertLead — a real completed voice call's new lead
//   - lib/meta-instagram-crm.ts / lib/meta-messenger-crm.ts's first-contact
//     lead creation — WITH associatedWithInboundMessage:true (see
//     dispatchLeadQualification's own param doc)
//
// WHO SHOULD NOT (documented, not merely omitted):
//   - src/lib/leads-store.ts (manual Leads-page creation) — client-side; a
//     human is already present and can use the existing explicit "Run Lead
//     Qualification" action.
//   - any bulk import / backfill / seed / demo path.
//   - google-ads-lead-test-inject.ts's synthetic submissions — see
//     google-ads-lead-ingestion.ts's isSyntheticGoogleAdsSubmission().
//   - gmail-contact-actions.ts's "Create Lead" — email is out of live-agent
//     scope this phase.

import type { LeadQualificationBackgroundPayload } from "./lead-qualification-background";

export type FireLeadCreatedOptions = {
  contactId?: string;
  /** See dispatchLeadQualification's own param doc — true when this lead
   * was created as a direct byproduct of a real inbound customer message. */
  associatedWithInboundMessage?: boolean;
  actorId?: string;
  /** Test seam only — defaults to the real HTTP dispatch. Never let the
   * default run in a test; inject a fake that never touches the network. */
  dispatch?: (payload: LeadQualificationBackgroundPayload) => Promise<boolean>;
};

/**
 * The real, production dispatch: one `fetch()` to the background function.
 * Never throws; a false return means "not accepted" (never awaited further —
 * the caller's webhook must not know or care whether the actual AI run
 * later succeeds, fails, or is skipped by policy).
 */
export async function dispatchLeadQualificationBackground(payload: LeadQualificationBackgroundPayload): Promise<boolean> {
  const secret = process.env.AI_LEAD_QUALIFICATION_INTERNAL_DISPATCH_SECRET;
  if (!secret) {
    console.error("[lead-created-hook] AI_LEAD_QUALIFICATION_INTERNAL_DISPATCH_SECRET is not set — cannot dispatch.");
    return false;
  }
  // Deploy-preview safety: on Netlify, `URL` is always the canonical
  // PRODUCTION site URL, while `DEPLOY_URL` is the current deploy's own
  // unique URL. `DEPLOY_URL` must take precedence — otherwise a Deploy
  // Preview or branch deploy's lead-created event would dispatch its Lead
  // Qualification background work to PRODUCTION instead of staying on the
  // same deployment that triggered it, silently crossing a deployment
  // boundary and making preview validation misleading (and, worse, running
  // real AI/SMS/WhatsApp side effects against production data from a
  // preview test). Fallback order once DEPLOY_URL is preferred:
  //   - Deploy Preview / branch deploy -> DEPLOY_URL (its own deployment)
  //   - production, when DEPLOY_URL is unavailable -> URL
  //   - neither present -> fail closed, exactly as before
  const siteUrl = process.env.DEPLOY_URL || process.env.URL;
  if (!siteUrl) {
    console.error("[lead-created-hook] No site URL available (URL/DEPLOY_URL env var) — cannot dispatch.");
    return false;
  }
  try {
    const res = await fetch(`${siteUrl}/.netlify/functions/lead-qualification-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Secret": secret },
      body: JSON.stringify(payload),
    });
    if (res.status !== 202 && res.status !== 200) {
      console.error("[lead-created-hook] background dispatch did not return 202:", res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[lead-created-hook] background dispatch failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

export async function fireLeadCreatedTrigger(orgId: string, leadId: string, opts: FireLeadCreatedOptions = {}): Promise<void> {
  const dispatch = opts.dispatch ?? dispatchLeadQualificationBackground;
  try {
    await dispatch({
      orgId,
      leadId,
      contactId: opts.contactId,
      associatedWithInboundMessage: opts.associatedWithInboundMessage,
      actorId: opts.actorId,
    });
  } catch (err) {
    // The lead itself is already safely persisted by the time this runs —
    // a dispatch-request failure is never the caller's problem.
    console.error("[lead-created-hook] best-effort dispatch request failed:", err instanceof Error ? err.message : err);
  }
}
