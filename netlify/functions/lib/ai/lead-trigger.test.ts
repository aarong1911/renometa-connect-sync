// netlify/functions/lib/ai/lead-trigger.test.ts
//
// Run:  node --test netlify/functions/lib/ai/lead-trigger.test.ts
// Pure-logic tests for the trigger eligibility / idempotency-key / known-
// qualification-fields helpers — no Supabase, no model, no network. Bundled
// with esbuild only because lead-trigger.ts's sibling ./types.ts has a
// relative import with no extension.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID as cryptoRandomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(path.join(tmpdir(), "lead-trigger-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  entryPoints: [path.join(here, "lead-trigger.ts")],
  outfile: path.join(outDir, "subject.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error",
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);

// ── Triggers: channel scope + backfill guard ────────────────────────────────

const inbound = (over: Record<string, unknown> = {}) => ({ channel: "sms", direction: "in", syncOrigin: "live", ...over });

test("1+3. live inbound on a supported channel from a lead's contact is eligible", () => {
  assert.equal(S.isLiveTriggerEligible(inbound()), true);
  for (const channel of ["whatsapp", "messenger", "instagram"]) {
    assert.equal(S.isLiveTriggerEligible(inbound({ channel })), true, channel);
  }
});

test("4. an unsupported channel does not route (email/voice/web_chat/internal never live-eligible)", () => {
  for (const channel of ["email", "voice", "web_chat", "internal"]) {
    assert.equal(S.isLiveTriggerEligible(inbound({ channel })), false, channel);
  }
});

test("5. an outbound/business-authored message never triggers", () => {
  assert.equal(S.isLiveTriggerEligible(inbound({ direction: "out" })), false);
  assert.equal(S.isLiveTriggerEligible(inbound({ authoredByBusiness: true })), false);
});

test("8. a Gmail bootstrap/history backfill message never triggers, regardless of channel or recency", () => {
  assert.equal(S.isLiveTriggerEligible(inbound({ syncOrigin: "backfill" })), false);
  assert.equal(S.isLiveTriggerEligible(inbound({ syncOrigin: undefined })), false, "an unlabeled origin fails closed, same as backfill");
});

test("9. a genuinely live/new message after a backfill run does trigger", () => {
  assert.equal(S.isLiveTriggerEligible(inbound({ syncOrigin: "live" })), true);
});

test("LIVE_TRIGGER_CHANNELS matches the channels context-builder.ts actually supports (sms/whatsapp/messenger/instagram)", () => {
  assert.deepEqual([...S.LIVE_TRIGGER_CHANNELS].sort(), ["instagram", "messenger", "sms", "whatsapp"]);
});

// ── Idempotency keys ─────────────────────────────────────────────────────

test("idempotency keys are deterministic, scoped, and distinct per trigger kind", () => {
  const a = S.buildLeadCreatedIdempotencyKey("lead-1");
  const b = S.buildLeadCreatedIdempotencyKey("lead-1");
  assert.equal(a, b);
  assert.notEqual(a, S.buildLeadCreatedIdempotencyKey("lead-2"));
  const m1 = S.buildInboundMessageIdempotencyKey("msg-1");
  assert.notEqual(a, m1, "lead_created and inbound_message keys for the same lead never collide");
  assert.equal(m1, S.buildInboundMessageIdempotencyKey("msg-1"));
  assert.notEqual(m1, S.buildInboundMessageIdempotencyKey("msg-2"));
});

// ── Known qualification fields ───────────────────────────────────────────

test("10-13+16. known fields structure is deterministic: first name, budget, timeline, project type", () => {
  const lead = { id: "l1", status: "new", name: "John Test", estimatedBudget: 50000, projectType: "Kitchen remodel", timeline: "within three months", location: "Denver, CO" };
  const known = S.resolveKnownQualificationFields(lead, undefined);
  assert.deepEqual(known, { firstName: "John", projectType: "Kitchen remodel", budget: 50000, timeline: "within three months", location: "Denver, CO" });
  // Deterministic: same input, same output.
  assert.deepEqual(known, S.resolveKnownQualificationFields(lead, undefined));
});

test("first name falls back to the linked contact when the lead has no name of its own", () => {
  const known = S.resolveKnownQualificationFields({ id: "l1", status: "new" }, { id: "c1", name: "Sam Rivera" });
  assert.equal(known.firstName, "Sam");
});

test("missing fields stay undefined, never fabricated", () => {
  const known = S.resolveKnownQualificationFields({ id: "l1", status: "new" }, undefined);
  assert.deepEqual(known, { firstName: undefined, projectType: undefined, budget: undefined, timeline: undefined, location: undefined });
});

test("15. only the known-qualification fields are carried through — no other lead/contact data leaks into this structure", () => {
  const lead = { id: "l1", status: "new", source: "website", score: 90, name: "John Test", estimatedBudget: 50000 } as any;
  const known = S.resolveKnownQualificationFields(lead, undefined);
  assert.deepEqual(Object.keys(known).sort(), ["budget", "firstName", "location", "projectType", "timeline"]);
});

test("describeKnownQualificationFields renders explicit 'do not ask again' lines only for what is actually known", () => {
  assert.deepEqual(S.describeKnownQualificationFields({}), []);
  const lines = S.describeKnownQualificationFields({ firstName: "John", budget: 50000 });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /John/);
  assert.match(lines[1], /\$50,000/);
  assert.match(lines[1], /do not ask/i);
});

test("manual_run's idempotency key is a pure function of (leadId, invocationId) — no clock, no window, never collides with the permanent lead_created key", () => {
  const keyA = S.buildManualRunIdempotencyKey("lead-1", "inv-aaaaaaaa");
  const createdKey = S.buildLeadCreatedIdempotencyKey("lead-1");
  assert.notEqual(keyA, createdKey);
  assert.equal(keyA, S.buildManualRunIdempotencyKey("lead-1", "inv-aaaaaaaa"), "same invocation id -> same key, regardless of when it's called");
  assert.notEqual(keyA, S.buildManualRunIdempotencyKey("lead-1", "inv-bbbbbbbb"), "a different invocation id -> a different key");
});

test("10. a malformed invocation id is rejected (too short, empty, unsafe characters); a real crypto.randomUUID() always passes", () => {
  assert.equal(S.isValidInvocationId(cryptoRandomUUID()), true);
  for (const bad of [undefined, null, "", "short", "has spaces here!!", "a".repeat(101), 12345, {}]) {
    assert.equal(S.isValidInvocationId(bad), false, JSON.stringify(bad));
  }
});
