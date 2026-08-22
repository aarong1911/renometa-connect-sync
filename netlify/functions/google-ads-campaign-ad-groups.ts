// netlify/functions/google-ads-campaign-ad-groups.ts
//
// Campaign -> Ad Groups drill-down phase: read-only list of a single
// campaign's ad groups with their performance metrics, for the Campaign
// Detail Sheet's "Ad Groups" tab. Strictly read-only — makes no Google Ads
// mutate call of any kind (no CampaignService/AdGroupService/
// AdGroupCriterionService/CampaignBudgetService write, no status/budget/
// bid change). Follows the exact same auth/org-isolation/token-refresh/
// error-handling shape already proven by google-ads-campaign-performance.ts:
// resolveOrgFromBearerToken() is the only identity source, the connection
// row is validated via preflightGoogleAdsConnection(), the refresh token is
// decrypted + exchanged only for the duration of this invocation.
//
// campaignId is the only input, and is validated as a digit-only string
// server-side before ever being interpolated into the GAQL query — never
// accepts organization_id, google_ads_customer_id, login_customer_id, or
// any token from the browser; all of those are always resolved server-side
// from the authenticated org's own google_ads_connections row.
//
// Ad Groups are queried from the `ad_group` MAIN resource (not a stats-only
// "view") so a configured-but-zero-serving ad group still returns its own
// row with zeroed metrics — see buildGoogleAdsAdGroupPerformanceQuery's doc
// comment in lib/google-ads-api.ts for the full reasoning.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { googleAdsCorsHeaders } from "./lib/google-ads-cors";
import { decryptBytea } from "./lib/gmail-token-crypto";
import { refreshGoogleAdsAccessToken } from "./lib/google-ads-oauth-token";
import {
  searchGoogleAds,
  parseGoogleAdsAccountSummary,
  buildGoogleAdsAdGroupPerformanceQuery,
  parseGoogleAdsAdGroupPerformance,
  preflightGoogleAdsConnection,
  classifyGoogleAdsSearchError,
  GOOGLE_ADS_ACCOUNT_SUMMARY_QUERY,
  type GoogleAdsConnectionRowForSummary,
  type GoogleAdsAdGroupPerformanceRow,
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
}

interface CampaignAdGroupsResponse {
  connected: true;
  customerId: string;
  campaignId: string;
  currencyCode: string | null;
  dateRange: typeof DATE_RANGE;
  adGroups: GoogleAdsAdGroupPerformanceRow[];
}

function errorResponse(headers: Record<string, string>, statusCode: number, errorCode: string) {
  return { statusCode, headers, body: JSON.stringify({ connected: false, error: errorCode }) };
}

export const handler: Handler = async (event) => {
  const headers = googleAdsCorsHeaders(event, "POST, OPTIONS");
  const logError = (phase: string, extra?: Record<string, unknown>) =>
    console.error(`[google-ads-campaign-ad-groups] ${phase}`, extra ?? {});

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

  const campaignId = typeof reqBody.campaignId === "string" ? reqBody.campaignId.trim() : "";
  if (!campaignId || !/^\d+$/.test(campaignId)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "campaignId must be a digit-only string" }) };
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

  // Account summary only for currencyCode — same reason as
  // google-ads-campaign-performance.ts (Spend/Conversion value on this tab
  // must use the advertiser's real currency, never the plain CRM Won-value
  // formatter).
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

  let adGroups: GoogleAdsAdGroupPerformanceRow[];
  try {
    const query = buildGoogleAdsAdGroupPerformanceQuery(campaignId);
    const results = await searchGoogleAds(accessToken, developerToken, selectedCustomerId, query, loginCustomerId);
    adGroups = parseGoogleAdsAdGroupPerformance(results);
  } catch (e) {
    const { errorCode, logSuffix, logExtra } = classifyGoogleAdsSearchError(e);
    logError(`ad_groups_${logSuffix}`, logExtra);
    return errorResponse(headers, 500, errorCode);
  }

  const response: CampaignAdGroupsResponse = {
    connected: true,
    customerId: selectedCustomerId,
    campaignId,
    currencyCode,
    dateRange: DATE_RANGE,
    adGroups,
  };

  return { statusCode: 200, headers, body: JSON.stringify(response) };
};
