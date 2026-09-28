// src/lib/gmail-auto-sync.ts
//
// Conservative automatic Gmail refresh for the Conversations page, as a
// dependency-injected controller (unit-tested in gmail-auto-sync.test.ts).
//
// IMPORTANT: this does not read the database or fake anything. Gmail messages
// only reach Supabase when the server-side sync (netlify/functions/gmail-sync.ts)
// runs, so the injected `sync` MUST be the real server sync — the hook wires in
// triggerGmailSync(), exactly what the manual "Sync Gmail" button calls. Realtime
// or query invalidation alone can never surface a new Gmail reply.
//
// Guards (so it can never become a sync storm):
//   - one sync in flight at a time (auto triggers AND the manual button share it;
//     a manual click while a sync is running simply joins it)
//   - a minimum gap between automatic syncs (focus / visibility / interval events
//     cannot fire more often than that)
//   - only while the page is visible
//   - failures are quiet (onError only) and grow the minimum gap exponentially
//     (capped), so a broken connection is retried rarely, never in a loop; the
//     next successful sync resets it

export type GmailSyncSource = "auto" | "manual";

export type GmailSyncOutcome =
  | { ok: true; fetched: number; inserted: number; updated: number; skipped: number; changed?: number }
  | { ok: false; error: string };

export const AUTO_SYNC_INTERVAL_MS = 45_000;
export const AUTO_SYNC_MIN_GAP_MS = 20_000;
export const AUTO_SYNC_MAX_GAP_MS = 5 * 60_000;

export type GmailAutoSyncDeps = {
  /** The real server Gmail sync (see the file header). */
  sync: (source: GmailSyncSource) => Promise<GmailSyncOutcome>;
  onSynced?: (result: Extract<GmailSyncOutcome, { ok: true }>, source: GmailSyncSource) => void;
  onError?: (error: string, source: GmailSyncSource) => void;
  isVisible: () => boolean;
  now: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  /** Subscribes to a page event; returns the unsubscribe function. */
  addListener: (event: "focus" | "visibilitychange", fn: () => void) => () => void;
  intervalMs?: number;
  minGapMs?: number;
};

export type GmailAutoSync = {
  start(): void;
  stop(): void;
  /** Runs a sync now (manual button). Joins a sync already in flight. */
  syncNow(source?: GmailSyncSource): Promise<GmailSyncOutcome>;
  isInFlight(): boolean;
};

/** After a successful sync, refetch the conversation data only if something was actually written. */
export function shouldRefreshAfterSync(result: Extract<GmailSyncOutcome, { ok: true }>, source: GmailSyncSource): boolean {
  if (source === "manual") return true;
  return (result.changed ?? result.inserted) > 0;
}

export function createGmailAutoSync(deps: GmailAutoSyncDeps): GmailAutoSync {
  const intervalMs = deps.intervalMs ?? AUTO_SYNC_INTERVAL_MS;
  const baseGap = deps.minGapMs ?? AUTO_SYNC_MIN_GAP_MS;
  let running = false;
  let inFlight: Promise<GmailSyncOutcome> | null = null;
  let lastStartedAt = -Infinity;
  let failures = 0;
  let timer: unknown = null;
  let unsubscribe: Array<() => void> = [];

  const currentGap = () => Math.min(baseGap * 2 ** failures, AUTO_SYNC_MAX_GAP_MS);

  const run = (source: GmailSyncSource): Promise<GmailSyncOutcome> => {
    lastStartedAt = deps.now();
    const p = (async (): Promise<GmailSyncOutcome> => {
      try {
        const result = await deps.sync(source);
        if (result.ok) {
          failures = 0;
          deps.onSynced?.(result, source);
        } else {
          failures++;
          deps.onError?.(result.error, source);
        }
        return result;
      } catch (e) {
        failures++;
        const error = e instanceof Error ? e.message : "Gmail sync failed";
        deps.onError?.(error, source);
        return { ok: false, error };
      } finally {
        inFlight = null;
      }
    })();
    inFlight = p;
    return p;
  };

  const trigger = () => {
    if (!running || inFlight || !deps.isVisible()) return;
    if (deps.now() - lastStartedAt < currentGap()) return;
    void run("auto");
  };

  return {
    start() {
      if (running) return;
      running = true;
      trigger(); // opening Conversations
      timer = deps.setInterval(trigger, intervalMs);
      unsubscribe = [deps.addListener("focus", trigger), deps.addListener("visibilitychange", trigger)];
    },
    stop() {
      running = false;
      if (timer !== null) deps.clearInterval(timer);
      timer = null;
      unsubscribe.forEach((u) => u());
      unsubscribe = [];
    },
    syncNow(source = "manual") {
      return inFlight ?? run(source);
    },
    isInFlight: () => inFlight !== null,
  };
}
