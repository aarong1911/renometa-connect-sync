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

// ── LIVE VALIDATION FIX: get_availability schema now carries optional
// preference hints, and the prompt requires a real day-signal first ────

test("get_availability decision accepts optional preferredTime (24-hour HH:MM) and preferredDaypart", () => {
  const withTime = S.parseSchedulingDecision(JSON.stringify({ type: "get_availability", date: "2027-03-17", preferredTime: "10:00" }));
  assert.equal(withTime.kind, "decision");
  assert.equal(withTime.decision.preferredTime, "10:00");

  const withDaypart = S.parseSchedulingDecision(JSON.stringify({ type: "get_availability", date: "2027-03-17", preferredDaypart: "afternoon" }));
  assert.equal(withDaypart.kind, "decision");
  assert.equal(withDaypart.decision.preferredDaypart, "afternoon");

  const withNeither = S.parseSchedulingDecision(JSON.stringify({ type: "get_availability", date: "2027-03-17" }));
  assert.equal(withNeither.kind, "decision");
  assert.equal(withNeither.decision.preferredTime, undefined);
});

test("preferredTime must be 24-hour HH:MM — a 12-hour or malformed value falls back safely, never silently coerced", () => {
  for (const bad of ["10:00am", "25:00", "10:60", "10", "10:0"]) {
    const parsed = S.parseSchedulingDecision(JSON.stringify({ type: "get_availability", date: "2027-03-17", preferredTime: bad }));
    assert.equal(parsed.kind, "fallback", bad);
  }
});

test("preferredDaypart only accepts the three known literal values", () => {
  const parsed = S.parseSchedulingDecision(JSON.stringify({ type: "get_availability", date: "2027-03-17", preferredDaypart: "late_night" }));
  assert.equal(parsed.kind, "fallback");
});

test("the prompt now REQUIRES a real day-signal from the customer before get_availability may be used — the root cause of the live defect (an unconditional 'use this when you don't have a current offer' invitation) is gone", () => {
  const req = S.buildSchedulingDecisionRequest(AGENT_INSTRUCTIONS, baseContext(), baseEvent, undefined);
  assert.match(req.system, /ONLY use this when the customer has given you SOME indication of which day they mean/);
  assert.match(req.system, /NEVER call get_availability, and NEVER pick a day yourself, when the customer has not told you ANY day or time preference yet/);
  assert.ok(!req.system.includes("Use this when you don't yet have a current offer to work with"), "the old unconditional invitation line must be gone");
});

test("the prompt describes preferredTime/preferredDaypart and defines the exact daypart boundaries selectCandidateSlots() itself uses", () => {
  const req = S.buildSchedulingDecisionRequest(AGENT_INSTRUCTIONS, baseContext(), baseEvent, undefined);
  assert.match(req.system, /morning = before noon, afternoon = noon-5pm, evening = 5pm or later/);
});

test("the prompt tells the model to ask which day when only a time was given, with no day at all", () => {
  const req = S.buildSchedulingDecisionRequest(AGENT_INSTRUCTIONS, baseContext(), baseEvent, undefined);
  assert.match(req.system, /The same applies if the customer gave only a time with no day at all.*ask which day, do not guess one/);
});

// ── selectCandidateSlots() — preference-aware ranking, pure function ────

const TZ = "America/New_York";
const MORNING_1 = { start: "2027-03-17T12:00:00.000Z", end: "2027-03-17T13:00:00.000Z", timeZone: TZ }; // 8:00 AM ET
const MORNING_2 = { start: "2027-03-17T12:30:00.000Z", end: "2027-03-17T13:30:00.000Z", timeZone: TZ }; // 8:30 AM ET
const MORNING_3 = { start: "2027-03-17T13:00:00.000Z", end: "2027-03-17T14:00:00.000Z", timeZone: TZ }; // 9:00 AM ET
const MORNING_4 = { start: "2027-03-17T13:30:00.000Z", end: "2027-03-17T14:30:00.000Z", timeZone: TZ }; // 9:30 AM ET
const TEN_AM = { start: "2027-03-17T14:00:00.000Z", end: "2027-03-17T15:00:00.000Z", timeZone: TZ }; // 10:00 AM ET
const NINE_THIRTY = MORNING_4; // 9:30 AM ET
const TEN_THIRTY = { start: "2027-03-17T14:30:00.000Z", end: "2027-03-17T15:30:00.000Z", timeZone: TZ }; // 10:30 AM ET
const TWO_PM = { start: "2027-03-17T18:00:00.000Z", end: "2027-03-17T19:00:00.000Z", timeZone: TZ }; // 2:00 PM ET
const FIVE_PM = { start: "2027-03-17T21:00:00.000Z", end: "2027-03-17T22:00:00.000Z", timeZone: TZ }; // 5:00 PM ET

const ALL_MORNING_PLUS_AFTERNOON = [MORNING_1, MORNING_2, MORNING_3, MORNING_4, TWO_PM, FIVE_PM];

test("with no preference at all, returns the first `limit` candidates unchanged — the pre-fix behavior, preserved for the date-only/no-time case", () => {
  const result = S.selectCandidateSlots(ALL_MORNING_PLUS_AFTERNOON, undefined, 4);
  assert.deepEqual(result.slots, [MORNING_1, MORNING_2, MORNING_3, MORNING_4]);
  assert.equal(result.exactMatch, false);
});

test("an exact preferredTime match is detected and surfaced first — never silently missed just because it wasn't chronologically first", () => {
  const result = S.selectCandidateSlots([MORNING_1, TEN_AM, TWO_PM], { time: "10:00" }, 4);
  assert.equal(result.exactMatch, true);
  assert.ok(result.slots.some((s: any) => s.start === TEN_AM.start));
});

test("no exact match for the requested time: the nearest REAL alternatives are returned, chronologically ordered, never the requested (nonexistent) time itself", () => {
  // Real candidates at 9:30 and 10:30 ET; customer asked for 10:00 ET, which does not exist.
  const result = S.selectCandidateSlots([NINE_THIRTY, TEN_THIRTY, TWO_PM, FIVE_PM], { time: "10:00" }, 2);
  assert.equal(result.exactMatch, false);
  assert.equal(result.slots.length, 2);
  assert.deepEqual(result.slots.map((s: any) => s.start), [NINE_THIRTY.start, TEN_THIRTY.start]);
});

test("a daypart preference (afternoon) prefers real afternoon candidates — morning slots are not blindly selected just because they are chronologically first", () => {
  const result = S.selectCandidateSlots(ALL_MORNING_PLUS_AFTERNOON, { daypart: "afternoon" }, 4);
  assert.deepEqual(result.slots, [TWO_PM]);
  assert.ok(!result.slots.some((s: any) => s.start === MORNING_1.start));
});

test("a daypart preference with zero real matches falls back to the ordinary first-N list — never fabricates a slot just to fill the daypart", () => {
  const result = S.selectCandidateSlots([MORNING_1, MORNING_2], { daypart: "evening" }, 4);
  assert.deepEqual(result.slots, [MORNING_1, MORNING_2]);
  assert.equal(result.exactMatch, false);
});

test("preferredTime takes precedence over preferredDaypart when both are somehow set", () => {
  const result = S.selectCandidateSlots([NINE_THIRTY, TWO_PM], { time: "09:30", daypart: "afternoon" }, 4);
  assert.equal(result.exactMatch, true);
  assert.ok(result.slots.some((s: any) => s.start === NINE_THIRTY.start));
});

test("the final-response prompt never exposes internal mechanics (option numbers, tool names) to the customer, and tells the model to speak naturally about times", () => {
  const req = S.buildSchedulingFinalRequest(AGENT_INSTRUCTIONS, baseContext(), baseEvent, "These real, available slots were just found: 1) Wed Mar 17 3:00 PM.", [SLOT_A]);
  assert.match(req.system, /Do not mention internal tools, systems, option numbers/);
  assert.match(req.system, /never as an option number or raw timestamp/);
  const userContent = req.messages[0].content;
  assert.match(userContent, /Real outcome: These real, available slots were just found/);
});
