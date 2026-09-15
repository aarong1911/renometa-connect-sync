// netlify/functions/lib/ai/agents/reception.ts
//
// AI Center — Phase AI-1K. The structured-decision contract for
// Reception: the ONLY AI-1 agent allowed to request a handoff, and ONLY
// ever to "lead_qualification". This file defines the decision schema,
// its strict runtime validator, and the decision-call prompt builder. It
// does NOT call a model and does NOT construct an AIAgentHandoff itself —
// orchestrator.ts does that from a validated decision (see its
// "Reception turn" section), mirroring exactly how
// agents/lead-qualification.ts stays a pure contract module while
// orchestrator.ts owns actually running anything.
//
// ── TRUST BOUNDARY ───────────────────────────────────────────────────────
//
// The model may choose:
//   - "respond" with plain text, or
//   - "handoff" to lead_qualification, with a reason/summary/knownFacts/
//     openQuestions it composes itself from the conversation.
//
// The model may NEVER choose orgId, userId, actor, autonomyLevel,
// executionId, contactId, leadId, or projectId — this schema has no field
// for any of them, on either variant. A handoff is a structured
// CONTENT decision, never an authorization decision: orchestrator.ts
// always continues using the same, unmodified `trustedContext` after a
// handoff (see this file's header and orchestrator.ts's "Reception turn"
// section) — nothing here can widen what Lead Qualification is allowed to
// do once it takes over.
//
// Reception has NO tool access in AI-1K — this schema has no "tool"
// variant at all (compare to lead-qualification.ts's three-variant
// schema), so there is no path for the model to request one even by
// mistake.
//
// At most one handoff per run: this contract expresses exactly one
// decision, and "handoff" is a terminal choice for Reception in AI-1K —
// there is no field or path for Reception to hand off more than once, and
// Lead Qualification's own decision schema (lead-qualification.ts) has no
// "handoff" variant at all, so control can never bounce back to Reception
// or onward to a third agent. This is enforced by the type/schema shape
// itself, not by a runtime counter.

import { z } from "zod";
import type { AIChannel, AIChannelEvent, AIResolvedContext } from "../types";
import type { ModelRequest } from "../providers/model-provider";
import { AI_CENTER_DEFAULT_MODEL, AI_CENTER_MAX_TOKENS, buildContextLines, channelGuidance } from "../prompting";

// ── Handoff allowlist (AI-1K) ─────────────────────────────────────────────
//
// Reception may hand off ONLY to lead_qualification, even though
// AIAgentKey (ai/types.ts) is an extensible string type that could in
// principle name any agent. The Zod schema below already restricts
// `toAgent` to the single literal "lead_qualification", but per this
// task's explicit instruction ("Do not rely only on type literals"),
// orchestrator.ts checks this allowlist too before ever building an
// AIAgentHandoff or invoking Lead Qualification — the same defense-in-
// depth pattern already used for LEAD_QUALIFICATION_TOOL_ALLOWLIST.
export const RECEPTION_HANDOFF_ALLOWLIST: ReadonlySet<string> = new Set(["lead_qualification"]);

// Safe, generic, never-untrue fallback — same role as
// lead-qualification.ts's GENERIC_FALLBACK_RESPONSE, kept as a separate
// constant here so this file has no import dependency on that one (both
// are leaf agent-contract modules; neither should need the other).
export const GENERIC_FALLBACK_RESPONSE =
  "Thanks for reaching out — let me make sure I get you to the right place.";

// ── Decision schema ────────────────────────────────────────────────────────
//
// Two fully-.strict() variants combined with z.union (same reasoning as
// lead-qualification.ts: each variant's literal `type` value fully
// determines which one a given object can match, so plain z.union is
// unambiguous without needing z.discriminatedUnion). `.strict()` means an
// unexpected extra field (e.g. a model trying to add a `leadId` or
// `autonomyLevel`) fails the WHOLE object, never partially matches.
//
// knownFacts is a bounded string-to-string record — chosen to match
// AIAgentHandoff.knownFacts's real type (Record<string, unknown>,
// ai/types.ts) exactly, rather than the array shape from this task's own
// illustrative example, specifically so the validated decision can be
// assigned directly into an AIAgentHandoff with no reshaping and no
// second handoff type. Bounded to a small number of short entries — a
// handoff summary, not a data dump.

const respondDecisionSchema = z
  .object({
    type: z.literal("respond"),
    response: z.string().min(1).max(2000),
  })
  .strict();

const MAX_KNOWN_FACTS = 6;
const MAX_OPEN_QUESTIONS = 6;

const handoffDecisionSchema = z
  .object({
    type: z.literal("handoff"),
    toAgent: z.literal("lead_qualification"),
    reason: z.string().min(1).max(300),
    summary: z.string().min(1).max(1000),
    knownFacts: z
      .record(z.string().min(1).max(60), z.string().min(1).max(300))
      .refine((facts) => Object.keys(facts).length <= MAX_KNOWN_FACTS, {
        message: `knownFacts must have at most ${MAX_KNOWN_FACTS} entries`,
      })
      .optional(),
    openQuestions: z.array(z.string().min(1).max(200)).max(MAX_OPEN_QUESTIONS).optional(),
  })
  .strict();

const receptionDecisionSchema = z.union([respondDecisionSchema, handoffDecisionSchema]);

export type ReceptionDecision = z.infer<typeof receptionDecisionSchema>;
export type ReceptionHandoffDecision = Extract<ReceptionDecision, { type: "handoff" }>;

export type ParsedReceptionDecision =
  | { kind: "decision"; decision: ReceptionDecision }
  | { kind: "fallback"; responseText: string };

/**
 * Parses and strictly validates Reception's raw decision text. Never
 * throws; never attempts to recover a handoff out of malformed or
 * unstructured output by inspection/regex — a parse or validation
 * failure always falls back to a safe response, never a handoff. Same
 * two-case fallback reasoning as
 * lead-qualification.ts's parseLeadQualificationDecision(): non-JSON text
 * is used as-is (it was a genuine natural-language attempt, never a
 * handoff either way); JSON that fails the strict schema (unknown
 * toAgent, extra fields, wrong shape) falls back to a fixed generic
 * response rather than ever being shown to the customer or inspected
 * further for a salvageable handoff.
 */
export function parseReceptionDecision(rawText: string): ParsedReceptionDecision {
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(cleaned);
  } catch {
    return { kind: "fallback", responseText: rawText.trim() || GENERIC_FALLBACK_RESPONSE };
  }

  const result = receptionDecisionSchema.safeParse(parsedJson);
  if (!result.success) {
    return { kind: "fallback", responseText: GENERIC_FALLBACK_RESPONSE };
  }

  return { kind: "decision", decision: result.data };
}

// ── Prompt builder ─────────────────────────────────────────────────────────

function buildDecisionSystemInstructions(agentInstructions: string, organizationName: string, channel: AIChannel): string {
  const guidance = channelGuidance(channel);
  return [
    agentInstructions,
    ...(guidance ? ["", guidance] : []),
    "",
    "You may either respond directly, or hand this conversation off to Lead Qualification — a specialist on the same team who will continue naturally as part of the same business conversation (the customer will not be told about a hand-off).",
    "Hand off to Lead Qualification only when the customer is clearly presenting a potential project, job, or service opportunity for this business — e.g. a remodeling/renovation request, an estimate request, or a description of project scope, budget, timeline, or property work.",
    "Do NOT hand off just because the customer says hello, asks a basic general question you can answer yourself, or hasn't given enough information yet to tell if there's a real project — respond directly in those cases.",
    "You represent this business, not a marketplace or referral service — if the customer describes a real project opportunity, move it toward qualification for THIS business, never toward finding another contractor.",
    "You have not booked, sent, updated any CRM record, or performed a hand-off yet — this decision does not perform anything itself.",
    "",
    `Organization: ${organizationName}.`,
    "",
    "Respond with ONLY a single JSON object — no markdown, no code fences, no text outside the JSON — matching exactly one of these shapes:",
    '{"type":"respond","response":"<your natural-language reply to the customer>"}',
    '{"type":"handoff","toAgent":"lead_qualification","reason":"<short reason this is a qualification opportunity>","summary":"<one or two sentence summary of what the customer wants>","knownFacts":{"<short fact label>":"<short value>"},"openQuestions":["<short open question>"]}',
    '"knownFacts" and "openQuestions" are optional — include them only when you actually have something to note; do not invent facts that weren\'t said.',
  ].join("\n");
}

/** The single model call for a Reception turn: asks for a structured
 * decision (respond, or hand off to Lead Qualification). JSON output is
 * requested via prompt instructions only — no Anthropic-specific
 * structured-output API is used; parseReceptionDecision() is the actual
 * enforcement point. */
export function buildReceptionDecisionRequest(
  agentInstructions: string,
  context: AIResolvedContext,
  event: AIChannelEvent,
): ModelRequest {
  const system = buildDecisionSystemInstructions(agentInstructions, context.organization.name, context.channel);
  const contextLines = buildContextLines(context);
  const inboundText = event.content.text?.trim() || "(no message text provided)";

  const userMessage = [
    `Current inbound event:\n${inboundText}`,
    contextLines.length > 0 ? `Known CRM context:\n${contextLines.join("\n")}` : "Known CRM context: none available.",
    "Decide your response now, following the JSON contract exactly.",
  ].join("\n\n");

  return {
    model: AI_CENTER_DEFAULT_MODEL,
    system,
    messages: [{ role: "user", content: userMessage }],
    maxTokens: AI_CENTER_MAX_TOKENS,
  };
}
