// netlify/functions/lib/google-ads-lead-ingestion.test.ts
//
// Run:  node --test netlify/functions/lib/google-ads-lead-ingestion.test.ts
// AI-3C. Covers ONLY the real-vs-synthetic distinction used to decide
// whether a Google Ads lead gets a live Lead Qualification trigger —
// isSyntheticGoogleAdsSubmission(). No live Supabase, no network.

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
const outDir = mkdtempSync(path.join(tmpdir(), "google-ads-lead-ingestion-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await esbuild.build({
  entryPoints: [path.join(here, "google-ads-lead-ingestion.ts")],
  outfile: path.join(outDir, "subject.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error",
  alias: { "@": path.join(path.resolve(here, "../../.."), "src") },
  external: ["nodemailer", "@supabase/supabase-js"],
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);

test("12. a real Google Ads submission's raw_fields (no synthetic marker) is never treated as synthetic", () => {
  const realFields = [
    { fieldType: "FULL_NAME", fieldValue: "Jane Homeowner" },
    { fieldType: "EMAIL", fieldValue: "jane@example.com" },
    { fieldType: "PHONE_NUMBER", fieldValue: "+15550001111" },
  ];
  assert.equal(S.isSyntheticGoogleAdsSubmission(realFields), false);
});

test("13. the dev-only synthetic test harness's marker is recognized regardless of position in the array", () => {
  const marker = { fieldType: "__renometa_test_fixture", fieldValue: "true" };
  assert.equal(S.isSyntheticGoogleAdsSubmission([marker]), true);
  assert.equal(S.isSyntheticGoogleAdsSubmission([{ fieldType: "FULL_NAME", fieldValue: "Test User" }, marker]), true);
  assert.equal(S.isSyntheticGoogleAdsSubmission([marker, { fieldType: "EMAIL", fieldValue: "test@example.com" }]), true);
});

test("a real field with a similar-looking but not-exact fieldType is never mistaken for the marker", () => {
  assert.equal(S.isSyntheticGoogleAdsSubmission([{ fieldType: "__renometa_test_fixture_v2", fieldValue: "true" }]), false);
  assert.equal(S.isSyntheticGoogleAdsSubmission([{ fieldType: "FULL_NAME", fieldValue: "__renometa_test_fixture" }]), false, "the marker must be the fieldType, not any fieldValue");
});

test("fails safe toward synthetic (no AI trigger) when raw_fields is not even an array — the shape a real submission's parsed fields always have", () => {
  for (const bad of [null, undefined, {}, "not an array", 42]) {
    assert.equal(S.isSyntheticGoogleAdsSubmission(bad), true, JSON.stringify(bad));
  }
});

test("a well-formed array with no recognizable marker (odd per-item shapes included) is never treated as synthetic just because an item looks unusual", () => {
  assert.equal(S.isSyntheticGoogleAdsSubmission([null]), false);
  assert.equal(S.isSyntheticGoogleAdsSubmission([{ fieldType: 5 }]), false);
  assert.equal(S.isSyntheticGoogleAdsSubmission([]), false);
});
