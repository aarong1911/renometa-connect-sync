// src/lib/google-ads-client.ts
//
// Frontend fetch layer for the read-only Google Ads reporting endpoints —
// currently just campaign-performance, used by the Marketing → Google Ads
// tab (src/routes/marketing.tsx). Same bearer-session pattern already used
// throughout Settings → Integrations (see settings.integrations.tsx /
// integration-config-drawer.tsx) — never a new auth mechanism.
//
// Deliberately separate from marketing-campaign-client.ts (CRM Email/SMS
// campaigns) — Google Ads reporting and CRM campaigns are conceptually and
// visually distinct surfaces that must never share a data/action layer.

import { supabase } from "@/lib/supabase";
import type {
  GoogleAdsCampaignPerformanceResponse,
  GoogleAdsLeadSyncStatusResponse,
  GoogleAdsLeadSyncResultResponse,
  GoogleAdsTestLeadInjectInput,
  GoogleAdsTestLeadInjectResponse,
  GoogleAdsConversionStatusResponse,
  GoogleAdsConversionEventCreateInput,
  GoogleAdsConversionEventCreateResponse,
  GoogleAdsConversionEventTestCreateInput,
  GoogleAdsConversionActionsResponse,
  GoogleAdsConversionMappingsListResponse,
  GoogleAdsConversionMappingSaveInput,
  GoogleAdsConversionMappingSaveResponse,
  GoogleAdsConversionEventsListResponse,
  GoogleAdsConversionExportResponse,
  GoogleAdsCampaignCrmOutcomesResponse,
  GoogleAdsCampaignLeadIdsResponse,
  GoogleAdsCampaignAdGroupsResponse,
  GoogleAdsAdGroupKeywordsResponse,
  GoogleAdsAdGroupSearchTermsResponse,
  GoogleAdsAdGroupCrmOutcomesResponse,
  GoogleAdsAdGroupLeadIdsResponse,
} from "@/lib/google-ads-format";

// Discriminated result — the UI branches on `kind` to show the right
// state (connect / select account / retry sync / reconnect / generic
// error) rather than a single opaque "failed" boolean. `errorCode` (when
// present) is always one of the endpoint's own safe internal codes, never
// a raw provider message.
export type GoogleAdsCampaignPerformanceResult =
  | { ok: true; data: GoogleAdsCampaignPerformanceResponse }
  | { ok: false; kind: "unauthorized" }
  | { ok: false; kind: "not_connected" }
  | { ok: false; kind: "account_selection_required" }
  | { ok: false; kind: "account_sync_required" }
  | { ok: false; kind: "reconnect_required" }
  | { ok: false; kind: "provider_error"; errorCode: string | null }
  | { ok: false; kind: "network_error" };

export async function fetchGoogleAdsCampaignPerformance(): Promise<GoogleAdsCampaignPerformanceResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, kind: "unauthorized" };

  let res: Response;
  try {
    res = await fetch("/.netlify/functions/google-ads-campaign-performance", {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
  } catch {
    return { ok: false, kind: "network_error" };
  }

  const json = await res.json().catch(() => ({}));

  if (res.ok && json?.connected === true) {
    return { ok: true, data: json as GoogleAdsCampaignPerformanceResponse };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, kind: "unauthorized" };
  }

  const errorCode: string | null = typeof json?.error === "string" ? json.error : null;
  switch (errorCode) {
    case "google_ads_not_connected":
      return { ok: false, kind: "not_connected" };
    case "account_selection_required":
      return { ok: false, kind: "account_selection_required" };
    case "account_sync_required":
      return { ok: false, kind: "account_sync_required" };
    case "reconnect_required":
      return { ok: false, kind: "reconnect_required" };
    default:
      return { ok: false, kind: "provider_error", errorCode };
  }
}

// ── Lead-form ingestion ───────────────────────────────────────────────

export type GoogleAdsLeadSyncStatusResult =
  | { ok: true; data: GoogleAdsLeadSyncStatusResponse }
  | { ok: false };

export async function fetchGoogleAdsLeadSyncStatus(): Promise<GoogleAdsLeadSyncStatusResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false };
  try {
    const res = await fetch("/.netlify/functions/google-ads-lead-sync-status", {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (!res.ok) return { ok: false };
    const json = await res.json().catch(() => null);
    if (!json) return { ok: false };
    return { ok: true, data: json as GoogleAdsLeadSyncStatusResponse };
  } catch {
    return { ok: false };
  }
}

// Same discriminated-`kind` shape as fetchGoogleAdsCampaignPerformance —
// deliberately not shared as one generic type, since the two endpoints'
// success payloads are unrelated (campaign metrics vs. a sync-run
// summary) and forcing a shared wrapper would make call sites less clear
// about which endpoint they're actually reading.
export type GoogleAdsLeadSyncTriggerResult =
  | { ok: true; data: GoogleAdsLeadSyncResultResponse }
  | { ok: false; kind: "unauthorized" }
  | { ok: false; kind: "not_connected" }
  | { ok: false; kind: "account_selection_required" }
  | { ok: false; kind: "account_sync_required" }
  | { ok: false; kind: "reconnect_required" }
  | { ok: false; kind: "provider_error"; errorCode: string | null }
  | { ok: false; kind: "network_error" };

// ── Dev-only test harness (Phase 3, Step 6C.1) ────────────────────────
// Calls the dev-only google-ads-lead-test-inject.ts endpoint, which
// refuses to run outside a real local `netlify dev` session regardless of
// what calls it. This client function has no environment guard of its
// own — the backend guard is the actual protection; a 404 here just means
// "not available in this environment" and is handled as a normal result,
// not a crash.
export type GoogleAdsTestLeadInjectResult =
  | { ok: true; data: GoogleAdsTestLeadInjectResponse }
  | { ok: false; kind: "unauthorized" }
  | { ok: false; kind: "not_available" }
  | { ok: false; kind: "provider_error"; message?: string }
  | { ok: false; kind: "network_error" };

export async function injectGoogleAdsTestLead(input: GoogleAdsTestLeadInjectInput): Promise<GoogleAdsTestLeadInjectResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, kind: "unauthorized" };

  let res: Response;
  try {
    res = await fetch("/.netlify/functions/google-ads-lead-test-inject", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(input),
    });
  } catch {
    return { ok: false, kind: "network_error" };
  }

  if (res.status === 404) {
    return { ok: false, kind: "not_available" };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, kind: "unauthorized" };
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, kind: "provider_error", message: typeof json?.error === "string" ? json.error : undefined };
  }
  return { ok: true, data: json as GoogleAdsTestLeadInjectResponse };
}

export async function triggerGoogleAdsLeadSync(): Promise<GoogleAdsLeadSyncTriggerResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, kind: "unauthorized" };

  let res: Response;
  try {
    res = await fetch("/.netlify/functions/google-ads-lead-sync", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
  } catch {
    return { ok: false, kind: "network_error" };
  }

  const json = await res.json().catch(() => ({}));

  if (res.ok && json?.connected === true) {
    return { ok: true, data: json as GoogleAdsLeadSyncResultResponse };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, kind: "unauthorized" };
  }

  const errorCode: string | null = typeof json?.error === "string" ? json.error : null;
  switch (errorCode) {
    case "google_ads_not_connected":
      return { ok: false, kind: "not_connected" };
    case "account_selection_required":
      return { ok: false, kind: "account_selection_required" };
    case "account_sync_required":
      return { ok: false, kind: "account_sync_required" };
    case "reconnect_required":
      return { ok: false, kind: "reconnect_required" };
    default:
      return { ok: false, kind: "provider_error", errorCode };
  }
}

// ── Conversion attribution foundation (Phase 3, Step 7A) ────────────────
// No Google Ads API call happens from either of these — both only read/
// write netlify functions backed by google_ads_conversion_events /
// google_ads_conversion_mappings (local queue only, see
// lib/google-ads-conversion-events.ts on the backend).

export type GoogleAdsConversionStatusResult =
  | { ok: true; data: GoogleAdsConversionStatusResponse }
  | { ok: false };

export async function fetchGoogleAdsConversionStatus(): Promise<GoogleAdsConversionStatusResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false };
  try {
    const res = await fetch("/.netlify/functions/google-ads-conversion-status", {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (!res.ok) return { ok: false };
    const json = await res.json().catch(() => null);
    if (!json?.ok) return { ok: false };
    return { ok: true, data: json as GoogleAdsConversionStatusResponse };
  } catch {
    return { ok: false };
  }
}

// Hardened PRODUCTION trigger (Step 7A.1) — the endpoint now validates
// real CRM milestone state (leads.status === 'qualified' / a real linked
// appointment / deals.status === 'won') server-side before creating
// anything; `kind: "milestone_rejected"` carries back the endpoint's own
// safe error code (lead_not_qualified, appointment_lead_mismatch,
// deal_not_won, etc. — see MILESTONE_REJECTION_STATUS in the endpoint)
// rather than a generic failure. Not wired into any automatic CRM hook;
// only ever called explicitly (e.g. a future manual "mark as qualified"
// action). Never used for synthetic dev fixtures — see
// createGoogleAdsConversionEventTest below for that.
export type GoogleAdsConversionEventCreateResult =
  | { ok: true; data: GoogleAdsConversionEventCreateResponse }
  | { ok: false; kind: "unauthorized" }
  | { ok: false; kind: "milestone_rejected"; reason: string }
  | { ok: false; kind: "google_ads_attribution_not_found" }
  | { ok: false; kind: "provider_error"; message?: string }
  | { ok: false; kind: "network_error" };

const MILESTONE_REJECTION_REASONS = new Set([
  "lead_not_found", "lead_not_qualified",
  "appointment_not_found", "appointment_lead_mismatch",
  "deal_not_found", "deal_not_won", "deal_lead_mismatch",
]);

export async function createGoogleAdsConversionEvent(
  input: GoogleAdsConversionEventCreateInput,
): Promise<GoogleAdsConversionEventCreateResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, kind: "unauthorized" };

  let res: Response;
  try {
    res = await fetch("/.netlify/functions/google-ads-conversion-event-create", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(input),
    });
  } catch {
    return { ok: false, kind: "network_error" };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, kind: "unauthorized" };
  }

  const json = await res.json().catch(() => ({}));
  const errorCode: string | null = typeof json?.error === "string" ? json.error : null;

  if (!res.ok || !json?.ok) {
    if (errorCode && MILESTONE_REJECTION_REASONS.has(errorCode)) {
      return { ok: false, kind: "milestone_rejected", reason: errorCode };
    }
    if (errorCode === "google_ads_attribution_not_found") {
      return { ok: false, kind: "google_ads_attribution_not_found" };
    }
    return { ok: false, kind: "provider_error", message: errorCode ?? undefined };
  }
  return { ok: true, data: json as GoogleAdsConversionEventCreateResponse };
}

// ── Dev-only test harness (Phase 3, Step 7A.1) ───────────────────────────
// Calls the dev-only google-ads-conversion-event-test-create.ts endpoint,
// which refuses to run outside a real local `netlify dev` session
// regardless of what calls it — same "no environment guard on the client,
// the backend endpoint is the actual boundary" pattern as
// injectGoogleAdsTestLead. Unlike createGoogleAdsConversionEvent above,
// this accepts eventAt/conversionValue/currencyCode directly, since it
// exists specifically to exercise synthetic leads that have no real CRM
// milestone to derive those fields from.
export type GoogleAdsConversionEventTestCreateResult =
  | { ok: true; data: GoogleAdsConversionEventCreateResponse }
  | { ok: false; kind: "unauthorized" }
  | { ok: false; kind: "not_available" }
  | { ok: false; kind: "no_provider_attribution" }
  | { ok: false; kind: "provider_error"; message?: string }
  | { ok: false; kind: "network_error" };

export async function createGoogleAdsConversionEventTest(
  input: GoogleAdsConversionEventTestCreateInput,
): Promise<GoogleAdsConversionEventTestCreateResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, kind: "unauthorized" };

  let res: Response;
  try {
    res = await fetch("/.netlify/functions/google-ads-conversion-event-test-create", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(input),
    });
  } catch {
    return { ok: false, kind: "network_error" };
  }

  if (res.status === 404) {
    return { ok: false, kind: "not_available" };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, kind: "unauthorized" };
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.ok) {
    if (json?.error === "no_provider_attribution") {
      return { ok: false, kind: "no_provider_attribution" };
    }
    return { ok: false, kind: "provider_error", message: typeof json?.error === "string" ? json.error : undefined };
  }
  return { ok: true, data: json as GoogleAdsConversionEventCreateResponse };
}

// ── Conversion-action discovery + mapping (Phase 3, Step 7B.1) ──────────
// Same discriminated-`kind` shape as fetchGoogleAdsCampaignPerformance —
// discovery/mapping only, no field returned by any of these three
// functions is ever used to trigger a Google Ads conversion upload call.

export type GoogleAdsConversionActionsResult =
  | { ok: true; data: GoogleAdsConversionActionsResponse }
  | { ok: false; kind: "unauthorized" }
  | { ok: false; kind: "not_connected" }
  | { ok: false; kind: "account_selection_required" }
  | { ok: false; kind: "account_sync_required" }
  | { ok: false; kind: "reconnect_required" }
  | { ok: false; kind: "provider_error"; errorCode: string | null }
  | { ok: false; kind: "network_error" };

function mapGoogleAdsConnectionErrorCode(errorCode: string | null): GoogleAdsConversionActionsResult {
  switch (errorCode) {
    case "google_ads_not_connected":
      return { ok: false, kind: "not_connected" };
    case "account_selection_required":
      return { ok: false, kind: "account_selection_required" };
    case "account_sync_required":
      return { ok: false, kind: "account_sync_required" };
    case "reconnect_required":
      return { ok: false, kind: "reconnect_required" };
    default:
      return { ok: false, kind: "provider_error", errorCode };
  }
}

export async function fetchGoogleAdsConversionActions(): Promise<GoogleAdsConversionActionsResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, kind: "unauthorized" };

  let res: Response;
  try {
    res = await fetch("/.netlify/functions/google-ads-conversion-actions", {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
  } catch {
    return { ok: false, kind: "network_error" };
  }

  const json = await res.json().catch(() => ({}));

  if (res.ok && json?.connected === true) {
    return { ok: true, data: json as GoogleAdsConversionActionsResponse };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, kind: "unauthorized" };
  }

  const errorCode: string | null = typeof json?.error === "string" ? json.error : null;
  return mapGoogleAdsConnectionErrorCode(errorCode);
}

export type GoogleAdsConversionMappingsListResult =
  | { ok: true; data: GoogleAdsConversionMappingsListResponse }
  | { ok: false; kind: "unauthorized" }
  | { ok: false; kind: "not_connected" }
  | { ok: false; kind: "account_selection_required" }
  | { ok: false; kind: "account_sync_required" }
  | { ok: false; kind: "reconnect_required" }
  | { ok: false; kind: "provider_error"; errorCode: string | null }
  | { ok: false; kind: "network_error" };

export async function fetchGoogleAdsConversionMappings(): Promise<GoogleAdsConversionMappingsListResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, kind: "unauthorized" };

  let res: Response;
  try {
    res = await fetch("/.netlify/functions/google-ads-conversion-mappings-list", {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
  } catch {
    return { ok: false, kind: "network_error" };
  }

  const json = await res.json().catch(() => ({}));

  if (res.ok && Array.isArray(json?.mappings)) {
    return { ok: true, data: json as GoogleAdsConversionMappingsListResponse };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, kind: "unauthorized" };
  }

  const errorCode: string | null = typeof json?.error === "string" ? json.error : null;
  return mapGoogleAdsConnectionErrorCode(errorCode) as GoogleAdsConversionMappingsListResult;
}

export type GoogleAdsConversionMappingSaveResult =
  | { ok: true; data: GoogleAdsConversionMappingSaveResponse }
  | { ok: false; kind: "unauthorized" }
  | { ok: false; kind: "conversion_action_not_found" }
  | { ok: false; kind: "not_connected" }
  | { ok: false; kind: "account_selection_required" }
  | { ok: false; kind: "account_sync_required" }
  | { ok: false; kind: "reconnect_required" }
  | { ok: false; kind: "provider_error"; errorCode: string | null }
  | { ok: false; kind: "network_error" };

export async function saveGoogleAdsConversionMapping(
  input: GoogleAdsConversionMappingSaveInput,
): Promise<GoogleAdsConversionMappingSaveResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, kind: "unauthorized" };

  let res: Response;
  try {
    res = await fetch("/.netlify/functions/google-ads-conversion-mapping-save", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(input),
    });
  } catch {
    return { ok: false, kind: "network_error" };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, kind: "unauthorized" };
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.ok) {
    const errorCode: string | null = typeof json?.error === "string" ? json.error : null;
    if (errorCode === "conversion_action_not_found") {
      return { ok: false, kind: "conversion_action_not_found" };
    }
    return mapGoogleAdsConnectionErrorCode(errorCode) as GoogleAdsConversionMappingSaveResult;
  }
  return { ok: true, data: json as GoogleAdsConversionMappingSaveResponse };
}

// ── Campaign CRM outcomes (Google Ads product phase) ────────────────────
// Read-only — never calls a Google Ads API, never touches conversion
// export/upload logic. campaignId/campaignName are the only inputs; org
// and selected customer are always resolved server-side.

export type GoogleAdsCampaignCrmOutcomesResult =
  | { ok: true; data: GoogleAdsCampaignCrmOutcomesResponse }
  | { ok: false; kind: "unauthorized" }
  | { ok: false; kind: "not_connected" }
  | { ok: false; kind: "account_selection_required" }
  | { ok: false; kind: "account_sync_required" }
  | { ok: false; kind: "reconnect_required" }
  | { ok: false; kind: "provider_error"; errorCode: string | null }
  | { ok: false; kind: "network_error" };

export async function fetchGoogleAdsCampaignCrmOutcomes(input: {
  campaignId?: string | null;
  campaignName?: string | null;
}): Promise<GoogleAdsCampaignCrmOutcomesResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, kind: "unauthorized" };

  let res: Response;
  try {
    res = await fetch("/.netlify/functions/google-ads-campaign-crm-outcomes", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(input),
    });
  } catch {
    return { ok: false, kind: "network_error" };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, kind: "unauthorized" };
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errorCode: string | null = typeof json?.error === "string" ? json.error : null;
    return mapGoogleAdsConnectionErrorCode(errorCode) as GoogleAdsCampaignCrmOutcomesResult;
  }
  return { ok: true, data: json as GoogleAdsCampaignCrmOutcomesResponse };
}

// ── Campaign -> CRM Leads Deep Link (Google Ads product phase) ──────────
// Resolves the exact lead_id set attributed to one campaign, for the
// Leads page's campaign-context filter chip. Read-only, same auth/error
// pattern as fetchGoogleAdsCampaignCrmOutcomes above.

export type GoogleAdsCampaignLeadIdsResult =
  | { ok: true; data: GoogleAdsCampaignLeadIdsResponse }
  | { ok: false; kind: "unauthorized" }
  | { ok: false; kind: "not_connected" }
  | { ok: false; kind: "account_selection_required" }
  | { ok: false; kind: "account_sync_required" }
  | { ok: false; kind: "reconnect_required" }
  | { ok: false; kind: "provider_error"; errorCode: string | null }
  | { ok: false; kind: "network_error" };

export async function fetchGoogleAdsCampaignLeadIds(input: {
  campaignId?: string | null;
  campaignName?: string | null;
}): Promise<GoogleAdsCampaignLeadIdsResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, kind: "unauthorized" };

  let res: Response;
  try {
    res = await fetch("/.netlify/functions/google-ads-campaign-leads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(input),
    });
  } catch {
    return { ok: false, kind: "network_error" };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, kind: "unauthorized" };
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errorCode: string | null = typeof json?.error === "string" ? json.error : null;
    return mapGoogleAdsConnectionErrorCode(errorCode) as GoogleAdsCampaignLeadIdsResult;
  }
  return { ok: true, data: json as GoogleAdsCampaignLeadIdsResponse };
}

// ── Ad Group -> CRM Leads Deep Link (Google Ads product phase) ──────────
// Same pattern as fetchGoogleAdsCampaignLeadIds above, one level deeper.

export type GoogleAdsAdGroupLeadIdsResult =
  | { ok: true; data: GoogleAdsAdGroupLeadIdsResponse }
  | { ok: false; kind: "unauthorized" }
  | { ok: false; kind: "not_connected" }
  | { ok: false; kind: "account_selection_required" }
  | { ok: false; kind: "account_sync_required" }
  | { ok: false; kind: "reconnect_required" }
  | { ok: false; kind: "provider_error"; errorCode: string | null }
  | { ok: false; kind: "network_error" };

export async function fetchGoogleAdsAdGroupLeadIds(input: { campaignId: string; adGroupId: string }): Promise<GoogleAdsAdGroupLeadIdsResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, kind: "unauthorized" };

  let res: Response;
  try {
    res = await fetch("/.netlify/functions/google-ads-ad-group-leads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(input),
    });
  } catch {
    return { ok: false, kind: "network_error" };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, kind: "unauthorized" };
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errorCode: string | null = typeof json?.error === "string" ? json.error : null;
    return mapGoogleAdsConnectionErrorCode(errorCode) as GoogleAdsAdGroupLeadIdsResult;
  }
  return { ok: true, data: json as GoogleAdsAdGroupLeadIdsResponse };
}

// ── Campaign -> Ad Groups -> Keywords/Search Terms drill-down (Google Ads
// product phase) ─────────────────────────────────────────────────────────
// Same read-only auth/error pattern as every fetch function above — never
// calls Google directly from React; each of these just tells the trusted
// server-side endpoint which already-authenticated org's campaign/ad group
// to read, and the endpoint resolves customer/token/GAQL itself.

export type GoogleAdsCampaignAdGroupsResult =
  | { ok: true; data: GoogleAdsCampaignAdGroupsResponse }
  | { ok: false; kind: "unauthorized" }
  | { ok: false; kind: "not_connected" }
  | { ok: false; kind: "account_selection_required" }
  | { ok: false; kind: "account_sync_required" }
  | { ok: false; kind: "reconnect_required" }
  | { ok: false; kind: "provider_error"; errorCode: string | null }
  | { ok: false; kind: "network_error" };

export async function fetchGoogleAdsCampaignAdGroups(input: { campaignId: string }): Promise<GoogleAdsCampaignAdGroupsResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, kind: "unauthorized" };

  let res: Response;
  try {
    res = await fetch("/.netlify/functions/google-ads-campaign-ad-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(input),
    });
  } catch {
    return { ok: false, kind: "network_error" };
  }

  if (res.status === 401 || res.status === 403) return { ok: false, kind: "unauthorized" };

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errorCode: string | null = typeof json?.error === "string" ? json.error : null;
    return mapGoogleAdsConnectionErrorCode(errorCode) as GoogleAdsCampaignAdGroupsResult;
  }
  return { ok: true, data: json as GoogleAdsCampaignAdGroupsResponse };
}

export type GoogleAdsAdGroupKeywordsResult =
  | { ok: true; data: GoogleAdsAdGroupKeywordsResponse }
  | { ok: false; kind: "unauthorized" }
  | { ok: false; kind: "not_connected" }
  | { ok: false; kind: "account_selection_required" }
  | { ok: false; kind: "account_sync_required" }
  | { ok: false; kind: "reconnect_required" }
  | { ok: false; kind: "provider_error"; errorCode: string | null }
  | { ok: false; kind: "network_error" };

export async function fetchGoogleAdsAdGroupKeywords(input: { campaignId: string; adGroupId: string }): Promise<GoogleAdsAdGroupKeywordsResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, kind: "unauthorized" };

  let res: Response;
  try {
    res = await fetch("/.netlify/functions/google-ads-ad-group-keywords", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(input),
    });
  } catch {
    return { ok: false, kind: "network_error" };
  }

  if (res.status === 401 || res.status === 403) return { ok: false, kind: "unauthorized" };

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errorCode: string | null = typeof json?.error === "string" ? json.error : null;
    return mapGoogleAdsConnectionErrorCode(errorCode) as GoogleAdsAdGroupKeywordsResult;
  }
  return { ok: true, data: json as GoogleAdsAdGroupKeywordsResponse };
}

export type GoogleAdsAdGroupSearchTermsResult =
  | { ok: true; data: GoogleAdsAdGroupSearchTermsResponse }
  | { ok: false; kind: "unauthorized" }
  | { ok: false; kind: "not_connected" }
  | { ok: false; kind: "account_selection_required" }
  | { ok: false; kind: "account_sync_required" }
  | { ok: false; kind: "reconnect_required" }
  | { ok: false; kind: "provider_error"; errorCode: string | null }
  | { ok: false; kind: "network_error" };

export async function fetchGoogleAdsAdGroupSearchTerms(input: { campaignId: string; adGroupId: string }): Promise<GoogleAdsAdGroupSearchTermsResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, kind: "unauthorized" };

  let res: Response;
  try {
    res = await fetch("/.netlify/functions/google-ads-ad-group-search-terms", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(input),
    });
  } catch {
    return { ok: false, kind: "network_error" };
  }

  if (res.status === 401 || res.status === 403) return { ok: false, kind: "unauthorized" };

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errorCode: string | null = typeof json?.error === "string" ? json.error : null;
    return mapGoogleAdsConnectionErrorCode(errorCode) as GoogleAdsAdGroupSearchTermsResult;
  }
  return { ok: true, data: json as GoogleAdsAdGroupSearchTermsResponse };
}

// ── Ad Group-Level CRM Outcomes (Google Ads product phase) ──────────────
// Pure Supabase-backed reporting — the endpoint itself makes zero calls to
// Google, so this fetch function is no different in shape from any other
// here; it's just a POST to a trusted Netlify function.

export type GoogleAdsAdGroupCrmOutcomesResult =
  | { ok: true; data: GoogleAdsAdGroupCrmOutcomesResponse }
  | { ok: false; kind: "unauthorized" }
  | { ok: false; kind: "not_connected" }
  | { ok: false; kind: "account_selection_required" }
  | { ok: false; kind: "account_sync_required" }
  | { ok: false; kind: "reconnect_required" }
  | { ok: false; kind: "provider_error"; errorCode: string | null }
  | { ok: false; kind: "network_error" };

export async function fetchGoogleAdsAdGroupCrmOutcomes(input: { campaignId: string; adGroupId: string }): Promise<GoogleAdsAdGroupCrmOutcomesResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, kind: "unauthorized" };

  let res: Response;
  try {
    res = await fetch("/.netlify/functions/google-ads-ad-group-crm-outcomes", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(input),
    });
  } catch {
    return { ok: false, kind: "network_error" };
  }

  if (res.status === 401 || res.status === 403) return { ok: false, kind: "unauthorized" };

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errorCode: string | null = typeof json?.error === "string" ? json.error : null;
    return mapGoogleAdsConnectionErrorCode(errorCode) as GoogleAdsAdGroupCrmOutcomesResult;
  }
  return { ok: true, data: json as GoogleAdsAdGroupCrmOutcomesResponse };
}

// ── Local conversion events + export (Phase 3, Step 7B.2) ───────────────
// exportGoogleAdsConversionEvent() is the ONLY client function that
// triggers a live Google Ads conversion upload — it never constructs the
// upload payload itself; it only tells the trusted server-side endpoint
// which local eventId to export, and that endpoint resolves everything
// else (gclid, conversion action, value/currency) from validated
// server-side state.

export type GoogleAdsConversionEventsListResult =
  | { ok: true; data: GoogleAdsConversionEventsListResponse }
  | { ok: false; kind: "unauthorized" }
  | { ok: false; kind: "not_connected" }
  | { ok: false; kind: "account_selection_required" }
  | { ok: false; kind: "account_sync_required" }
  | { ok: false; kind: "reconnect_required" }
  | { ok: false; kind: "provider_error"; errorCode: string | null }
  | { ok: false; kind: "network_error" };

export async function fetchGoogleAdsConversionEvents(): Promise<GoogleAdsConversionEventsListResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, kind: "unauthorized" };

  let res: Response;
  try {
    res = await fetch("/.netlify/functions/google-ads-conversion-events-list", {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
  } catch {
    return { ok: false, kind: "network_error" };
  }

  const json = await res.json().catch(() => ({}));

  if (res.ok && Array.isArray(json?.events)) {
    return { ok: true, data: json as GoogleAdsConversionEventsListResponse };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, kind: "unauthorized" };
  }

  const errorCode: string | null = typeof json?.error === "string" ? json.error : null;
  return mapGoogleAdsConnectionErrorCode(errorCode) as GoogleAdsConversionEventsListResult;
}

// Safe error codes this endpoint can return, beyond the shared connection
// errors already handled by mapGoogleAdsConnectionErrorCode — every one of
// these maps to a specific local-state or Google-side reason, never a raw
// Supabase/Google error message.
export type GoogleAdsConversionExportRejection =
  | "event_not_found"
  | "already_exported"
  | "synthetic_fixture_ineligible"
  | "event_not_ready"
  | "missing_gclid"
  | "mapping_not_found"
  | "mapping_disabled"
  | "conversion_action_not_found"
  | "conversion_action_not_upload_clicks"
  | "event_customer_mismatch"
  | "google_ads_attribution_not_found"
  | "google_ads_partial_failure"
  | "google_ads_upload_failed";

export type GoogleAdsConversionExportResult =
  | { ok: true; data: GoogleAdsConversionExportResponse }
  | { ok: false; kind: "unauthorized" }
  | { ok: false; kind: "rejected"; reason: GoogleAdsConversionExportRejection }
  | { ok: false; kind: "reconnect_required" }
  | { ok: false; kind: "provider_error"; errorCode: string | null }
  | { ok: false; kind: "network_error" };

const EXPORT_REJECTION_REASONS = new Set<GoogleAdsConversionExportRejection>([
  "event_not_found", "already_exported", "synthetic_fixture_ineligible", "event_not_ready",
  "missing_gclid", "mapping_not_found", "mapping_disabled", "conversion_action_not_found",
  "conversion_action_not_upload_clicks", "event_customer_mismatch",
  "google_ads_attribution_not_found", "google_ads_partial_failure", "google_ads_upload_failed",
]);

export async function exportGoogleAdsConversionEvent(eventId: string): Promise<GoogleAdsConversionExportResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, kind: "unauthorized" };

  let res: Response;
  try {
    res = await fetch("/.netlify/functions/google-ads-conversion-export", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ eventId }),
    });
  } catch {
    return { ok: false, kind: "network_error" };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, kind: "unauthorized" };
  }

  const json = await res.json().catch(() => ({}));
  const errorCode: string | null = typeof json?.error === "string" ? json.error : null;

  if (!res.ok || !json?.ok) {
    if (errorCode === "reconnect_required") return { ok: false, kind: "reconnect_required" };
    if (errorCode && EXPORT_REJECTION_REASONS.has(errorCode as GoogleAdsConversionExportRejection)) {
      return { ok: false, kind: "rejected", reason: errorCode as GoogleAdsConversionExportRejection };
    }
    return { ok: false, kind: "provider_error", errorCode };
  }
  return { ok: true, data: json as GoogleAdsConversionExportResponse };
}
