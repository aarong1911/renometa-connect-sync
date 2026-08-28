// src/lib/meta-ads-client.ts
//
// Frontend fetch layer for the read-only Meta Ads reporting endpoints
// (Phase 1A / Step 2) — account summary, campaigns, ad sets, ads, and
// generic Insights. Same bearer-session + discriminated-result pattern as
// google-ads-client.ts; no dashboard UI wiring happens here (Step 3).
//
// None of these functions accept an ad-account ID — the backend always
// resolves the selected advertiser server-side via resolveMetaAdsContext().

import { supabase } from "@/lib/supabase";

// ── Shared types ──────────────────────────────────────────────────────

export type MetaAdsDateRangePreset = "TODAY" | "YESTERDAY" | "LAST_7_DAYS" | "LAST_14_DAYS" | "LAST_30_DAYS" | "THIS_MONTH" | "LAST_MONTH";

export interface MetaAdsDateRangeInput {
  dateRange?: MetaAdsDateRangePreset;
  startDate?: string;
  endDate?: string;
}

export interface MetaAdsDateRangeShape {
  preset: string | null;
  since: string | null;
  until: string | null;
}

export interface MetaAdsAccount {
  id: string;
  name: string | null;
  accountStatus: number | null;
  currency: string | null;
  timezoneName: string | null;
  businessId: string | null;
  businessName: string | null;
}

export interface MetaAdsInsights {
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  leads: number;
  costPerLead: number | null;
  leadActionBreakdown: Record<string, number>;
}

export interface MetaAdsCampaign {
  id: string;
  name: string;
  status: string;
  effectiveStatus: string | null;
  objective: string | null;
  buyingType: string | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  budgetRemaining: number | null;
  startTime: string | null;
  stopTime: string | null;
  createdTime: string | null;
  updatedTime: string | null;
  insights: MetaAdsInsights;
}

export interface MetaAdsAdSet {
  id: string;
  campaignId: string | null;
  name: string;
  status: string;
  effectiveStatus: string | null;
  optimizationGoal: string | null;
  billingEvent: string | null;
  bidStrategy: string | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  startTime: string | null;
  endTime: string | null;
  createdTime: string | null;
  updatedTime: string | null;
  targetingSummary: string | null;
  insights: MetaAdsInsights;
}

export interface MetaAdsAd {
  id: string;
  campaignId: string | null;
  adSetId: string | null;
  name: string;
  status: string;
  effectiveStatus: string | null;
  createdTime: string | null;
  updatedTime: string | null;
  creativeId: string | null;
  creativeName: string | null;
  thumbnailUrl: string | null;
  insights: MetaAdsInsights;
}

export interface MetaAdsAccountSummaryResponse {
  connected: true;
  selectionState: "connected";
  dateRange: MetaAdsDateRangeShape;
  adAccount: MetaAdsAccount;
  summary: MetaAdsInsights;
}

export interface MetaAdsCampaignsResponse {
  connected: true;
  dateRange: MetaAdsDateRangeShape;
  campaigns: MetaAdsCampaign[];
  truncated: boolean;
}

export interface MetaAdsAdSetsResponse {
  connected: true;
  dateRange: MetaAdsDateRangeShape;
  adSets: MetaAdsAdSet[];
  truncated: boolean;
}

export interface MetaAdsAdsResponse {
  connected: true;
  dateRange: MetaAdsDateRangeShape;
  ads: MetaAdsAd[];
  truncated: boolean;
}

export interface MetaAdsInsightsRow extends MetaAdsInsights {
  entityId: string | null;
}

export interface MetaAdsInsightsResponse {
  connected: true;
  level: "account" | "campaign" | "adset" | "ad";
  dateRange: MetaAdsDateRangeShape;
  rows: MetaAdsInsightsRow[];
  truncated: boolean;
}

// Discriminated result — the UI branches on `kind`, same convention as
// GoogleAdsCampaignPerformanceResult in google-ads-client.ts. `not_connected`
// and `no_ad_account_selected` are normal/expected states (not failures);
// `errorCode` on `provider_error` is always one of the endpoint's own safe
// internal codes, never a raw Meta error message.
export type MetaAdsResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "unauthorized" }
  | { ok: false; kind: "not_connected" }
  | { ok: false; kind: "no_ad_account_selected" }
  | { ok: false; kind: "reconnect_required" }
  | { ok: false; kind: "permission_required" }
  | { ok: false; kind: "account_unavailable" }
  | { ok: false; kind: "temporarily_unavailable" }
  | { ok: false; kind: "provider_error"; errorCode: string | null }
  | { ok: false; kind: "network_error" };

function dateRangeToQueryParams(input?: MetaAdsDateRangeInput): URLSearchParams {
  const params = new URLSearchParams();
  if (input?.startDate && input?.endDate) {
    params.set("startDate", input.startDate);
    params.set("endDate", input.endDate);
  } else if (input?.dateRange) {
    params.set("dateRange", input.dateRange);
  }
  return params;
}

function mapErrorCodeToResult<T>(errorCode: string | null): MetaAdsResult<T> {
  switch (errorCode) {
    case "not_connected":
      return { ok: false, kind: "not_connected" };
    case "no_ad_account_selected":
      return { ok: false, kind: "no_ad_account_selected" };
    case "reconnect_required":
      return { ok: false, kind: "reconnect_required" };
    case "permission_required":
      return { ok: false, kind: "permission_required" };
    case "account_unavailable":
      return { ok: false, kind: "account_unavailable" };
    case "temporarily_unavailable":
      return { ok: false, kind: "temporarily_unavailable" };
    default:
      return { ok: false, kind: "provider_error", errorCode };
  }
}

async function fetchMetaAdsJson<T>(path: string): Promise<MetaAdsResult<T>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, kind: "unauthorized" };

  let res: Response;
  try {
    res = await fetch(path, { headers: { Authorization: `Bearer ${session.access_token}` } });
  } catch {
    return { ok: false, kind: "network_error" };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, kind: "unauthorized" };
  }

  const json = await res.json().catch(() => ({}));
  const errorCode: string | null = typeof json?.errorCode === "string" ? json.errorCode : null;

  if (res.ok && json?.connected === true) {
    return { ok: true, data: json as T };
  }
  if (res.ok && json?.connected === false) {
    return mapErrorCodeToResult<T>(errorCode);
  }
  return mapErrorCodeToResult<T>(errorCode);
}

export function getMetaAdsAccountSummary(dateRange?: MetaAdsDateRangeInput): Promise<MetaAdsResult<MetaAdsAccountSummaryResponse>> {
  const qs = dateRangeToQueryParams(dateRange).toString();
  return fetchMetaAdsJson(`/.netlify/functions/meta-ads-account-summary${qs ? `?${qs}` : ""}`);
}

export function getMetaAdsCampaigns(input?: MetaAdsDateRangeInput & { status?: string }): Promise<MetaAdsResult<MetaAdsCampaignsResponse>> {
  const params = dateRangeToQueryParams(input);
  if (input?.status) params.set("status", input.status);
  const qs = params.toString();
  return fetchMetaAdsJson(`/.netlify/functions/meta-ads-campaigns${qs ? `?${qs}` : ""}`);
}

export function getMetaAdsAdSets(input?: MetaAdsDateRangeInput & { campaignId?: string }): Promise<MetaAdsResult<MetaAdsAdSetsResponse>> {
  const params = dateRangeToQueryParams(input);
  if (input?.campaignId) params.set("campaignId", input.campaignId);
  const qs = params.toString();
  return fetchMetaAdsJson(`/.netlify/functions/meta-ads-adsets${qs ? `?${qs}` : ""}`);
}

export function getMetaAdsAds(
  input?: MetaAdsDateRangeInput & { campaignId?: string; adSetId?: string },
): Promise<MetaAdsResult<MetaAdsAdsResponse>> {
  const params = dateRangeToQueryParams(input);
  if (input?.campaignId) params.set("campaignId", input.campaignId);
  if (input?.adSetId) params.set("adSetId", input.adSetId);
  const qs = params.toString();
  return fetchMetaAdsJson(`/.netlify/functions/meta-ads-ads${qs ? `?${qs}` : ""}`);
}

export function getMetaAdsInsights(
  input?: MetaAdsDateRangeInput & { level?: "account" | "campaign" | "adset" | "ad"; campaignId?: string; adSetId?: string; adId?: string },
): Promise<MetaAdsResult<MetaAdsInsightsResponse>> {
  const params = dateRangeToQueryParams(input);
  if (input?.level) params.set("level", input.level);
  if (input?.campaignId) params.set("campaignId", input.campaignId);
  if (input?.adSetId) params.set("adSetId", input.adSetId);
  if (input?.adId) params.set("adId", input.adId);
  const qs = params.toString();
  return fetchMetaAdsJson(`/.netlify/functions/meta-ads-insights${qs ? `?${qs}` : ""}`);
}
