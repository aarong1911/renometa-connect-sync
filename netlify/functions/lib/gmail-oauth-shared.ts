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
export function buildGmailRedirectUri(): string {
  const base =
    process.env.GOOGLE_REDIRECT_BASE_URL ||
    process.env.APP_BASE_URL ||
    process.env.URL ||
    "https://connect.renometa.com";
  return `${base.replace(/\/$/, "")}/.netlify/functions/gmail-oauth-callback`;
}

// Safe, secret-free diagnostics for the "which env vars actually loaded,
// and what did we resolve from them" class of bug — logs presence booleans
// and a short client-id suffix only, never the client secret or any token.
// Call from both gmail-oauth-start.ts and gmail-oauth-callback.ts so a
// mismatch between what Start used to build the authorize URL and what the
// Callback used for the token exchange (e.g. a Netlify env var silently
// overriding a local .env value between the two invocations) is visible
// directly in the function logs.
export function logGmailOAuthEnvDiagnostics(context: string): void {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
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
