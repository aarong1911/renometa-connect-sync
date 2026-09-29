// netlify/functions/lib/ai/agents/lead-qualification.test.ts
//
// Run:  node --test netlify/functions/lib/ai/agents/lead-qualification.test.ts
// Pure prompt-builder tests — no model, no Supabase, no network. Verifies the
// AI-3A known-qualification-fields injection and that the pre-existing
// marketplace/referral-avoidance persona instruction is still present
// (regression: this phase must not lose it).

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(path.join(tmpdir(), "lead-qual-agent-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  entryPoints: [path.join(here, "lead-qualification.ts")],
  outfile: path.join(outDir, "subject.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error",
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);

// Same marketplace-avoidance line orchestrator.ts actually passes today as
// `agentInstructions` (see orchestrator.ts:234) — reused verbatim so this
// test proves the REAL text, not an invented stand-in.
const AGENT_INSTRUCTIONS =
  "The business using RenoMeta Connect is the contractor/service provider the lead is contacting — you represent THAT business, not a marketplace, referral service, or neutral third party. Assume the customer is considering hiring this business for the project. Do not ask whether the customer is looking for another contractor, comparing contractors, already has a contractor, or needs help finding one, unless the customer explicitly brings that up first.";

const baseContext = (lead?: Record<string, unknown>) => ({
  organization: { id: "org-1", name: "Acme Remodeling" },
  channel: "sms" as const,
  lead,
});
const baseEvent = { eventId: "e1", channel: "sms" as const, eventType: "message_received", content: { type: "text" as const, text: "Hi, can you help with my kitchen?" } };

test("17+18. known budget and timeline are not re-asked — the prompt tells the model they're already known", () => {
  const context = baseContext({ id: "l1", status: "new", name: "John Test", estimatedBudget: 50000, timeline: "within three months" });
  const req = S.buildLeadQualificationDecisionRequest(AGENT_INSTRUCTIONS, context, baseEvent);
  assert.match(req.system, /Budget: \$50,000 \(already known; do not ask for budget again\)/);
  assert.match(req.system, /Desired timeline: within three months \(already known; do not ask when they want to start again\)/);
});

test("19. first name is surfaced for natural use when known", () => {
  const context = baseContext({ id: "l1", status: "new", name: "John Test" });
  const req = S.buildLeadQualificationDecisionRequest(AGENT_INSTRUCTIONS, context, baseEvent);
  assert.match(req.system, /First name: John \(use it naturally; do not ask for it\)/);
});

test("a brand-new lead with nothing known yet gets no known-fields block at all (prompt unchanged from before this pass)", () => {
  const context = baseContext({ id: "l1", status: "new" });
  const req = S.buildLeadQualificationDecisionRequest(AGENT_INSTRUCTIONS, context, baseEvent);
  assert.ok(!req.system.includes("Already known about this lead"));
});

test("20+21. the marketplace/referral-avoidance persona instruction is present verbatim — never asks 'specific contractor or exploring options'", () => {
  const context = baseContext({ id: "l1", status: "new" });
  const req = S.buildLeadQualificationDecisionRequest(AGENT_INSTRUCTIONS, context, baseEvent);
  assert.match(req.system, /not a marketplace, referral service, or neutral third party/);
  assert.match(req.system, /Do not ask whether the customer is looking for another contractor/);
});

test("22. the model is steered toward exactly one allowlisted tool, never invited to invent pricing/availability/promises", () => {
  const context = baseContext({ id: "l1", status: "new" });
  const req = S.buildLeadQualificationDecisionRequest(AGENT_INSTRUCTIONS, context, baseEvent);
  assert.match(req.system, /get_lead_context/);
  assert.match(req.system, /add_internal_note/);
  assert.match(req.system, /Do not request any tool other than these two/);
});

test("known fields also appear on the second (final response) prompt, not just the decision prompt", () => {
  const context = baseContext({ id: "l1", status: "new", name: "John Test", estimatedBudget: 50000 });
  const req = S.buildLeadQualificationFinalRequest(AGENT_INSTRUCTIONS, context, baseEvent, "An internal note was added successfully.");
  assert.match(req.system, /First name: John/);
  assert.match(req.system, /Budget: \$50,000/);
});

test("23. LEAD_QUALIFICATION_TOOL_ALLOWLIST stays narrow — never includes a send/communicate action (handoff to human is the only escalation path this phase supports)", () => {
  assert.deepEqual([...S.LEAD_QUALIFICATION_TOOL_ALLOWLIST].sort(), ["add_internal_note", "get_lead_context"]);
});
