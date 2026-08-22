// netlify/functions/lib/google-ads-oauth-token.ts
//
// Shared refresh-token -> temporary access-token exchange, used by both
// google-ads-accounts.ts and google-ads-select-account.ts so the two never
// carry diverging copies of the same POST /token call. Not used by
// google-ads-oauth-callback.ts (that file does its own one-time
// authorization_code exchange, a different grant type entirely).
//
// Never logs or exposes: the refresh token, the returned access token,
// GOOGLE_ADS_CLIENT_SECRET, or a raw Google response body. Only a safe
// HTTP status code and Google's own short machine-readable `error` field
// (never `error_description`) are logged on failure.

import { fetchWithTimeout } from "./google-ads-api";

export type GoogleAdsTokenRefreshErrorCode = "server_configuration" | "reconnect_required" | "network_error";

export type GoogleAdsTokenRefreshResult =
  | { ok: true; accessToken: string; expiresInSec: number }
  | { ok: false; errorCode: GoogleAdsTokenRefreshErrorCode };

export async function refreshGoogleAdsAccessToken(refreshToken: string): Promise<GoogleAdsTokenRefreshResult> {
  const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("[google-ads-oauth-token] missing GOOGLE_ADS_CLIENT_ID/SECRET");
    return { ok: false, errorCode: "server_configuration" };
  }

  let res: Response;
  try {
    res = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
  } catch (e: any) {
    console.error("[google-ads-oauth-token] refresh request failed", {
      reason: e?.name === "AbortError" ? "timeout" : "network_error",
    });
    return { ok: false, errorCode: "network_error" };
  }

  if (!res.ok) {
    const errJson: any = await res.json().catch(() => ({}));
    const googleErrorCode: string | undefined = errJson?.error;
    console.error("[google-ads-oauth-token] refresh rejected", { status: res.status, error: googleErrorCode });
    // Google returns invalid_grant (typically with 400/401) when a refresh
    // token has been revoked, expired, or the user removed app access —
    // retrying won't help; the user must reconnect.
    if (res.status === 400 || res.status === 401 || googleErrorCode === "invalid_grant") {
      return { ok: false, errorCode: "reconnect_required" };
    }
    return { ok: false, errorCode: "network_error" };
  }

  const json: any = await res.json().catch(() => ({}));
  const accessToken: string | undefined = json.access_token;
  const expiresInSec = Number(json.expires_in) || 3600;
  if (!accessToken) {
    console.error("[google-ads-oauth-token] refresh response missing access_token");
    return { ok: false, errorCode: "reconnect_required" };
  }

  return { ok: true, accessToken, expiresInSec };
}
