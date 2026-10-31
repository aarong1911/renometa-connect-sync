// netlify/functions/lib/gmail-sync-health.test.ts
//
// Run:  node --test netlify/functions/lib/gmail-sync-health.test.ts
// Pure functions only — no Supabase, no Gmail, no network.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);
const esbuild = createRequire(req.resolve("vite/package.json"))("esbuild");
const outDir = mkdtempSync(path.join(tmpdir(), "gmail-sync-health-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
for (const [entry, out] of [
  [path.join(here, "gmail-sync-health.ts"), "health.mjs"],
  [path.join(here, "../../../src/lib/gmail-connection-health.ts"), "connection.mjs"],
]) {
  await esbuild.build({ entryPoints: [entry], outfile: path.join(outDir, out), bundle: true, platform: "node", format: "esm", logLevel: "error" });
}
const H: any = await import(pathToFileURL(path.join(outDir, "health.mjs")).href);
const C: any = await import(pathToFileURL(path.join(outDir, "connection.mjs")).href);

const DUP_KEY = 'Gmail sync failed: Failed to save fetched messages: duplicate key value violates unique constraint "gmail_messages_org_rfc_message_id_uq"';
const log = (status: string, at: string, message: string | null = null, stats: any = {}) => ({ status, started_at: at, finished_at: at, message, stats });
const state = (last_sync_status: string | null, last_sync_at: string | null = null, sync_error: string | null = null) => ({ last_sync_status, last_sync_at, sync_error });

test("a successful last sync is healthy and reports its time", () => {
  const v = H.deriveGmailSyncHealth(state("ok", "2026-10-31T10:00:00Z"), log("success", "2026-10-31T09:00:00Z"), log("success", "2026-10-31T09:00:00Z"));
  assert.deepEqual(v, { syncHealth: "ok", syncError: null, lastSuccessfulSyncAt: "2026-10-31T10:00:00Z", lastFailedSyncAt: null });
});

test("a failing sync is reported as failing even though the OAuth connection is fine, with the last real success", () => {
  const v = H.deriveGmailSyncHealth(
    state("error", "2026-10-30T05:05:39Z", DUP_KEY), // last_sync_at written by a pre-fix failure — not trusted
    log("error", "2026-10-30T05:05:39Z", DUP_KEY, { kind: "error" }),
    log("success", "2026-10-25T18:57:25Z"),
  );
  assert.equal(v.syncHealth, "failing");
  assert.equal(v.syncError, DUP_KEY);
  assert.equal(v.lastSuccessfulSyncAt, "2026-10-25T18:57:25Z");
  assert.equal(v.lastFailedSyncAt, "2026-10-30T05:05:39Z");
});

test("production's state (status cleared by the old reconnect, latest log = duplicate-key error) still shows failing", () => {
  const v = H.deriveGmailSyncHealth(state(null, "2026-10-30T05:05:39Z"), log("error", "2026-10-30T05:05:32Z", DUP_KEY, {}), log("success", "2026-10-25T18:57:25Z"));
  assert.equal(v.syncHealth, "failing");
  assert.equal(v.syncError, DUP_KEY);
});

test("an auth failure is its own state", () => {
  const v = H.deriveGmailSyncHealth(state("auth_error", null, "Reconnect Gmail"), log("error", "t1", "Reconnect Gmail", { kind: "auth_error" }), null);
  assert.equal(v.syncHealth, "auth_error");
});

test("after a reconnect clears an auth failure, the old auth log no longer reads as failing", () => {
  const tagged = H.deriveGmailSyncHealth(state(null), log("error", "t1", "x", { kind: "auth_error" }), null);
  assert.equal(tagged.syncHealth, "pending");
  const legacy = H.deriveGmailSyncHealth(state(null), log("error", "t1", "Gmail connection has expired ... Reconnect Gmail for this organization to continue syncing.", {}), null);
  assert.equal(legacy.syncHealth, "pending", "pre-2026-10-31 auth logs carry no kind and are recognised by their message");
});

test("never synced -> pending; only a success log -> ok", () => {
  assert.equal(H.deriveGmailSyncHealth(state(null), null, null).syncHealth, "pending");
  assert.equal(H.deriveGmailSyncHealth(state(null), log("success", "t"), log("success", "t")).syncHealth, "ok");
});

test("reconnect is needed only without a refresh token or after an auth failure — never just because the access token expired", () => {
  assert.equal(C.gmailNeedsReconnect({ connected: true, hasRefreshToken: true, syncHealth: "ok" }), false);
  assert.equal(C.gmailNeedsReconnect({ connected: true, hasRefreshToken: true, syncHealth: "failing" }), false, "a sync failure is not an OAuth failure");
  assert.equal(C.gmailNeedsReconnect({ connected: true, hasRefreshToken: true, syncHealth: "auth_error" }), true);
  assert.equal(C.gmailNeedsReconnect({ connected: true, hasRefreshToken: false, syncHealth: "ok" }), true);
  assert.equal(C.gmailNeedsReconnect({ connected: false, hasRefreshToken: false, syncHealth: null }), false);
});
