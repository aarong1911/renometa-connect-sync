// netlify/functions/lib/ai/router.test.ts
//
// Run:  node --test netlify/functions/lib/ai/router.test.ts
//
// Lead-Qualification-to-Scheduling handoff phase. router.ts had NO test
// file at all before this pass. Covers the new Tier 2
// (routeByConversationState) — the one, narrow conversation-ownership
// signal this phase adds (an outstanding, fresh scheduling offer routes
// to "scheduling") — plus a full regression pass over every pre-existing
// Tier 1/3/fallback rule, proving this addition changes nothing about
// Reception/Lead Qualification routing.
//
// Pure, synchronous, no Supabase/model/network — routeAIEvent() itself
// has none of those (see router.ts's own "PURITY" header); this test
// constructs AIResolvedContext objects directly, including the new
// context.conversation.schedulingOfferActive field, which in production
// is computed by context-builder.ts (covered separately).

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(path.join(tmpdir(), "router-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  entryPoints: [path.join(here, "router.ts")],
  outfile: path.join(outDir, "subject.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error",
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);

const BASE_EVENT = { eventId: "e1", channel: "sms" as const, eventType: "message_received", content: { type: "text" as const, text: "hi" } };
const ORG = { id: "org-1", name: "Acme Remodeling" };

function contextWithOffer(active: boolean | undefined, extra: Record<string, unknown> = {}) {
  return {
    organization: ORG,
    channel: "sms" as const,
    conversation: { channel: "sms" as const, schedulingOfferActive: active },
    ...extra,
  };
}

// ── Tier 2: active/stale/missing/error-safe offer ────────────────────────

test("active offer -> routes to scheduling, before CRM-context routing could send it to Lead Qualification", () => {
  const context = contextWithOffer(true, { lead: { id: "l1", status: "qualified" } });
  const decision = S.routeAIEvent({ ...BASE_EVENT, eventType: "message_received" }, context);
  assert.equal(decision.agentKey, "scheduling");
  assert.equal(decision.source, "conversation_state");
});

test("stale offer (schedulingOfferActive: false, as context-builder.ts resolves for a >24h-old offer) falls through to existing Tier 3 behavior", () => {
  const context = contextWithOffer(false, { lead: { id: "l1", status: "qualified" } });
  const decision = S.routeAIEvent({ ...BASE_EVENT, eventType: "message_received" }, context);
  assert.equal(decision.agentKey, "lead_qualification");
  assert.equal(decision.source, "rule");
});

test("no offer at all (schedulingOfferActive undefined) falls through to existing Tier 3 behavior, unchanged", () => {
  const context = contextWithOffer(undefined, { lead: { id: "l1", status: "qualified" } });
  const decision = S.routeAIEvent({ ...BASE_EVENT, eventType: "message_received" }, context);
  assert.equal(decision.agentKey, "lead_qualification");
  assert.equal(decision.source, "rule");
});

test("no conversation summary at all (e.g. a channel with no conversation context) never throws, falls through safely", () => {
  const context = { organization: ORG, channel: "sms" as const, lead: { id: "l1", status: "qualified" } };
  const decision = S.routeAIEvent({ ...BASE_EVENT, eventType: "message_received" }, context);
  assert.equal(decision.agentKey, "lead_qualification");
});

test("a malformed/unavailable scheduling read (context-builder.ts's own fail-safe already collapses an error to `false`/undefined before this ever runs) has no special case here — it just looks like 'no active offer' and falls through to existing routing, never throws", () => {
  // Simulates exactly what context-builder.ts hands the router after a
  // genuine readOfferedSlots() query failure: schedulingOfferActive simply
  // absent — proving the router itself needs no try/catch of its own.
  const context = { organization: ORG, channel: "sms" as const, conversation: { channel: "sms" as const }, lead: { id: "l1", status: "new" } };
  const decision = S.routeAIEvent({ ...BASE_EVENT, eventType: "message_received" }, context);
  assert.equal(decision.agentKey, "lead_qualification");
});

test("near/at the exact TTL boundary: router.ts itself has no TTL math at all — it only ever sees the already-resolved boolean, so a true boundary test belongs to context-builder.test.ts; this test documents that division of responsibility and confirms the router trusts the boolean as given either way", () => {
  assert.equal(S.routeAIEvent({ ...BASE_EVENT }, contextWithOffer(true)).agentKey, "scheduling");
  assert.equal(S.routeAIEvent({ ...BASE_EVENT }, contextWithOffer(false)).agentKey, "reception");
});

// ── Full regression: every pre-existing rule stays unchanged ────────────

test("explicit event routing (Tier 1) is completely unaffected by Tier 2 — new_lead still routes to lead_qualification even with an active offer present", () => {
  const context = contextWithOffer(true);
  const decision = S.routeAIEvent({ ...BASE_EVENT, eventType: "new_lead" }, context);
  assert.equal(decision.agentKey, "lead_qualification");
  assert.equal(decision.source, "deterministic");
});

for (const [eventType, expectedAgent] of [
  ["missed_call", "reception"],
  ["call_started", "reception"],
  ["call_ended", "reception"],
  ["manual_test", "reception"],
  ["internal_request", "reception"],
  ["workflow_trigger", "reception"],
] as const) {
  test(`Tier 1 regression: ${eventType} still routes to ${expectedAgent}, unaffected by this phase`, () => {
    const decision = S.routeAIEvent({ ...BASE_EVENT, eventType }, { organization: ORG, channel: "sms" });
    assert.equal(decision.agentKey, expectedAgent);
    assert.equal(decision.source, "deterministic");
  });
}

test("Tier 3 regression: an active (new/contacted/qualified) lead with NO scheduling offer still routes to lead_qualification exactly as before", () => {
  for (const status of ["new", "contacted", "qualified"]) {
    const decision = S.routeAIEvent({ ...BASE_EVENT }, { organization: ORG, channel: "sms", lead: { id: "l1", status } });
    assert.equal(decision.agentKey, "lead_qualification", status);
    assert.equal(decision.source, "rule");
  }
});

test("Tier 3 regression: converted/lost leads still fall through to the Reception fallback, unaffected", () => {
  for (const status of ["converted", "lost"]) {
    const decision = S.routeAIEvent({ ...BASE_EVENT }, { organization: ORG, channel: "sms", lead: { id: "l1", status } });
    assert.equal(decision.agentKey, "reception", status);
    assert.equal(decision.source, "fallback");
  }
});

test("Tier 3 regression: scheduling is still never selected from CRM/entity context alone (no offer present)", () => {
  const decision = S.routeAIEvent({ ...BASE_EVENT }, { organization: ORG, channel: "sms", lead: { id: "l1", status: "qualified" }, project: { id: "p1", name: "Kitchen", status: "active" } });
  assert.equal(decision.agentKey, "lead_qualification");
});

test("fallback regression: no event-type match, no offer, no lead -> Reception, unaffected", () => {
  const decision = S.routeAIEvent({ ...BASE_EVENT }, { organization: ORG, channel: "sms" });
  assert.equal(decision.agentKey, "reception");
  assert.equal(decision.source, "fallback");
});
