// netlify/functions/lib/ai/pricing-provenance.ts
//
// Pricing Intelligence v1 (P3) — provenance for STAFF-ONLY pricing figures, and the deterministic "is this a pricing-guidance
// request?" detector.
//
// ── WHY PROVENANCE, NOT A REGEX EXCEPTION ────────────────────────────────
//
// The customer-facing money guard (agents/estimate-assistant.ts guardEstimateReply) answers "may this dollar figure appear in
// a REPLY?" and its answer is unchanged: only figures grounded in the business's own data (stored estimate figures, Trusted
// Business Knowledge) or written by the customer. Suggested prices are NOT in that set, so they can never appear in a
// customer reply — there is deliberately no "estimate agent may now say money" switch.
//
// Staff-only display is a different question: "did this number really come from the pricing tool in THIS run?" That is what
// a PricingProvenance answers. It is created from one get_pricing_suggestions result, is bound to the execution id of that
// run, and can vouch only for the exact figures that result contained:
//   - a figure the model invented is not in it            -> rejected
//   - a figure that is in it, for STAFF display           -> accepted
//   - the same figure in a CUSTOMER reply                 -> still rejected by guardEstimateReply (it is not in its sets)
//   - a mix of one real figure and one unrelated figure   -> rejected (every figure must be vouched for)
//   - a provenance from an earlier run                    -> rejected (run id mismatch)

import { extractMoneyAmounts } from "./agents/estimate-assistant";
import type { StaffPricingIntelligence } from "../../../../src/lib/pricing/staff-pricing";

const cents = (n: number): number => Math.round(n * 100) / 100;

/** The price-bearing fields of one tool suggestion (everything else — counts, dates — is not a dollar figure). */
const PRICE_FIELDS = ["suggestedUnitPrice", "suggestedTotal", "lowEstimate", "highEstimate", "lowTotal", "highTotal"] as const;

export class PricingProvenance {
  readonly runId: string;
  private readonly figureSet: Set<number>;

  constructor(runId: string, figures: Iterable<number>) {
    this.runId = runId;
    this.figureSet = new Set([...figures].filter((n) => Number.isFinite(n)).map(cents));
  }

  /** True when `n` is a figure from THIS provenance's tool result. */
  has(n: number): boolean {
    return this.figureSet.has(cents(n));
  }

  /** Read-only view of the vouched-for figures (used only to CLASSIFY a blocked customer reply, never to allow one). */
  get figures(): ReadonlySet<number> {
    return this.figureSet;
  }
}

/** Builds the provenance for one run from the raw get_pricing_suggestions output. Only numeric price fields count. */
export function createPricingProvenance(runId: string, toolOutput: unknown): PricingProvenance {
  const out: number[] = [];
  const suggestions = toolOutput && typeof toolOutput === "object" ? (toolOutput as { suggestions?: unknown }).suggestions : undefined;
  if (Array.isArray(suggestions)) {
    for (const s of suggestions) {
      if (!s || typeof s !== "object") continue;
      const rec = s as Record<string, unknown>;
      for (const f of PRICE_FIELDS) if (typeof rec[f] === "number") out.push(rec[f] as number);
      const ev = rec.evidence && typeof rec.evidence === "object" ? (rec.evidence as Record<string, unknown>) : {};
      if (typeof ev.medianUnitPrice === "number") out.push(ev.medianUnitPrice);
    }
  }
  return new PricingProvenance(runId, out);
}

/**
 * Every numeric price in the staff payload must be vouched for by the SAME run's tool output. Returns false for a payload
 * from another run or one carrying any figure the tool never produced.
 */
export function isGroundedStaffPayload(payload: StaffPricingIntelligence, provenance: PricingProvenance): boolean {
  if (payload.runId !== provenance.runId) return false;
  for (const s of payload.suggestions) {
    const figures = [s.suggestedUnitPrice, s.suggestedTotal, s.lowEstimate, s.highEstimate, s.evidence.medianUnitPrice];
    for (const n of figures) if (n !== null && !provenance.has(n)) return false;
  }
  return true;
}

export type StaffTextCheck = { ok: true } | { ok: false; reason: "stale_run" | "ungrounded_figure" };

/**
 * Checks free STAFF-FACING text (for example an inspector note) that mentions dollar figures. Every figure must come from the
 * pricing result of the SAME run. Customer-facing text must NEVER be passed here to be allowed — it goes through
 * guardEstimateReply, which does not accept tool figures.
 */
export function checkStaffPricingText(text: string, provenance: PricingProvenance, currentRunId: string): StaffTextCheck {
  if (provenance.runId !== currentRunId) return { ok: false, reason: "stale_run" };
  for (const n of extractMoneyAmounts(text)) if (!provenance.has(n)) return { ok: false, reason: "ungrounded_figure" };
  return { ok: true };
}

// ── "Pricing guidance" intent (deterministic; narrow on purpose) ─────────────

const GUIDANCE_PATTERNS: RegExp[] = [
  // "pricing suggestions / guidance / help / ideas", "price suggestions"
  /\bpric(?:e|es|ing)\s+(?:guidance|suggestions?|recommendations?|help|check|ideas?)\b/i,
  // "suggest prices", "suggest pricing", "suggested rates", "give me suggestions for pricing"
  /\bsuggest(?:ed|ions?)?\s+(?:a\s+|some\s+)?(?:pric|rates?\b)/i,
  /\bsuggestions?\s+(?:for|on|about)\s+(?:the\s+)?pric/i,
  // "what should we charge (for these)?", "what should I price", "what should these line items cost / be priced / run"
  /\bwhat\s+should\s+(?:we|i|you)\s+(?:charge|price)\b/i,
  /\bwhat\s+should\s+(?:these|the|those|each|this)\s+(?:line\s+)?(?:items?|lines?)\s+(?:cost|be\s+priced|run|go\s+for)\b/i,
  /\bhow\s+should\s+(?:we|i)\s+price\b/i,
  // "price these items", "price the unpriced items", "price out the lines", "price the remaining items"
  /\bprice\s+(?:out\s+)?(?:these|the|those|all|my|our)\s+(?:remaining\s+|unpriced\s+|open\s+|missing\s+)?(?:line\s+)?(?:lines?|items?)\b/i,
  /\bprice\s+(?:out\s+)?(?:the\s+|these\s+|those\s+|all\s+(?:of\s+)?(?:the\s+)?)?(?:remaining|unpriced|open|missing|rest)\b/i,
  // "help me price …", "help with pricing", "can you help with pricing"
  /\bhelp\s+(?:me\s+|us\s+)?(?:with\s+|to\s+)?pric(?:e|ing)\b/i,
  /\bhistorical\s+pric/i,
];

/**
 * True only for an EXPLICIT request for pricing guidance ("pricing suggestions", "what should we charge", "help with pricing").
 * A plain "how much is it?", a status question, or "what's on my estimate?" never matches, so read-only turns do not call the
 * pricing tool. Used together with the server's own knowledge of the estimate; it never selects ids.
 */
export function detectPricingGuidanceRequest(text: string | undefined | null): boolean {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (t.length === 0 || t.length > 2000) return false;
  return GUIDANCE_PATTERNS.some((re) => re.test(t));
}

/**
 * Unsupported claim the assistant must never make: that there is "no price book / catalog, so every price must come from you".
 * Organization-history pricing exists without a price book. A reply matching this is replaced, never delivered.
 */
export const UNSUPPORTED_PRICE_SOURCE_CLAIM =
  /\bno\s+(?:price\s*book|pricebook|pricing\s+(?:catalog|source|data)|catalog)\b[^.]*\b(?:every|each|all)\s+(?:unit\s+)?price|\bevery\s+(?:unit\s+)?price\s+(?:needs?|has|must|have)\s+to\s+come\s+(?:directly\s+)?from\s+you|\bevery\s+(?:unit\s+)?price\s+(?:needs?|must)\s+(?:to\s+)?(?:come|be\s+(?:entered|supplied|provided))\b[^.]*\b(?:you|owner)\b|\bthere(?:'s|\s+is)\s+no\s+price\s*book\b/i;

export const STAFF_GUIDANCE_REPLACEMENT_REPLY =
  "Pricing suggestions for the unpriced lines have been prepared from this organization's own history and are attached to this run for staff (see Pricing Intelligence). Nothing has been applied to the estimate.";
export const GENERIC_PRICE_SOURCE_REPLACEMENT_REPLY = "Our team will confirm pricing for these items.";

/** Items (from the server-read estimate) that count as UNPRICED for a staff pricing-guidance request: not a heading, and either
 * an unpriced placeholder (price_pending) or a $0 line (a line added in the editor with a blank price is stored as $0 with no
 * marker). Already-priced lines (> $0) are never requested, so reviewed/manual prices are never re-priced. Pure. */
export function selectUnpricedGuidanceItems<T extends { isHeading?: boolean; pricePending?: boolean; unitPrice?: number | null }>(items: readonly T[]): T[] {
  return items.filter((i) => !i.isHeading && (i.pricePending === true || i.unitPrice === 0));
}

// ── Who is asking? (staff-initiated only) ────────────────────────────────────

/**
 * Pricing guidance is a STAFF capability. A turn is staff-initiated when an authenticated human drives it (actor "user" — the
 * AI Center Test Console / ai-orchestrate endpoint) or when it arrives on the "internal" channel. A customer-channel event
 * (SMS, email, WhatsApp, …) with a non-human actor is NEVER staff-initiated, so customer wording can never trigger the staff
 * pricing read or its routing shortcuts.
 */
export function isStaffInitiated(actor: { actorType?: string } | undefined, channel: string | undefined): boolean {
  return actor?.actorType === "user" || channel === "internal";
}
