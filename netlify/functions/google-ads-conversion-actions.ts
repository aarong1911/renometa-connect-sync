// netlify/functions/google-ads-conversion-actions.ts
//
// Phase 3, Step 7B.1: read-only Google Ads conversion-action discovery for
// the authenticated organization's SELECTED advertiser. Follows the exact
// auth/org-isolation/token/error-handling shape already proven by
// google-ads-campaign-performance.ts: resolveOrgFromBearerToken() is the
// only identity source, the connection row is validated via
// preflightGoogleAdsConnection(), the refresh token is decrypted +
// exchanged only for the duration of this invocation, and every failure
// maps to one of the fixed set of safe internal error codes already used
// across every other Google Ads endpoint.
//
// Makes exactly ONE live Google Ads read (googleAds:search against the
// conversion_action resource). Never calls
// customers:uploadClickConversions or any other mutate/upload endpoint —
// this is discovery only, per Step 7B.1's explicit scope.
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
  parseGoogleAdsConversionActions,
  preflightGoogleAdsConnection,
  GoogleAdsApiError,
  GoogleAdsResultLimitExceededError,
  GOOGLE_ADS_CONVERSION_ACTIONS_QUERY,
  type GoogleAdsConnectionRowForSummary,
  type GoogleAdsConversionAction,
} from "./lib/google-ads-api";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

interface ConnectionRow extends GoogleAdsConnectionRowForSummary {
  id: string;
}

interface ConversionActionsResponse {
  connected: true;
  customerId: string;
  loginCustomerId: string | null;
  actions: GoogleAdsConversionAction[];
}

function errorResponse(headers: Record<string, string>, statusCode: number, errorCode: string) {
  return { statusCode, headers, body: JSON.stringify({ connected: false, error: errorCode }) };
}

export const handler: Handler = async (event) => {
  const requestId = crypto.randomBytes(6).toString("hex");
  const headers = googleAdsCorsHeaders(event, "GET, OPTIONS");
  const logError = (phase: string, extra?: Record<string, unknown>) =>
    console.error(`[google-ads-conversion-actions:${requestId}] ${phase}`, extra ?? {});
  const logInfo = (phase: string, extra?: Record<string, unknown>) =>
    console.log(`[google-ads-conversion-actions:${requestId}] ${phase}`, extra ?? {});

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

  let actions: GoogleAdsConversionAction[];
  try {
    const results = await searchGoogleAds(accessToken, developerToken, selectedCustomerId, GOOGLE_ADS_CONVERSION_ACTIONS_QUERY, loginCustomerId);
    actions = parseGoogleAdsConversionActions(results);
  } catch (e) {
    if (e instanceof GoogleAdsResultLimitExceededError) {
      logError("result_limit_exceeded");
      return errorResponse(headers, 500, "result_limit_exceeded");
    }
    if (e instanceof GoogleAdsApiError) {
      logError("google_ads_api_error", { status: e.status });
      return errorResponse(headers, 500, "google_ads_api_error");
    }
    logError("network_error");
    return errorResponse(headers, 500, "network_error");
  }

  logInfo("ok", { selectedCustomerId, loginCustomerId, actionCount: actions.length });

  const response: ConversionActionsResponse = {
    connected: true,
    customerId: selectedCustomerId,
    loginCustomerId,
    actions,
  };

  return { statusCode: 200, headers, body: JSON.stringify(response) };
};
