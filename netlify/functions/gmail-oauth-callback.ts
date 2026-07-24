// netlify/functions/gmail-oauth-callback.ts
//
// Google redirects here (full-page, not a popup) after the user approves
// (or denies) the consent screen opened by gmail-oauth-start.ts. Validates
// the state, exchanges the code for tokens, resolves the connected
// account's email, encrypts and saves the tokens into `integrations`, and
// redirects the browser back to Settings → Integrations with a result.
//
// State single-use enforcement: oauth_states has no separate
// consumed/used-at column, so "already used" is enforced by DELETING the
// row on first successful lookup (in one atomic delete-and-return query) —
// its absence on a replayed/second attempt IS the "already used" signal,
// same as "missing" or "expired".
//
// Never logs token values — only status codes / high-level error messages.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { encryptToBytea } from "./lib/gmail-token-crypto";
import { buildGmailRedirectUri, logGmailOAuthEnvDiagnostics } from "./lib/gmail-oauth-shared";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// App-facing redirect (never sent to Google) — prefers APP_LOCAL_URL so a
// local `netlify dev` session lands back on localhost, but must NEVER fall
// back to localhost in an environment where none of the URL env vars are
// set, since that fallback also applies in production. Falling back to the
// known production app URL is safe either way: a misconfigured local dev
// setup missing every one of these vars would just redirect to production
// instead of silently defaulting to the wrong scheme/host for a real user.
function settingsRedirect(
  status: "success" | "error",
  message?: string,
) {
  const base =
    process.env.APP_LOCAL_URL ||
    process.env.GOOGLE_REDIRECT_BASE_URL ||
    process.env.APP_BASE_URL ||
    process.env.URL ||
    "https://connect.renometa.com";

  const url = new URL(
    "/settings/integrations",
    base.replace(/\/$/, "") + "/",
  );

  url.searchParams.set("gmail", status);

  if (message) {
    url.searchParams.set("gmail_message", message);
  }

  // Safe to log in full — status + a short user-facing message + a URL
  // that never contains tokens or secrets.
  console.log("[gmail-oauth-callback] resolved settings redirect:", url.toString());

  return {
    statusCode: 302,
    headers: {
      Location: url.toString(),
      "Cache-Control": "no-store",
    },
    body: "",
  };
}

export const handler: Handler = async (event) => {
  logGmailOAuthEnvDiagnostics("callback");

  const params = event.queryStringParameters ?? {};
  const { code, state, error: googleError, error_description } = params;

  if (googleError) {
    return settingsRedirect("error", error_description || googleError);
  }
  if (!code || !state) {
    return settingsRedirect("error", "Missing code or state from Google's redirect");
  }

  // Atomically claim + delete the state row.
  const { data: stateRow, error: stateErr } = await supabaseAdmin
    .from("oauth_states")
    .delete()
    .eq("state", state)
    .eq("provider", "gmail")
    .gt("expires_at", new Date().toISOString())
    .select("org_id, user_id")
    .maybeSingle();

  if (stateErr) {
    console.error("[gmail-oauth-callback] state lookup failed:", stateErr.message);
    return settingsRedirect("error", "Could not verify the connection request");
  }
  if (!stateRow) {
    return settingsRedirect("error", "This connection request is invalid, expired, or has already been used — please try connecting again");
  }
  const orgId: string = stateRow.org_id;

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return settingsRedirect("error", "Gmail OAuth is not configured on the server");
  }

  try {
    const redirectUri = buildGmailRedirectUri();
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
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
      // Parse Google's error body for diagnosis — but log/return ONLY
      // `error` and `error_description`, which are Google's own short
      // machine-readable error code and a human-readable explanation
      // (e.g. "invalid_client" / "The provided client secret is
      // invalid."). Never log the response body wholesale — Google's
      // token error responses don't include the code/tokens, but there's
      // no reason to risk it by logging the raw body instead of the two
      // specific safe fields.
      const errJson: any = await tokenRes.json().catch(() => ({}));
      const googleErrorCode: string | undefined = errJson.error;
      const googleErrorDescription: string | undefined = errJson.error_description;
      console.error("[gmail-oauth-callback] token exchange failed", {
        status: tokenRes.status,
        error: googleErrorCode,
        error_description: googleErrorDescription,
      });
      const safeMessage = googleErrorDescription || googleErrorCode || "Google did not return an access token";
      return settingsRedirect("error", safeMessage);
    }
    const tokenJson: any = await tokenRes.json();
    const accessToken: string | undefined = tokenJson.access_token;
    const refreshToken: string | undefined = tokenJson.refresh_token;
    const expiresInSec: number = Number(tokenJson.expires_in) || 3600;

    if (!accessToken) {
      console.error("[gmail-oauth-callback] token response missing access_token");
      return settingsRedirect("error", "Google did not return an access token");
    }

    // Connected account email — used for display only, never for auth.
    let accountEmail: string | null = null;
    try {
      const profileRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (profileRes.ok) {
        const profileJson: any = await profileRes.json();
        accountEmail = profileJson.email ?? null;
      }
    } catch (e: any) {
      console.warn("[gmail-oauth-callback] userinfo fetch failed:", e.message);
    }

    const { data: existing } = await supabaseAdmin
      .from("integrations")
      .select("id, refresh_token_encrypted")
      .eq("org_id", orgId)
      .eq("provider", "gmail")
      .maybeSingle();

    // A connection with no refresh token anywhere (neither returned now nor
    // already on file) can never be renewed once the access token expires
    // — treat that as a failed connection attempt rather than saving
    // something we already know is broken.
    if (!refreshToken && !existing?.refresh_token_encrypted) {
      return settingsRedirect(
        "error",
        "Google did not grant offline access, so this connection can't be kept alive automatically. Please try connecting again.",
      );
    }

    const expiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();

    const payload: Record<string, any> = {
      org_id: orgId,
      provider: "gmail",
      status: "connected",
      access_token_encrypted: encryptToBytea(accessToken),
      token_expires_at: expiresAt,
      provider_account_email: accountEmail,
      last_sync_status: null,
      sync_error: null,
      updated_at: new Date().toISOString(),
    };
    // Only touch refresh_token_encrypted when Google actually returned a
    // new one — omitting the key entirely (rather than writing null)
    // leaves whatever is already stored untouched on reconnect.
    if (refreshToken) {
      payload.refresh_token_encrypted = encryptToBytea(refreshToken);
    }

    if (existing) {
      const { error: updateErr } = await supabaseAdmin.from("integrations").update(payload).eq("id", existing.id);
      if (updateErr) {
        console.error("[gmail-oauth-callback] update failed:", updateErr.message);
        return settingsRedirect("error", "Could not save the Gmail connection");
      }
    } else {
      const { error: insertErr } = await supabaseAdmin.from("integrations").insert(payload);
      if (insertErr) {
        console.error("[gmail-oauth-callback] insert failed:", insertErr.message);
        return settingsRedirect("error", "Could not save the Gmail connection");
      }
    }

    return settingsRedirect("success");
  } catch (err: any) {
    console.error("[gmail-oauth-callback] unhandled error:", err.message);
    return settingsRedirect("error", "Unexpected error connecting Gmail");
  }
};
