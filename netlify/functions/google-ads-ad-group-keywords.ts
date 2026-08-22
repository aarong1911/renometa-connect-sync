// netlify/functions/google-ads-ad-group-keywords.ts
//
// Ad Group -> Keywords drill-down (Campaign Detail Sheet's Ad Group Detail
// -> Keywords tab). Read-only — no AdGroupCriterionService write, no
// negative-keyword mutation, no status/bid change. Same auth/org-isolation/
// token-refresh shape as google-ads-campaign-ad-groups.ts.
//
// Scoped by BOTH campaignId AND adGroupId (Step 9) — an adGroupId that
// doesn't actually belong to the given campaignId simply returns zero rows
// (the GAQL WHERE requires both to match the same row), it can never
// silently return another campaign's ad group's keywords.
//
// Keyword Drill-Down Live Fix pass: runs TWO separate read-only GAQL
// queries (structure, then metrics) rather than one combined query — the
// original single-query version failed live against a genuinely
// zero-serving configured keyword. See buildGoogleAdsKeywordStructureQuery/
// buildGoogleAdsKeywordMetricsQuery's doc comments in lib/google-ads-api.ts
// for the full reasoning. Negative criteria are filtered out AFTER parsing
// (mergeGoogleAdsKeywordPerformance), never via a GAQL `negative = false`
// WHERE clause — audiences/demographics/placements/locations/negative
// keywords are still never mixed into this table, just excluded in code
// instead of in the query itself.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { googleAdsCorsHeaders } from "./lib/google-ads-cors";
import { decryptBytea } from "./lib/gmail-token-crypto";
import { refreshGoogleAdsAccessToken } from "./lib/google-ads-oauth-token";
import {
  searchGoogleAds,
  parseGoogleAdsAccountSummary,
  buildGoogleAdsKeywordStructureQuery,
  buildGoogleAdsKeywordMetricsQuery,
  mergeGoogleAdsKeywordPerformance,
  preflightGoogleAdsConnection,
  classifyGoogleAdsSearchError,
  GOOGLE_ADS_ACCOUNT_SUMMARY_QUERY,
  type GoogleAdsConnectionRowForSummary,
  type GoogleAdsKeywordPerformanceRow,
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

interface AdGroupKeywordsResponse {
  connected: true;
  campaignId: string;
  adGroupId: string;
  currencyCode: string | null;
  dateRange: typeof DATE_RANGE;
  keywords: GoogleAdsKeywordPerformanceRow[];
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
    console.error(`[google-ads-ad-group-keywords] ${phase}`, extra ?? {});

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

  // Structure first (Query A) — the source of truth for which keywords
  // exist, regardless of metrics/date-segmentation. If this fails, there's
  // no point attempting the metrics query at all.
  let structureResults: any[];
  try {
    const structureQuery = buildGoogleAdsKeywordStructureQuery(campaignId, adGroupId);
    structureResults = await searchGoogleAds(accessToken, developerToken, selectedCustomerId, structureQuery, loginCustomerId);
  } catch (e) {
    const { errorCode, logSuffix, logExtra } = classifyGoogleAdsSearchError(e);
    logError(`keyword_structure_${logSuffix}`, logExtra);
    return errorResponse(headers, 500, errorCode);
  }

  // Metrics second (Query B) — a failure here is logged and treated as
  // "no metrics available" (empty result set) rather than failing the
  // whole request, since the structural keyword list is still valid and
  // more important to show than a metrics outage (Step 6: "metrics are
  // secondary to structural visibility").
  let metricsResults: any[] = [];
  try {
    const metricsQuery = buildGoogleAdsKeywordMetricsQuery(campaignId, adGroupId);
    metricsResults = await searchGoogleAds(accessToken, developerToken, selectedCustomerId, metricsQuery, loginCustomerId);
  } catch (e) {
    const { logSuffix, logExtra } = classifyGoogleAdsSearchError(e);
    logError(`keyword_metrics_${logSuffix}_nonfatal`, logExtra);
  }

  const keywords: GoogleAdsKeywordPerformanceRow[] = mergeGoogleAdsKeywordPerformance(structureResults, metricsResults);

  const response: AdGroupKeywordsResponse = {
    connected: true,
    campaignId,
    adGroupId,
    currencyCode,
    dateRange: DATE_RANGE,
    keywords,
  };

  return { statusCode: 200, headers, body: JSON.stringify(response) };
};
