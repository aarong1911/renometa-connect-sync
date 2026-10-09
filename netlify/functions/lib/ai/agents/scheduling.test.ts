// netlify/functions/lib/ai/agents/scheduling.test.ts
//
// Run:  node --test netlify/functions/lib/ai/agents/scheduling.test.ts
//
// Lead-Qualification-to-Scheduling handoff phase. Pure prompt-builder/
// decision-parser tests for the new Scheduling Agent contract — no
// model, no Supabase, no network, same convention as
// lead-qualification.test.ts/reception's own (absent) equivalent.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(path.join(tmpdir(), "scheduling-agent-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  entryPoints: [path.join(here, "scheduling.ts")],
  outfile: path.join(outDir, "subject.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error",
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);

const AGENT_INSTRUCTIONS = "You are Scheduling, responsible for helping a customer book an appointment.";
const baseContext = (extra: Record<string, unknown> = {}) => ({
  organization: { id: "org-1", name: "Acme Remodeling", timezone: "America/New_York" },
  channel: "sms" as const,
  ...extra,
});
const baseEvent = { eventId: "e1", channel: "sms" as const, eventType: "message_received", content: { type: "text" as const, text: "11 works" } };

const SLOT_A = { start: "2027-03-17T19:00:00.000Z", end: "2027-03-17T20:00:00.000Z", timeZone: "America/New_York" };
const SLOT_B = { start: "2027-03-17T21:00:00.000Z", end: "2027-03-17T22:00:00.000Z", timeZone: "America/New_York" };

// ── Decision parsing ──────────────────────────────────────────────────────

test("respond decision parses, including the optional declineScheduling flag", () => {
  const parsed = S.parseSchedulingDecision(JSON.stringify({ type: "respond", response: "What day works for you?", declineScheduling: false }));
  assert.equal(parsed.kind, "decision");
  assert.equal(parsed.decision.type, "respond");
  assert.equal(parsed.decision.declineScheduling, false);
});

test("respond decision with no declineScheduling field at all still parses (optional)", () => {
  const parsed = S.parseSchedulingDecision(JSON.stringify({ type: "respond", response: "Not now? No problem." }));
  assert.equal(parsed.kind, "decision");
  assert.equal(parsed.decision.declineScheduling, undefined);
});

test("get_availability decision requires a well-formed YYYY-MM-DD date — a malformed one falls back safely, never silently coerced", () => {
  const good = S.parseSchedulingDecision(JSON.stringify({ type: "get_availability", date: "2027-03-20" }));
  assert.equal(good.kind, "decision");
  assert.equal(good.decision.type, "get_availability");

  for (const badDate of ["March 20", "2027-3-20", "2027/03/20", "tomorrow", ""]) {
    const parsed = S.parseSchedulingDecision(JSON.stringify({ type: "get_availability", date: badDate }));
    assert.equal(parsed.kind, "fallback", badDate);
  }
});

test("select_offered_slot / propose_appointment require a positive integer selectedOptionNumber", () => {
  for (const type of ["select_offered_slot", "propose_appointment"]) {
    assert.equal(S.parseSchedulingDecision(JSON.stringify({ type, selectedOptionNumber: 1 })).kind, "decision", type);
    assert.equal(S.parseSchedulingDecision(JSON.stringify({ type, selectedOptionNumber: 0 })).kind, "fallback", type);
    assert.equal(S.parseSchedulingDecision(JSON.stringify({ type, selectedOptionNumber: -1 })).kind, "fallback", type);
    assert.equal(S.parseSchedulingDecision(JSON.stringify({ type, selectedOptionNumber: 1.5 })).kind, "fallback", type);
    assert.equal(S.parseSchedulingDecision(JSON.stringify({ type, selectedOptionNumber: "1" })).kind, "fallback", type);
  }
});

test("neither select_offered_slot nor propose_appointment has a field for a raw start/end time — the schema has no way to express a model-generated time at all", () => {
  const withTime = S.parseSchedulingDecision(JSON.stringify({ type: "propose_appointment", selectedOptionNumber: 1, startsAt: "2027-03-17T19:00:00.000Z" }));
  // .strict() rejects the whole object once an extra field is present.
  assert.equal(withTime.kind, "fallback");
});

test("there is no 'handoff' decision variant at all — Scheduling cannot hand off to anything in this phase (structural loop prevention)", () => {
  const parsed = S.parseSchedulingDecision(JSON.stringify({ type: "handoff", toAgent: "lead_qualification", reason: "x", summary: "y" }));
  assert.equal(parsed.kind, "fallback");
});

test("an unrecognized decision type falls back safely", () => {
  const parsed = S.parseSchedulingDecision(JSON.stringify({ type: "book_now", time: "whenever" }));
  assert.equal(parsed.kind, "fallback");
  assert.equal(parsed.responseText, S.GENERIC_FALLBACK_RESPONSE);
});

test("non-JSON model output is used as-is (a genuine natural-language attempt), never discarded", () => {
  const parsed = S.parseSchedulingDecision("Sure, happy to help you find a time!");
  assert.equal(parsed.kind, "fallback");
  assert.equal(parsed.responseText, "Sure, happy to help you find a time!");
});

// ── Offer formatting ──────────────────────────────────────────────────────

test("formatOfferedSlotOptions renders a 1-indexed, human-readable list in the same order the slots were given", () => {
  const options = S.formatOfferedSlotOptions([SLOT_A, SLOT_B]);
  assert.equal(options.length, 2);
  assert.match(options[0], /^1\)/);
  assert.match(options[1], /^2\)/);
  // Human-readable, not a raw ISO timestamp.
  assert.ok(!options[0].includes("2027-03-17T19:00:00.000Z"));
});

// ── Prompt builders ───────────────────────────────────────────────────────

test("the decision prompt shows a numbered list of currently offered slots when present, and tells the model to reference them only by option number", () => {
  const req = S.buildSchedulingDecisionRequest(AGENT_INSTRUCTIONS, baseContext(), baseEvent, [SLOT_A, SLOT_B]);
  assert.match(req.system, /1\)/);
  assert.match(req.system, /2\)/);
  assert.match(req.system, /refer to them ONLY by their option number/);
});

test("with no currently offered slots, the prompt says select_offered_slot/propose_appointment are not available right now", () => {
  const req = S.buildSchedulingDecisionRequest(AGENT_INSTRUCTIONS, baseContext(), baseEvent, undefined);
  assert.match(req.system, /select_offered_slot: only usable when options were just offered/);
  assert.match(req.system, /propose_appointment: only usable when options were just offered/);
});

test("the prompt includes today's date in the organization's own timezone, not the server's local time or UTC", () => {
  const req = S.buildSchedulingDecisionRequest(AGENT_INSTRUCTIONS, baseContext(), baseEvent, undefined, undefined, new Date("2027-03-16T02:30:00.000Z"));
  // 2027-03-16T02:30:00Z is 2027-03-15 22:30 in America/New_York (EDT, UTC-4) — a different calendar day than the raw UTC date.
  assert.match(req.system, /2027-03-15/);
});

test("known qualification fields (budget/timeline/location/first name) are surfaced exactly like Lead Qualification's own known-fields block", () => {
  const context = baseContext({ lead: { id: "l1", status: "qualified", name: "John Test", estimatedBudget: 50000, timeline: "within a month", location: "Austin, TX" } });
  const req = S.buildSchedulingDecisionRequest(AGENT_INSTRUCTIONS, context, baseEvent, undefined);
  assert.match(req.system, /Budget: \$50,000/);
  assert.match(req.system, /Desired timeline: within a month/);
  assert.match(req.system, /Location\/service area: Austin, TX/);
  assert.match(req.system, /First name: John/);
});

test("a handoff context block is included when reached via a Lead Qualification handoff, and the continuity instruction is present", () => {
  const handoff = { fromAgent: "lead_qualification" as const, toAgent: "scheduling" as const, reason: "ready", summary: "Kitchen remodel, ready to book.", knownFacts: { projectType: "kitchen remodel" }, openQuestions: ["Preferred day?"] };
  const req = S.buildSchedulingDecisionRequest(AGENT_INSTRUCTIONS, baseContext(), baseEvent, undefined, handoff);
  assert.match(req.system, /Lead Qualification has handed this conversation to you/);
  const userContent = req.messages[0].content;
  assert.match(userContent, /Kitchen remodel, ready to book\./);
  assert.match(userContent, /projectType: kitchen remodel/);
  assert.match(userContent, /Preferred day\?/);
});

test("without a handoff, no handoff context block or continuity instruction appears", () => {
  const req = S.buildSchedulingDecisionRequest(AGENT_INSTRUCTIONS, baseContext(), baseEvent, undefined);
  assert.ok(!req.system.includes("has handed this conversation to you"));
});

test("the final-response prompt never exposes internal mechanics (option numbers, tool names) to the customer, and tells the model to speak naturally about times", () => {
  const req = S.buildSchedulingFinalRequest(AGENT_INSTRUCTIONS, baseContext(), baseEvent, "These real, available slots were just found: 1) Wed Mar 17 3:00 PM.", [SLOT_A]);
  assert.match(req.system, /Do not mention internal tools, systems, option numbers/);
  assert.match(req.system, /never as an option number or raw timestamp/);
  const userContent = req.messages[0].content;
  assert.match(userContent, /Real outcome: These real, available slots were just found/);
});
