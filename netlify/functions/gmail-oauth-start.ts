// netlify/functions/gmail-oauth-start.ts
//
// Entry point for connecting Gmail. Unlike meta-oauth-start.ts (which is
// opened directly as a full-page/popup redirect target with orgId/userId
// passed as query params and no auth check of its own), this is a JSON API
// called via authenticated fetch from Settings → Integrations — the client
// calls this with its Supabase session token, gets back a Google
// authorization URL, and navigates the browser there itself
// (window.location.href = url). This lets us resolve the org from a real
// authenticated user rather than trusting client-supplied ids.
//
// Required env vars: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_GMAIL_SCOPES, and one of
// GOOGLE_REDIRECT_BASE_URL / APP_BASE_URL / URL to build the callback URL
// (see buildRedirectUri below) — must exactly match what
// gmail-oauth-callback.ts uses, and must be registered as an authorized
// redirect URI in Google Cloud Console.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { buildGmailRedirectUri, logGmailOAuthEnvDiagnostics } from "./lib/gmail-oauth-shared";
import { getAppConfig } from "./lib/app-config-store";
import { resolveIntegrationManager } from "./lib/resolve-org";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export const handler: Handler = async (event) => {
  await logGmailOAuthEnvDiagnostics(supabaseAdmin, "start");

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // Org resolved server-side (profiles.organization_id first,
  // org_memberships fallback — same precedence as gmail-sync.ts), and only
  // the org owner may connect or replace the org's Gmail account.
  const resolved = await resolveIntegrationManager(supabaseAdmin, event.headers.authorization);
  if (!resolved.ok) {
    return { statusCode: resolved.statusCode, headers: CORS, body: JSON.stringify({ error: resolved.error }) };
  }
  const { orgId, userId } = resolved;

  // Env-footprint reduction (2026-09) — see google-ads-config.ts's header;
  // supabaseAdmin already exists at module scope above.
  const clientId = await getAppConfig(supabaseAdmin, "GOOGLE_OAUTH_CLIENT_ID");
  const scopes = process.env.GOOGLE_GMAIL_SCOPES;
  if (!clientId || !scopes) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Gmail OAuth is not configured on the server" }) };
  }

  const state = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + STATE_TTL_MS).toISOString();

  const { error: insertErr } = await supabaseAdmin.from("oauth_states").insert({
    state,
    provider: "gmail",
    org_id: orgId,
    user_id: userId,
    expires_at: expiresAt,
  });
  if (insertErr) {
    console.error("[gmail-oauth-start] failed to persist state:", insertErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Could not start the Gmail connection" }) };
  }

  const redirectUri = buildGmailRedirectUri();
  const authUrl =
    `https://accounts.google.com/o/oauth2/v2/auth` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    // offline + consent is the combination Google documents as reliably
    // returning a refresh_token — without prompt=consent, a user who has
    // already granted this app access once (e.g. reconnecting) will NOT
    // get a new refresh_token issued at all.
    `&access_type=offline` +
    `&prompt=consent` +
    `&include_granted_scopes=true` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&state=${encodeURIComponent(state)}`;

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ url: authUrl }) };
};
