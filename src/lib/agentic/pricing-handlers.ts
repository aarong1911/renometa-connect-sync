// src/lib/agentic/pricing-handlers.ts
//
// Pricing Intelligence v1 (P2) — the get_pricing_suggestions action: a READ-ONLY, org-scoped, staff-only pricing
// SUGGESTION built from the organization's own history. It never writes, never changes a price, and has no outbound effect.
//
// ── TRUST BOUNDARY ───────────────────────────────────────────────────────
//
// Two schemas, on purpose:
//   getPricingSuggestionsModelInput   what a MODEL may ever supply: { items } only (strict). No ids of any kind, no
//                                     org, no prices. A model that adds `orgId`, `estimateId`, `projectId`, `leadId`,
//                                     `contactId`, a price, or anything else fails validation.
//   getPricingSuggestionsInput        what the registered ACTION receives: the model's items PLUS the trusted ids that
//                                     SERVER code binds (bindTrustedPricingInput). Same pattern as get_estimate_context,
//                                     whose ids are likewise bound by the orchestrator. The orgId is never part of the
//                                     input at all: it comes from ActionContext, which trusted server code builds.
// The handler re-verifies every id against ctx.orgId (a foreign id resolves to "nothing", never to another tenant's data).
//
// ── OUTPUT ───────────────────────────────────────────────────────────────
//
// Aggregates only: the pure engine's contract (price, range, confidence, sample counts, dates, assumptions) plus a small
// `basis` block. It contains no customer / contact / project names, no database ids, no historical line text, no internal
// cost or vendor data. STAFF-ONLY in v1: nothing here is wired into a customer reply.

import { z } from "zod";
import type { ActionHandler } from "./types";
import { lookupCurrentEstimate } from "./estimate-lookup";
import { isPricePendingItem } from "../estimate-pricing-gate";
import { matchLineItem } from "../pricing/line-item-normalizer";
import { EVIDENCE_WINDOW_MONTHS, type PricingSuggestion } from "../pricing/pricing-engine";
import { suggestPricingWithPriceBook } from "../pricing/pricing-suggestions";
import { readPriceBook } from "../pricing/price-book-reader";
import { classifyProjectTypeFromText, normalizeProjectType } from "../pricing/project-type";
import { readPricingEvidence } from "../pricing/pricing-evidence-reader";

export const MAX_PRICING_ITEMS = 10;
const GENERIC_NOT_FOUND = "The requested record was not found in this organization.";
const PRICING_FAILED = "Could not load pricing suggestions.";

/** Item types a model may name. "discount" is excluded: a discount is never priced from history. */
export const PRICING_ITEM_TYPES = ["labor", "material", "service", "equipment", "allowance", "fee", "custom"] as const;

export const pricingRequestItemSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(1000).optional(),
    itemType: z.enum(PRICING_ITEM_TYPES).optional(),
    unit: z.string().trim().min(1).max(40).optional(),
    quantity: z.number().finite().positive().max(1_000_000).optional(),
  })
  .strict();
export type PricingRequestItemInput = z.infer<typeof pricingRequestItemSchema>;

/** What a model may supply. Strict: any other key (an id, an org, a price) is a validation failure. */
export const getPricingSuggestionsModelInput = z
  .object({ items: z.array(pricingRequestItemSchema).min(1).max(MAX_PRICING_ITEMS) })
  .strict();
export type GetPricingSuggestionsModelInput = z.infer<typeof getPricingSuggestionsModelInput>;

/** What the registered action receives: the model's items + TRUSTED ids bound by server code. */
export const getPricingSuggestionsInput = z
  .object({
    items: z.array(pricingRequestItemSchema).min(1).max(MAX_PRICING_ITEMS),
    estimateId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    leadId: z.string().uuid().optional(),
    contactId: z.string().uuid().optional(),
    /** SERVER-BOUND ONLY (never in the model-visible schema): for an explicit staff pricing-guidance request, a current-estimate
     * line that is $0 with no reviewed marker counts as UNPRICED (a line added in the editor with a blank price) rather than
     * as a deliberate reviewed $0, so it can receive a suggestion. A line already priced above $0 is never affected. */
    zeroPriceCountsAsUnpriced: z.boolean().optional(),
  })
  .strict();
export type GetPricingSuggestionsInput = z.infer<typeof getPricingSuggestionsInput>;

export type TrustedPricingScope = { estimateId?: string; projectId?: string; leadId?: string; contactId?: string };

/**
 * The ONLY way model output becomes action input: the model's value is validated against the STRICT model schema (so an id,
 * an org or a price in it throws), and the ids come exclusively from `trusted` — the runtime context. Throws a ZodError on
 * any extra model key.
 */
export function bindTrustedPricingInput(modelInput: unknown, trusted: TrustedPricingScope, options?: { zeroPriceCountsAsUnpriced?: boolean }): GetPricingSuggestionsInput {
  const parsed = getPricingSuggestionsModelInput.parse(modelInput);
  return {
    items: parsed.items,
    ...(options?.zeroPriceCountsAsUnpriced ? { zeroPriceCountsAsUnpriced: true } : {}),
    ...(trusted.estimateId ? { estimateId: trusted.estimateId } : {}),
    ...(trusted.projectId ? { projectId: trusted.projectId } : {}),
    ...(trusted.leadId ? { leadId: trusted.leadId } : {}),
    ...(trusted.contactId ? { contactId: trusted.contactId } : {}),
  };
}

// ── Output ───────────────────────────────────────────────────────────────

export type CurrentLineStatus = "priced" | "reviewed_zero" | "unpriced_placeholder" | "not_on_estimate" | "unknown";

export type PricingSuggestionsOutput = {
  staffOnly: true;
  basis: {
    projectType: string | null;
    projectTypeSource: "project" | "lead_service" | "unknown";
    currentEstimateStatus: string | null;
    evidenceWindowMonths: number;
    estimateEvidenceLines: number;
    changeOrderEvidenceLines: number;
    /** Active Price Book entries available to the matcher (a count only — never entries, ids, costs or notes). */
    priceBookItems: number;
    /** false when the price book could not be read (e.g. the table does not exist yet); history is then used on its own. */
    priceBookAvailable: boolean;
    changeOrderEvidenceAvailable: boolean;
    truncated: boolean;
  };
  suggestions: PricingSuggestion[];
  /** Aligned with `suggestions`: whether the CURRENT estimate already has a matching line, and in what state. Reviewed
   * pricing is never to be overwritten; this lets staff (and later phases) see it. */
  currentEstimateLines: CurrentLineStatus[];
  pricingNote: string;
};

export const PRICING_NOTE =
  "Suggested from this organization's own past estimates and change orders. These are suggestions for staff review only: nothing has been applied, nothing is a quote, and they must not be shared with the customer.";

// ── Handler ──────────────────────────────────────────────────────────────

type HandlerDeps = { now: () => Date };

async function resolveProjectType(
  ctx: Parameters<ActionHandler>[0],
  scope: { projectId?: string | null; leadId?: string | null },
): Promise<{ projectType: string | null; source: "project" | "lead_service" | "unknown" }> {
  if (scope.projectId) {
    const { data, error } = await ctx.supabase.from("projects").select("id, project_type").eq("id", scope.projectId).eq("org_id", ctx.orgId).maybeSingle();
    if (!error) {
      const t = normalizeProjectType(data?.project_type);
      if (t) return { projectType: t, source: "project" };
    }
  }
  if (scope.leadId) {
    const { data, error } = await ctx.supabase.from("leads").select("id, custom_fields").eq("id", scope.leadId).eq("org_id", ctx.orgId).maybeSingle();
    if (!error && data) {
      const cf = data.custom_fields && typeof data.custom_fields === "object" ? (data.custom_fields as Record<string, unknown>) : {};
      const t = classifyProjectTypeFromText(cf.service);
      if (t) return { projectType: t, source: "lead_service" };
    }
  }
  return { projectType: null, source: "unknown" };
}

export function createGetPricingSuggestions(deps: HandlerDeps): ActionHandler<GetPricingSuggestionsInput, PricingSuggestionsOutput> {
  return async (ctx, input) => {
    try {
      const now = deps.now();

      // 1. current basis — every lookup below is org-scoped (ctx.orgId); a foreign / unknown id yields "nothing".
      let estimateRow: any = null;
      let estimateAmbiguous = false;
      const lookup = await lookupCurrentEstimate(
        ctx.supabase,
        ctx.orgId,
        { estimateId: input.estimateId, projectId: input.projectId, leadId: input.leadId, contactId: input.contactId },
        "id, status, project_id, lead_id, created_at",
      );
      if (lookup.kind === "error") return { ok: false, error: PRICING_FAILED };
      if (input.estimateId && lookup.kind === "none") return { ok: false, error: GENERIC_NOT_FOUND };
      if (lookup.kind === "found") {
        estimateRow = lookup.row;
        estimateAmbiguous = lookup.ambiguous;
      }
      // An ambiguous scope is never treated as "the" estimate.
      const currentEstimate = estimateRow && !estimateAmbiguous ? estimateRow : null;

      const { projectType, source } = await resolveProjectType(ctx, {
        projectId: currentEstimate?.project_id ?? input.projectId,
        leadId: currentEstimate?.lead_id ?? input.leadId,
      });

      // 2. org-scoped evidence → pure engine
      const read = await readPricingEvidence(ctx.supabase, ctx.orgId, now);
      if (!read.ok) return { ok: false, error: PRICING_FAILED };
      // Price Book first (org-scoped, active entries only, no cost/markup/notes/ids selected), then history, never blended.
      const priceBook = await readPriceBook(ctx.supabase, ctx.orgId);

      const suggestions = suggestPricingWithPriceBook(
        input.items.map((i) => ({ name: i.name, description: i.description ?? null, itemType: i.itemType ?? null, unit: i.unit ?? null, quantity: i.quantity ?? null })),
        priceBook.items,
        read.evidence,
        { now, projectType },
      );

      // 3. what the CURRENT estimate already has for each requested item (read-only; protects reviewed pricing)
      let currentLines: any[] | null = null;
      if (currentEstimate) {
        const { data, error } = await ctx.supabase
          .from("estimate_items")
          .select("name, item_type, unit, unit_price, is_heading, metadata")
          .eq("estimate_id", currentEstimate.id)
          .limit(200);
        if (!error) currentLines = data ?? [];
      }
      const currentEstimateLines: CurrentLineStatus[] = input.items.map((i) => {
        if (!currentLines) return "unknown";
        const hit = currentLines.find((l) => !l.is_heading && matchLineItem({ name: i.name, itemType: i.itemType ?? null }, { name: String(l.name ?? ""), itemType: l.item_type ?? null }, { ignoreUnit: true }));
        if (!hit) return "not_on_estimate";
        if (Number(hit.unit_price) > 0) return "priced";
        if (isPricePendingItem(hit)) return "unpriced_placeholder";
        // $0 with no reviewed marker: a deliberate reviewed $0 by default; on an explicit staff guidance request it is a blank-price line.
        return input.zeroPriceCountsAsUnpriced ? "unpriced_placeholder" : "reviewed_zero";
      });
      if (input.zeroPriceCountsAsUnpriced && currentLines) {
        currentEstimateLines.forEach((state, i) => {
          const s = suggestions[i];
          const hit = currentLines!.find((l) => !l.is_heading && matchLineItem({ name: input.items[i].name, itemType: input.items[i].itemType ?? null }, { name: String(l.name ?? ""), itemType: l.item_type ?? null }, { ignoreUnit: true }));
          if (state === "unpriced_placeholder" && hit && !isPricePendingItem(hit) && Number(hit.unit_price) === 0 && s.pricingSource === "org_history") {
            s.assumptions = [...s.assumptions, "This line is currently $0 and is not marked as reviewed; a suggestion is shown because pricing guidance was requested."];
          }
        });
      }

      return {
        ok: true,
        output: {
          staffOnly: true,
          basis: {
            projectType,
            projectTypeSource: source,
            currentEstimateStatus: currentEstimate ? String(currentEstimate.status) : null,
            evidenceWindowMonths: EVIDENCE_WINDOW_MONTHS,
            estimateEvidenceLines: read.diagnostics.estimateLinesEligible,
            changeOrderEvidenceLines: read.diagnostics.changeOrderItemsEligible,
            priceBookItems: priceBook.items.length,
            priceBookAvailable: priceBook.available,
            changeOrderEvidenceAvailable: read.diagnostics.changeOrderEvidenceAvailable,
            truncated: read.diagnostics.truncated,
          },
          suggestions,
          currentEstimateLines,
          pricingNote: PRICING_NOTE,
        },
      };
    } catch (err) {
      console.error("[pricing-handlers] get_pricing_suggestions failed", { message: err instanceof Error ? err.message : String(err) });
      return { ok: false, error: PRICING_FAILED };
    }
  };
}

/** The registered handler (real clock). Tests build their own with a fixed clock via createGetPricingSuggestions. */
export const getPricingSuggestions = createGetPricingSuggestions({ now: () => new Date() });
