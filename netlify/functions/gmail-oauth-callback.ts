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
import { getAppConfigs } from "./lib/app-config-store";
import { GMAIL_SYNC_AUTH_ERROR } from "./lib/gmail-sync-health";
import { INTEGRATION_OWNER_ONLY_ERROR, resolveOrgAndAuthority } from "./lib/resolve-org";
import { fetchGmailAccountEmail } from "./lib/gmail-send";

// Google's consent screen lets the user untick individual permissions. The
// connection is still saved (whatever was granted keeps working), but the
// user is told right away which feature won't work instead of finding out
// on their first estimate send. Compares against the scopes this app
// actually requested (GOOGLE_GMAIL_SCOPES) — never a hard-coded list.
export function missingGmailScopes(requested: string | undefined, granted: unknown): string[] {
  if (typeof granted !== "string") return [];
  const grantedSet = new Set(granted.split(/\s+/).filter(Boolean));
  return (requested ?? "")
    .split(/\s+/)
    .filter((s) => s.includes("/auth/gmail."))
    .filter((s) => !grantedSet.has(s));
}

function partialGrantMessage(missing: string[]): string {
  const cantRead = missing.some((s) => s.endsWith("/gmail.readonly"));
  const cantSend = missing.some((s) => s.endsWith("/gmail.send"));
  const what =
    cantRead && cantSend ? "read or send email"
    : cantRead ? "read email, so inbox sync won't work"
    : cantSend ? "send email, so estimates and change orders can't be emailed"
    : "use every Gmail feature";
  return `Google connected, but permission to ${what}. Click Reconnect and leave every Gmail box checked.`;
}

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
  status: "success" | "partial" | "error",
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
  await logGmailOAuthEnvDiagnostics(supabaseAdmin, "callback");

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

  // The state was minted for the org owner (gmail-oauth-start.ts) up to 10
  // minutes ago — re-check they still own this org before saving a mailbox
  // for everyone in it.
  const authority = stateRow.user_id ? await resolveOrgAndAuthority(supabaseAdmin, stateRow.user_id) : null;
  if (!authority || authority.orgId !== orgId || authority.role !== "owner") {
    return settingsRedirect("error", INTEGRATION_OWNER_ONLY_ERROR);
  }

  // Env-footprint reduction (2026-09) — see google-ads-config.ts's header;
  // supabaseAdmin already exists at module scope, so these are not
  // bootstrap secrets and resolve via app_config_secrets instead.
  const gmailOAuthConfig = await getAppConfigs(supabaseAdmin, ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"]);
  const clientId = gmailOAuthConfig.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = gmailOAuthConfig.GOOGLE_OAUTH_CLIENT_SECRET;
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

    // Connected account email — shown in Settings/Conversations, used as the
    // From address, and as the Gmail sync cursor's account check. Never
    // used for auth.
    //
    // The legacy oauth2/v2/userinfo endpoint only reliably returns `email`
    // when an identity scope (email/openid) was granted, and this function
    // never requests one on its own (broadening scope requires new user
    // consent). At least one production connection was saved with a NULL
    // email, so when userinfo has none, Gmail's own users.getProfile is
    // asked instead — it returns the mailbox address under gmail.readonly,
    // which the app already requests. `picture` is captured from userinfo
    // opportunistically; if absent, `accountPictureUrl` stays null. No
    // scope change.
    let accountEmail: string | null = null;
    let accountPictureUrl: string | null = null;
    try {
      const profileRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (profileRes.ok) {
        const profileJson: any = await profileRes.json();
        accountEmail = profileJson.email ?? null;
        // Only ever the connected account's own photo URL — never fetched
        // for, or applied to, any other sender's address.
        accountPictureUrl = typeof profileJson.picture === "string" ? profileJson.picture : null;
      }
    } catch (e: any) {
      console.warn("[gmail-oauth-callback] userinfo fetch failed:", e.message);
    }
    if (!accountEmail) accountEmail = await fetchGmailAccountEmail(accessToken);
    if (!accountEmail) console.warn("[gmail-oauth-callback] connected account address could not be determined");

    const { data: existing } = await supabaseAdmin
      .from("integrations")
      .select("id, refresh_token_encrypted, config, provider_account_email, last_sync_status")
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

    // Non-secret account metadata only — merged with (not overwriting)
    // whatever else is already in `config`, so a future unrelated config
    // key added by some other code path is never clobbered here.
    const existingConfig: Record<string, any> = (existing?.config && typeof existing.config === "object") ? existing.config : {};
    const nextConfig = { ...existingConfig, picture_url: accountPictureUrl };

    const payload: Record<string, any> = {
      org_id: orgId,
      provider: "gmail",
      status: "connected",
      access_token_encrypted: encryptToBytea(accessToken),
      token_expires_at: expiresAt,
      provider_account_email: accountEmail,
      config: nextConfig,
      updated_at: new Date().toISOString(),
    };
    // Reconnecting fixes a credential failure, and a different account's sync
    // state no longer applies — clear those. Any other sync failure (e.g. a
    // batch the database rejected) is not fixed by reconnecting, so it stays
    // visible until the next sync result replaces it.
    if (!existing || existing.last_sync_status === GMAIL_SYNC_AUTH_ERROR || existing.provider_account_email !== accountEmail) {
      payload.last_sync_status = null;
      payload.sync_error = null;
    }
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

    const missing = missingGmailScopes(process.env.GOOGLE_GMAIL_SCOPES, tokenJson.scope);
    if (missing.length > 0) {
      console.warn("[gmail-oauth-callback] connected without some requested Gmail scopes", { missing });
      return settingsRedirect("partial", partialGrantMessage(missing));
    }
    return settingsRedirect("success");
  } catch (err: any) {
    console.error("[gmail-oauth-callback] unhandled error:", err.message);
    return settingsRedirect("error", "Unexpected error connecting Gmail");
  }
};
