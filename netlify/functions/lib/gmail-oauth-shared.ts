// netlify/functions/lib/gmail-oauth-shared.ts
//
// Shared between gmail-oauth-start.ts and gmail-oauth-callback.ts so both
// build the exact same redirect_uri — Google rejects a token exchange
// whose redirect_uri doesn't match the one used in the initial
// authorization request byte-for-byte.
//
// This is the Google-facing OAuth redirect_uri (must exactly match an
// Authorized redirect URI registered on the OAuth client in Google Cloud
// Console) — distinct from settingsRedirect()'s base in
// gmail-oauth-callback.ts, which is where the browser lands *after* the
// callback finishes and follows a different, app-facing priority order
// (APP_LOCAL_URL first) since it's never sent to Google.
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAppConfigs } from "./app-config-store";

export function buildGmailRedirectUri(): string {
  const base =
    process.env.GOOGLE_REDIRECT_BASE_URL ||
    process.env.APP_BASE_URL ||
    process.env.URL ||
    "https://connect.renometa.com";
  return `${base.replace(/\/$/, "")}/.netlify/functions/gmail-oauth-callback`;
}

// Safe, secret-free diagnostics for the "which config actually resolved,
// and from where" class of bug — logs presence booleans and a short
// client-id suffix only, never the client secret or any token. Call from
// both gmail-oauth-start.ts and gmail-oauth-callback.ts so a mismatch
// between what Start used to build the authorize URL and what the
// Callback used for the token exchange (e.g. a stale Netlify env var
// silently overriding an app_config_secrets value for one invocation but
// not the other) is visible directly in the function logs.
//
// Env-footprint reduction (2026-09): GOOGLE_OAUTH_CLIENT_ID/SECRET now
// resolve via app_config_secrets (see google-ads-config.ts's header for
// the same pattern) — this diagnostic reads through getAppConfigs() too,
// via the same effective resolution the handlers use, rather than reading
// process.env directly and silently going stale/misleading once the
// Netlify env var is removed.
export async function logGmailOAuthEnvDiagnostics(supabaseAdmin: SupabaseClient, context: string): Promise<void> {
  const config = await getAppConfigs(supabaseAdmin, ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"]);
  const clientId = config.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = config.GOOGLE_OAUTH_CLIENT_SECRET;
  console.log(`[gmail-oauth:${context}] env diagnostics`, {
    hasClientId: !!clientId,
    hasClientSecret: !!clientSecret,
    // Client IDs aren't secret (they're sent in the browser URL bar during
    // consent), but only the suffix is logged anyway per the "don't print
    // secret values" requirement for this diagnostic pass.
    clientIdSuffix: clientId ? clientId.slice(-24) : null,
    hasGoogleRedirectBaseUrl: !!process.env.GOOGLE_REDIRECT_BASE_URL,
    hasAppLocalUrl: !!process.env.APP_LOCAL_URL,
    hasAppBaseUrl: !!process.env.APP_BASE_URL,
    hasNetlifyUrl: !!process.env.URL,
    resolvedGoogleRedirectUri: buildGmailRedirectUri(),
  });
}
