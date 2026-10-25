// netlify/functions/lib/estimate-suggest-pricing.ts
//
// Pricing Intelligence P4 — the staff "Suggest Pricing" action on an open estimate. HTTP-free core (testable); the thin handler is
// netlify/functions/estimate-suggest-pricing.ts.
//
// TRUST + BEHAVIOR
//   - The estimate id comes from the staff UI (the estimate that is open); the organization comes from the authenticated session.
//     getEstimateContext is org-scoped, so a foreign / unknown id is "not found" — indistinguishable from a missing one.
//   - The unpriced items are resolved SERVER-SIDE from the stored estimate (never from the browser, never from a model): the P3
//     explicit-staff rule — price_pending placeholders AND $0 lines (selectUnpricedGuidanceItems). Lines priced above $0 (reviewed
//     or manual) are never requested, so they can never receive a suggestion.
//   - The same get_pricing_suggestions handler as the Estimate Assistant runs (Price Book -> organization history -> none).
//     No model is involved anywhere in this path. READ ONLY: nothing is written, no approval is created, nothing is applied.
//   - The result is the staff-only pricing payload (staff-pricing.ts) — the same shape the Run Inspector renders.

import { randomUUID } from "node:crypto";
import { getEstimateContext } from "../../../src/lib/agentic/estimate-handlers";
import { createGetPricingSuggestions, MAX_PRICING_ITEMS, PRICING_ITEM_TYPES, type PricingSuggestionsOutput } from "../../../src/lib/agentic/pricing-handlers";
import { buildStaffPricingIntelligence, type StaffPricingIntelligence } from "../../../src/lib/pricing/staff-pricing";
import { selectUnpricedGuidanceItems } from "./ai/pricing-provenance";

/** Hard cap on lines priced per click (keeps the request bounded). Beyond it the response says so. */
export const MAX_SUGGEST_ITEMS = 40;

export const ALL_PRICED_MESSAGE = "All estimate items already have reviewed pricing.";

export type SuggestPricingDb = { from: (table: string) => any };

export type SuggestPricingResult =
  | { ok: true; kind: "all_priced"; message: string }
  | { ok: true; kind: "suggestions"; pricing: StaffPricingIntelligence; requestedItems: number; capped: boolean }
  | { ok: false; status: 404 | 409 | 500; error: string };

/** A blank unit or the editor's default "each" is not a real unit signal: treat it as an open unit for matching. */
function unitSignal(unit: string | null | undefined): string | undefined {
  const u = (unit ?? "").trim();
  return u === "" || u.toLowerCase() === "each" ? undefined : u;
}

export async function suggestPricingForEstimate(
  db: SuggestPricingDb,
  ctx: { orgId: string; userId: string },
  estimateId: unknown,
  deps: { now: () => Date } = { now: () => new Date() },
): Promise<SuggestPricingResult> {
  if (typeof estimateId !== "string" || !/^[0-9a-f-]{36}$/i.test(estimateId)) return { ok: false, status: 404, error: "Estimate not found." };

  const actionCtx = { supabase: db as any, orgId: ctx.orgId, actor: { actorType: "user" as const, actorId: ctx.userId, source: "estimate_suggest_pricing" } };

  const context = await getEstimateContext(actionCtx, { estimateId });
  if (!context.ok || !context.output) return { ok: false, status: 500, error: "Could not load the estimate." };
  const found = context.output;
  if (!found.found || !found.estimate) return { ok: false, status: 404, error: "Estimate not found." };

  const unpriced = selectUnpricedGuidanceItems(found.items ?? []);
  if (unpriced.length === 0) return { ok: true, kind: "all_priced", message: ALL_PRICED_MESSAGE };

  const capped = unpriced.length > MAX_SUGGEST_ITEMS;
  const requested = unpriced.slice(0, MAX_SUGGEST_ITEMS);
  const handler = createGetPricingSuggestions(deps);

  let merged: PricingSuggestionsOutput | null = null;
  for (let i = 0; i < requested.length; i += MAX_PRICING_ITEMS) {
    const batch = requested.slice(i, i + MAX_PRICING_ITEMS);
    const result = await handler(actionCtx, {
      items: batch.map((l) => ({
        name: l.name,
        ...(l.itemType && (PRICING_ITEM_TYPES as readonly string[]).includes(l.itemType) ? { itemType: l.itemType as (typeof PRICING_ITEM_TYPES)[number] } : {}),
        ...(unitSignal(l.unit) ? { unit: unitSignal(l.unit) } : {}),
        ...(typeof l.quantity === "number" && l.quantity > 0 ? { quantity: l.quantity } : {}),
      })),
      estimateId,
      zeroPriceCountsAsUnpriced: true,
    });
    if (!result.ok || !result.output) return { ok: false, status: 500, error: "Could not calculate pricing suggestions." };
    merged = merged
      ? { ...result.output, suggestions: [...merged.suggestions, ...result.output.suggestions], currentEstimateLines: [...merged.currentEstimateLines, ...result.output.currentEstimateLines] }
      : result.output;
  }
  if (!merged) return { ok: false, status: 500, error: "Could not calculate pricing suggestions." };

  const pricing = buildStaffPricingIntelligence({ runId: randomUUID(), requestedItems: requested.length, toolOutput: merged as never });
  return { ok: true, kind: "suggestions", pricing, requestedItems: requested.length, capped };
}
