// netlify/functions/lib/ai/existing-estimate-intent.ts
//
// A deliberately NARROW, deterministic detector for "the customer is asking to CHANGE an estimate that already
// exists". It is used by orchestrator.ts ONLY when trusted CRM context has ALREADY resolved an existing estimate
// (AIResolvedContext.existingEstimate) — so it can never invent an estimate, only decide that Lead Qualification
// should stop generic qualification and hand the turn to the Estimate Assistant.
//
// Why deterministic at all: whether to hand off was previously a pure model judgment, and production showed the model
// carrying on with qualification questions even though an estimate (EST-000008) already existed. A backstop in code
// makes the required behavior independent of model drift.
//
// What it does NOT do:
//   - It never extracts or chooses an estimate id, an item, a price, or a quantity. The estimate is the one the server
//     resolved from trusted ids; the items are chosen later by the Estimate Assistant's own (approval-gated) decision.
//   - It does not try to understand every phrasing. Anything it does not match still goes through the normal model
//     decision, which is now told about the existing estimate and may hand off itself.
//
// A match requires BOTH an estimate noun and a change verb in the customer's CURRENT message, so a plain budget
// mention, a scheduling request, or small talk never matches.

const ESTIMATE_NOUN = /\b(estimate|estimates|quote|quotes|proposal|proposals|line[- ]items?)\b/i;
const CHANGE_VERB = /\b(add|adding|include|including|update|updating|change|changing|modify|modifying|edit|editing|revise|revising|adjust|adjusting|remove|removing|delete|deleting|swap|swapping|replace|replacing|amend)\b/i;

export function detectExistingEstimateChangeIntent(text: string | undefined | null): boolean {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (t.length === 0 || t.length > 2000) return false;
  return ESTIMATE_NOUN.test(t) && CHANGE_VERB.test(t);
}

// ── Read-only references to the customer's OWN estimate ───────────────────────────────────────────────────
//
// "What's on my estimate?", "What's the total on my quote?", "Is my proposal ready?", "Can you show me the estimate?"
// carry no change verb, but they plainly refer to an estimate the customer already has. When the server has resolved
// exactly ONE existing estimate, those turns belong to the Estimate Assistant (which reads the estimate through the
// audited get_estimate_context action and answers only from it), not to generic qualification.
//
// A reference requires a DEFINITE possessive/demonstrative determiner (my / our / your / the / this / that / existing)
// directly before the noun (at most one short adjective between), or an estimate number such as EST-000008. That is
// what keeps generic talk about estimating out: "Do you provide estimates?", "Can I get a quote?", "how much does an
// estimate cost", "free estimates" have no definite determiner on a singular noun and never match.
const DEFINITE_REFERENCE = /\b(?:my|our|your|the|this|that|existing)\s+(?:(?!free\b)[a-z]+\s+)?(?:estimate|quote|proposal)\b/i;
const ESTIMATE_NUMBER = /\bEST-\d{3,}\b/i;
/** Generic questions ABOUT the estimating service itself, even when phrased with "the". */
const GENERIC_ESTIMATING_QUESTION = /\b(?:do|does|can|could|will|would)\s+(?:you|your\s+(?:company|team)|they)\s+(?:guys\s+)?(?:provide|offer|give|do|charge for)\b|\b(?:free|estimating|estimators?)\b/i;

export function detectExistingEstimateReference(text: string | undefined | null): boolean {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (t.length === 0 || t.length > 2000) return false;
  if (GENERIC_ESTIMATING_QUESTION.test(t)) return false;
  return DEFINITE_REFERENCE.test(t) || ESTIMATE_NUMBER.test(t);
}

/**
 * How the customer's current message relates to an estimate that already exists:
 *   "change"    - asks to add/update/remove something on it (applies when ONE or SEVERAL active estimates were resolved)
 *   "reference" - plainly refers to their estimate without changing it (applies ONLY when exactly one was resolved)
 *   null        - anything else (the normal model decision runs, now aware of the estimate)
 */
export type ExistingEstimateIntent = "change" | "reference";

export function classifyExistingEstimateIntent(text: string | undefined | null): ExistingEstimateIntent | null {
  if (detectExistingEstimateChangeIntent(text)) return "change";
  if (detectExistingEstimateReference(text)) return "reference";
  return null;
}
