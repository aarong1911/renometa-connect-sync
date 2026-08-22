// netlify/functions/google-ads-oauth-callback.ts
//
// Google redirects here (full-page GET, top-level browser navigation — NOT
// a frontend fetch) after the user approves or denies the consent screen
// opened by google-ads-oauth-start.ts. No Supabase bearer token is
// available or required — the only trusted identity comes from the signed
// `state` param minted by google-ads-oauth-start.ts and verified via
// lib/google-ads-oauth-state.ts. Query-param userId/orgId are never
// accepted; Google never sends any in the first place, but this is called
// out explicitly since it's the core trust rule for this file.
//
// Flow: verify state -> re-confirm user still exists & still belongs to
// the org -> atomically consume the state nonce (replay guard) -> handle
// Google denial/error -> exchange code for tokens -> resolve the effective
// encrypted refresh token explicitly (new vs. preserved-as-is, never via
// upsert-omission semantics) -> discover accessible Google Ads accounts ->
// explicit insert-or-update of google_ads_connections -> redirect to a
// server-configured Integrations URL with a short, non-sensitive result
// code.
//
// Never logs: authorization code, access token, refresh token, client
// secret, developer token, encryption key, signed state, raw nonce, full
// Google response bodies, or provider error_description text.

import type { Handler } from "@netlify/functions";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { verifyGoogleAdsOAuthState } from "./lib/google-ads-oauth-state";
import { userBelongsToOrg } from "./lib/resolve-org";
import { encryptToBytea } from "./lib/gmail-token-crypto";
import {
  listAccessibleCustomers,
  discoverGoogleAdsAccounts,
  deriveGoogleAdsSelectionState,
  fetchWithTimeout,
  type GoogleAdsConnectionStatus,
} from "./lib/google-ads-api";

// Only ever redirect the browser back to one of these two origins — never a
// return URL sourced from a query param or from inside the signed state.
const ALLOWED_REDIRECT_ORIGINS = new Set([
  "http://localhost:5173",
  "http://localhost:9999",
  "https://connect.renometa.com",
]);

// Resolves the app-facing URL to send the browser back to after this
// callback finishes. Priority: GOOGLE_ADS_POST_CONNECT_URL (introduced for
// this feature, expected to already include the /settings/integrations
// path) -> the repo's existing app-base-URL convention (CONNECT_APP_URL,
// same var change-order-send.ts/estimate-send.ts already use) with
// /settings/integrations appended -> a hardcoded safe production default.
// Every candidate's origin is validated against ALLOWED_REDIRECT_ORIGINS
// before use — a misconfigured env var (e.g. pointed at :9999, the Netlify
// Functions dev port, which is intentionally NOT in the allowlist) falls
// through to the safe default rather than ever being trusted verbatim.
export function resolvePostConnectUrl(): URL {
  const configured = process.env.GOOGLE_ADS_POST_CONNECT_URL;
  if (configured) {
    try {
      const u = new URL(configured);
      if (ALLOWED_REDIRECT_ORIGINS.has(u.origin)) return u;
    } catch {
      // fall through to the next candidate
    }
  }

  const appBase = process.env.CONNECT_APP_URL || process.env.APP_BASE_URL;
  if (appBase) {
    try {
      const u = new URL(appBase);
      if (ALLOWED_REDIRECT_ORIGINS.has(u.origin)) {
        return new URL("/settings/integrations", u.origin);
      }
    } catch {
      // fall through to the safe default
    }
  }

  return new URL("https://connect.renometa.com/settings/integrations");
}

function integrationsRedirect(code: string, reason?: string) {
  const url = resolvePostConnectUrl();
  url.searchParams.set("google_ads", code);
  if (reason) url.searchParams.set("reason", reason);
  return {
    statusCode: 302,
    headers: {
      Location: url.toString(),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
    body: "",
  };
}

export const handler: Handler = async (event) => {
  const requestId = crypto.randomBytes(6).toString("hex");
  const log = (phase: string, extra?: Record<string, unknown>) =>
    console.log(`[google-ads-oauth-callback:${requestId}] ${phase}`, extra ?? {});
  const warn = (phase: string, extra?: Record<string, unknown>) =>
    console.warn(`[google-ads-oauth-callback:${requestId}] ${phase}`, extra ?? {});
  const err = (phase: string, extra?: Record<string, unknown>) =>
    console.error(`[google-ads-oauth-callback:${requestId}] ${phase}`, extra ?? {});

  if (event.httpMethod !== "GET") {
    return integrationsRedirect("error", "server_configuration");
  }

  // ── 1. Validate configuration BEFORE constructing the Supabase client or
  // touching the request further. Never reveal which specific var(s) are
  // missing in the response — only in the log, and only as booleans.
  const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_ADS_REDIRECT_URI;
  const stateSecret = process.env.GOOGLE_ADS_OAUTH_STATE_SECRET;
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const encryptionKey = process.env.ENCRYPTION_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (
    !clientId || !clientSecret || !redirectUri || !stateSecret ||
    !developerToken || !encryptionKey || !supabaseUrl || !supabaseServiceRoleKey
  ) {
    err("state_verification", {
      hasClientId: !!clientId,
      hasClientSecret: !!clientSecret,
      hasRedirectUri: !!redirectUri,
      hasStateSecret: !!stateSecret,
      hasDeveloperToken: !!developerToken,
      hasEncryptionKey: !!encryptionKey,
      hasSupabaseUrl: !!supabaseUrl,
      hasSupabaseServiceRoleKey: !!supabaseServiceRoleKey,
    });
    return integrationsRedirect("error", "server_configuration");
  }

  const supabaseAdmin: SupabaseClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const params = event.queryStringParameters ?? {};
  const { code, state, error: googleError, error_description: _errorDescription } = params;

  // ── 2. Verify state FIRST — before trusting/acting on code, error, or
  // error_description in any way.
  if (!state) {
    warn("state_verification", { present: false });
    return integrationsRedirect("error", "invalid_state");
  }

  let statePayload: ReturnType<typeof verifyGoogleAdsOAuthState>;
  try {
    statePayload = verifyGoogleAdsOAuthState(state, stateSecret);
  } catch (e: any) {
    // e.message is one of the generic strings from google-ads-oauth-state.ts
    // ("Invalid OAuth state" / "Invalid OAuth state signature" / "Expired
    // OAuth state") — safe to log, never the state itself.
    warn("state_verification", { reason: e?.message });
    return integrationsRedirect("error", "invalid_state");
  }
  const { userId, orgId, nonce, intent } = statePayload;

  // ── 3. Re-confirm, server-side, that the user still exists and still
  // belongs to this org — the signed state could be up to 10 minutes old,
  // and membership may have been revoked since it was issued.
  const { data: userLookup, error: userLookupErr } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (userLookupErr || !userLookup?.user) {
    warn("state_verification", { reason: "user_not_found" });
    return integrationsRedirect("error", "invalid_state");
  }
  const stillMember = await userBelongsToOrg(supabaseAdmin, userId, orgId);
  if (!stillMember) {
    warn("state_verification", { reason: "not_org_member", orgId });
    return integrationsRedirect("error", "invalid_state");
  }

  // ── 4. Atomically consume the nonce BEFORE exchanging the code. The
  // primary-key uniqueness constraint on google_ads_oauth_nonces.nonce_hash
  // is what makes a replayed callback (same nonce twice) fail — this is a
  // write-time decision made by the database, not a read-then-write check
  // in application code, so a concurrent duplicate can't race past it.
  const nonceHash = crypto.createHash("sha256").update(nonce).digest("hex");
  const { error: nonceErr } = await supabaseAdmin.from("google_ads_oauth_nonces").insert({
    nonce_hash: nonceHash,
    organization_id: orgId,
    user_id: userId,
    expires_at: new Date(statePayload.exp).toISOString(),
  });
  if (nonceErr) {
    if (nonceErr.code === "23505") {
      // Unique-constraint violation = this nonce was already consumed —
      // treat exactly like an invalid/expired state. A failed exchange
      // here just means the user starts OAuth again, which is safe.
      warn("state_verification", { reason: "nonce_replay" });
      return integrationsRedirect("error", "invalid_state");
    }
    err("state_verification", { reason: "nonce_insert_failed", code: nonceErr.code });
    return integrationsRedirect("error", "server_configuration");
  }

  // ── 5. Handle Google denial/errors — only AFTER state is verified and the
  // nonce is consumed, so a forged/replayed error callback can't reach here.
  if (googleError) {
    if (googleError === "access_denied") {
      log("provider_error", { error: "access_denied" });
      return integrationsRedirect("cancelled");
    }
    warn("provider_error", { error: googleError });
    return integrationsRedirect("error", "provider_error");
  }
  if (!code) {
    warn("provider_error", { reason: "missing_code" });
    return integrationsRedirect("error", "provider_error");
  }

  // ── 6. Exchange the authorization code for tokens.
  let tokenJson: any;
  try {
    const tokenRes = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) {
      const errJson: any = await tokenRes.json().catch(() => ({}));
      // Google's own short machine-readable error code only — never the
      // full body, never error_description (may contain account-specific
      // detail we don't want in logs).
      err("token_exchange", { status: tokenRes.status, error: errJson?.error });
      return integrationsRedirect("error", "token_exchange");
    }
    tokenJson = await tokenRes.json();
  } catch (e: any) {
    err("token_exchange", { reason: e?.name === "AbortError" ? "timeout" : "network_error" });
    return integrationsRedirect("error", "token_exchange");
  }

  const accessToken: string | undefined = tokenJson.access_token;
  const refreshToken: string | undefined = tokenJson.refresh_token;
  const expiresInSec = Number(tokenJson.expires_in) || 3600;
  const tokenType: string = typeof tokenJson.token_type === "string" ? tokenJson.token_type : "Bearer";
  const grantedScopes: string[] = typeof tokenJson.scope === "string" ? tokenJson.scope.split(" ").filter(Boolean) : [];

  if (!accessToken) {
    err("token_exchange", { reason: "missing_access_token" });
    return integrationsRedirect("error", "token_exchange");
  }

  // ── 7. Look up any existing connection for this org, then resolve the
  // EFFECTIVE encrypted refresh token explicitly — never by relying on
  // upsert/PostgREST column-omission semantics to "preserve" a value.
  //
  // - If Google returned a new refresh_token this run, that (freshly
  //   encrypted) value always wins.
  // - Otherwise, if an existing connection already has one, its encrypted
  //   value is reused UNCHANGED — read straight from the DB and written
  //   back as-is, never decrypted, never re-encrypted.
  // - If neither exists, there is no renewable connection to save.
  //
  // This value is then included in the payload explicitly and
  // unconditionally below (never omitted, never null/empty/undefined),
  // so persistence behavior doesn't depend on whatever PostgREST's
  // upsert-column-merge semantics happen to be.
  const { data: existing } = await supabaseAdmin
    .from("google_ads_connections")
    .select("id, encrypted_refresh_token")
    .eq("organization_id", orgId)
    .maybeSingle();

  // `||` (not `??`) on both sides deliberately treats an empty string the
  // same as null/undefined — encryptToBytea never produces "" and a real
  // bytea column should never read back as "", but this guarantees an
  // empty string can never slip through as if it were a usable value.
  const newlyEncryptedRefreshToken: string | null = refreshToken ? encryptToBytea(refreshToken) : null;
  const existingEncryptedRefreshToken: string | null = existing?.encrypted_refresh_token || null;

  // Reconnect + Disconnect phase, Step 8 — an EXPLICIT reconnect must never
  // silently keep operating against the OLD Google identity/hierarchy just
  // because Google happened not to return a fresh refresh_token this run.
  // Falling back to `existingEncryptedRefreshToken` here would make the UI
  // report "reconnected" while every subsequent API call is still using the
  // previous authorization — exactly the failure mode this phase exists to
  // prevent. Nothing is written to the connection row on this path; the
  // organization's existing (old) connection is left completely untouched,
  // so it keeps working normally until the user successfully reconnects.
  if (intent === "reconnect" && !newlyEncryptedRefreshToken) {
    warn("token_exchange", { reason: "reconnect_missing_new_refresh_token" });
    return integrationsRedirect("error", "reconnect_requires_consent");
  }

  const effectiveEncryptedRefreshToken: string | null =
    newlyEncryptedRefreshToken || existingEncryptedRefreshToken;

  if (!effectiveEncryptedRefreshToken) {
    // No refresh token anywhere (neither returned now nor already on
    // file) — this connection could never be renewed once the access
    // token expires. Fail safely rather than saving something already
    // known to be broken.
    err("token_exchange", { reason: "missing_refresh_token" });
    return integrationsRedirect("error", "token_exchange");
  }

  // ── 8. Discover accessible Google Ads accounts. A failure here must NOT
  // discard the resolved refresh token — the connection is still saved,
  // just with status "needs_account_sync" so the UI can show "authorized,
  // but account retrieval needs retrying." Selection fields are always
  // freshly derived from THIS run's discovery — an ambiguous or empty
  // result here does not fall back to any prior selection; it is null
  // until a single advertiser is unambiguously found (or the user picks
  // one, once selection UI exists).
  let status: GoogleAdsConnectionStatus = "needs_account_sync";
  let accessibleCustomerIds: string[] = [];
  let selectedCustomerId: string | null = null;
  let loginCustomerId: string | null = null;
  let lastErrorCode: string | null = null;
  let discoverySucceeded = false;

  try {
    const directCustomerIds = await listAccessibleCustomers(accessToken, developerToken);
    if (directCustomerIds.length === 0) {
      lastErrorCode = "no_accessible_customers";
    } else {
      const { accounts, failedCustomerIds } = await discoverGoogleAdsAccounts(accessToken, developerToken, directCustomerIds);
      discoverySucceeded = true;

      const seen = new Set<string>(accounts.map((a) => a.customerId));
      accessibleCustomerIds = accounts.map((a) => a.customerId);
      for (const id of directCustomerIds) {
        if (!seen.has(id)) accessibleCustomerIds.push(id);
      }

      const selection = deriveGoogleAdsSelectionState(accounts);
      status = selection.status;
      selectedCustomerId = selection.selectedCustomerId;
      loginCustomerId = selection.loginCustomerId;
      lastErrorCode = selection.lastErrorCode;

      if (failedCustomerIds.length > 0) {
        log("account_discovery", { failedCount: failedCustomerIds.length, totalRoots: directCustomerIds.length });
      }
    }
  } catch {
    status = "needs_account_sync";
    lastErrorCode = "account_discovery_failed";
    warn("account_discovery", { reason: "unhandled_error" });
  }

  // ── 9. Persist. Never store the access token — it's only used
  // transiently within this callback for account discovery. The effective
  // encrypted refresh token resolved in step 7 is always included
  // explicitly, never omitted.
  const nowIso = new Date().toISOString();
  const payload: Record<string, any> = {
    organization_id: orgId,
    connected_by_user_id: userId,
    provider: "google_ads",
    status,
    encrypted_refresh_token: effectiveEncryptedRefreshToken,
    granted_scopes: grantedScopes,
    token_type: tokenType,
    access_token_expires_at: new Date(Date.now() + expiresInSec * 1000).toISOString(),
    accessible_customer_ids: accessibleCustomerIds,
    selected_customer_id: selectedCustomerId,
    login_customer_id: loginCustomerId,
    last_error_code: lastErrorCode,
    updated_at: nowIso,
  };
  if (discoverySucceeded) payload.last_synced_at = nowIso;

  // Explicit insert-or-update by id (proven column-for-column behavior)
  // rather than a single .upsert() call, so persistence never depends on
  // PostgREST's upsert/merge-duplicates column semantics — an UPDATE only
  // ever touches the columns present in `payload`, which already includes
  // every column this function is responsible for on every path.
  const { error: writeErr } = existing
    ? await supabaseAdmin.from("google_ads_connections").update(payload).eq("id", existing.id)
    : await supabaseAdmin.from("google_ads_connections").insert(payload);

  if (writeErr) {
    err("account_discovery", { reason: "connection_write_failed", code: writeErr.code });
    return integrationsRedirect("error", "server_configuration");
  }

  log("account_discovery", { status, accountCount: accessibleCustomerIds.length, orgId });

  if (status === "connected") return integrationsRedirect("connected");
  if (status === "needs_account_selection") return integrationsRedirect("select_account");
  return integrationsRedirect("sync_pending");
};
