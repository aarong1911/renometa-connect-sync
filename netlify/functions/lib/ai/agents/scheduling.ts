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
//     natural-language date string — plus two OPTIONAL structured
//     preference hints (preferredTime "HH:MM", preferredDaypart). LIVE
//     VALIDATION FIX: these two hints are used ONLY to rank/filter the
//     REAL slots get_availability's own handler returns (see
//     selectCandidateSlots() below) — they never assert that a slot at
//     that time exists, and the prompt (see buildDecisionSystemInstructions)
//     now requires the model to have an actual day-signal from the
//     customer before it may call this action at all, closing the
//     original defect where Scheduling picked an arbitrary date itself.
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

// LIVE VALIDATION FIX (PR #17 deploy-preview finding): Scheduling was
// calendar-led, not preference-led — it called get_availability on its
// own initiative (an arbitrary near-term date) before the customer had
// ever named a day, then presented the first four chronological slots
// regardless of any time-of-day the customer actually asked for. Two
// changes close this: (1) the prompt (below) now requires a real
// day-signal from the customer before get_availability is ever called at
// all — see buildDecisionSystemInstructions()'s rewritten description;
// (2) these two NEW optional fields let the model carry forward a
// structured (never raw-text, never a timestamp) time-of-day preference
// it genuinely heard, so the orchestrator can rank/filter the REAL
// returned slots against it (see selectCandidateSlots() below) instead of
// always taking the chronologically-first four. Neither field is ever
// used to invent a slot — they only ever narrow/reorder what
// get_availability's trusted output actually contains.
const getAvailabilityDecisionSchema = z
  .object({
    type: z.literal("get_availability"),
    /** Plain "YYYY-MM-DD" — structured, never natural language (see this
     * file's header). The prompt tells the model today's real date in the
     * org's timezone so it can compute "tomorrow"/"next Tuesday" itself;
     * this field is still independently validated here regardless. Per
     * the prompt rewrite above, the model must only ever set this from a
     * day the CUSTOMER actually indicated — never arbitrarily. */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
    /** An exact clock time the customer mentioned for this date (e.g.
     * "10 works", "around 2"), rounded to the nearest half hour —
     * "HH:MM" 24-hour, local to the organization's timezone. Used ONLY to
     * rank the real returned candidates by closeness; a slot at this
     * exact time is never assumed to exist just because this field is
     * set. Omit when the customer gave no specific time. */
    preferredTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "Expected 24-hour HH:MM").optional(),
    /** A rough part of day the customer mentioned (e.g. "Friday
     * afternoon") when no exact time was given. Used ONLY to prefer real
     * candidates that fall in that window; if none of the real returned
     * slots fall in it, the ordinary bounded list is still shown rather
     * than inventing one. Omit when the customer gave neither a time nor
     * a daypart — morning/afternoon/evening match this file's own prompt
     * description of each window exactly (see buildDecisionSystemInstructions). */
    preferredDaypart: z.enum(["morning", "afternoon", "evening"]).optional(),
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

// ── Preference-aware candidate selection ─────────────────────────────────
//
// LIVE VALIDATION FIX. Replaces the previous unconditional "take the
// chronologically-first N" behavior with preference-aware ranking, while
// changing NOTHING about where the candidates themselves come from: every
// slot this function can possibly return was already present in the
// trusted `allSlots` array get_availability's real handler returned.
// This function only reorders/filters that array — it never constructs,
// mutates, or invents a slot. Pure and dependency-free (no Supabase, no
// model) so it's directly unit-testable.

export type SlotPreference = {
  /** "HH:MM", 24-hour, local to the slot's own timeZone — same format as
   * getAvailabilityDecisionSchema's preferredTime. */
  time?: string;
  daypart?: "morning" | "afternoon" | "evening";
};

export type SlotSelectionResult = {
  slots: PersistedSlotOffer[];
  /** True only when the customer's exact preferredTime matches a REAL
   * returned slot's own start time precisely (0-minute distance) — the
   * one signal the orchestrator uses to phrase "that time is available"
   * vs. "that time isn't available, but here are the closest real
   * alternatives" without re-deriving the time math itself. */
  exactMatch: boolean;
};

/** Local-timezone minutes-since-midnight of a slot's own start — same
 * Intl.DateTimeFormat approach scheduling-availability.ts already uses
 * for its own local-time math, kept independent here (this file has no
 * dependency on that module beyond the PersistedSlotOffer TYPE) since
 * this is presentation/ranking only, never an availability/authority
 * decision. */
function localMinutesOfDay(slot: PersistedSlotOffer): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: slot.timeZone, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(slot.start));
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10);
  let hour = get("hour");
  if (hour === 24) hour = 0;
  return hour * 60 + get("minute");
}

function parseHHMM(value: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/** morning: before noon. afternoon: noon up to (not including) 5 PM.
 * evening: 5 PM onward. Matches this file's own prompt description of
 * each window exactly — the model's semantic understanding and this
 * function's literal ranges must stay in agreement, or "afternoon" could
 * mean two different things in the same conversation. */
const DAYPART_RANGES: Record<"morning" | "afternoon" | "evening", [number, number]> = {
  morning: [0, 12 * 60],
  afternoon: [12 * 60, 17 * 60],
  evening: [17 * 60, 24 * 60],
};

const DEFAULT_CANDIDATE_LIMIT = 4;

/**
 * Picks which of the REAL, trusted `allSlots` candidates to present/
 * persist, honoring a customer's structured time-of-day preference when
 * one exists. With no preference at all, behavior is unchanged from
 * before this fix: the first `limit` candidates in their original
 * (chronological) order.
 *
 * With `preference.time` set: ranks every real candidate by absolute
 * distance (in minutes, local to each slot's own timeZone) from the
 * requested time, picks the closest `limit`, and re-sorts that picked set
 * back into chronological order for presentation. `exactMatch` is true
 * only when the single closest candidate is an exact (0-minute) match —
 * i.e. the customer's requested time genuinely exists in the real
 * availability data, never assumed.
 *
 * With `preference.daypart` set (and no `time`): filters to real
 * candidates whose local start time falls in that daypart's window; if
 * NONE do, falls back to the ordinary unconditional first-`limit` list
 * (still real data — never fabricated just to fill the daypart) rather
 * than returning nothing.
 */
export function selectCandidateSlots(
  allSlots: PersistedSlotOffer[],
  preference: SlotPreference | undefined,
  limit: number = DEFAULT_CANDIDATE_LIMIT,
): SlotSelectionResult {
  if (!preference?.time && !preference?.daypart) {
    return { slots: allSlots.slice(0, limit), exactMatch: false };
  }

  if (preference.time) {
    const target = parseHHMM(preference.time);
    if (target === null) return { slots: allSlots.slice(0, limit), exactMatch: false };

    const ranked = allSlots
      .map((slot) => ({ slot, distance: Math.abs(localMinutesOfDay(slot) - target) }))
      .sort((a, b) => a.distance - b.distance || new Date(a.slot.start).getTime() - new Date(b.slot.start).getTime());

    const exactMatch = ranked.length > 0 && ranked[0].distance === 0;
    const picked = ranked
      .slice(0, limit)
      .map((r) => r.slot)
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    return { slots: picked, exactMatch };
  }

  // preference.daypart, no preference.time
  const [lo, hi] = DAYPART_RANGES[preference.daypart!];
  const matching = allSlots.filter((slot) => {
    const minutes = localMinutesOfDay(slot);
    return minutes >= lo && minutes < hi;
  });
  if (matching.length > 0) return { slots: matching.slice(0, limit), exactMatch: false };
  return { slots: allSlots.slice(0, limit), exactMatch: false };
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

// LIVE VALIDATION FIX (PR #17 defect #2): a real SMS turn had Scheduling
// reply "We have you down for Tuesday at 10 AM... just to confirm — that
// works for you, right?" immediately after a successful get_availability
// — at that moment NO schedule_appointment approval existed and NO
// appointment existed; only a read-only availability check had run. That
// wording falsely implied an already-completed booking. This rule is
// included in BOTH prompts (the decision call's own `respond` path can
// independently generate customer-facing text too, not just the final-
// response call) rather than relying on outcomeSummary phrasing alone —
// see orchestrator.ts's describeAvailabilityOutcome() for the factual
// (never customer-facing) half of this fix. Deliberately NOT a hardcoded
// exact sentence — the model still phrases things naturally; this only
// forbids the specific class of false claim that caused the live defect.
const NO_PREMATURE_BOOKING_LANGUAGE_RULE =
  "CRITICAL: until a human teammate has actually approved a booking, NEVER say or imply that an appointment is already booked, scheduled, confirmed, or reserved. Do not use phrases like \"we have you down\", \"you're booked\", \"you're scheduled\", \"your appointment is confirmed\", \"I've booked that\", \"I've scheduled that\", \"your spot is reserved\", or anything else implying the booking already exists. A time that was just found to be available is only AVAILABLE, not booked — say it is available and ask if they'd like it scheduled (e.g. \"Tuesday at 10 AM is available — would you like me to schedule that?\"). A request that was just submitted is only PENDING a teammate's approval — say it has been submitted/is pending, never that it is already booked.";

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
    // LIVE VALIDATION FIX: this is the exact line that let the model pick
    // an arbitrary date on its own initiative. Rewritten to require a
    // real day-signal from the CUSTOMER before this action may be used at
    // all — see this phase's own report for the live defect this closes.
    "- get_availability: looks up real, currently-open appointment slots for a specific date. ONLY use this when the customer has given you SOME indication of which day they mean (an exact date, a weekday like \"Tuesday\", a relative day like \"tomorrow\"/\"next week\", or a day they want to switch to from what was last offered). Set preferredTime (24-hour HH:MM) when the customer also gave a specific clock time for that day (e.g. \"around 10\" -> \"10:00\"); set preferredDaypart (morning = before noon, afternoon = noon-5pm, evening = 5pm or later) when they gave a rough part of day instead (e.g. \"Friday afternoon\"). Omit both when the customer named only a day with no time preference at all.",
    "- NEVER call get_availability, and NEVER pick a day yourself, when the customer has not told you ANY day or time preference yet — use respond instead and ask a short, concrete question such as \"What day and time works best for you?\". The same applies if the customer gave only a time with no day at all (e.g. just \"10am\") — ask which day, do not guess one.",
    offeredSlots && offeredSlots.length > 0
      ? "- select_offered_slot: use when the customer's reply clearly references ONE of the numbered options above, but you want to confirm it back to them before actually booking (e.g. they mentioned a time but haven't explicitly said to book it yet)."
      : "- select_offered_slot: only usable when options were just offered above — not available right now.",
    offeredSlots && offeredSlots.length > 0
      ? "- propose_appointment: use when the customer's reply clearly and unambiguously identifies ONE of the numbered options above AND confirms they want it booked (e.g. \"yes, 11 works\", \"book the second one\", \"that works, let's do it\")."
      : "- propose_appointment: only usable when options were just offered above — not available right now.",
    "- respond: use for anything else — greeting, asking what day and time works (the correct choice when nothing has been specified yet), answering a question using the CRM context above, asking for clarification when you cannot tell which numbered option the customer means, or acknowledging a clear decline (set declineScheduling:true only when the customer clearly does not want to schedule right now, e.g. \"not now\" or \"no thanks\").",
    "If the customer's reply could match more than one numbered option, or doesn't clearly match any of them, use respond and ask a short clarifying question — never guess which option they meant.",
    "Never state a specific appointment time yourself unless it is one of the exact numbered options you were just given above, or one just returned by get_availability.",
    "You have not booked anything yet, and selecting or proposing an option here does not mean it is confirmed — you will be told the real outcome afterward.",
    "",
    NO_PREMATURE_BOOKING_LANGUAGE_RULE,
    "",
    `Organization: ${organizationName}.`,
    "",
    "Respond with ONLY a single JSON object — no markdown, no code fences, no text outside the JSON — matching exactly one of these shapes:",
    '{"type":"respond","response":"<your natural-language reply to the customer>","declineScheduling":false}',
    '{"type":"get_availability","date":"<YYYY-MM-DD>","preferredTime":"<HH:MM, optional>","preferredDaypart":"<morning|afternoon|evening, optional>","reason":"<short optional reason>"}',
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
    NO_PREMATURE_BOOKING_LANGUAGE_RULE,
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
