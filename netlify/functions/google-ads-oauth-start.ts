// netlify/functions/google-ads-oauth-start.ts
//
// Entry point for connecting Google Ads. Called via authenticated fetch
// from Settings → Integrations (Google Ads card) — the client sends its
// Supabase session token, this resolves the org server-side, signs an
// HMAC-protected `state`, and returns Google's authorization URL for the
// browser to navigate to itself (window.location.assign). Mirrors the
// signed-state pattern used by meta-oauth-start.ts, adapted to a JSON
// API + bearer-auth shape like gmail-oauth-start.ts (Google Ads has no
// analog to Meta's org/user query-param popup flow — this is a same-tab
// redirect, so the org/user must come from a verified session, not the URL).
//
// This function only starts the flow — it does not exchange the code or
// persist a connection. That is the (not-yet-built) google-ads-oauth-callback.ts.
//
// Required env vars: GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_REDIRECT_URI,
// GOOGLE_ADS_OAUTH_STATE_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import {
  signGoogleAdsOAuthState,
  type GoogleAdsOAuthStatePayload,
  type GoogleAdsOAuthIntent,
} from "./lib/google-ads-oauth-state";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "http://localhost:9999",
  "https://connect.renometa.com",
]);

function corsHeaders(event: Parameters<Handler>[0]) {
  const requestOrigin = event.headers.origin ?? event.headers.Origin;
  const origin = requestOrigin && ALLOWED_ORIGINS.has(requestOrigin) ? requestOrigin : "";
  return {
    "Content-Type": "application/json",
    ...(origin ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" } : {}),
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes, per spec — never longer

export const handler: Handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const resolved = await resolveOrgFromBearerToken(supabaseAdmin, event.headers.authorization);
  if (!resolved) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  }
  const { userId, orgId } = resolved;

  // Reconnect + Disconnect phase — the ONLY value ever accepted here is a
  // strict-whitelisted `intent`; everything else that matters (userId,
  // orgId) still comes exclusively from the resolved session above, never
  // the request body.
  let reqBody: { intent?: unknown } = {};
  try {
    reqBody = event.body ? JSON.parse(event.body) : {};
  } catch {
    // Malformed body just falls back to the default "connect" intent below
    // rather than failing the whole request — intent is the only thing
    // ever read from it.
  }
  const intent: GoogleAdsOAuthIntent = reqBody.intent === "reconnect" ? "reconnect" : "connect";

  const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_ADS_REDIRECT_URI;
  const stateSecret = process.env.GOOGLE_ADS_OAUTH_STATE_SECRET;
  if (!clientId || !redirectUri || !stateSecret) {
    console.error("[google-ads-oauth-start] missing required env var(s)");
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Google Ads OAuth is not configured on the server" }) };
  }

  const nonce = crypto.randomBytes(16).toString("hex");
  const issuedAt = Date.now();
  const statePayload: GoogleAdsOAuthStatePayload = {
    userId,
    orgId,
    nonce,
    iat: issuedAt,
    exp: issuedAt + STATE_TTL_MS,
    intent,
  };
  const state = signGoogleAdsOAuthState(statePayload, stateSecret);

  // Normal connect keeps the existing behavior unchanged: `prompt=consent`
  // alone (Google already returns a fresh refresh_token on every such
  // authorization, since re-consent is forced regardless of any existing
  // session). An explicit RECONNECT additionally adds `select_account` —
  // Google's own documented, supported space-delimited `prompt` value list
  // (https://developers.google.com/identity/protocols/oauth2/web-server#creatingclient)
  // — so a user whose browser is still signed into the OLD Google identity
  // is shown an account chooser instead of silently re-consenting as the
  // same account, making it possible to actually authorize a different
  // Google identity/manager hierarchy.
  const prompt = intent === "reconnect" ? "consent select_account" : "consent";

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/adwords openid email profile",
    access_type: "offline",
    prompt,
    include_granted_scopes: "true",
    state,
  });
  authUrl.search = params.toString();

  return { statusCode: 200, headers, body: JSON.stringify({ authorizationUrl: authUrl.toString() }) };
};
