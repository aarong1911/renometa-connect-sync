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
