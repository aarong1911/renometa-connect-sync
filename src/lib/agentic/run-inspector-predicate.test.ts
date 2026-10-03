// src/lib/agentic/run-inspector-predicate.test.ts
//
// Run:  node --test --loader ts-node/esm src/lib/agentic/run-inspector-predicate.test.ts
//   (bundled with esbuild below, same convention as the AI Center test
//   suites under netlify/functions/lib/ai/ — no live Supabase, no network,
//   pure function under test.)
//
// AI-3D. Proves the exact 9 behaviors requested for the Run Inspector fix:
//   1. manual_run runtime execution (started_at set)     -> visible
//   2. lead_created runtime execution (started_at set)    -> visible
//   3. inbound_lead_message runtime execution (started_at set) -> visible
//   4. a claim/idempotency row (started_at null) for any of the 3 new
//      sources is NOT shown as a duplicate
//   5. ai_orchestrate_http (started_at set) still shows
//   6. twilio_inbound_sms (started_at set) still shows
//   7. whatsapp_inbound (started_at set) still shows
//   8. an unrelated/legacy source (e.g. agent-execute.ts's
//      "contacts_or_leads_manual_run") remains excluded regardless of
//      started_at
//   9. (see leads-toast.test.ts / a grep-based assertion below) — toast no
//      longer references nonexistent "Activity"; covered separately since
//      it is a string-literal check on leads.tsx, not this predicate.

import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);
const esbuild = createRequire(req.resolve("vite/package.json"))("esbuild");
const outDir = mkdtempSync(path.join(tmpdir(), "run-inspector-predicate-"));
process.on("exit", () => { try { rmSync(outDir, { recursive: true, force: true }); } catch {} });

await esbuild.build({
  entryPoints: [path.join(here, "run-inspector-predicate.ts")],
  outfile: path.join(outDir, "subject.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error",
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);

const NOW = new Date().toISOString();

test("1. manual_run runtime execution (started_at set) is visible", () => {
  assert.equal(S.isRunInspectorRuntimeRow({ source: "manual_run", started_at: NOW }), true);
});

test("2. lead_created runtime execution (started_at set) is visible", () => {
  assert.equal(S.isRunInspectorRuntimeRow({ source: "lead_created", started_at: NOW }), true);
});

test("3. inbound_lead_message runtime execution (started_at set) is visible", () => {
  assert.equal(S.isRunInspectorRuntimeRow({ source: "inbound_lead_message", started_at: NOW }), true);
});

test("4. a claim/idempotency row (started_at null) is NOT shown, for each of the 3 new sources", () => {
  for (const source of ["manual_run", "lead_created", "inbound_lead_message"]) {
    assert.equal(S.isRunInspectorRuntimeRow({ source, started_at: null }), false, source);
    assert.equal(S.isRunInspectorRuntimeRow({ source, started_at: undefined }), false, source);
  }
});

test("5. ai_orchestrate_http still shows", () => {
  assert.equal(S.isRunInspectorRuntimeRow({ source: "ai_orchestrate_http", started_at: NOW }), true);
});

test("6. twilio_inbound_sms still shows", () => {
  assert.equal(S.isRunInspectorRuntimeRow({ source: "twilio_inbound_sms", started_at: NOW }), true);
});

test("7. whatsapp_inbound still shows", () => {
  assert.equal(S.isRunInspectorRuntimeRow({ source: "whatsapp_inbound", started_at: NOW }), true);
});

test("8. an unrelated/legacy execution (agent-execute.ts's own source) remains excluded, even with started_at set", () => {
  assert.equal(S.isRunInspectorRuntimeRow({ source: "contacts_or_leads_manual_run", started_at: NOW }), false);
});

test("a null/empty source is never treated as a match", () => {
  assert.equal(S.isRunInspectorRuntimeRow({ source: null, started_at: NOW }), false);
  assert.equal(S.isRunInspectorRuntimeRow({ source: undefined, started_at: NOW }), false);
  assert.equal(S.isRunInspectorRuntimeRow({ source: "", started_at: NOW }), false);
});

test("RUN_INSPECTOR_SOURCES contains exactly the 6 expected sources, no more no less", () => {
  assert.deepEqual(
    [...S.RUN_INSPECTOR_SOURCES].sort(),
    ["ai_orchestrate_http", "inbound_lead_message", "lead_created", "manual_run", "twilio_inbound_sms", "whatsapp_inbound"].sort(),
  );
});
