// netlify/functions/lib/gmail-sync-health.ts
//
// Gmail sync health, reported separately from the OAuth connection.
//
// Before 2026-10-31 Settings showed one badge: "Connected" whenever the
// integration row said status = 'connected', and "Needs reconnect" whenever
// the 1-hour access token had expired — even with a refresh token on file
// that gmail-sync.ts renews automatically. A sync that failed on every run
// (the duplicate Message-ID incident) therefore looked healthy, and the
// reconnect callback also wiped the recorded error.
//
// Fields this reads (integrations row, written by gmail-sync.ts):
//   last_sync_status  'ok' | 'error' | 'auth_error' (GMAIL_SYNC_AUTH_ERROR) | null
//   sync_error        message of the last failed sync, null after a success
//   last_sync_at      time of the last SUCCESSFUL sync since 2026-10-31
//                     (failures no longer overwrite it; older rows may still
//                     hold a failure time, so it is only trusted while 'ok')
// and integration_sync_logs (every failure is logged; a success is logged
// unless it was a silent no-change auto-sync with nothing to recover from).

import type { GmailSyncHealth } from "../../../src/lib/gmail-connection-health";

export type { GmailSyncHealth };

export const GMAIL_SYNC_AUTH_ERROR = "auth_error";

export type GmailSyncStateRow = {
  last_sync_at: string | null;
  last_sync_status: string | null;
  sync_error: string | null;
};

export type GmailSyncLogEntry = {
  status: string;
  started_at: string | null;
  finished_at: string | null;
  message: string | null;
  stats: Record<string, unknown> | null;
};

export type GmailSyncHealthView = {
  syncHealth: GmailSyncHealth;
  syncError: string | null;
  lastSuccessfulSyncAt: string | null;
  lastFailedSyncAt: string | null;
};

const logTime = (log: GmailSyncLogEntry | null) => log?.finished_at ?? log?.started_at ?? null;

/** An auth failure is fixed by reconnecting; logs from before 2026-10-31 carry no `kind`, so fall back to the message. */
function isAuthFailureLog(log: GmailSyncLogEntry): boolean {
  if (log.stats && log.stats.kind === GMAIL_SYNC_AUTH_ERROR) return true;
  return !(log.stats && "kind" in log.stats) && /reconnect gmail/i.test(log.message ?? "");
}

/**
 * `latestLog` = the org's newest gmail integration_sync_logs row,
 * `latestSuccessLog` = its newest row with status 'success'.
 */
export function deriveGmailSyncHealth(
  state: GmailSyncStateRow,
  latestLog: GmailSyncLogEntry | null,
  latestSuccessLog: GmailSyncLogEntry | null,
): GmailSyncHealthView {
  const failedAt = latestLog && latestLog.status === "error" ? logTime(latestLog) : null;
  const loggedSuccessAt = logTime(latestSuccessLog);

  if (state.last_sync_status === "ok") {
    return { syncHealth: "ok", syncError: null, lastSuccessfulSyncAt: state.last_sync_at ?? loggedSuccessAt, lastFailedSyncAt: null };
  }
  if (state.last_sync_status === GMAIL_SYNC_AUTH_ERROR) {
    return { syncHealth: "auth_error", syncError: state.sync_error, lastSuccessfulSyncAt: loggedSuccessAt, lastFailedSyncAt: failedAt };
  }
  if (state.last_sync_status) {
    return { syncHealth: "failing", syncError: state.sync_error, lastSuccessfulSyncAt: loggedSuccessAt, lastFailedSyncAt: failedAt };
  }

  // No status: never synced, or cleared by a reconnect. The log still says
  // whether the last run failed — unless that failure was an auth error the
  // reconnect has just fixed, in which case the next sync decides.
  if (latestLog?.status === "error" && !isAuthFailureLog(latestLog)) {
    return { syncHealth: "failing", syncError: latestLog.message, lastSuccessfulSyncAt: loggedSuccessAt, lastFailedSyncAt: failedAt };
  }
  if (latestLog?.status === "success") {
    return { syncHealth: "ok", syncError: null, lastSuccessfulSyncAt: loggedSuccessAt, lastFailedSyncAt: null };
  }
  return { syncHealth: "pending", syncError: null, lastSuccessfulSyncAt: loggedSuccessAt, lastFailedSyncAt: null };
}
