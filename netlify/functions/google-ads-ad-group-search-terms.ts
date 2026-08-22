// netlify/functions/google-ads-ad-group-search-terms.ts
//
// Ad Group -> Search Terms drill-down (Campaign Detail Sheet's Ad Group
// Detail -> Search Terms tab). Read-only — search_term_view is a
// stats-only view; there is no mutation surface for it at all. Same auth/
// org-isolation/token-refresh shape as the Ad Groups/Keywords endpoints.
//
// Scoped by BOTH campaignId AND adGroupId, exactly like the Keywords
// endpoint — an adGroupId from another campaign can never silently return
// data. An empty `searchTerms` array is a normal, expected result (not an
// error) for a low/zero-serving campaign — Google only surfaces a search
// term row once an actual search triggered an ad, and may additionally
// suppress some terms for privacy/volume-threshold reasons; there is no
// "configured entity" backing this view the way there is for ad groups/
// keywords.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { googleAdsCorsHeaders } from "./lib/google-ads-cors";
import { decryptBytea } from "./lib/gmail-token-crypto";
import { refreshGoogleAdsAccessToken } from "./lib/google-ads-oauth-token";
import {
  searchGoogleAds,
  parseGoogleAdsAccountSummary,
  buildGoogleAdsSearchTermPerformanceQuery,
  parseGoogleAdsSearchTermPerformance,
  preflightGoogleAdsConnection,
  classifyGoogleAdsSearchError,
  GOOGLE_ADS_ACCOUNT_SUMMARY_QUERY,
  type GoogleAdsConnectionRowForSummary,
  type GoogleAdsSearchTermPerformanceRow,
} from "./lib/google-ads-api";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const DATE_RANGE = "LAST_30_DAYS" as const;

interface ConnectionRow extends GoogleAdsConnectionRowForSummary {
  id: string;
}

interface RequestBody {
  campaignId?: unknown;
  adGroupId?: unknown;
}

interface AdGroupSearchTermsResponse {
  connected: true;
  campaignId: string;
  adGroupId: string;
  currencyCode: string | null;
  dateRange: typeof DATE_RANGE;
  searchTerms: GoogleAdsSearchTermPerformanceRow[];
}

function errorResponse(headers: Record<string, string>, statusCode: number, errorCode: string) {
  return { statusCode, headers, body: JSON.stringify({ connected: false, error: errorCode }) };
}

function digitsOnly(value: unknown): string {
  return typeof value === "string" && /^\d+$/.test(value.trim()) ? value.trim() : "";
}

export const handler: Handler = async (event) => {
  const headers = googleAdsCorsHeaders(event, "POST, OPTIONS");
  const logError = (phase: string, extra?: Record<string, unknown>) =>
    console.error(`[google-ads-ad-group-search-terms] ${phase}`, extra ?? {});

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") {
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

  let reqBody: RequestBody;
  try {
    reqBody = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const campaignId = digitsOnly(reqBody.campaignId);
  const adGroupId = digitsOnly(reqBody.adGroupId);
  if (!campaignId || !adGroupId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "campaignId and adGroupId must both be digit-only strings" }) };
  }

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
      await supabaseAdmin
        .from("google_ads_connections")
        .update({ status: "needs_account_sync", last_error_code: "reconnect_required", updated_at: new Date().toISOString() })
        .eq("id", connection!.id)
        .eq("organization_id", orgId);
      return errorResponse(headers, 409, "reconnect_required");
    }
    return errorResponse(headers, 500, tokenResult.errorCode);
  }
  const { accessToken } = tokenResult;

  let currencyCode: string | null;
  try {
    const summaryResults = await searchGoogleAds(accessToken, developerToken, selectedCustomerId, GOOGLE_ADS_ACCOUNT_SUMMARY_QUERY, loginCustomerId);
    const parsedSummary = parseGoogleAdsAccountSummary(summaryResults, selectedCustomerId, loginCustomerId);
    if (!parsedSummary.ok) {
      logError(parsedSummary.reason === "customer_id_mismatch" ? "account_mismatch" : "google_ads_api_error");
      return errorResponse(headers, 500, parsedSummary.reason === "customer_id_mismatch" ? "account_mismatch" : "google_ads_api_error");
    }
    currencyCode = parsedSummary.account.currencyCode;
  } catch (e) {
    const { errorCode, logSuffix, logExtra } = classifyGoogleAdsSearchError(e);
    logError(`account_summary_${logSuffix}`, logExtra);
    return errorResponse(headers, 500, errorCode);
  }

  let searchTerms: GoogleAdsSearchTermPerformanceRow[];
  try {
    const query = buildGoogleAdsSearchTermPerformanceQuery(campaignId, adGroupId);
    const results = await searchGoogleAds(accessToken, developerToken, selectedCustomerId, query, loginCustomerId);
    searchTerms = parseGoogleAdsSearchTermPerformance(results);
  } catch (e) {
    const { errorCode, logSuffix, logExtra } = classifyGoogleAdsSearchError(e);
    logError(`search_terms_${logSuffix}`, logExtra);
    return errorResponse(headers, 500, errorCode);
  }

  const response: AdGroupSearchTermsResponse = {
    connected: true,
    campaignId,
    adGroupId,
    currencyCode,
    dateRange: DATE_RANGE,
    searchTerms,
  };

  return { statusCode: 200, headers, body: JSON.stringify(response) };
};
