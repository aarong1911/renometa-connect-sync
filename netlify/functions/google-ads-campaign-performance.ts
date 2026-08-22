// netlify/functions/google-ads-campaign-performance.ts
//
// Phase 3, second read-only Google Ads API connection test: fetches
// campaign-level performance for the authenticated organization's SELECTED
// advertiser over a fixed, server-owned LAST_30_DAYS window. Read-only —
// makes no write/mutate call to Google, and does not change
// selected_customer_id/login_customer_id/status.
//
// Follows the exact auth/org-isolation/token/error-handling shape already
// proven by google-ads-account-summary.ts: resolveOrgFromBearerToken() is
// the only identity source, the connection row is validated via
// preflightGoogleAdsConnection(), the refresh token is decrypted +
// exchanged only for the duration of this invocation, and every failure
// maps to one of a fixed set of safe internal error codes.
//
// Two live Google Ads reads happen here, in order:
//   1. GOOGLE_ADS_ACCOUNT_SUMMARY_QUERY (shared with
//      google-ads-account-summary.ts) — gets currencyCode/timeZone so the
//      response can report them even when there are zero campaigns, and
//      re-validates the returned customer ID matches what was requested.
//   2. The campaign-performance query below.
//
// Never logs or returns: encrypted_refresh_token, the decrypted refresh
// token, the temporary access token, GOOGLE_ADS_CLIENT_SECRET,
// GOOGLE_ADS_DEVELOPER_TOKEN, organization ID, connected user ID, or a raw
// Google response body.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { googleAdsCorsHeaders } from "./lib/google-ads-cors";
import { decryptBytea } from "./lib/gmail-token-crypto";
import { refreshGoogleAdsAccessToken } from "./lib/google-ads-oauth-token";
import {
  searchGoogleAds,
  parseGoogleAdsAccountSummary,
  parseGoogleAdsCampaignPerformance,
  summarizeGoogleAdsCampaignPerformance,
  preflightGoogleAdsConnection,
  GoogleAdsApiError,
  GoogleAdsResultLimitExceededError,
  GOOGLE_ADS_ACCOUNT_SUMMARY_QUERY,
  type GoogleAdsConnectionRowForSummary,
  type GoogleAdsCampaignPerformance,
  type GoogleAdsCampaignPerformanceSummary,
} from "./lib/google-ads-api";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// Fixed, server-owned GAQL query and date range — never accepted from the
// browser. ORDER BY impressions DESC matches Google's own ranking; the
// parser preserves that order rather than re-sorting.
const CAMPAIGN_PERFORMANCE_QUERY = `
  SELECT
    campaign.id,
    campaign.name,
    campaign.status,
    campaign.advertising_channel_type,
    metrics.impressions,
    metrics.clicks,
    metrics.cost_micros,
    metrics.conversions,
    metrics.conversions_value
  FROM campaign
  WHERE segments.date DURING LAST_30_DAYS
  ORDER BY metrics.impressions DESC
`.trim();

const DATE_RANGE = "LAST_30_DAYS" as const;

interface ConnectionRow extends GoogleAdsConnectionRowForSummary {
  id: string;
}

interface CampaignPerformanceResponse {
  connected: true;
  customerId: string;
  loginCustomerId: string | null;
  currencyCode: string | null;
  timeZone: string | null;
  dateRange: typeof DATE_RANGE;
  summary: GoogleAdsCampaignPerformanceSummary;
  campaigns: GoogleAdsCampaignPerformance[];
}

function errorResponse(headers: Record<string, string>, statusCode: number, errorCode: string) {
  return { statusCode, headers, body: JSON.stringify({ connected: false, error: errorCode }) };
}

export const handler: Handler = async (event) => {
  const requestId = crypto.randomBytes(6).toString("hex");
  const headers = googleAdsCorsHeaders(event, "GET, OPTIONS");
  const logError = (phase: string, extra?: Record<string, unknown>) =>
    console.error(`[google-ads-campaign-performance:${requestId}] ${phase}`, extra ?? {});
  const logWarn = (phase: string, extra?: Record<string, unknown>) =>
    console.warn(`[google-ads-campaign-performance:${requestId}] ${phase}`, extra ?? {});
  const logInfo = (phase: string, extra?: Record<string, unknown>) =>
    console.log(`[google-ads-campaign-performance:${requestId}] ${phase}`, extra ?? {});

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!developerToken) {
    logError("server_configuration", { hasDeveloperToken: false });
    return errorResponse(headers, 500, "server_configuration");
  }

  const resolved = await resolveOrgFromBearerToken(supabaseAdmin, event.headers.authorization);
  if (!resolved) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  }
  const { orgId } = resolved;

  // Only the columns this endpoint actually needs.
  const { data: connection, error: connErr } = (await supabaseAdmin
    .from("google_ads_connections")
    .select("id, status, encrypted_refresh_token, selected_customer_id, login_customer_id")
    .eq("organization_id", orgId)
    .maybeSingle()) as unknown as { data: ConnectionRow | null; error: any };

  if (connErr) {
    logError("connection_lookup_failed", { code: connErr.code });
    return errorResponse(headers, 500, "server_configuration");
  }

  const preflight = preflightGoogleAdsConnection(connection);
  if (!preflight.ok) {
    const statusCode = preflight.errorCode === "google_ads_not_connected" ? 404 : 409;
    return errorResponse(headers, statusCode, preflight.errorCode);
  }
  const { selectedCustomerId, loginCustomerId } = preflight;
  // Non-null by construction here — preflight only returns ok:true when a
  // connection row (and therefore connection.id) exists.
  const connectionId = connection!.id;

  let refreshTokenPlain: string;
  try {
    refreshTokenPlain = decryptBytea(connection!.encrypted_refresh_token!);
  } catch {
    logError("decrypt_failed");
    return errorResponse(headers, 500, "server_configuration");
  }

  const tokenResult = await refreshGoogleAdsAccessToken(refreshTokenPlain);
  if (!tokenResult.ok) {
    if (tokenResult.errorCode === "reconnect_required") {
      // Same visibility pattern as google-ads-accounts.ts /
      // google-ads-account-summary.ts — mark the connection as needing
      // attention without discarding its stored (now-invalid) refresh
      // token; the user reconnecting is what actually replaces it.
      await supabaseAdmin
        .from("google_ads_connections")
        .update({ status: "needs_account_sync", last_error_code: "reconnect_required", updated_at: new Date().toISOString() })
        .eq("id", connectionId)
        .eq("organization_id", orgId);
      return errorResponse(headers, 409, "reconnect_required");
    }
    // server_configuration or network_error — transient/config issue, the
    // stored connection row (refresh token, selection) is left untouched.
    return errorResponse(headers, 500, tokenResult.errorCode);
  }
  const { accessToken } = tokenResult;

  // ── 1. Account summary — needed for currencyCode/timeZone even when the
  // campaign query below returns zero rows, and doubles as an early,
  // cheap re-validation that the selected customer ID is still valid.
  let currencyCode: string | null;
  let timeZone: string | null;
  try {
    const summaryResults = await searchGoogleAds(accessToken, developerToken, selectedCustomerId, GOOGLE_ADS_ACCOUNT_SUMMARY_QUERY, loginCustomerId);
    const parsedSummary = parseGoogleAdsAccountSummary(summaryResults, selectedCustomerId, loginCustomerId);
    if (!parsedSummary.ok) {
      logError(parsedSummary.reason === "customer_id_mismatch" ? "account_mismatch" : "google_ads_api_error", {
        selectedCustomerId,
        loginCustomerId,
      });
      return errorResponse(headers, 500, parsedSummary.reason === "customer_id_mismatch" ? "account_mismatch" : "google_ads_api_error");
    }
    currencyCode = parsedSummary.account.currencyCode;
    timeZone = parsedSummary.account.timeZone;
  } catch (e) {
    return handleGoogleAdsFetchError(e, logError, headers, "account_summary");
  }

  // ── 2. Campaign performance ────────────────────────────────────────────
  let campaigns: GoogleAdsCampaignPerformance[];
  try {
    const campaignResults = await searchGoogleAds(accessToken, developerToken, selectedCustomerId, CAMPAIGN_PERFORMANCE_QUERY, loginCustomerId);
    campaigns = parseGoogleAdsCampaignPerformance(campaignResults);
  } catch (e) {
    return handleGoogleAdsFetchError(e, logError, headers, "campaign_performance");
  }

  const summary = summarizeGoogleAdsCampaignPerformance(campaigns);

  // Best-effort operational bookkeeping only — never the selected account,
  // login customer, encrypted refresh token, status, or accessible IDs. A
  // failure here must not turn a successful read into a failed response.
  const { error: updateErr } = await supabaseAdmin
    .from("google_ads_connections")
    .update({ last_synced_at: new Date().toISOString(), last_error_code: null, updated_at: new Date().toISOString() })
    .eq("id", connectionId)
    .eq("organization_id", orgId);
  if (updateErr) {
    logWarn("last_synced_at_update_failed", { code: updateErr.code });
  }

  logInfo("ok", { selectedCustomerId, loginCustomerId, campaignCount: campaigns.length });

  const response: CampaignPerformanceResponse = {
    connected: true,
    customerId: selectedCustomerId,
    loginCustomerId,
    currencyCode,
    timeZone,
    dateRange: DATE_RANGE,
    summary,
    campaigns,
  };

  return { statusCode: 200, headers, body: JSON.stringify(response) };
};

// Shared classification for both Google reads — GoogleAdsResultLimitExceededError
// gets its own safe code (never silently truncated totals), a thrown
// GoogleAdsApiError logs its safe HTTP status only, anything else
// (timeout/network) is generic network_error. Never logs a raw error
// message or response body.
function handleGoogleAdsFetchError(
  e: unknown,
  logError: (phase: string, extra?: Record<string, unknown>) => void,
  headers: Record<string, string>,
  phase: string,
) {
  if (e instanceof GoogleAdsResultLimitExceededError) {
    logError(`${phase}_result_limit_exceeded`);
    return errorResponse(headers, 500, "result_limit_exceeded");
  }
  if (e instanceof GoogleAdsApiError) {
    logError(`${phase}_google_ads_api_error`, { status: e.status });
    return errorResponse(headers, 500, "google_ads_api_error");
  }
  logError(`${phase}_network_error`);
  return errorResponse(headers, 500, "network_error");
}
