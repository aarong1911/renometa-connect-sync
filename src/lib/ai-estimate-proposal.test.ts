// src/lib/ai-estimate-proposal.test.ts
//
// Run:  node --test src/lib/ai-estimate-proposal.test.ts
//
// Estimate Assistant Foundation — the Approvals tab's pure proposal reader.
// Defensive against malformed jsonb; never surfaces anything but the title,
// scope and line-item NAMES.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(path.join(tmpdir(), "ai-estimate-proposal-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  entryPoints: [path.join(here, "ai-estimate-proposal.ts")],
  outfile: path.join(outDir, "subject.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error",
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);

test("only the two estimate action keys are recognized", () => {
  assert.equal(S.isEstimateActionKey("create_estimate_draft"), true);
  assert.equal(S.isEstimateActionKey("add_estimate_line_items"), true);
  for (const k of ["send_sms", "schedule_appointment", "create_follow_up_task", "send_estimate", ""]) assert.equal(S.isEstimateActionKey(k), false, k);
  assert.equal(S.readEstimateProposal("send_sms", { items: [{ name: "x" }] }), undefined);
});

test("create: title, scope and item names are read; nothing else (e.g. ids) is surfaced", () => {
  const view = S.readEstimateProposal("create_estimate_draft", {
    contactId: "c-secret", leadId: "l-secret", title: " Kitchen remodel ", scope: "New cabinets.",
    items: [{ name: "Cabinet replacement", itemType: "material" }, { name: "  Sink installation  ", description: "x" }],
  });
  assert.deepEqual(view, { kind: "create", title: "Kitchen remodel", scope: "New cabinets.", itemNames: ["Cabinet replacement", "Sink installation"] });
  assert.ok(!JSON.stringify(view).includes("secret"));
});

test("add: only item names", () => {
  assert.deepEqual(S.readEstimateProposal("add_estimate_line_items", { estimateId: "e-1", items: [{ name: "Tile backsplash" }] }), { kind: "add", itemNames: ["Tile backsplash"] });
});

test("malformed / hostile jsonb never throws and yields an empty, safe view", () => {
  for (const bad of [null, undefined, "x", 5, [], { items: "nope" }, { items: [null, 3, {}, { name: 9 }, { name: "   " }] }]) {
    const v = S.readEstimateProposal("add_estimate_line_items", bad);
    assert.deepEqual(v, { kind: "add", itemNames: [] }, JSON.stringify(bad));
  }
});

test("the disclosure states there are no prices and nothing is sent", () => {
  assert.match(S.ESTIMATE_PROPOSAL_DISCLOSURE, /unpriced/);
  assert.match(S.ESTIMATE_PROPOSAL_DISCLOSURE, /Nothing is sent to the customer/);
});
