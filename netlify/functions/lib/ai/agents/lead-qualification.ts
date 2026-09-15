// netlify/functions/lib/ai/agents/lead-qualification.ts
//
// AI Center — Phase AI-1J. The structured-decision contract for the
// Lead Qualification agent: the ONLY AI-1 agent allowed to request a CRM
// tool. This file defines the decision schema, its strict runtime
// validator, the two prompt builders (structured decision + final
// response), and how a validated decision's tool arguments are bound to
// trusted server context. It does NOT call a model, does NOT call the
// Tool Registry, and does NOT touch Supabase — actually invoking a model
// or a tool remains orchestrator.ts's job (see its "Lead Qualification
// tool-enabled turn" section), matching the required path:
//
//   orchestrator -> AI Tool Registry -> Gen-2 executeStep() -> handler
//
// ── TRUST BOUNDARY (the reason this file exists as a separate module) ──
//
// The model may choose:
//   - which of the two allowlisted tools to request (or neither)
//   - genuine business arguments (currently: add_internal_note's note
//     text)
//
// The model may NEVER choose or override orgId, userId, actor,
// autonomyLevel, executionId, contactId, leadId, projectId, permission
// level, risk level, or approval requirement. In particular, even though
// add_internal_note's own action-registry schema accepts a
// `targetEntityId` argument, this file's buildTrustedToolInput() NEVER
// reads a targetEntityId out of the model's decision — it always binds to
// the caller-supplied trusted `leadId` instead. A model that includes a
// `targetEntityId` in its JSON (it isn't even asked to) has that field
// silently ignored, never forwarded to the tool.
//
// One tool maximum: this contract has no field or path for the model to
// request a second tool call, a follow-up decision, or any multi-step
// plan. It expresses exactly one of: respond, or request one of two
// specific tools. Enforcing "at most one tool call per run" is
// orchestrator.ts's job (it only ever asks this contract for a decision
// once per run) — this file simply never gives the model a way to ask
// for more than one action in a single decision.

import { z } from "zod";
import type { AIAgentHandoff, AIChannel, AIChannelEvent, AIResolvedContext } from "../types";
import type { ModelRequest } from "../providers/model-provider";
import { AI_CENTER_DEFAULT_MODEL, AI_CENTER_MAX_TOKENS, buildContextLines, channelGuidance } from "../prompting";

// ── AI-1K: optional handoff continuity (see orchestrator.ts's "Reception
// turn") ─────────────────────────────────────────────────────────────────
//
// When Reception hands off, Lead Qualification's prompts get this
// addendum plus a compact block built from the validated AIAgentHandoff.
// Per this task's explicit instruction: the customer-facing experience
// must read as ONE business conversation — never "I am the Lead
// Qualification Agent" or "Reception transferred you." Also per this
// task: handoff facts are context only — trusted CRM context (already
// injected above this block by buildContextLines()) remains authoritative
// if the two ever conflict; this is why the block below is explicitly
// labeled as such rather than presented as equally-trusted data.
const HANDOFF_CONTINUITY_INSTRUCTION =
  "Reception has handed this conversation to you. Continue naturally as the same business conversation — do not introduce yourself as a separate AI agent, and do not tell the customer they were transferred or handed off, unless the customer explicitly asks how this works.";

function buildHandoffContextBlock(handoff: AIAgentHandoff): string {
  const lines: string[] = [
    `Notes from Reception (context only — the CRM data above is authoritative if anything here conflicts): ${handoff.summary}`,
  ];
  if (handoff.knownFacts && Object.keys(handoff.knownFacts).length > 0) {
    const facts = Object.entries(handoff.knownFacts)
      .map(([label, value]) => `${label}: ${String(value)}`)
      .join("; ");
    lines.push(`Reception noted: ${facts}`);
  }
  if (handoff.openQuestions && handoff.openQuestions.length > 0) {
    lines.push(`Still open per Reception: ${handoff.openQuestions.join("; ")}`);
  }
  return lines.join("\n");
}

// ── Per-agent tool allowlist (AI-1J) ─────────────────────────────────────
//
// Deliberately separate from, and narrower than, the AI Tool Registry's
// own AI_TOOL_ALLOWLIST (tools/registry.ts), which also includes
// create_follow_up_task. Per this task's explicit instruction: "Do not
// rely solely on the global registry allowlist. Agent-level capability
// restrictions matter." This set is checked by orchestrator.ts before any
// tool name is ever passed to executeAITool() — defense in depth on top
// of (not a replacement for) the registry's own allowlist and the
// action-executor's own risk/approval/autonomy checks.
export const LEAD_QUALIFICATION_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  "get_lead_context",
  "add_internal_note",
]);

// A safe, generic, never-untrue response used whenever the model's output
// can't be trusted as a structured decision — see parseLeadQualificationDecision().
export const GENERIC_FALLBACK_RESPONSE =
  "Thanks for reaching out — let me gather a bit more information to help with your request.";

// ── Decision schema ───────────────────────────────────────────────────────
//
// Three fully-.strict() variants (not z.discriminatedUnion — two of the
// three variants would share the same "type" literal ("tool"), which
// discriminatedUnion doesn't support; a plain z.union of strict schemas is
// unambiguous here because each variant's literal fields fully determine
// which one a given object can match). `.strict()` on every variant means
// an unexpected extra field (e.g. a model trying to sneak in a
// `targetEntityId` or `leadId`) makes the WHOLE object fail every variant,
// never partially matches one.

const respondDecisionSchema = z
  .object({
    type: z.literal("respond"),
    response: z.string().min(1).max(2000),
  })
  .strict();

const getLeadContextDecisionSchema = z
  .object({
    type: z.literal("tool"),
    tool: z.literal("get_lead_context"),
    reason: z.string().max(300).optional(),
  })
  .strict();

const addInternalNoteDecisionSchema = z
  .object({
    type: z.literal("tool"),
    tool: z.literal("add_internal_note"),
    // ONLY genuine business input the model may supply for this tool —
    // no targetEntityType/targetEntityId field exists here at all, so
    // there is nothing for buildTrustedToolInput() to even consider
    // trusting from the model for those fields.
    arguments: z.object({ content: z.string().min(1).max(4000) }).strict(),
    reason: z.string().max(300).optional(),
  })
  .strict();

const leadQualificationDecisionSchema = z.union([
  respondDecisionSchema,
  getLeadContextDecisionSchema,
  addInternalNoteDecisionSchema,
]);

export type LeadQualificationDecision = z.infer<typeof leadQualificationDecisionSchema>;
export type LeadQualificationToolDecision = Extract<LeadQualificationDecision, { type: "tool" }>;

export type ParsedLeadQualificationDecision =
  | { kind: "decision"; decision: LeadQualificationDecision }
  | { kind: "fallback"; responseText: string };

/**
 * Parses and strictly validates the decision model's raw text output.
 * Never throws. Never attempts to recover a tool call out of malformed or
 * unstructured output by inspection/regex — per this task's explicit
 * instruction, a parse or validation failure always falls back to a safe
 * response, never a tool execution.
 *
 * Two distinct fallback cases, deliberately handled differently:
 *   1. The text isn't JSON at all (JSON.parse throws) — the model likely
 *      just ignored the JSON-only instruction and wrote a normal reply.
 *      That raw text is still the model's own natural-language attempt to
 *      help the customer, so it's used AS the response rather than
 *      discarded — it was never going to be treated as a tool decision
 *      either way.
 *   2. The text IS valid JSON but fails the strict schema (wrong shape,
 *      disallowed tool name, extra fields, etc.) — this is not something
 *      safe to show a customer verbatim (it may look like broken JSON or
 *      reference internal concepts), so a fixed GENERIC_FALLBACK_RESPONSE
 *      is used instead, and the parsed object is never inspected further
 *      for a salvageable tool call.
 */
export function parseLeadQualificationDecision(rawText: string): ParsedLeadQualificationDecision {
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(cleaned);
  } catch {
    return { kind: "fallback", responseText: rawText.trim() || GENERIC_FALLBACK_RESPONSE };
  }

  const result = leadQualificationDecisionSchema.safeParse(parsedJson);
  if (!result.success) {
    return { kind: "fallback", responseText: GENERIC_FALLBACK_RESPONSE };
  }

  return { kind: "decision", decision: result.data };
}

// ── Trusted tool-input binding ────────────────────────────────────────────

/**
 * Builds the exact input object passed to executeAITool() for a validated
 * "tool" decision. `leadId` must already be a caller-verified trusted
 * value (orchestrator.ts refuses to call this at all when
 * trustedContext.leadId is absent) — it is NEVER read from the model's
 * decision. For add_internal_note, `targetEntityType`/`targetEntityId`
 * are hardcoded to "lead"/`leadId` here; the model's decision object has
 * no field for either (see addInternalNoteDecisionSchema above), so there
 * is nothing to override even if it tried.
 */
export function buildTrustedToolInput(decision: LeadQualificationToolDecision, leadId: string): Record<string, unknown> {
  if (decision.tool === "get_lead_context") {
    return { leadId };
  }
  return {
    targetEntityType: "lead",
    targetEntityId: leadId,
    content: decision.arguments.content,
  };
}

/** Safe, generic (never content-bearing) summary of a successful tool
 * result, fed to the second/final model call — see this file's header
 * and orchestrator.ts's "Lead Qualification tool-enabled turn" for why no
 * note body, customer text, or raw handler output is ever included here. */
export function summarizeToolSuccess(tool: LeadQualificationToolDecision["tool"]): string {
  if (tool === "get_lead_context") return "Lead context was retrieved successfully.";
  return "An internal note was added successfully. This note is staff-only and was never shown to the customer.";
}

// ── Prompt builders ───────────────────────────────────────────────────────

function buildDecisionSystemInstructions(agentInstructions: string, organizationName: string, channel: AIChannel): string {
  const guidance = channelGuidance(channel);
  return [
    agentInstructions,
    ...(guidance ? ["", guidance] : []),
    "",
    "You may optionally use ONE of the following tools, or simply respond directly — most turns should simply respond:",
    "- get_lead_context: re-reads the current lead's CRM record, if you need to confirm details beyond what's already provided below.",
    "- add_internal_note: adds a short, factual, staff-only note to the current lead's record. Never customer-facing. Only use this when there is genuinely useful, factual information worth preserving — never speculative conclusions, guesses, or unconfirmed details.",
    "Do not request any tool other than these two.",
    "Never claim that an action (such as adding a note) has already happened — this decision does not perform the action itself; you will be told the result afterward.",
    "Never request, imply, or promise sending an SMS, email, or any customer message, and never book or schedule an appointment.",
    "",
    `Organization: ${organizationName}.`,
    "",
    "Respond with ONLY a single JSON object — no markdown, no code fences, no text outside the JSON — matching exactly one of these shapes:",
    '{"type":"respond","response":"<your natural-language reply to the customer>"}',
    '{"type":"tool","tool":"get_lead_context","reason":"<short optional reason>"}',
    '{"type":"tool","tool":"add_internal_note","arguments":{"content":"<concise, factual note text>"},"reason":"<short optional reason>"}',
  ].join("\n");
}

/** The first model call for a Lead Qualification turn: asks for a
 * structured decision (respond, or request one allowlisted tool). JSON
 * output is requested via prompt instructions only (ModelRequest has no
 * Anthropic-specific structured-output field, and none is added here) —
 * parseLeadQualificationDecision() is the actual enforcement point. */
export function buildLeadQualificationDecisionRequest(
  agentInstructions: string,
  context: AIResolvedContext,
  event: AIChannelEvent,
  handoff?: AIAgentHandoff,
): ModelRequest {
  const baseSystem = buildDecisionSystemInstructions(agentInstructions, context.organization.name, context.channel);
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

/** The second, final model call — response generation ONLY. No tool
 * decision is requested and none may be executed from its output
 * (orchestrator.ts never parses this call's text as a decision). */
export function buildLeadQualificationFinalRequest(
  agentInstructions: string,
  context: AIResolvedContext,
  event: AIChannelEvent,
  toolResultSummary: string,
  handoff?: AIAgentHandoff,
): ModelRequest {
  const guidance = channelGuidance(context.channel);
  const systemParts = [
    agentInstructions,
    ...(guidance ? ["", guidance] : []),
    "",
    "You just completed an internal action. Do not mention internal tools, notes, or CRM systems to the customer — respond naturally based on what you now know.",
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
    `Internal result: ${toolResultSummary}`,
    "Respond to the customer now, in natural language only. Do not request another tool.",
  );

  return {
    model: AI_CENTER_DEFAULT_MODEL,
    system,
    messages: [{ role: "user", content: userMessageParts.join("\n\n") }],
    maxTokens: AI_CENTER_MAX_TOKENS,
  };
}
