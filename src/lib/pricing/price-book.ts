// src/lib/pricing/price-book.ts
//
// Pricing Intelligence P4 — the Price Book: PURE write-side validation/normalization and PURE read-side matching.
// No I/O, no model, no clock, no randomness. Used by the trusted CRUD service (server) and by the suggestion pipeline.
//
// ── WHAT A PRICE BOOK ENTRY IS ───────────────────────────────────────────
//
// An organization-owned, deterministic price for a named line item: name, aliases, optional project types, item type, unit, a
// sell unit price and an optional low/high range. It produces a staff-only SUGGESTION; nothing here writes an estimate.
//
// ── SENSITIVE FIELDS ─────────────────────────────────────────────────────
//
// internal_unit_cost, default_markup_percent and notes are staff configuration. They exist ONLY on PriceBookRecord (the CRUD
// shape, owner/admin only). The MATCHING shape, PriceBookItem, has no id, no cost, no markup and no notes, so a matched entry
// can never carry them into a suggestion, a prompt, a reply or tool output — the reader that builds PriceBookItem does not even
// select those columns.
//
// ── NORMALIZATION ────────────────────────────────────────────────────────
//
// normalized_name / aliases / unit are computed HERE with the same deterministic normalizer Pricing Intelligence matches with
// (line-item-normalizer.ts). A browser-supplied normalized_name is never read.

import { z } from "zod";
import {
  matchLineItem, normalizeItemName, normalizeUnit, unitStorageForm, MATCH_TIER_RANK, type MatchTier,
} from "./line-item-normalizer";
import { PROJECT_TYPES } from "./project-type";

// ── Vocabulary ───────────────────────────────────────────────────────────

/** The pricing item-type vocabulary (the estimate vocabulary minus "discount", which is never priced from a catalog). */
export const PRICE_BOOK_ITEM_TYPES = ["labor", "material", "service", "equipment", "allowance", "fee", "custom"] as const;
export type PriceBookItemType = (typeof PRICE_BOOK_ITEM_TYPES)[number];

export const MAX_PRICE_BOOK_ALIASES = 25;
export const MAX_PRICE_BOOK_ITEMS_READ = 2000;
/** numeric(14,2) ceiling. */
export const MAX_MONEY = 999_999_999_999.99;
/** numeric(8,4) ceiling. */
export const MAX_MARKUP = 9999.9999;

// ── Write-side shapes ────────────────────────────────────────────────────

/** What a browser may send to create/update an entry. No org id, no reviewer id, no normalized_name, no timestamps. */
const money = z.number().finite().min(0).max(MAX_MONEY);
const nullableMoney = money.nullable().optional();

export const priceBookWriteSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    aliases: z.array(z.string().trim().min(1).max(200)).max(MAX_PRICE_BOOK_ALIASES).optional(),
    projectTypes: z.array(z.enum(PROJECT_TYPES)).max(PROJECT_TYPES.length).optional(),
    itemType: z.enum(PRICE_BOOK_ITEM_TYPES).nullable().optional(),
    unit: z.string().trim().min(1).max(40),
    sellUnitPrice: money,
    lowUnitPrice: nullableMoney,
    highUnitPrice: nullableMoney,
    internalUnitCost: nullableMoney,
    defaultMarkupPercent: z.number().finite().min(0).max(MAX_MARKUP).nullable().optional(),
    taxable: z.boolean().optional(),
    active: z.boolean().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    /** true = mark reviewed now (the server stamps reviewed_at / reviewed_by from the authenticated user); false = clear. */
    reviewed: z.boolean().optional(),
  })
  .strict();
export type PriceBookWriteInput = z.infer<typeof priceBookWriteSchema>;

/** A partial update: every field optional (still strict, still no ids / normalized_name). */
export const priceBookPatchSchema = priceBookWriteSchema.partial().strict();
export type PriceBookPatchInput = z.infer<typeof priceBookPatchSchema>;

/** The server-normalized column values for a (full) write. Never contains org_id, reviewed_by or timestamps. */
export type NormalizedPriceBookColumns = {
  name: string;
  normalized_name: string;
  aliases: string[];
  project_types: string[];
  item_type: string | null;
  unit: string;
  sell_unit_price: number;
  low_unit_price: number | null;
  high_unit_price: number | null;
  internal_unit_cost: number | null;
  default_markup_percent: number | null;
  taxable: boolean;
  active: boolean;
  notes: string | null;
};

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export type NormalizeResult = { ok: true; columns: NormalizedPriceBookColumns } | { ok: false; errors: string[] };

/**
 * Validates a FULL write and computes the server-side columns: normalized_name and aliases via the shared normalizer, unit via
 * the shared unit normalizer, money rounded to cents, project types de-duplicated. Rejects anything the database would reject
 * (negative prices, low <= sell <= high violations) with a clear message before it ever reaches Postgres.
 */
export function normalizePriceBookWrite(input: unknown): NormalizeResult {
  const parsed = priceBookWriteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`) };
  const v = parsed.data;
  const errors: string[] = [];

  const normalizedName = normalizeItemName(v.name);
  if (normalizedName === "") errors.push("name: must contain letters or numbers");

  const aliases = [...new Set((v.aliases ?? []).map((a) => normalizeItemName(a)).filter((a) => a !== "" && a !== normalizedName))];

  const sell = round2(v.sellUnitPrice);
  const low = v.lowUnitPrice == null ? null : round2(v.lowUnitPrice);
  const high = v.highUnitPrice == null ? null : round2(v.highUnitPrice);
  if (low !== null && low > sell) errors.push("lowUnitPrice: must be less than or equal to the sell price");
  if (high !== null && high < sell) errors.push("highUnitPrice: must be greater than or equal to the sell price");
  if (low !== null && high !== null && low > high) errors.push("lowUnitPrice: must be less than or equal to the high price");

  const unitCanonical = normalizeUnit(v.unit);
  const unit = unitStorageForm(unitCanonical);
  if (unit.trim() === "") errors.push("unit: required");

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    columns: {
      name: v.name,
      normalized_name: normalizedName,
      aliases,
      project_types: [...new Set(v.projectTypes ?? [])].sort(),
      item_type: v.itemType ?? null,
      unit,
      sell_unit_price: sell,
      low_unit_price: low,
      high_unit_price: high,
      internal_unit_cost: v.internalUnitCost == null ? null : round2(v.internalUnitCost),
      default_markup_percent: v.defaultMarkupPercent == null ? null : Math.round(v.defaultMarkupPercent * 10_000) / 10_000,
      taxable: v.taxable ?? true,
      active: v.active ?? true,
      notes: v.notes && v.notes.trim() ? v.notes.trim() : null,
    },
  };
}

// ── Read-side shapes (matching) ──────────────────────────────────────────

/** The ONLY shape the suggestion pipeline sees. No id, no internal cost, no markup, no notes, no reviewer id. */
export type PriceBookItem = {
  name: string;
  aliases: string[];
  projectTypes: string[];
  itemType: string | null;
  unit: string;
  sellUnitPrice: number;
  lowUnitPrice: number | null;
  highUnitPrice: number | null;
  reviewed: boolean;
};

export type PriceBookMatch = {
  item: PriceBookItem;
  tier: MatchTier;
  projectTypeSpecific: boolean;
};

export type PriceBookMatchResult =
  | { kind: "match"; match: PriceBookMatch }
  /** Several different entries match equally well; none is chosen. */
  | { kind: "ambiguous" }
  | { kind: "none" };

type MatchRequest = { name: string; itemType?: string | null; unit?: string | null };

/** Best tier of a request against one entry: its name (exact / global alias / token / fuzzy) or any of ITS OWN aliases (an exact
 * hit on a catalog alias is the "alias" tier; looser alias hits keep their token / fuzzy tier). Units and item types are checked first. */
function bestTierForEntry(req: MatchRequest, item: PriceBookItem, ignoreUnit: boolean): MatchTier | null {
  const candidate = { itemType: item.itemType, unit: item.unit };
  let best: MatchTier | null = matchLineItem(req, { name: item.name, ...candidate }, { ignoreUnit });
  for (const alias of item.aliases) {
    const t = matchLineItem(req, { name: alias, ...candidate }, { ignoreUnit });
    if (!t) continue;
    const tier: MatchTier = t === "exact" ? "alias" : t;
    if (!best || MATCH_TIER_RANK[tier] > MATCH_TIER_RANK[best]) best = tier;
  }
  return best;
}

const samePricing = (a: PriceBookItem, b: PriceBookItem): boolean =>
  a.sellUnitPrice === b.sellUnitPrice && a.lowUnitPrice === b.lowUnitPrice && a.highUnitPrice === b.highUnitPrice && normalizeUnit(a.unit) === normalizeUnit(b.unit);

/**
 * Finds the price book entry for a requested item. DETERMINISTIC rules:
 *   1. Only ACTIVE entries are ever passed in (inactive entries are filtered by the reader), and units / item types must be
 *      compatible — an incompatible unit or type never matches.
 *   2. Project scope: with a KNOWN project type an entry is eligible if it targets that type or is generic (no project types);
 *      with an UNKNOWN project type only generic entries are eligible (a type-specific entry cannot be confirmed).
 *   3. Best name tier wins (exact > alias > token > fuzzy). Within that tier a type-specific entry beats a generic one.
 *   4. Still several candidates? Prefer REVIEWED over unreviewed; if candidates are still different (different price / range /
 *      unit) the result is "ambiguous" and NOTHING is chosen. Candidates with identical pricing are not a conflict.
 * No lower tier is ever mixed in, and nothing is ever blended with history.
 */
export function matchPriceBook(request: MatchRequest, items: readonly PriceBookItem[], projectType: string | null): PriceBookMatchResult {
  const ignoreUnit = !(typeof request.unit === "string" && request.unit.trim() !== "");
  const pt = projectType ? projectType.trim().toLowerCase() : null;

  const eligible: Array<{ item: PriceBookItem; tier: MatchTier; specific: boolean }> = [];
  for (const item of items) {
    const generic = item.projectTypes.length === 0;
    const specific = !generic && pt !== null && item.projectTypes.includes(pt);
    if (!generic && !specific) continue;
    const tier = bestTierForEntry(request, item, ignoreUnit);
    if (tier) eligible.push({ item, tier, specific });
  }
  if (eligible.length === 0) return { kind: "none" };

  const bestRank = Math.max(...eligible.map((e) => MATCH_TIER_RANK[e.tier]));
  let pool = eligible.filter((e) => MATCH_TIER_RANK[e.tier] === bestRank);
  const specificPool = pool.filter((e) => e.specific);
  if (specificPool.length > 0) pool = specificPool;

  // With an open unit, candidates in different units are a genuine conflict (we cannot know which unit is meant).
  const reviewed = pool.filter((e) => e.item.reviewed);
  const decisive = reviewed.length > 0 ? reviewed : pool;
  const first = decisive[0];
  if (!decisive.every((e) => samePricing(e.item, first.item))) return { kind: "ambiguous" };

  // Deterministic representative among identical candidates: stable by name.
  const chosen = [...decisive].sort((a, b) => a.item.name.localeCompare(b.item.name))[0];
  return { kind: "match", match: { item: chosen.item, tier: chosen.tier, projectTypeSpecific: chosen.specific } };
}

// ── Confidence ───────────────────────────────────────────────────────────

export type PriceBookConfidence = "high" | "medium" | "low";

/**
 * HIGH   reviewed entry, exact/alias name, project-type-specific match OR (project type unknown and a generic entry)
 * MEDIUM unreviewed exact/alias; a reviewed GENERIC entry when the project type is known; any token match (capped)
 * LOW    fuzzy
 */
export function priceBookConfidence(input: { tier: MatchTier; reviewed: boolean; projectTypeSpecific: boolean; projectTypeKnown: boolean }): PriceBookConfidence {
  if (input.tier === "fuzzy") return "low";
  if (input.tier === "token") return "medium";
  if (!input.reviewed) return "medium";
  if (input.projectTypeSpecific || !input.projectTypeKnown) return "high";
  return "medium";
}
