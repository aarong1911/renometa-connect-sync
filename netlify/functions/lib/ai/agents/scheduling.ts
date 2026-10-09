// netlify/functions/lib/ai/agents/scheduling.ts
//
// Lead-Qualification-to-Scheduling handoff phase. The structured-decision
// contract for the Scheduling Agent — the first real implementation of
// the "scheduling" AIAgentKey that router.ts and action-registry.ts have
// reserved since PR #16. Follows the exact same shape as
// agents/lead-qualification.ts and agents/reception.ts: this file defines
// the decision schema, its strict runtime validator, and the prompt
// builders. It does NOT call a model, does NOT call executeStep(), and
// does NOT touch Supabase — actually running anything remains
// orchestrator.ts's job (see its "Scheduling turn" section).
//
// ── TRUST BOUNDARY ───────────────────────────────────────────────────────
//
// The model may choose one of four decision types (respond,
// get_availability, select_offered_slot, propose_appointment) and, within
// each, only genuinely model-owned content:
//   - respond: natural-language reply text, plus an optional boolean flag
//     (declineScheduling) the model sets when the customer has clearly
//     declined — a deterministic SIGNAL, not free text, so the
//     orchestrator's resulting clearOfferedSlots() call is never driven by
//     string-matching the model's own prose.
//   - get_availability: a single structured ISO date (validated by this
//     schema's own regex before anything else ever sees it) — never a
//     natural-language date string.
//   - select_offered_slot / propose_appointment: an integer
//     `selectedOptionNumber` referencing ONE of the slots most recently
//     offered to this customer (1-indexed, matching the numbered list the
//     prompt itself shows the model) — NEVER a start/end time the model
//     writes out itself. orchestrator.ts validates this number against
//     the REAL persisted offer (scheduling-offer-state.ts) before trusting
//     it for anything; an out-of-range or unresolvable number is treated
//     as "unmatched," never guessed into the nearest real slot.
//
// The model may NEVER choose or override orgId, actor, autonomyLevel,
// executionId, contactId, leadId, projectId, the actual appointment
// start/end time, or any approval/risk/autonomy field — none of those has
// a field anywhere in this schema. This is the one hard rule the entire
// scheduling-foundation phase (PR #16) was already built around: a model-
// generated time is never authoritative. This file's schema structurally
// cannot violate that — it has no way to express a raw time at all.
//
// No handoff variant exists in this schema, on purpose — see
// orchestrator.ts's "Scheduling turn" section for why Scheduling cannot
// hand off to anything in this PR (structural loop prevention, same
// pattern Lead Qualification's own schema already relies on).

import { z } from "zod";
import type { AIAgentHandoff, AIChannel, AIChannelEvent, AIResolvedContext } from "../types";
import type { ModelRequest } from "../providers/model-provider";
import { AI_CENTER_DEFAULT_MODEL, AI_CENTER_MAX_TOKENS, buildContextLines, channelGuidance } from "../prompting";
import { describeKnownQualificationFields, resolveKnownQualificationFields } from "../lead-trigger";
import type { PersistedSlotOffer } from "../../scheduling-offer-state";

// ── Handoff continuity (reused pattern from lead-qualification.ts) ──────

const HANDOFF_CONTINUITY_INSTRUCTION =
  "Lead Qualification has handed this conversation to you. Continue naturally as the same business conversation — do not introduce yourself as a separate AI agent, and do not tell the customer they were transferred or handed off, unless the customer explicitly asks how this works.";

function buildHandoffContextBlock(handoff: AIAgentHandoff): string {
  const lines: string[] = [
    `Notes from Lead Qualification (context only — the CRM data above is authoritative if anything here conflicts): ${handoff.summary}`,
  ];
  if (handoff.knownFacts && Object.keys(handoff.knownFacts).length > 0) {
    const facts = Object.entries(handoff.knownFacts)
      .map(([label, value]) => `${label}: ${String(value)}`)
      .join("; ");
    lines.push(`Lead Qualification noted: ${facts}`);
  }
  if (handoff.openQuestions && handoff.openQuestions.length > 0) {
    lines.push(`Still open per Lead Qualification: ${handoff.openQuestions.join("; ")}`);
  }
  return lines.join("\n");
}

// A safe, generic, never-untrue response used whenever the model's output
// can't be trusted as a structured decision — same role as the other two
// agent files' own fallback constants.
export const GENERIC_FALLBACK_RESPONSE =
  "Thanks for your patience — let me check on scheduling and get back to you.";

// ── Decision schema ───────────────────────────────────────────────────────
//
// Four fully-.strict() variants (same z.union-over-strict-schemas
// reasoning as lead-qualification.ts/reception.ts — each variant's
// literal `type` fully determines which one a given object can match).

const respondDecisionSchema = z
  .object({
    type: z.literal("respond"),
    response: z.string().min(1).max(2000),
    /** True only when the customer has clearly declined scheduling (e.g.
     * "not now", "no thanks") — a deterministic signal the orchestrator
     * acts on (clearOfferedSlots()), never inferred from the response text
     * itself. Omitted/false for an ordinary response. */
    declineScheduling: z.boolean().optional(),
  })
  .strict();

const getAvailabilityDecisionSchema = z
  .object({
    type: z.literal("get_availability"),
    /** Plain "YYYY-MM-DD" — structured, never natural language (see this
     * file's header). The prompt tells the model today's real date in the
     * org's timezone so it can compute "tomorrow"/"next Tuesday" itself;
     * this field is still independently validated here regardless. */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
    reason: z.string().max(300).optional(),
  })
  .strict();

/** Shared by select_offered_slot and propose_appointment — both reference
 * the currently-offered list the same way; they differ only in what the
 * orchestrator DOES once the reference is validated (see orchestrator.ts's
 * "Scheduling turn" section: select_offered_slot only confirms/clarifies,
 * propose_appointment actually calls executeStep()). Neither carries a
 * `response` field — exactly like lead-qualification.ts's own `tool`
 * variants, the customer-facing reply is generated by a SECOND model call
 * once the orchestrator knows the real outcome (matched/unmatched/booked/
 * failed), never pre-written by this same decision call before that
 * outcome is known. */
const selectedOptionField = z.number().int().positive();

const selectOfferedSlotDecisionSchema = z
  .object({
    type: z.literal("select_offered_slot"),
    selectedOptionNumber: selectedOptionField,
    reason: z.string().max(300).optional(),
  })
  .strict();

const proposeAppointmentDecisionSchema = z
  .object({
    type: z.literal("propose_appointment"),
    selectedOptionNumber: selectedOptionField,
    reason: z.string().max(300).optional(),
  })
  .strict();

const schedulingDecisionSchema = z.union([
  respondDecisionSchema,
  getAvailabilityDecisionSchema,
  selectOfferedSlotDecisionSchema,
  proposeAppointmentDecisionSchema,
]);

export type SchedulingDecision = z.infer<typeof schedulingDecisionSchema>;
export type SchedulingRespondDecision = Extract<SchedulingDecision, { type: "respond" }>;
export type SchedulingGetAvailabilityDecision = Extract<SchedulingDecision, { type: "get_availability" }>;
export type SchedulingSelectOfferedSlotDecision = Extract<SchedulingDecision, { type: "select_offered_slot" }>;
export type SchedulingProposeAppointmentDecision = Extract<SchedulingDecision, { type: "propose_appointment" }>;
/** Either slot-referencing variant — orchestrator.ts validates
 * `selectedOptionNumber` against the real persisted offer identically for
 * both before branching on which one it is. */
export type SchedulingSlotReferenceDecision = Extract<SchedulingDecision, { type: "select_offered_slot" | "propose_appointment" }>;

export type ParsedSchedulingDecision =
  | { kind: "decision"; decision: SchedulingDecision }
  | { kind: "fallback"; responseText: string };

/**
 * Parses and strictly validates the decision model's raw text output.
 * Same two-case fallback reasoning as the other two agent contract files:
 * non-JSON text is used as-is (a genuine natural-language attempt, never a
 * structured action either way); JSON that fails the strict schema always
 * falls back to a fixed generic response, never inspected further for a
 * salvageable action.
 */
export function parseSchedulingDecision(rawText: string): ParsedSchedulingDecision {
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(cleaned);
  } catch {
    return { kind: "fallback", responseText: rawText.trim() || GENERIC_FALLBACK_RESPONSE };
  }

  const result = schedulingDecisionSchema.safeParse(parsedJson);
  if (!result.success) {
    return { kind: "fallback", responseText: GENERIC_FALLBACK_RESPONSE };
  }

  return { kind: "decision", decision: result.data };
}

// ── Offer formatting (shared between prompt building and orchestrator) ──

/** Renders a persisted slot offer as the exact numbered list the prompt
 * shows the model and `selectedOptionNumber` indexes into — ONE canonical
 * formatting function so the prompt's list and the orchestrator's own
 * validation always agree on what "option 2" means. `timeZone` is read
 * from the slot itself (every PersistedSlotOffer carries its own, already
 * the org's authoritative zone — see scheduling-availability.ts), never
 * recomputed or guessed here. */
export function formatOfferedSlotOptions(slots: PersistedSlotOffer[]): string[] {
  return slots.map((slot, index) => {
    const start = new Date(slot.start);
    const label = start.toLocaleString("en-US", {
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
      timeZone: slot.timeZone,
    });
    return `${index + 1}) ${label}`;
  });
}

// ── Prompt builders ───────────────────────────────────────────────────────

function buildKnownFieldsBlock(context: AIResolvedContext): string {
  const known = resolveKnownQualificationFields(context.lead, context.contact);
  const lines = describeKnownQualificationFields(known);
  if (lines.length === 0) return "";
  return [
    "",
    "Already known about this customer (from CRM records) — use it naturally, never re-ask:",
    ...lines.map((l) => `- ${l}`),
  ].join("\n");
}

/** Today's calendar date in the organization's own timezone, as a plain
 * "YYYY-MM-DD" + friendly day name — informational only, so the model can
 * compute "tomorrow"/"next Tuesday" into a real structured date for
 * get_availability. Never itself trusted for anything — get_availability's
 * own `date` field is independently validated and the real booking/
 * availability math always re-resolves organizations.timezone server-side
 * regardless of what this string says. */
function describeTodayInOrgTimezone(timeZone: string | undefined, now: Date): string {
  if (!timeZone) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "long",
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const weekday = get("weekday");
    const ymd = `${get("year")}-${get("month")}-${get("day")}`;
    return `Today's date where this business is located: ${ymd} (${weekday}).`;
  } catch {
    return "";
  }
}

function buildOfferedSlotsBlock(offeredSlots: PersistedSlotOffer[] | undefined): string {
  if (!offeredSlots || offeredSlots.length === 0) return "";
  const options = formatOfferedSlotOptions(offeredSlots);
  return [
    "",
    "You most recently offered these specific appointment times (refer to them ONLY by their option number — never restate or invent a different time):",
    ...options,
  ].join("\n");
}

function buildDecisionSystemInstructions(
  agentInstructions: string,
  organizationName: string,
  channel: AIChannel,
  context: AIResolvedContext,
  offeredSlots: PersistedSlotOffer[] | undefined,
  now: Date,
): string {
  const guidance = channelGuidance(channel);
  const todayLine = describeTodayInOrgTimezone(context.organization.timezone, now);
  return [
    agentInstructions,
    ...(guidance ? ["", guidance] : []),
    buildKnownFieldsBlock(context),
    buildOfferedSlotsBlock(offeredSlots),
    "",
    ...(todayLine ? [todayLine] : []),
    "You may choose exactly one of the following actions:",
    "- get_availability: looks up real, currently-open appointment slots for a specific date you choose (YYYY-MM-DD). Use this when you don't yet have a current offer to work with, or when the customer wants a different day than what was last offered.",
    offeredSlots && offeredSlots.length > 0
      ? "- select_offered_slot: use when the customer's reply clearly references ONE of the numbered options above, but you want to confirm it back to them before actually booking (e.g. they mentioned a time but haven't explicitly said to book it yet)."
      : "- select_offered_slot: only usable when options were just offered above — not available right now.",
    offeredSlots && offeredSlots.length > 0
      ? "- propose_appointment: use when the customer's reply clearly and unambiguously identifies ONE of the numbered options above AND confirms they want it booked (e.g. \"yes, 11 works\", \"book the second one\", \"that works, let's do it\")."
      : "- propose_appointment: only usable when options were just offered above — not available right now.",
    "- respond: use for anything else — greeting, asking what day works, answering a question using the CRM context above, asking for clarification when you cannot tell which numbered option the customer means, or acknowledging a clear decline (set declineScheduling:true only when the customer clearly does not want to schedule right now, e.g. \"not now\" or \"no thanks\").",
    "If the customer's reply could match more than one numbered option, or doesn't clearly match any of them, use respond and ask a short clarifying question — never guess which option they meant.",
    "Never state a specific appointment time yourself unless it is one of the exact numbered options you were just given above, or one just returned by get_availability.",
    "You have not booked anything yet, and selecting or proposing an option here does not mean it is confirmed — you will be told the real outcome afterward.",
    "",
    `Organization: ${organizationName}.`,
    "",
    "Respond with ONLY a single JSON object — no markdown, no code fences, no text outside the JSON — matching exactly one of these shapes:",
    '{"type":"respond","response":"<your natural-language reply to the customer>","declineScheduling":false}',
    '{"type":"get_availability","date":"<YYYY-MM-DD>","reason":"<short optional reason>"}',
    '{"type":"select_offered_slot","selectedOptionNumber":<the option number>,"reason":"<short optional reason>"}',
    '{"type":"propose_appointment","selectedOptionNumber":<the option number>,"reason":"<short optional reason>"}',
  ].join("\n");
}

/** The first model call for a Scheduling turn: asks for a structured
 * decision. JSON output is requested via prompt instructions only —
 * parseSchedulingDecision() is the actual enforcement point. */
export function buildSchedulingDecisionRequest(
  agentInstructions: string,
  context: AIResolvedContext,
  event: AIChannelEvent,
  offeredSlots: PersistedSlotOffer[] | undefined,
  handoff?: AIAgentHandoff,
  now: Date = new Date(),
): ModelRequest {
  const baseSystem = buildDecisionSystemInstructions(agentInstructions, context.organization.name, context.channel, context, offeredSlots, now);
  const system = handoff ? `${baseSystem}\n\n${HANDOFF_CONTINUITY_INSTRUCTION}` : baseSystem;
  const contextLines = buildContextLines(context);
  const inboundText = event.content.text?.trim() || "(no message text provided)";

  const userMessageParts = [
    `Current inbound event:\n${inboundText}`,
    contextLines.length > 0 ? `Known CRM context:\n${contextLines.join("\n")}` : "Known CRM context: none available.",
  ];
  if (handoff) userMessageParts.push(buildHandoffContextBlock(handoff));
  userMessageParts.push("Decide your response now, following the JSON contract exactly.");

  return {
    model: AI_CENTER_DEFAULT_MODEL,
    system,
    messages: [{ role: "user", content: userMessageParts.join("\n\n") }],
    maxTokens: AI_CENTER_MAX_TOKENS,
  };
}

/** The second, final model call — response generation ONLY, once the
 * orchestrator knows the real outcome of a get_availability/
 * select_offered_slot/propose_appointment decision. No further action
 * decision is requested and none may be executed from its output. */
export function buildSchedulingFinalRequest(
  agentInstructions: string,
  context: AIResolvedContext,
  event: AIChannelEvent,
  outcomeSummary: string,
  offeredSlots: PersistedSlotOffer[] | undefined,
  handoff?: AIAgentHandoff,
  now: Date = new Date(),
): ModelRequest {
  const guidance = channelGuidance(context.channel);
  const todayLine = describeTodayInOrgTimezone(context.organization.timezone, now);
  const systemParts = [
    agentInstructions,
    ...(guidance ? ["", guidance] : []),
    buildKnownFieldsBlock(context),
    buildOfferedSlotsBlock(offeredSlots),
    "",
    ...(todayLine ? [todayLine] : []),
    "You just completed an internal step. Do not mention internal tools, systems, option numbers, or CRM details to the customer — respond naturally based on the real outcome you're told below.",
    "Refer to any specific appointment time only in the natural, human way a person would say it (e.g. \"Tuesday at 2 PM\"), never as an option number or raw timestamp.",
    `Organization: ${context.organization.name}.`,
  ];
  if (handoff) systemParts.push("", HANDOFF_CONTINUITY_INSTRUCTION);
  const system = systemParts.join("\n");

  const contextLines = buildContextLines(context);
  const inboundText = event.content.text?.trim() || "(no message text provided)";

  const userMessageParts = [
    `Current inbound event:\n${inboundText}`,
    contextLines.length > 0 ? `Known CRM context:\n${contextLines.join("\n")}` : "Known CRM context: none available.",
  ];
  if (handoff) userMessageParts.push(buildHandoffContextBlock(handoff));
  userMessageParts.push(
    `Real outcome: ${outcomeSummary}`,
    "Respond to the customer now, in natural language only. Do not request another action.",
  );

  return {
    model: AI_CENTER_DEFAULT_MODEL,
    system,
    messages: [{ role: "user", content: userMessageParts.join("\n\n") }],
    maxTokens: AI_CENTER_MAX_TOKENS,
  };
}
