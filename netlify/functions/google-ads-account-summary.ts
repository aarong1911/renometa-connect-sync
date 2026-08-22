// netlify/functions/google-ads-account-summary.ts
//
// Phase 3, first read-only Google Ads API connection test: fetches the
// authenticated organization's SELECTED advertiser's basic account details
// (name, currency, timezone, test/manager flags, status) directly from the
// live Google Ads API. Read-only — makes no write/mutate call to Google at
// all, and does not change selected_customer_id/login_customer_id/status.
//
// All identity comes from resolveOrgFromBearerToken() + the org's
// google_ads_connections row — never from a query param, header, or
// request body. See lib/google-ads-api.ts's preflightGoogleAdsConnection(),
// searchGoogleAds(), and parseGoogleAdsAccountSummary() for the pure logic
// this endpoint is a thin, testable wrapper around.
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
  preflightGoogleAdsConnection,
  GoogleAdsApiError,
  GOOGLE_ADS_ACCOUNT_SUMMARY_QUERY,
  type GoogleAdsConnectionRowForSummary,
} from "./lib/google-ads-api";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

interface ConnectionRow extends GoogleAdsConnectionRowForSummary {
  id: string;
}

function errorResponse(headers: Record<string, string>, statusCode: number, errorCode: string) {
  return { statusCode, headers, body: JSON.stringify({ connected: false, error: errorCode }) };
}

export const handler: Handler = async (event) => {
  const requestId = crypto.randomBytes(6).toString("hex");
  const headers = googleAdsCorsHeaders(event, "GET, OPTIONS");
  const logError = (phase: string, extra?: Record<string, unknown>) =>
    console.error(`[google-ads-account-summary:${requestId}] ${phase}`, extra ?? {});
  const logWarn = (phase: string, extra?: Record<string, unknown>) =>
    console.warn(`[google-ads-account-summary:${requestId}] ${phase}`, extra ?? {});

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
      // Same visibility pattern as google-ads-accounts.ts — a working
      // connection whose refresh token was just discovered to be revoked
      // should show up as needing sync/reconnect, not silently stay
      // "connected". The existing refresh token itself is left untouched
      // (only status/last_error_code are updated) — a transient refresh
      // failure never discards it.
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

  let results: any[];
  try {
    results = await searchGoogleAds(accessToken, developerToken, selectedCustomerId, GOOGLE_ADS_ACCOUNT_SUMMARY_QUERY, loginCustomerId);
  } catch (e) {
    if (e instanceof GoogleAdsApiError) {
      logError("google_ads_api_error", { status: e.status });
    } else {
      logError("network_error");
    }
    return errorResponse(headers, 500, "google_ads_api_error");
  }

  const parsed = parseGoogleAdsAccountSummary(results, selectedCustomerId, loginCustomerId);
  if (!parsed.ok) {
    logError(parsed.reason === "customer_id_mismatch" ? "account_mismatch" : "google_ads_api_error", {
      selectedCustomerId,
      loginCustomerId,
    });
    return errorResponse(headers, 500, parsed.reason === "customer_id_mismatch" ? "account_mismatch" : "google_ads_api_error");
  }

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

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ connected: true, account: parsed.account }),
  };
};
