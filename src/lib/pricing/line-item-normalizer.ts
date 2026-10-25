// src/lib/pricing/line-item-normalizer.ts
//
// Pricing Intelligence v1 (P1) — PURE, deterministic text/unit normalization and name matching for estimate and
// change-order line items. No I/O, no database, no model, no randomness, no clock. Imports nothing.
//
// This module only answers "do these two line items describe the same thing?". It never prices anything.
//
// MATCH TIERS (best to worst):
//   exact  - identical after normalization
//   alias  - identical after the small, explicit alias map is applied
//   token  - high token-set (Jaccard) similarity
//   fuzzy  - weaker token / edit-distance similarity; callers must treat it as LOW confidence
// Incompatible UNITS never match at any tier; incompatible item types never match either.

// ── Units ────────────────────────────────────────────────────────────────

/** Canonical unit codes. Anything else is kept as `other:<cleaned text>` so two identical unknown units still match. */
export type CanonicalUnit = "each" | "sqft" | "lf" | "hour" | "lump_sum" | `other:${string}`;

const UNIT_ALIASES: Record<string, CanonicalUnit> = {
  // each
  ea: "each", each: "each", unit: "each", units: "each", item: "each", items: "each", pc: "each", pcs: "each", piece: "each", pieces: "each",
  // area
  sf: "sqft", sqft: "sqft", "sq ft": "sqft", "sq feet": "sqft", "sq foot": "sqft", "square foot": "sqft", "square feet": "sqft", "square ft": "sqft",
  ft2: "sqft", "ft 2": "sqft", "sq. ft.": "sqft", "sq ft.": "sqft",
  // length
  lf: "lf", "lin ft": "lf", "linear ft": "lf", "linear foot": "lf", "linear feet": "lf", "lineal ft": "lf", "lineal feet": "lf", "lin feet": "lf",
  // time
  hr: "hour", hrs: "hour", hour: "hour", hours: "hour",
  // lump sum
  ls: "lump_sum", "lump sum": "lump_sum", lumpsum: "lump_sum", lump: "lump_sum",
};

/**
 * Normalizes a unit string. A blank / missing unit is "each": the estimate editor's default unit is "each", and a line
 * with no unit is a count-style line. (Callers that do not know the unit at all pass `undefined` for the REQUEST and let
 * the engine pick the dominant historical unit; this function is for evidence rows and explicit units.)
 */
export function normalizeUnit(raw: string | null | undefined): CanonicalUnit {
  const cleaned = (raw ?? "")
    .toLowerCase()
    .replace(/[.,;:()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return "each";
  const direct = UNIT_ALIASES[cleaned];
  if (direct) return direct;
  const compact = cleaned.replace(/\s+/g, "");
  if (UNIT_ALIASES[compact]) return UNIT_ALIASES[compact];
  return `other:${cleaned}`;
}

/** Units are compatible only when they are the same canonical unit. */
export function unitsCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeUnit(a) === normalizeUnit(b);
}

// ── Item types ───────────────────────────────────────────────────────────

/** labor and service describe the same kind of charge in practice; everything else only matches itself. `null`, an
 * unknown value and "custom" are neutral (they do not block a match). */
const TYPE_GROUP: Record<string, string> = {
  labor: "labor_service",
  service: "labor_service",
  material: "material",
  equipment: "equipment",
  allowance: "allowance",
  fee: "fee",
  discount: "discount",
};

export function itemTypesCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  const ga = a ? TYPE_GROUP[a.toLowerCase()] : undefined;
  const gb = b ? TYPE_GROUP[b.toLowerCase()] : undefined;
  if (!ga || !gb) return true; // neutral: unknown / custom / missing
  return ga === gb;
}

// ── Names ────────────────────────────────────────────────────────────────

/** Harmless filler phrases removed BEFORE tokenizing (whole-phrase, word-bounded). */
const FILLER_PHRASES: RegExp[] = [
  /\b(?:supply and install|furnish and install|supply install|installation|install) of\b/g,
  /\b(?:the|a|an|of|for|and|with)\b/g,
];

/** Word-level rewrites applied per token after singularization (verb/noun variants of the same word). */
const TOKEN_REWRITES: Record<string, string> = {
  installation: "install", installing: "install", installed: "install", installs: "install",
  replacement: "replace", replacing: "replace", replaced: "replace",
  removal: "remove", removing: "remove", removed: "remove",
  demolition: "demo", demolish: "demo",
  tiling: "tile", tiled: "tile",
  painting: "paint", painted: "paint",
};

/** Words ending in s that are NOT plurals (or whose singular form would be wrong). */
const SINGULAR_EXCEPTIONS = new Set(["glass", "grass", "plus", "bonus", "gas", "bus", "canvas", "lumens", "series", "news", "mattress", "access", "chassis", "hardwood", "this", "its", "is", "was"]);

/** Conservative singularization: handles the regular cases only and never touches short or exception words. */
export function singularize(word: string): string {
  if (word.length <= 3 || SINGULAR_EXCEPTIONS.has(word)) return word;
  if (/(?:ss|us|is|ous)$/.test(word)) return word;
  if (/ies$/.test(word) && word.length > 4) return word.slice(0, -3) + "y";
  if (/(?:ches|shes|sses|xes|zes)$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word)) return word.slice(0, -1);
  return word;
}

/**
 * Small, EXPLICIT alias map: canonical phrase -> alternative phrases (all given in already-normalized, singular form).
 * Deliberately short and boring; a catalog (later phase) will supersede it with org-curated aliases. Never learned,
 * never model-generated.
 */
export const ALIAS_MAP: ReadonlyArray<readonly [canonical: string, aliases: readonly string[]]> = [
  ["drywall", ["sheetrock", "sheet rock", "gypsum board", "gyp board", "gypsum"]],
  ["countertop", ["counter top", "counter"]],
  ["backsplash", ["back splash", "splash"]],
  ["baseboard", ["base board", "base molding", "base trim"]],
  ["demo", ["tear out", "teardown", "tear down", "demo and haul away"]],
  ["vanity", ["bathroom vanity", "vanity cabinet"]],
  ["lvp", ["luxury vinyl plank", "vinyl plank"]],
  ["recessed light", ["can light", "pot light", "recessed lighting"]],
  ["toilet", ["water closet", "commode"]],
  ["faucet", ["tap", "mixer tap"]],
  ["hvac", ["heating and cooling", "heating cooling", "furnace and ac"]],
  ["permit", ["building permit", "permit fee"]],
];

/** Lowercase, punctuation cleanup, whitespace normalization, filler removal, singularization and word rewrites.
 * Returns a space-joined string of tokens; two names that mean the same thing "exactly" produce the same string. */
export function normalizeItemName(raw: string | null | undefined): string {
  let s = (raw ?? "").toLowerCase();
  s = s.replace(/&/g, " and ").replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  for (const re of FILLER_PHRASES) s = s.replace(re, " ");
  s = s.replace(/\s+/g, " ").trim();
  const tokens = s
    .split(" ")
    .filter(Boolean)
    .map((t) => singularize(t))
    .map((t) => TOKEN_REWRITES[t] ?? t);
  return tokens.join(" ");
}

/** Applies the alias map to an ALREADY-NORMALIZED name: every alias phrase becomes its canonical phrase. */
export function applyAliases(normalized: string): string {
  let s = ` ${normalized} `;
  for (const [canonical, aliases] of ALIAS_MAP) {
    // Normalize the alias phrases the same way names are, so "Sheet Rock" and "sheetrocks" both collapse.
    for (const alias of aliases) {
      const a = normalizeItemName(alias);
      if (a && a !== canonical) s = s.split(` ${a} `).join(` ${canonical} `);
    }
  }
  return s.replace(/\s+/g, " ").trim();
}

/** The two comparable forms of a name. */
export type NormalizedName = { normalized: string; canonical: string; tokens: string[] };

export function toNormalizedName(raw: string | null | undefined): NormalizedName {
  const normalized = normalizeItemName(raw);
  const canonical = applyAliases(normalized);
  return { normalized, canonical, tokens: tokenSet(canonical) };
}

function tokenSet(canonical: string): string[] {
  return Array.from(new Set(canonical.split(" ").filter(Boolean))).sort();
}

// ── Similarity ───────────────────────────────────────────────────────────

/** Jaccard similarity of two token sets, 0..1. */
export function tokenSetSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let shared = 0;
  for (const t of a) if (setB.has(t)) shared += 1;
  return shared / (a.length + b.length - shared);
}

/** 1 - normalized Levenshtein distance, 0..1. */
export function editSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = temp;
    }
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

// ── Matching ─────────────────────────────────────────────────────────────

export type MatchTier = "exact" | "alias" | "token" | "fuzzy";

/** Strict ordering used to prefer better tiers. */
export const MATCH_TIER_RANK: Record<MatchTier, number> = { exact: 4, alias: 3, token: 2, fuzzy: 1 };

/** Thresholds are intentionally conservative; tuning them is a deliberate, tested change. */
export const TOKEN_MATCH_MIN_JACCARD = 0.75;
export const FUZZY_MATCH_MIN_JACCARD = 0.5;
export const FUZZY_MATCH_MIN_EDIT = 0.82;

/**
 * Compares a requested item to one historical line item. Returns the match tier, or null when they do not match.
 * Units and item types are checked FIRST: an incompatible unit or type never matches regardless of how similar the
 * names are.
 */
export function matchLineItem(
  request: { name: string; itemType?: string | null; unit?: string | null },
  candidate: { name: string; itemType?: string | null; unit?: string | null },
  options?: { ignoreUnit?: boolean },
): MatchTier | null {
  if (!options?.ignoreUnit && !unitsCompatible(request.unit, candidate.unit)) return null;
  if (!itemTypesCompatible(request.itemType, candidate.itemType)) return null;

  const a = toNormalizedName(request.name);
  const b = toNormalizedName(candidate.name);
  if (a.normalized === "" || b.normalized === "") return null;

  if (a.normalized === b.normalized) return "exact";
  if (a.canonical === b.canonical) return "alias";

  const jaccard = tokenSetSimilarity(a.tokens, b.tokens);
  // A single-word name must match exactly or via alias; it never "token matches" a longer phrase.
  const multiWord = a.tokens.length >= 2 && b.tokens.length >= 2;
  if (multiWord && jaccard >= TOKEN_MATCH_MIN_JACCARD) return "token";

  if ((multiWord && jaccard >= FUZZY_MATCH_MIN_JACCARD) || editSimilarity(a.canonical, b.canonical) >= FUZZY_MATCH_MIN_EDIT) return "fuzzy";
  return null;
}
