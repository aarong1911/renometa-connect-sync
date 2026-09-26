// src/lib/gmail-auto-sync.test.ts
//
// Run:  node --test src/lib/gmail-auto-sync.test.ts
// Tests the production controller (src/lib/gmail-auto-sync.ts) with fake timers /
// page events, and — via an esbuild bundle of the real hook module — that the
// production wiring calls the REAL server sync endpoint. No live Gmail/Supabase:
// global fetch is replaced with a recorder and the Supabase client is a stub.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AUTO_SYNC_INTERVAL_MS,
  AUTO_SYNC_MAX_GAP_MS,
  AUTO_SYNC_MIN_GAP_MS,
  createGmailAutoSync,
  shouldRefreshAfterSync,
  type GmailSyncOutcome,
  type GmailSyncSource,
} from "./gmail-auto-sync.ts";

const OK = (extra: Partial<Extract<GmailSyncOutcome, { ok: true }>> = {}): GmailSyncOutcome => ({ ok: true, fetched: 10, inserted: 0, updated: 0, skipped: 0, changed: 0, ...extra });

/** Deterministic page environment: manual clock, interval list, page events. */
function makeEnv() {
  let t = 1_000_000;
  let visible = true;
  const intervals = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  const listeners: Record<string, Set<() => void>> = { focus: new Set(), visibilitychange: new Set() };
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    setVisible: (v: boolean) => {
      visible = v;
    },
    isVisible: () => visible,
    setInterval: (fn: () => void, ms: number) => {
      const id = nextId++;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval: (h: unknown) => void intervals.delete(h as number),
    addListener: (event: "focus" | "visibilitychange", fn: () => void) => {
      listeners[event].add(fn);
      return () => void listeners[event].delete(fn);
    },
    tick: () => intervals.forEach((i) => i.fn()),
    fire: (event: "focus" | "visibilitychange") => listeners[event].forEach((fn) => fn()),
    intervalCount: () => intervals.size,
    listenerCount: () => listeners.focus.size + listeners.visibilitychange.size,
  };
}

function setup(syncImpl: (source: GmailSyncSource) => Promise<GmailSyncOutcome> = async () => OK()) {
  const env = makeEnv();
  const calls: GmailSyncSource[] = [];
  const synced: Array<{ result: GmailSyncOutcome; source: GmailSyncSource }> = [];
  const errors: string[] = [];
  const ctl = createGmailAutoSync({
    sync: async (source) => {
      calls.push(source);
      return syncImpl(source);
    },
    onSynced: (result, source) => synced.push({ result, source }),
    onError: (error) => errors.push(error),
    isVisible: env.isVisible,
    now: env.now,
    setInterval: env.setInterval,
    clearInterval: env.clearInterval,
    addListener: env.addListener,
  });
  return { env, ctl, calls, synced, errors };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test("21. opening Conversations triggers one sync; focus and visibility events trigger more only past the minimum gap", async () => {
  const { env, ctl, calls } = setup();
  ctl.start();
  await flush();
  assert.equal(calls.length, 1, "initial sync on open");

  env.fire("focus");
  env.fire("visibilitychange");
  await flush();
  assert.equal(calls.length, 1, "inside the minimum gap: no storm");

  env.advance(AUTO_SYNC_MIN_GAP_MS + 1);
  env.fire("focus");
  await flush();
  assert.equal(calls.length, 2, "focus after the gap syncs");

  env.advance(AUTO_SYNC_MIN_GAP_MS + 1);
  env.fire("visibilitychange");
  await flush();
  assert.equal(calls.length, 3, "becoming visible after the gap syncs");
  assert.deepEqual([...new Set(calls)], ["auto"]);
});

test("21b. nothing runs while the page is hidden, and it resumes when visible again", async () => {
  const { env, ctl, calls } = setup();
  env.setVisible(false);
  ctl.start();
  await flush();
  assert.equal(calls.length, 0);
  env.advance(AUTO_SYNC_INTERVAL_MS);
  env.tick();
  await flush();
  assert.equal(calls.length, 0, "interval tick while hidden does nothing");
  env.setVisible(true);
  env.fire("visibilitychange");
  await flush();
  assert.equal(calls.length, 1);
});

test("22. the interval trigger syncs periodically (45 s) and stop() removes every timer and listener", async () => {
  const { env, ctl, calls } = setup();
  ctl.start();
  await flush();
  assert.equal(AUTO_SYNC_INTERVAL_MS, 45_000);
  assert.equal(env.intervalCount(), 1);
  env.advance(AUTO_SYNC_INTERVAL_MS);
  env.tick();
  await flush();
  env.advance(AUTO_SYNC_INTERVAL_MS);
  env.tick();
  await flush();
  assert.equal(calls.length, 3);

  ctl.stop();
  assert.equal(env.intervalCount(), 0);
  assert.equal(env.listenerCount(), 0);
  env.advance(AUTO_SYNC_INTERVAL_MS);
  env.tick();
  env.fire("focus");
  await flush();
  assert.equal(calls.length, 3, "a stopped controller never syncs");
});

test("20. overlapping syncs are prevented; a manual click while one runs joins it instead of starting another", async () => {
  let release!: (r: GmailSyncOutcome) => void;
  const { env, ctl, calls } = setup(() => new Promise<GmailSyncOutcome>((r) => (release = r)));
  ctl.start(); // auto sync now in flight
  await flush();
  assert.equal(ctl.isInFlight(), true);

  env.advance(AUTO_SYNC_MIN_GAP_MS + 1);
  env.fire("focus");
  env.tick();
  const manual = ctl.syncNow("manual"); // joins the in-flight run
  await flush();
  assert.equal(calls.length, 1, "still exactly one sync call");

  release(OK({ inserted: 1, changed: 1 }));
  const res = await manual;
  assert.equal(res.ok, true);
  assert.equal(ctl.isInFlight(), false);
});

test("manual sync always runs (ignores the auto gap and visibility) and is reported as manual", async () => {
  const { env, ctl, calls, synced } = setup();
  env.setVisible(false);
  await ctl.syncNow("manual");
  await ctl.syncNow("manual");
  assert.deepEqual(calls, ["manual", "manual"]);
  assert.equal(synced.length, 2);
  assert.equal(synced[0].source, "manual");
});

test("23. a successful sync reports its result so the real conversation queries are refreshed only when something changed", async () => {
  const { ctl, synced } = setup(async () => OK({ inserted: 1, changed: 1 }));
  ctl.start();
  await flush();
  assert.equal(synced.length, 1);
  assert.equal(shouldRefreshAfterSync(synced[0].result as Extract<GmailSyncOutcome, { ok: true }>, "auto"), true);

  const okNone = OK({ changed: 0 }) as Extract<GmailSyncOutcome, { ok: true }>;
  assert.equal(shouldRefreshAfterSync(okNone, "auto"), false, "no-op auto sync does not refetch 2000 rows");
  assert.equal(shouldRefreshAfterSync(okNone, "manual"), true, "manual always refreshes");
  // older server responses without `changed` fall back to `inserted`
  assert.equal(shouldRefreshAfterSync({ ok: true, fetched: 1, inserted: 2, updated: 0, skipped: 0 }, "auto"), true);
  assert.equal(shouldRefreshAfterSync({ ok: true, fetched: 1, inserted: 0, updated: 5, skipped: 0 }, "auto"), false);
});

test("24. automatic failures are quiet (onError only, never thrown), back off exponentially, cap out, and recover", async () => {
  let fail = true;
  const { env, ctl, calls, errors, synced } = setup(async () => (fail ? { ok: false, error: "Gmail API list request failed (500)" } : OK({ inserted: 1, changed: 1 })));
  ctl.start();
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(errors.length, 1);

  // Within the (now doubled) gap, focus/interval events do not retry: no retry loop.
  env.advance(AUTO_SYNC_MIN_GAP_MS + 1);
  env.fire("focus");
  env.tick();
  await flush();
  assert.equal(calls.length, 1);

  env.advance(AUTO_SYNC_MIN_GAP_MS * 2);
  env.fire("focus");
  await flush();
  assert.equal(calls.length, 2, "retried once the backoff has elapsed");

  for (let i = 0; i < 12; i++) {
    env.advance(AUTO_SYNC_MAX_GAP_MS + 1);
    env.fire("focus");
    await flush();
  }
  assert.ok(calls.length <= 2 + 12, "at most one attempt per capped gap");
  env.advance(AUTO_SYNC_MAX_GAP_MS + 1);
  const before = calls.length;
  env.fire("focus");
  env.advance(1000);
  env.fire("focus");
  await flush();
  assert.equal(calls.length, before + 1, "even at the cap only one attempt per gap");

  fail = false;
  env.advance(AUTO_SYNC_MAX_GAP_MS + 1);
  env.fire("focus");
  await flush();
  assert.equal(synced.length, 1, "recovered");
  env.advance(AUTO_SYNC_MIN_GAP_MS + 1);
  env.fire("focus");
  await flush();
  assert.equal(calls.length, before + 3, "after a success the normal 20 s gap applies again");
});

test("24b. a thrown sync error is contained (no unhandled rejection) and counted as a failure", async () => {
  const { ctl, errors, calls } = setup(async () => {
    throw new Error("network down");
  });
  ctl.start();
  await flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(errors, ["network down"]);
  const res = await ctl.syncNow("manual");
  assert.equal(res.ok, false, "a manual sync still reports the error to its caller");
});

// ── 19. the production wiring calls the REAL server sync ──────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const outDir = mkdtempSync(path.join(tmpdir(), "gmail-auto-sync-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

test("19. the hook's sync is the real gmail-sync call: same endpoint, bearer token, and 'silent' only for automatic runs", async () => {
  const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
  await esbuild.build({
    entryPoints: [path.join(here, "test-support/email-entry.ts")],
    outfile: path.join(outDir, "entry.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "error",
    alias: { "@/lib/supabase": path.join(here, "test-support/supabase-stub.ts"), "@": path.join(repoRoot, "src") },
    define: { "import.meta.env.DEV": "false", "import.meta.env.VITE_SUPABASE_URL": '"https://fake.supabase.co"', "import.meta.env.VITE_SUPABASE_ANON_KEY": '"fake"' },
  });
  const mod: any = await import(pathToFileURL(path.join(outDir, "entry.mjs")).href);

  const realFetch = globalThis.fetch;
  const requests: Array<{ url: string; init: any }> = [];
  globalThis.fetch = (async (url: string, init: any) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, fetched: 3, inserted: 1, updated: 0, skipped: 0, changed: 1 }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const auto = await mod.syncViaGmailServer("auto");
    const manual = await mod.syncViaGmailServer("manual");
    assert.equal(requests.length, 2);
    for (const r of requests) {
      assert.equal(r.url, "/.netlify/functions/gmail-sync");
      assert.equal(r.init.method, "POST");
      assert.equal(r.init.headers.Authorization, "Bearer test-token");
    }
    assert.equal(requests[0].init.body, JSON.stringify({ silent: true }));
    assert.equal(requests[1].init.body, JSON.stringify({}));
    assert.deepEqual([auto.ok, manual.ok, auto.changed], [true, true, 1]);

    // and end-to-end through the controller: opening Conversations hits the server once
    requests.length = 0;
    const env = makeEnv();
    const ctl = mod.createGmailAutoSync({ sync: mod.syncViaGmailServer, isVisible: env.isVisible, now: env.now, setInterval: env.setInterval, clearInterval: env.clearInterval, addListener: env.addListener });
    ctl.start();
    await flush();
    ctl.stop();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/.netlify/functions/gmail-sync");
  } finally {
    globalThis.fetch = realFetch;
  }
});
