// netlify/functions/google-ads-select-account.ts
//
// Authenticated advertiser-selection endpoint — the final step of the
// Google Ads OAuth flow's "select_account" branch. Accepts ONLY a
// customerId from the browser; every other fact used to persist the
// selection (loginCustomerId, manager status, organization, user) is
// resolved/validated server-side against a fresh live discovery call, never
// trusted from the request body or from the connection's previously-stored
// accessible_customer_ids.
//
// Never logs or returns: the encrypted or decrypted refresh token, the
// temporary access token, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_DEVELOPER_TOKEN,
// or the full internal connection row.

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
  validateSelectableAdvertiser,
} from "./lib/google-ads-api";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

interface ConnectionRow {
  id: string;
  encrypted_refresh_token: string;
}

export const handler: Handler = async (event) => {
  const requestId = crypto.randomBytes(6).toString("hex");
  const headers = googleAdsCorsHeaders(event, "POST, OPTIONS");
  const log = (phase: string, extra?: Record<string, unknown>) =>
    console.error(`[google-ads-select-account:${requestId}] ${phase}`, extra ?? {});

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!developerToken) {
    log("server_configuration", { hasDeveloperToken: false });
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Google Ads is not configured on the server" }) };
  }

  const resolved = await resolveOrgFromBearerToken(supabaseAdmin, event.headers.authorization);
  if (!resolved) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  }
  const { orgId } = resolved;

  // Parse ONLY customerId — loginCustomerId/manager/orgId/userId are never
  // accepted from the browser, by construction (nothing else is even read
  // from reqBody below).
  let reqBody: { customerId?: unknown };
  try {
    reqBody = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }
  const submittedCustomerId = normalizeGoogleAdsCustomerId(
    typeof reqBody.customerId === "string" ? reqBody.customerId : null,
  );
  if (!submittedCustomerId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "A valid digit-only customerId is required" }) };
  }

  const { data: connection, error: connErr } = (await supabaseAdmin
    .from("google_ads_connections")
    .select("id, encrypted_refresh_token")
    .eq("organization_id", orgId)
    .maybeSingle()) as unknown as { data: ConnectionRow | null; error: any };

  if (connErr) {
    log("connection_lookup_failed", { code: connErr.code });
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Could not look up your Google Ads connection" }) };
  }
  if (!connection) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "No Google Ads connection found for this organization" }) };
  }

  let refreshTokenPlain: string;
  try {
    refreshTokenPlain = decryptBytea(connection.encrypted_refresh_token);
  } catch {
    log("decrypt_failed");
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Could not read your Google Ads connection" }) };
  }

  const tokenResult = await refreshGoogleAdsAccessToken(refreshTokenPlain);
  if (!tokenResult.ok) {
    if (tokenResult.errorCode === "reconnect_required") {
      await supabaseAdmin
        .from("google_ads_connections")
        .update({ status: "needs_account_sync", last_error_code: "reconnect_required", updated_at: new Date().toISOString() })
        .eq("id", connection.id)
        .eq("organization_id", orgId);
      return { statusCode: 409, headers, body: JSON.stringify({ error: "Your Google Ads authorization has expired — please reconnect" }) };
    }
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Could not verify your Google Ads accounts right now — please try again" }) };
  }
  const { accessToken } = tokenResult;

  // Validate the submission against a FRESH live discovery result — never
  // against the request body alone and never against the connection's
  // previously-stored accessible_customer_ids (which could be stale).
  let mergedIds: string[];
  let validation: ReturnType<typeof validateSelectableAdvertiser>;
  try {
    const directCustomerIds = await listAccessibleCustomers(accessToken, developerToken);
    const { accounts } = await discoverGoogleAdsAccounts(accessToken, developerToken, directCustomerIds);
    const seen = new Set(accounts.map((a) => a.customerId));
    mergedIds = accounts.map((a) => a.customerId);
    for (const id of directCustomerIds) {
      if (!seen.has(id)) mergedIds.push(id);
    }
    validation = validateSelectableAdvertiser(accounts, submittedCustomerId);
  } catch {
    log("account_discovery_failed");
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Could not verify your Google Ads accounts right now — please try again" }) };
  }

  if (!validation.ok) {
    const message = validation.reason === "manager_not_selectable"
      ? "Manager accounts cannot be selected — choose an advertiser account"
      : "That Google Ads account is not accessible from this connection";
    return { statusCode: 400, headers, body: JSON.stringify({ error: message }) };
  }
  const match = validation.account;

  const loginCustomerId = normalizeGoogleAdsCustomerId(match.loginCustomerId);
  const nowIso = new Date().toISOString();

  // Organization-scoped, id-scoped update — both conditions guard against a
  // concurrent disconnect/reconnect changing the row out from under this
  // request between the initial lookup and this write.
  const { data: updated, error: updateErr } = await supabaseAdmin
    .from("google_ads_connections")
    .update({
      selected_customer_id: submittedCustomerId,
      login_customer_id: loginCustomerId,
      status: "connected",
      accessible_customer_ids: Array.from(new Set(mergedIds)),
      last_synced_at: nowIso,
      last_error_code: null,
      // Real-Account Isolation Verification phase — lead_last_synced_at/
      // lead_last_error_code are written by google-ads-lead-sync.ts every
      // time a lead sync runs, always against whichever customer was
      // selected AT THAT TIME (see that file's operational-bookkeeping
      // update) — they describe "the selected advertiser's last sync",
      // not the OAuth connection globally. Left stale across an account
      // switch, they'd show a real timestamp/status from the PREVIOUS
      // advertiser under the newly selected one, before it has ever been
      // synced itself. Reset to null here so a freshly selected advertiser
      // starts from an honest "never synced" state rather than borrowing
      // the old advertiser's sync history. This never touches historical
      // submissions/events/mappings — only this per-connection metadata.
      lead_last_synced_at: null,
      lead_last_error_code: null,
      updated_at: nowIso,
    })
    .eq("id", connection.id)
    .eq("organization_id", orgId)
    .select("id")
    .maybeSingle();

  if (updateErr) {
    log("update_failed", { code: updateErr.code });
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Could not save your account selection" }) };
  }
  if (!updated) {
    // The connection changed (disconnected/reconnected) between the lookup
    // above and this write — safer to ask the user to retry than to write
    // a selection against a row that may no longer represent this org.
    return { statusCode: 409, headers, body: JSON.stringify({ error: "Your Google Ads connection changed — please try again" }) };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      status: "connected",
      account: {
        customerId: submittedCustomerId,
        descriptiveName: match.descriptiveName,
        loginCustomerId,
        testAccount: match.isTestAccount,
      },
    }),
  };
};
