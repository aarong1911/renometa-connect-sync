// src/lib/gmail-connection-health.ts
//
// The Gmail OAuth connection and Gmail sync are reported separately (see
// netlify/functions/lib/gmail-sync-health.ts, which derives `syncHealth`).
// Dependency-free so both the server and Settings can import it.

/**
 * ok        the last sync succeeded
 * failing   the last sync failed for a reason reconnecting does not fix
 * auth_error the last sync could not use the stored credentials
 * pending   no sync result since connecting (or since a reconnect fixed an auth error)
 */
export type GmailSyncHealth = "ok" | "failing" | "auth_error" | "pending";

/**
 * Whether the user must reconnect Gmail: the connection can't renew itself
 * (no refresh token), or the last sync proved the stored credentials no
 * longer work. An expired access token alone is NOT a reason — gmail-sync.ts
 * refreshes it with the refresh token on the next run.
 */
export function gmailNeedsReconnect(input: { connected: boolean; hasRefreshToken: boolean; syncHealth?: GmailSyncHealth | null }): boolean {
  return input.connected && (!input.hasRefreshToken || input.syncHealth === "auth_error");
}

/** Safe fields returned by netlify/functions/gmail-connection-status.ts — never token material. */
export type GmailConnectionStatus = {
  connected: boolean;
  accountEmail: string | null;
  hasRefreshToken: boolean;
  tokenExpiresAt: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  syncError: string | null;
  syncHealth: GmailSyncHealth | null;
  lastSuccessfulSyncAt: string | null;
  lastFailedSyncAt: string | null;
};

/**
 * Which of the Gmail card's layouts to show. Authorization ("reconnect") and
 * sync health are separate: a failing sync on a still-authorized account is
 * "connected" with a sync problem, and only a genuine credential failure asks
 * the user to reconnect.
 */
export type GmailCardState = "loading" | "status_error" | "not_connected" | "reconnect" | "connected";

export function gmailCardState(input: { loading: boolean; error: string | null; status: GmailConnectionStatus | null }): GmailCardState {
  if (input.loading && !input.status) return "loading";
  if (input.error && !input.status) return "status_error";
  if (!input.status?.connected) return "not_connected";
  return gmailNeedsReconnect(input.status) ? "reconnect" : "connected";
}

/**
 * The toast for gmail-oauth-callback.ts's redirect back to Settings
 * (?gmail=success|partial|error&gmail_message=...). Google's own short codes
 * are turned into a next step instead of being shown raw.
 */
export function describeGmailOAuthReturn(result: string | null, message: string | null): { tone: "success" | "warning" | "error"; text: string } | null {
  if (result === "success") return { tone: "success", text: "Google account connected" };
  if (result === "partial") return { tone: "warning", text: message || "Google connected without every Gmail permission. Click Reconnect and allow all of them." };
  if (result !== "error") return null;
  if (message === "access_denied") {
    return { tone: "error", text: "Google connection was cancelled. Click Connect with Google when you're ready to try again." };
  }
  return { tone: "error", text: message ? `Couldn't connect Google: ${message}` : "Couldn't connect Google. Please try again." };
}
