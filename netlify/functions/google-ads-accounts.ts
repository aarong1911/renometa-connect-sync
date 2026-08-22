// netlify/functions/google-ads-accounts.ts
//
// Authenticated, on-demand Google Ads account-metadata discovery — powers
// the account-selection UI (Settings → Integrations → Google Ads drawer)
// and the "retry sync" action for a needs_account_sync connection. Decrypts
// the org's stored refresh token server-side, exchanges it for a temporary
// access token (never persisted — see lib/google-ads-oauth-token.ts),
// rediscovers accessible accounts via lib/google-ads-api.ts, and returns
// safe metadata only. Does not change selected_customer_id — see
// google-ads-select-account.ts for that.
//
// Never logs or returns: the encrypted or decrypted refresh token, the
// temporary access token, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_DEVELOPER_TOKEN,
// or a raw Google response body.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { googleAdsCorsHeaders } from "./lib/google-ads-cors";
import { decryptBytea } from "./lib/gmail-token-crypto";
import { refreshGoogleAdsAccessToken } from "./lib/google-ads-oauth-token";
import {
  listAccessibleCustomers,
  discoverGoogleAdsAccounts,
  normalizeGoogleAdsCustomerId,
  type GoogleAdsCustomerClient,
} from "./lib/google-ads-api";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

interface SafeGoogleAdsAccount {
  customerId: string;
  descriptiveName: string | null;
  manager: boolean;
  testAccount: boolean | null;
  status: string | null;
  currencyCode: string | null;
  timeZone: string | null;
  loginCustomerId: string | null;
  level: number | null;
}

function toSafeAccount(a: GoogleAdsCustomerClient): SafeGoogleAdsAccount | null {
  const customerId = normalizeGoogleAdsCustomerId(a.customerId);
  if (!customerId) return null;
  return {
    customerId,
    descriptiveName: a.descriptiveName,
    manager: a.isManager,
    testAccount: a.isTestAccount,
    status: a.status,
    currencyCode: a.currencyCode,
    timeZone: a.timeZone,
    loginCustomerId: normalizeGoogleAdsCustomerId(a.loginCustomerId),
    level: Number.isFinite(a.level) ? a.level : null,
  };
}

function sortAccounts(accounts: SafeGoogleAdsAccount[]): SafeGoogleAdsAccount[] {
  return [...accounts].sort((x, y) => {
    const byName = (x.descriptiveName ?? "").localeCompare(y.descriptiveName ?? "");
    if (byName !== 0) return byName;
    return x.customerId.localeCompare(y.customerId);
  });
}

interface ConnectionRow {
  id: string;
  encrypted_refresh_token: string;
}

export const handler: Handler = async (event) => {
  const requestId = crypto.randomBytes(6).toString("hex");
  const headers = googleAdsCorsHeaders(event, "GET, OPTIONS");
  const log = (phase: string, extra?: Record<string, unknown>) =>
    console.error(`[google-ads-accounts:${requestId}] ${phase}`, extra ?? {});

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!developerToken) {
    log("server_configuration", { hasDeveloperToken: false });
    return { statusCode: 500, headers, body: JSON.stringify({ status: "error", reason: "server_configuration" }) };
  }

  const resolved = await resolveOrgFromBearerToken(supabaseAdmin, event.headers.authorization);
  if (!resolved) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  }
  const { orgId } = resolved;

  const { data: connection, error: connErr } = (await supabaseAdmin
    .from("google_ads_connections")
    .select("id, encrypted_refresh_token")
    .eq("organization_id", orgId)
    .maybeSingle()) as unknown as { data: ConnectionRow | null; error: any };

  if (connErr) {
    log("connection_lookup_failed", { code: connErr.code });
    return { statusCode: 500, headers, body: JSON.stringify({ status: "error", reason: "server_configuration" }) };
  }
  if (!connection) {
    return { statusCode: 200, headers, body: JSON.stringify({ status: "disconnected", accounts: [], advertisers: [], managers: [] }) };
  }

  let refreshTokenPlain: string;
  try {
    refreshTokenPlain = decryptBytea(connection.encrypted_refresh_token);
  } catch {
    log("decrypt_failed");
    return { statusCode: 500, headers, body: JSON.stringify({ status: "error", reason: "server_configuration" }) };
  }

  const tokenResult = await refreshGoogleAdsAccessToken(refreshTokenPlain);
  if (!tokenResult.ok) {
    if (tokenResult.errorCode === "reconnect_required") {
      // Persist visibility into the connection row — a working connection
      // whose refresh token was just discovered to be revoked should show
      // up as needing sync/reconnect, not silently stay "connected".
      await supabaseAdmin
        .from("google_ads_connections")
        .update({ status: "needs_account_sync", last_error_code: "reconnect_required", updated_at: new Date().toISOString() })
        .eq("id", connection.id)
        .eq("organization_id", orgId);
      return { statusCode: 200, headers, body: JSON.stringify({ status: "reconnect_required", accounts: [], advertisers: [], managers: [] }) };
    }
    return { statusCode: 500, headers, body: JSON.stringify({ status: "error", reason: "token_refresh_failed" }) };
  }
  const { accessToken } = tokenResult;

  let discoveredAccounts: GoogleAdsCustomerClient[];
  let mergedIds: string[];
  try {
    const directCustomerIds = await listAccessibleCustomers(accessToken, developerToken);
    if (directCustomerIds.length === 0) {
      await supabaseAdmin
        .from("google_ads_connections")
        .update({ last_error_code: "no_accessible_customers", updated_at: new Date().toISOString() })
        .eq("id", connection.id)
        .eq("organization_id", orgId);
      return { statusCode: 200, headers, body: JSON.stringify({ status: "ok", accounts: [], advertisers: [], managers: [] }) };
    }
    const { accounts } = await discoverGoogleAdsAccounts(accessToken, developerToken, directCustomerIds);
    discoveredAccounts = accounts;
    const seen = new Set(accounts.map((a) => a.customerId));
    mergedIds = accounts.map((a) => a.customerId);
    for (const id of directCustomerIds) {
      if (!seen.has(id)) mergedIds.push(id);
    }
  } catch {
    log("account_discovery_failed");
    await supabaseAdmin
      .from("google_ads_connections")
      .update({ last_error_code: "account_discovery_failed", updated_at: new Date().toISOString() })
      .eq("id", connection.id)
      .eq("organization_id", orgId);
    return { statusCode: 500, headers, body: JSON.stringify({ status: "error", reason: "account_discovery_failed" }) };
  }

  const safeAccounts = discoveredAccounts
    .map(toSafeAccount)
    .filter((a): a is SafeGoogleAdsAccount => a !== null);
  // Dedupe by customerId (discoverGoogleAdsAccounts already dedupes across
  // roots, but this is defense-in-depth against a future change there).
  const dedupedById = new Map<string, SafeGoogleAdsAccount>();
  for (const a of safeAccounts) dedupedById.set(a.customerId, a);
  const dedupedAccounts = Array.from(dedupedById.values());

  const advertisers = sortAccounts(dedupedAccounts.filter((a) => a.manager === false));
  const managers = sortAccounts(dedupedAccounts.filter((a) => a.manager === true));

  await supabaseAdmin
    .from("google_ads_connections")
    .update({
      accessible_customer_ids: Array.from(new Set(mergedIds)),
      last_synced_at: new Date().toISOString(),
      last_error_code: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", connection.id)
    .eq("organization_id", orgId);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ status: "ok", accounts: dedupedAccounts, advertisers, managers }),
  };
};
