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
//
// ── AI-3J CORRECTION: DEPLOY_URL IS NOT A FUNCTION-RUNTIME VARIABLE ──────
//
// A previous pass here read `process.env.DEPLOY_URL || process.env.URL`,
// on the assumption that DEPLOY_URL identifies the CURRENT deploy at
// Netlify Function runtime. That assumption was WRONG, and was caught by
// a real Deploy Preview failure, not a doc re-read: DEPLOY_URL/
// DEPLOY_PRIME_URL are BUILD-TIME deploy metadata (available during the
// build step), not guaranteed Function-runtime environment variables.
// `process.env.DEPLOY_URL` is simply undefined inside a running Netlify
// Function, so the old code always fell through to `process.env.URL` —
// which, per Netlify's own docs, is the canonical PRODUCTION site URL,
// even when the function is running inside a Deploy Preview. The
// observed failure matched exactly: a PR's inbound-SMS webhook (running
// on `deploy-preview-15--renoconnect.netlify.app`) dispatched its
// internal background call to `URL` (production), which doesn't yet
// contain that PR's new background function — a 404.
//
// THE FIX: never rely on any Netlify deploy-identity env var for this at
// all. A REQUEST-ORIGINATED caller (a provider webhook) already knows its
// own true externally-visible origin — it's the exact URL the provider
// just called, reconstructed for signature verification (see
// ai-twilio-sms-inbound.ts's `reconstructRequestUrl()` /
// meta-whatsapp-inbound.ts's analogous need). `dispatchLeadQualification
// Background()` now accepts that origin explicitly (`opts.baseUrl`) and
// uses it when supplied, instead of any environment-variable guess. See
// that function's own doc comment for the exact validation/fallback
// rules, and ai-twilio-sms-inbound.ts for the one caller wired to supply
// it today.

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

export type DispatchLeadQualificationBackgroundOptions = {
  /**
   * AI-3J. The caller's own trusted, externally-visible request origin
   * (e.g. "https://deploy-preview-15--renoconnect.netlify.app") — when
   * supplied, this ALWAYS wins over any environment-variable fallback, so
   * the internal dispatch request stays on the exact same deployment that
   * received the original provider request (Deploy Preview -> same
   * preview, branch deploy -> same branch deploy, production ->
   * production, a custom domain -> that same domain).
   *
   * MUST come only from a value the caller itself independently verified
   * as the real request origin (e.g. reconstructRequestUrl()'s result,
   * which signature verification already depends on being correct) —
   * NEVER from user/provider-controlled form/query/body data. This
   * function does not and cannot enforce that at its own boundary; it is
   * a contract on every caller. ai-twilio-sms-inbound.ts is the one
   * caller wired to supply it as of this pass.
   *
   * Normalized via `new URL(baseUrl).origin` — a trailing slash, path, or
   * query string on the supplied value is safely discarded rather than
   * trusted literally. A malformed value (fails to parse as a URL) is
   * treated as a dispatch-time failure: logged, no fetch attempted,
   * returns false — exactly like a missing secret.
   */
  baseUrl?: string;
};

/**
 * The real, production dispatch: one `fetch()` to the background function.
 * Never throws; a false return means "not accepted" (never awaited further —
 * the caller's webhook must not know or care whether the actual AI run
 * later succeeds, fails, or is skipped by policy).
 *
 * BASE URL RESOLUTION (see AI-3J correction above for the full story):
 *   1. `opts.baseUrl`, if supplied — the caller's own verified request
 *      origin. Always wins.
 *   2. Otherwise, `process.env.URL` — Netlify's function-runtime built-in,
 *      which is the canonical PRODUCTION site URL. This is NOT
 *      Deploy-Preview-safe: a caller running inside a Deploy Preview with
 *      no `opts.baseUrl` supplied will dispatch to PRODUCTION, not to its
 *      own preview. Every caller that originates from an inbound provider
 *      request (and therefore has a real request origin available) should
 *      supply `opts.baseUrl` — see section 6 of this pass's own report for
 *      which existing callers do and don't have one readily available.
 *   3. Neither available -> fail closed, logged, no fetch attempted.
 */
export async function dispatchLeadQualificationBackground(
  payload: LeadQualificationBackgroundPayload,
  opts: DispatchLeadQualificationBackgroundOptions = {},
): Promise<boolean> {
  const secret = process.env.AI_LEAD_QUALIFICATION_INTERNAL_DISPATCH_SECRET;
  if (!secret) {
    console.error("[lead-created-hook] AI_LEAD_QUALIFICATION_INTERNAL_DISPATCH_SECRET is not set — cannot dispatch.");
    return false;
  }

  let siteUrl: string | undefined;
  if (opts.baseUrl !== undefined) {
    try {
      siteUrl = new URL(opts.baseUrl).origin;
    } catch {
      console.error("[lead-created-hook] opts.baseUrl is not a valid URL — refusing to dispatch rather than guessing.");
      return false;
    }
  } else {
    // NOT Deploy-Preview-safe — see this function's own doc comment above.
    siteUrl = process.env.URL;
  }
  if (!siteUrl) {
    console.error("[lead-created-hook] No site URL available (opts.baseUrl/URL env var) — cannot dispatch.");
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
