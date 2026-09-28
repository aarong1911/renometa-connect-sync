/// <reference types="node" />
// tests/netlify-functions/gmail-sync.test.ts
//
// Run: node --test tests/netlify-functions/gmail-sync.test.ts
// Covers the fix for the 2026-09-27 live-retest bug: routine Gmail syncs (every
// automatic and manual call) must list mail WITHOUT the `q=newer_than:` search
// filter, because that filter runs against Gmail's search index, which lags
// behind brand-new mail — the exact cause of "inbound reply only shows up after
// a manual sync". `buildGmailListPath` is the one pure function that decides the
// list URL; it moved to netlify/functions/lib/gmail-history-sync.ts as part of
// the incremental-sync rewrite (2026-09-27) — see that module's own tests
// (gmail-history-sync.test.ts) for the bootstrap/incremental orchestration this
// URL builder now feeds. Bundled with esbuild (same convention as the other
// netlify/functions/lib/*.test.ts files); nothing here touches Gmail/Supabase.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(path.join(tmpdir(), "gmail-sync-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  entryPoints: [path.join(here, "../../netlify/functions/lib/gmail-history-sync.ts")],
  outfile: path.join(outDir, "gmail-history-sync.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error",
});
const { buildGmailListPath }: any = await import(pathToFileURL(path.join(outDir, "gmail-history-sync.mjs")).href);

test("5. a routine sync (no windowDays — every automatic and manual call) lists with NO q= filter", () => {
  assert.equal(buildGmailListPath(10), "/messages?maxResults=10");
  assert.equal(buildGmailListPath(10, undefined), "/messages?maxResults=10");
  assert.ok(!buildGmailListPath(10).includes("q="), "no search-index filter on the routine path");
});

test("an explicit windowDays (reserved for a future 'Load more history' action) still opts into the search filter", () => {
  assert.equal(buildGmailListPath(50, 30), "/messages?maxResults=50&q=newer_than%3A30d");
  assert.equal(buildGmailListPath(10, 1), "/messages?maxResults=10&q=newer_than%3A1d");
});

test("bootstrap pagination: a pageToken is appended so multiple bootstrap pages can be followed", () => {
  assert.equal(buildGmailListPath(100, undefined, "tok123"), "/messages?maxResults=100&pageToken=tok123");
  assert.equal(buildGmailListPath(100, 7, "tok123"), "/messages?maxResults=100&q=newer_than%3A7d&pageToken=tok123");
});
