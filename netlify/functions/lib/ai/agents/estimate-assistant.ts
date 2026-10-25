// netlify/functions/lib/ai/agents/estimate-assistant.ts
//
// AI Center — Estimate Assistant Foundation. The structured-decision contract
// and prompt builders for the Estimate Assistant: an agent that helps turn
// TRUSTED CRM / project / estimate / Business Knowledge data into a useful
// estimate DRAFT — without ever inventing prices, quantities, scope, taxes,
// discounts, deposits, policies or company facts.
//
// This file defines the decision schema + strict validator, the prompt
// builders, the deterministic readiness / missing-information computation,
// and the deterministic customer-reply money guard. It does NOT call a model,
// does NOT call the Tool Registry, and does NOT touch Supabase — actually
// invoking a model or a tool remains orchestrator.ts's job
// (runEstimateAssistantTurn), exactly like agents/lead-qualification.ts.
//
// ── WHAT THE MODEL MAY DO ───────────────────────────────────────────────
//
// It may choose ONE of: respond / propose_estimate_draft /
// propose_add_line_items / clarify.
//   - A "propose_*" decision never writes anything. orchestrator.ts turns it
//     into an approval request through the existing executeStep() pipeline; a
//     human must approve before a single estimate row changes.
//   - The model supplies CONTENT only: a title, scope text, and line-item
//     STRUCTURE (name / description / itemType). There is no price, quantity,
//     unit, tax, discount, deposit or markup field on any variant (and
//     `.strict()` rejects unknown keys), so those cannot be smuggled in.
//   - The model NEVER supplies orgId, contactId, leadId, projectId,
//     estimateId, status, or any trust/approval field — buildTrusted*Input()
//     binds the ids from server-resolved context and never reads one out of a
//     decision.
//
// ── LOOP PREVENTION ─────────────────────────────────────────────────────
//
// The decision schema has no "handoff" variant at all, so control can never
// bounce onward from the Estimate Assistant to another agent (structural, not
// a runtime counter) — same approach as agents/scheduling.ts's original
// forward-only design. Reverse handoffs (e.g. back to Scheduling for "what
// times are open Thursday?") are intentionally NOT implemented this phase.
//
// ── CUSTOMER-FACING SAFETY ──────────────────────────────────────────────
//
// Internal-only estimate fields (cost_total, contingency, contractor_margin,
// the internal `notes` field) are never loaded (estimate-handlers.ts selects
// explicit columns), so they cannot appear in any prompt in this file.
// guardEstimateReply() additionally blocks any dollar figure in a reply that
// is not traceable to trusted data or to what the customer themselves wrote.

import { z } from "zod";
import type { AIAgentHandoff, AIChannel, AIChannelEvent, AIResolvedContext } from "../types";
import type { ModelRequest } from "../providers/model-provider";
import { AI_CENTER_DEFAULT_MODEL, AI_CENTER_MAX_TOKENS, buildBusinessKnowledgeSection, buildContextLines, channelGuidance } from "../prompting";
import { BUSINESS_KNOWLEDGE_CATALOG_KEYS, CUSTOM_CATEGORY, MAX_QUESTION_LENGTH } from "../../../../../src/lib/agentic/business-knowledge-catalog";
import {
  ESTIMATE_DRAFT_ITEM_TYPES,
  ESTIMATE_PRICING_AVAILABILITY,
  MAX_DRAFT_ITEMS,
  estimateDraftItemSchema,
  type EstimateContextItem,
} from "../../../../../src/lib/agentic/estimate-handlers";
import { buildHandoffContextBlock } from "./lead-qualification";

/** Agent-level tool allowlist — narrower than (and checked in addition to)
 * the AI Tool Registry's own global allowlist. */
export const ESTIMATE_ASSISTANT_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  "get_estimate_context",
  "create_estimate_draft",
  "add_estimate_line_items",
  // Pricing Intelligence v1 (P2): read-only. Available for isolated testing; the orchestrator does not call it yet.
  "get_pricing_suggestions",
]);

export const GENERIC_FALLBACK_RESPONSE =
  "Thanks — let me make sure I have the project details right so our team can prepare accurate numbers for you.";

/** Used whenever a drafted reply contains a dollar figure that cannot be
 * traced to trusted data. Deliberately says nothing about price. */
export const PRICE_SAFE_RESPONSE =
  "I want to make sure any numbers we share are accurate, so our team will review the project details and follow up with confirmed pricing.";

// ── Decision schema ───────────────────────────────────────────────────────

const respondDecisionSchema = z
  .object({ type: z.literal("respond"), response: z.string().min(1).max(2000) })
  .strict();

const proposeEstimateDraftDecisionSchema = z
  .object({
    type: z.literal("propose_estimate_draft"),
    title: z.string().trim().min(1).max(200),
    scope: z.string().trim().min(1).max(4000).optional(),
    items: z.array(estimateDraftItemSchema).max(MAX_DRAFT_ITEMS).optional(),
    reason: z.string().max(300).optional(),
  })
  .strict();

const proposeAddLineItemsDecisionSchema = z
  .object({
    type: z.literal("propose_add_line_items"),
    items: z.array(estimateDraftItemSchema).min(1).max(MAX_DRAFT_ITEMS),
    reason: z.string().max(300).optional(),
  })
  .strict();

// Same shape/semantics as Lead Qualification's clarify variant — the Owner
// Clarification workflow (knowledge-clarification.ts) is reused, not
// duplicated. The model supplies a catalog category + neutral question only.
const clarifyDecisionSchema = z
  .object({
    type: z.literal("clarify"),
    category: z.string().min(1).max(80),
    question: z.string().min(8).max(MAX_QUESTION_LENGTH),
  })
  .strict();

const estimateAssistantDecisionSchema = z.union([
  respondDecisionSchema,
  proposeEstimateDraftDecisionSchema,
  proposeAddLineItemsDecisionSchema,
  clarifyDecisionSchema,
]);

export type EstimateAssistantDecision = z.infer<typeof estimateAssistantDecisionSchema>;
export type EstimateAssistantProposeDraftDecision = Extract<EstimateAssistantDecision, { type: "propose_estimate_draft" }>;
export type EstimateAssistantAddItemsDecision = Extract<EstimateAssistantDecision, { type: "propose_add_line_items" }>;
export type EstimateAssistantClarifyDecision = Extract<EstimateAssistantDecision, { type: "clarify" }>;

/** One validation problem described WITHOUT any value: the schema field path
 * (array indexes collapsed to `[]`) and the Zod issue code. This is the only
 * shape that is ever persisted, logged, or shown to the repair prompt. */
export type DecisionValidationIssue = { path: string; code: string };

export type ParsedEstimateAssistantDecision =
  | { kind: "decision"; decision: EstimateAssistantDecision; normalized: boolean }
  /** `responseText` is ALWAYS the fixed GENERIC_FALLBACK_RESPONSE: raw model
   * output is never customer-facing. */
  | { kind: "fallback"; responseText: string; issues: DecisionValidationIssue[]; normalized: boolean };

/** Output allowance for the Estimate Assistant's structured DECISION (and its
 * single repair) call ONLY — a multi-line-item proposal does not fit in the
 * shared 400-token default. The response-only final call keeps the default. */
export const ESTIMATE_ASSISTANT_DECISION_MAX_TOKENS = 900;

const DECISION_SCHEMAS = {
  respond: respondDecisionSchema,
  propose_estimate_draft: proposeEstimateDraftDecisionSchema,
  propose_add_line_items: proposeAddLineItemsDecisionSchema,
  clarify: clarifyDecisionSchema,
} as const;

const SUPPORTED_ITEM_TYPES: ReadonlySet<string> = new Set(ESTIMATE_DRAFT_ITEM_TYPES);
const ITEM_KEYS: ReadonlySet<string> = new Set(["name", "description", "itemType"]);

const isBlank = (v: unknown): boolean => v === null || (typeof v === "string" && v.trim() === "");

function safePath(path: ReadonlyArray<string | number>): string {
  if (path.length === 0) return "(root)";
  return path.map((seg) => (typeof seg === "number" ? "[]" : seg)).join(".").replace(/\.\[\]/g, "[]");
}

function toSafeIssues(error: z.ZodError): DecisionValidationIssue[] {
  const seen = new Set<string>();
  const out: DecisionValidationIssue[] = [];
  for (const issue of error.issues) {
    const entry = { path: safePath(issue.path), code: String(issue.code) };
    const key = `${entry.path}|${entry.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * The ONLY pre-validation rewriting allowed, and deliberately tiny:
 *   A. KNOWN optional text fields (root `scope`/`reason`, item `description`)
 *      sent as null / "" / whitespace are OMITTED (the same meaning as absent).
 *   B. An item `itemType` that is blank is omitted; one that is a string
 *      outside the supported enum becomes "custom" — but ONLY when that item
 *      has no keys beyond name/description/itemType.
 * It NEVER removes, renames or "fixes" an unknown key, a money field
 * (price/quantity/tax/discount/deposit/markup/margin/cost/total/budget …) or
 * an id field (estimateId/leadId/contactId/projectId …): those survive to the
 * strict schema, which rejects them. The strict schema stays the boundary.
 * Pure: the input is never mutated.
 */
export function normalizeDecisionCandidate(value: unknown): { value: unknown; changed: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value, changed: false };
  const type = (value as { type?: unknown }).type;
  if (type !== "propose_estimate_draft" && type !== "propose_add_line_items") return { value, changed: false };

  let changed = false;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  const optionalRoot = type === "propose_estimate_draft" ? ["scope", "reason"] : ["reason"];
  for (const key of optionalRoot) {
    if (key in out && isBlank(out[key])) { delete out[key]; changed = true; }
  }
  if (Array.isArray(out.items)) {
    out.items = out.items.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const copy: Record<string, unknown> = { ...(item as Record<string, unknown>) };
      if ("description" in copy && isBlank(copy.description)) { delete copy.description; changed = true; }
      if ("itemType" in copy) {
        if (isBlank(copy.itemType)) { delete copy.itemType; changed = true; }
        else if (typeof copy.itemType === "string" && !SUPPORTED_ITEM_TYPES.has(copy.itemType) && Object.keys(copy).every((k) => ITEM_KEYS.has(k))) {
          copy.itemType = "custom";
          changed = true;
        }
      }
      return copy;
    });
  }
  return { value: out, changed };
}

/** Never throws and never salvages a proposal out of malformed output.
 * Anything that is not a single JSON object (prose, truncated JSON, prose
 * around JSON) or that fails the STRICT schema after the narrow normalization
 * above yields `kind: "fallback"` with the fixed generic text and value-free
 * issue metadata. Raw model text is NEVER returned for customer display — a
 * customer-facing reply exists only inside a validated `respond` decision.
 * (Markdown fences are stripped purely to locate the JSON; the content must
 * still pass the strict schema.) */
export function parseEstimateAssistantDecision(rawText: string): ParsedEstimateAssistantDecision {
  const fail = (issues: DecisionValidationIssue[], normalized = false): ParsedEstimateAssistantDecision =>
    ({ kind: "fallback", responseText: GENERIC_FALLBACK_RESPONSE, issues, normalized });

  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(cleaned);
  } catch {
    return fail([{ path: "(root)", code: "not_json" }]);
  }

  const { value, changed } = normalizeDecisionCandidate(parsedJson);
  const result = estimateAssistantDecisionSchema.safeParse(value);
  if (result.success) return { kind: "decision", decision: result.data, normalized: changed };

  // The union reports one opaque issue; re-run the matching variant for field-level paths/codes.
  const type = value && typeof value === "object" ? (value as { type?: unknown }).type : undefined;
  if (typeof type === "string" && Object.prototype.hasOwnProperty.call(DECISION_SCHEMAS, type)) {
    const detailed = DECISION_SCHEMAS[type as keyof typeof DECISION_SCHEMAS].safeParse(value);
    return fail(detailed.success ? [{ path: "(root)", code: "invalid_union" }] : toSafeIssues(detailed.error), changed);
  }
  return fail([{ path: "type", code: "unknown_decision_type" }], changed);
}

// ── Trusted input binding ─────────────────────────────────────────────────

/** Builds the exact rawInput for create_estimate_draft. Every id comes from
 * the caller's server-resolved trusted context; the decision contributes only
 * title / scope / item structure. */
export function buildTrustedCreateDraftInput(
  decision: EstimateAssistantProposeDraftDecision,
  trusted: { contactId?: string; leadId?: string; projectId?: string },
): Record<string, unknown> {
  return {
    ...(trusted.contactId ? { contactId: trusted.contactId } : {}),
    ...(trusted.leadId ? { leadId: trusted.leadId } : {}),
    ...(trusted.projectId ? { projectId: trusted.projectId } : {}),
    title: decision.title,
    ...(decision.scope ? { scope: decision.scope } : {}),
    ...(decision.items && decision.items.length > 0 ? { items: decision.items } : {}),
  };
}

/** Builds the exact rawInput for add_estimate_line_items. `estimateId` is the
 * server-resolved, org-verified estimate — never read from the decision. */
export function buildTrustedAddItemsInput(
  decision: EstimateAssistantAddItemsDecision,
  estimateId: string,
): Record<string, unknown> {
  return { estimateId, items: decision.items };
}

// ── Money guard ───────────────────────────────────────────────────────────

const DOLLAR_PREFIX_RE = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(\s?[kK]\b)?/g;
const DOLLAR_WORD_RE = /\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(?:dollars|bucks|usd)\b/gi;

/** Every dollar figure written in `text` ("$25,000", "$25k", "$1,250.50",
 * "500 dollars"), as numbers. */
export function extractMoneyAmounts(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(DOLLAR_PREFIX_RE)) {
    let n = Number(`${m[1].replace(/,/g, "")}${m[2] ? `.${m[2]}` : ""}`);
    if (m[3]) n *= 1000;
    if (Number.isFinite(n)) out.push(n);
  }
  for (const m of text.matchAll(DOLLAR_WORD_RE)) {
    const n = Number(`${m[1].replace(/,/g, "")}${m[2] ? `.${m[2]}` : ""}`);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * Every dollar figure the assistant is ALLOWED to repeat, split by WHO
 * vouches for it:
 *   - `trusted`: the business's own data — the stored estimate figures and
 *     Trusted Business Knowledge. These may be stated as facts.
 *   - `customer`: figures that only the CUSTOMER (or their CRM-recorded
 *     target budget / conversation) supplied. These may be acknowledged
 *     ("I see your target is $25,000") but never accepted or committed to.
 * Nothing outside these two sets may appear in a reply.
 */
export function collectGroundedAmounts(context: AIResolvedContext, event: AIChannelEvent): { trusted: Set<number>; customer: Set<number> } {
  const trusted = new Set<number>();
  const customer = new Set<number>();
  const addTo = (set: Set<number>, n: unknown) => { if (typeof n === "number" && Number.isFinite(n)) set.add(cents(n)); };

  for (const e of context.businessKnowledge?.entries ?? []) for (const n of extractMoneyAmounts(`${e.question} ${e.answer}`)) addTo(trusted, n);

  const est = context.estimate;
  if (est?.found && est.estimate) {
    const e = est.estimate;
    [e.subtotal, e.discountTotal, e.taxTotal, e.total, e.depositAmount, e.balanceDue].forEach((n) => addTo(trusted, n));
    if (e.discountType === "fixed") addTo(trusted, e.discountValue);
    if (e.depositType === "fixed") addTo(trusted, e.depositValue);
    for (const it of est.items ?? []) { addTo(trusted, it.unitPrice); addTo(trusted, it.lineTotal); }
  }

  for (const n of extractMoneyAmounts(event.content.text ?? "")) addTo(customer, n);
  for (const line of buildContextLines(context)) for (const n of extractMoneyAmounts(line)) addTo(customer, n);
  if (typeof context.lead?.estimatedBudget === "number") addTo(customer, context.lead.estimatedBudget);
  return { trusted, customer };
}

/** Language that accepts / confirms / commits to a price. Deliberately
 * narrow and fail-closed: a false positive only swaps in the safe reply. */
const COMMITMENT_RE =
  /\b(deal|agreed?|accept(?:ed|s)?|lock(?:ed|ing)?|guarantee[ds]?|we can do (?:it|that|this|the)|we(?:'ll| will) do (?:it|that|this)|can do it for|works for us|confirmed? (?:the |that |your )?(?:price|quote|total|budget)|(?:total|price|cost|quote|estimate)\b[^.$]{0,25}\b(?:will be|would be|should be|comes? to|is))\b/i;

/** Deterministic backstop for the #1 requirement of this agent: no invented
 * money and no price commitments. A reply is replaced with
 * PRICE_SAFE_RESPONSE when it states a dollar figure that is
 *   (a) not grounded at all (see collectGroundedAmounts), or
 *   (b) vouched for ONLY by the customer yet phrased as acceptance (e.g.
 *       "Yes, we can do it for $18,000").
 * Applied to EVERY reply path, including the non-JSON fallback. This is a
 * second line of defense behind the prompt rules — it never relaxes them.
 *
 * STAFF-ONLY PRICING (Pricing Intelligence P3): suggested prices from the read-only pricing tool are NOT grounded data for a
 * customer reply, so they are not in the allowed sets above and a reply containing one is replaced like any other invented
 * figure. `staffOnlyFigures` (the figures of THIS run's pricing result) is used ONLY to label that block (`reason:
 * "staff_pricing_figure"`) for the audit trail. It never allows anything: this guard has no "tool figures are fine" mode. */
export type EstimateReplyGuardResult = { text: string; replaced: boolean; reason?: "ungrounded" | "staff_pricing_figure" | "commitment" };

export function guardEstimateReply(
  text: string,
  context: AIResolvedContext,
  event: AIChannelEvent,
  staffOnlyFigures?: ReadonlySet<number>,
): EstimateReplyGuardResult {
  const mentioned = extractMoneyAmounts(text);
  if (mentioned.length === 0) return { text, replaced: false };
  const { trusted, customer } = collectGroundedAmounts(context, event);
  const ungrounded = mentioned.some((n) => !trusted.has(cents(n)) && !customer.has(cents(n)));
  if (ungrounded) {
    const staffFigure = !!staffOnlyFigures && mentioned.some((n) => !trusted.has(cents(n)) && !customer.has(cents(n)) && staffOnlyFigures.has(cents(n)));
    return { text: PRICE_SAFE_RESPONSE, replaced: true, reason: staffFigure ? "staff_pricing_figure" : "ungrounded" };
  }
  const customerOnly = mentioned.some((n) => !trusted.has(cents(n)));
  if (customerOnly && COMMITMENT_RE.test(text)) return { text: PRICE_SAFE_RESPONSE, replaced: true, reason: "commitment" };
  return { text, replaced: false };
}

// ── Readiness (deterministic known / missing computation) ────────────────

export type EstimateReadiness = { known: string[]; missing: string[] };

function formatMoney(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function describeItemLine(it: EstimateContextItem): string {
  if (it.isHeading) return `- [section] ${it.name}`;
  const type = it.itemType ? ` [${it.itemType}]` : "";
  if (it.pricePending) return `- ${it.name}${type} — price and quantity NOT set yet (unpriced placeholder, not $0)`;
  const qty = it.quantity != null ? `${it.quantity}${it.unit ? ` ${it.unit}` : ""}` : "";
  return `- ${it.name}${type} — ${qty} @ ${formatMoney(it.unitPrice ?? 0)} = ${formatMoney(it.lineTotal ?? 0)}`;
}

/**
 * What is KNOWN and what is MISSING for an accurate estimate, computed by
 * code from trusted context so it does not depend on the model noticing.
 * The customer's stated budget is reported as a TARGET, never as a price.
 * "Pricing" is always missing today because no trusted price source exists
 * (ESTIMATE_PRICING_AVAILABILITY) — flipping that flag is the single change
 * a future catalog needs.
 */
export function computeEstimateReadiness(context: AIResolvedContext): EstimateReadiness {
  const known: string[] = [];
  const missing: string[] = [];
  const lead = context.lead;
  const est = context.estimate;
  const hasEstimate = !!est?.found && !!est.estimate;

  if (lead?.projectType) known.push(`Project type / scope mentioned by the customer: ${lead.projectType}`);
  if (context.project) known.push(`Project: ${context.project.name} (${context.project.status})`);
  if (typeof lead?.estimatedBudget === "number") {
    known.push(`Customer's stated target budget: ${formatMoney(lead.estimatedBudget)} — a customer target only, NOT a quote, price, line-item price, or estimate total`);
  }
  if (lead?.timeline) known.push(`Desired timeline: ${lead.timeline}`);
  if (lead?.location) known.push(`Location: ${lead.location}`);

  if (hasEstimate) {
    const e = est!.estimate!;
    const items = (est!.items ?? []).filter((i) => !i.isHeading);
    const pending = items.filter((i) => i.pricePending);
    known.push(`An estimate exists: "${e.title}" (status: ${e.status}) with ${items.length} line item${items.length === 1 ? "" : "s"}${pending.length ? `, ${pending.length} not priced yet` : ""}`);
    if (e.scope) known.push("The estimate has a written scope");
    if (pending.length > 0) missing.push(`Unit price and quantity for: ${pending.map((i) => i.name).join(", ")}`);
    if (items.length === 0 && !(e.total > 0)) missing.push("Line items for the estimate");
  } else if (est?.found === false) {
    missing.push("No estimate exists yet for this customer/project");
  }

  if (!lead?.projectType && !(hasEstimate && est!.estimate!.scope)) missing.push("Project scope — what work is actually being requested");
  if (!lead?.location && !context.project) missing.push("Property address / location");
  if (!ESTIMATE_PRICING_AVAILABILITY.trustedCatalogAvailable) {
    missing.push("Confirmed unit prices — set or approved by the business owner (the assistant never sets prices; staff-only history-based suggestions may be attached separately)");
  }
  if (!hasEstimate || (est!.items ?? []).every((i) => i.isHeading || i.pricePending)) {
    missing.push("Measurements / quantities");
  }
  return { known, missing };
}

/** The labelled, bounded estimate block shown to the model. Everything here
 * was read from the database by get_estimate_context moments ago and is
 * authoritative; nothing about a line item exists unless it is listed. */
export function buildEstimateContextBlock(context: AIResolvedContext): string {
  const lines: string[] = ["Estimate context (read from the CRM just now — authoritative; nothing about an estimate exists unless it is listed here):"];
  const est = context.estimate;
  if (!est) {
    lines.push("- Estimate data could not be loaded. Do not describe, assume, or promise anything about an existing estimate.");
  } else if (!est.found || !est.estimate) {
    lines.push("- Existing estimate: none found for this customer/project.");
  } else {
    const e = est.estimate;
    if (est.ambiguous) lines.push("- NOTE: more than one active estimate matches this customer/project. Do not guess which one the customer means.");
    lines.push(`- Existing estimate: "${e.title}"${e.number ? ` (${e.number})` : ""}, status: ${e.status}. ${e.editableByAssistant ? "It is still a draft." : "It is no longer a draft — you cannot propose changes to it."}`);
    if (e.scope) lines.push(`- Scope: ${e.scope}`);
    if (e.exclusions) lines.push(`- Exclusions: ${e.exclusions}`);
    if (e.assumptions) lines.push(`- Assumptions: ${e.assumptions}`);
    const items = est.items ?? [];
    if (items.length === 0) lines.push("- Line items: none.");
    else {
      lines.push("- Line items:");
      for (const it of items) lines.push(`  ${describeItemLine(it)}`);
      if (est.itemsTruncated) lines.push("  (more items exist than are shown)");
    }
    const priced = items.some((i) => !i.isHeading && !i.pricePending);
    if (priced || e.total > 0) {
      const parts = [`subtotal ${formatMoney(e.subtotal)}`];
      if (e.discountTotal > 0) parts.push(`discount ${formatMoney(e.discountTotal)}`);
      if (e.taxTotal > 0) parts.push(`tax ${formatMoney(e.taxTotal)}`);
      parts.push(`total ${formatMoney(e.total)}`);
      if (e.depositAmount > 0) parts.push(`deposit ${formatMoney(e.depositAmount)}`);
      lines.push(`- Stored totals (calculated by the system — never recalculate or alter): ${parts.join(", ")}.`);
    } else {
      lines.push("- Stored totals: not priced yet.");
    }
  }
  lines.push(`- Pricing source: ${ESTIMATE_PRICING_AVAILABILITY.note}`);
  if (context.staffPricingOutcome) lines.push(`- Staff pricing lookup: ${context.staffPricingOutcome}`);

  const readiness = computeEstimateReadiness(context);
  lines.push("", "Known facts for the estimate (computed by the system):");
  lines.push(...(readiness.known.length ? readiness.known.map((k) => `- ${k}`) : ["- (none yet)"]));
  lines.push("", "Still missing before an accurate estimate can be prepared (computed by the system):");
  lines.push(...readiness.missing.map((m) => `- ${m}`));
  return lines.join("\n");
}

// ── Prompt builders ───────────────────────────────────────────────────────

const HANDOFF_CONTINUITY_INSTRUCTION =
  "This conversation has just been handed to you from earlier in the same business interaction. Continue naturally as the same business conversation — do not introduce yourself as a separate AI agent, and do not tell the customer they were transferred or handed off, unless the customer explicitly asks how this works.";

/** Rules specific to estimates. Business Knowledge rules (shared) are added
 * separately by buildBusinessKnowledgeSection(). */
export const ESTIMATE_ASSISTANT_RULES = [
  "MONEY RULES (absolute): The ONLY dollar figures you may state are (a) figures shown in the Estimate context block above, (b) figures written in Trusted Business Knowledge, and (c) a figure the customer themselves just wrote — and for (c), only to acknowledge it as THEIR target, never to confirm it. Never state or imply a price, total, range, ballpark, \"typically costs\", per-square-foot rate, labor rate, material cost, deposit, tax, discount, permit fee, markup, or duration unless it appears there. Generic construction-industry knowledge is NOT authority for this contractor's pricing.",
  "The customer's stated budget is a TARGET. Never treat it as a price, an estimate total, or a line-item price, and never agree to, accept, or commit to a price the customer proposes (for example, asking whether the whole project can be done for a stated amount) — acknowledge their target and say the estimate needs team review.",
  "A line item exists ONLY if it is listed in the Estimate context. A price changed ONLY if the listed figure shows it. An estimate was created, updated, or sent ONLY if you are told so by an internal result — never promise otherwise, and never say an estimate is final.",
  "\"We handle permits and inspections\" (Business Knowledge) is NOT the same as \"permit fees are included in this estimate\". Say permit fees are included ONLY if a listed line item, scope, assumption, or exclusion explicitly says so; otherwise say the team will confirm what the estimate covers.",
  "Distinguish KNOWN facts from PROPOSED structure. When information is missing, say specifically what you still need (for example cabinet selection, countertop material, measurements, and pricing) — you may name several missing inputs in one reply, taken from the system's \"still missing\" list. Do not pad the reply with questions the CRM already answers.",
  "You never create, change, or send anything yourself, and you never accept, approve, discount, or collect money. A team member reviews and approves any estimate change before it exists. You cannot schedule appointments.",
  "Never mention internal cost, margin, markup, contingency, internal notes, record ids, tool names, or approval mechanics to the customer.",
  "NEVER say or imply that \"there is no price book, so every price must come from you\": organization-history pricing exists even without a price book, and the SYSTEM (not you) looks it up. Do not substitute your own pricing questions for that lookup, and do not ask staff to supply prices when a Staff pricing lookup line says it already ran.",
  "PRICING SUGGESTIONS ARE INTERNAL AND ADVISORY: the business may attach staff-only historical price suggestions to a run. They are never shown to you, never a quote, and never final. Never state, hint at, or round a suggested price to the customer, never claim a price is final, never overwrite or contradict a reviewed/manual price, and never guess a market price yourself. If there is not enough history, that is an internal note for staff — tell the customer only that the team will confirm pricing.",
].join(" ");

function audienceGuidance(channel: AIChannel): string {
  if (channel === "internal") {
    return "This is an internal test/owner context: you may be explicit about what is known, what is missing, and what structure you would propose. Still never state an ungrounded price.";
  }
  return "You are replying directly to a customer: be concise, natural, and friendly. Describe what you know and what is needed in plain language; never reveal internal fields, ids, or how approvals work.";
}

function buildDecisionSystemInstructions(agentInstructions: string, organizationName: string, channel: AIChannel, context: AIResolvedContext): string {
  const guidance = channelGuidance(channel);
  return [
    agentInstructions,
    ...(guidance ? ["", guidance] : []),
    "",
    audienceGuidance(channel),
    buildBusinessKnowledgeSection(context),
    "",
    ESTIMATE_ASSISTANT_RULES,
    "",
    "Most turns should simply respond. You may instead make ONE proposal — a proposal does not change anything; a team member must approve it first:",
    "- propose_estimate_draft: use ONLY when the Estimate context says no estimate exists, the customer asked for an estimate, and the customer/CRM context states enough of the work to name its main line items. Supply a short title, optionally a scope drawn ONLY from stated facts, and line-item STRUCTURE (name, optional description, optional itemType) for work the customer or CRM actually named. There are no price or quantity fields.",
    "- propose_add_line_items: use ONLY when the Estimate context shows an editable draft estimate and the customer asked to add something that is NOT already listed. Same structure-only items.",
    "Never propose an item the customer or CRM did not mention, and never propose anything when the estimate is no longer a draft or when several estimates match.",
    "",
    // Owner Clarification reuse — same narrow conditions as Lead Qualification's clarify decision.
    `You may instead flag that the owner needs to answer a company-specific question ("clarify"). Use clarify ONLY when ALL of these are true: (1) the customer's CURRENT message asks a concrete factual question about THIS business's policies/capabilities (permits, warranty, design services, materials, estimate policy, financing, and similar); (2) Trusted Business Knowledge does NOT contain the answer; (3) the CRM and estimate context cannot answer it. Set "category" to the best-matching key from [${BUSINESS_KNOWLEDGE_CATALOG_KEYS.join(", ")}], or "${CUSTOM_CATEGORY}" if none fits, and "question" to a short neutral restatement. Do NOT use clarify for facts about this specific estimate (what it includes, its line items or totals) — those come only from the Estimate context; if the context doesn't say, respond that the team will confirm. Never write the customer-facing text for a clarify decision.`,
    "",
    `Organization: ${organizationName}.`,
    "",
    "Respond with ONLY a single JSON object — no markdown, no code fences, no text outside the JSON — matching exactly one of these shapes:",
    '{"type":"respond","response":"<your natural-language reply>"}',
    '{"type":"propose_estimate_draft","title":"<short estimate title>","scope":"<optional scope from stated facts only>","items":[{"name":"<line item name>","description":"<optional>","itemType":"<labor|material|service|equipment|allowance|fee|custom>"}],"reason":"<short optional reason>"}',
    '{"type":"propose_add_line_items","items":[{"name":"<line item name>","description":"<optional>","itemType":"<labor|material|service|equipment|allowance|fee|custom>"}],"reason":"<short optional reason>"}',
    '{"type":"clarify","category":"<catalog key or custom>","question":"<short neutral restatement of the customer\'s company-specific question>"}',
    "OUTPUT RULES: Return JSON only — no markdown fences and no text before or after the object. Every field marked optional may be omitted: omit it entirely when unknown, and never output null or an empty string for it. Do not add any field that is not shown in the shapes above. itemType must be exactly one of labor|material|service|equipment|allowance|fee|custom — if unsure, use \"custom\".",
    "Never include prices, quantities, totals, tax, discounts, deposits, markup, margins, budgets or identifiers in a decision — there is no price, quantity, tax, discount, or id field. The customer's budget is context only: it is not a line-item price and must never be copied into a proposal field.",
  ].join("\n");
}

function buildUserMessage(context: AIResolvedContext, event: AIChannelEvent, handoff: AIAgentHandoff | undefined, tail: string[]): string {
  const contextLines = buildContextLines(context);
  const inboundText = event.content.text?.trim() || "(no message text provided)";
  const parts = [
    `Current inbound event:\n${inboundText}`,
    contextLines.length > 0 ? `Known CRM context:\n${contextLines.join("\n")}` : "Known CRM context: none available.",
    buildEstimateContextBlock(context),
  ];
  if (handoff) parts.push(buildHandoffContextBlock(handoff));
  parts.push(...tail);
  return parts.join("\n\n");
}

/** The note appended to the (single) repair call. Value-free by construction:
 * it names only schema field paths and Zod issue codes — the invalid output
 * itself is NOT echoed; the model re-decides from the same trusted context. */
function buildRepairNote(issues: readonly DecisionValidationIssue[]): string[] {
  return [
    "Your previous structured decision did not match the required schema, so it could not be used. Problems found (field path: problem):",
    ...(issues.length > 0 ? issues.map((i) => `- ${i.path}: ${i.code}`) : ["- (root): unspecified"]),
    "Decide again from the information above and return corrected JSON only — a single object matching exactly one of the allowed shapes, with no additional fields, no markdown fences, and no text around it. Pricing, quantity, tax, discount, deposit, markup, margin, budget and identifier fields are forbidden.",
  ];
}

/** Structured-decision call. With `repairIssues` it is the single repair
 * attempt: the same trusted context, original user intent and allowed shapes,
 * plus the value-free issue list above. Both use the Estimate Assistant's own
 * output cap (ESTIMATE_ASSISTANT_DECISION_MAX_TOKENS), not the shared default. */
export function buildEstimateAssistantDecisionRequest(
  agentInstructions: string,
  context: AIResolvedContext,
  event: AIChannelEvent,
  handoff?: AIAgentHandoff,
  repairIssues?: readonly DecisionValidationIssue[],
): ModelRequest {
  const baseSystem = buildDecisionSystemInstructions(agentInstructions, context.organization.name, context.channel, context);
  const system = handoff ? `${baseSystem}\n\n${HANDOFF_CONTINUITY_INSTRUCTION}` : baseSystem;
  const tail = repairIssues
    ? [...buildRepairNote(repairIssues), "Decide your response now, following the JSON contract exactly."]
    : ["Decide your response now, following the JSON contract exactly."];
  return {
    model: AI_CENTER_DEFAULT_MODEL,
    system,
    messages: [{ role: "user", content: buildUserMessage(context, event, handoff, tail) }],
    maxTokens: ESTIMATE_ASSISTANT_DECISION_MAX_TOKENS,
  };
}

/** Second, final model call — response generation ONLY, after a proposal /
 * clarification outcome is known. The outcome summary is factual, generated
 * by code, and always states that nothing has been created yet. */
export function buildEstimateAssistantFinalRequest(
  agentInstructions: string,
  context: AIResolvedContext,
  event: AIChannelEvent,
  outcomeSummary: string,
  handoff?: AIAgentHandoff,
): ModelRequest {
  const guidance = channelGuidance(context.channel);
  const systemParts = [
    agentInstructions,
    ...(guidance ? ["", guidance] : []),
    "",
    audienceGuidance(context.channel),
    buildBusinessKnowledgeSection(context),
    "",
    ESTIMATE_ASSISTANT_RULES,
    "",
    "You just completed an internal step. Do not mention internal tools, approvals, or CRM systems to the customer — respond naturally based on the internal result below.",
    `Organization: ${context.organization.name}.`,
  ];
  if (handoff) systemParts.push("", HANDOFF_CONTINUITY_INSTRUCTION);
  return {
    model: AI_CENTER_DEFAULT_MODEL,
    system: systemParts.join("\n"),
    messages: [{
      role: "user",
      content: buildUserMessage(context, event, handoff, [
        `Internal result: ${outcomeSummary}`,
        "Respond to the customer now, in natural language only (no JSON). Do not request another action.",
      ]),
    }],
    maxTokens: AI_CENTER_MAX_TOKENS,
  };
}

/** Factual, content-free-of-prices summary of a submitted proposal, fed to
 * the final call. Never claims anything exists yet. */
export function summarizeProposalSubmitted(kind: "draft" | "add_items", itemNames: string[]): string {
  const list = itemNames.length ? ` (${itemNames.slice(0, 8).join(", ")})` : "";
  return kind === "draft"
    ? `A draft estimate structure${list} was submitted for the team to review. NOTHING has been created, priced, saved, or sent yet. Tell the customer the team will review the project details and prepare the estimate, and name what you still need (pricing and measurements from the team; any selections only the customer can make). Do not say an estimate exists.`
    : `A request to add line items${list} to the existing draft estimate was submitted for the team to review. NOTHING has been changed yet. Tell the customer the team will review and update the estimate, and that pricing for the new item still needs to be confirmed. Do not say the estimate has been updated.`;
}
