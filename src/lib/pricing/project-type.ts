// src/lib/pricing/project-type.ts
//
// Pricing Intelligence v1 (P2) — project-type helpers. PURE: no I/O, no model.
//
// `projects.project_type` is a CHECK-constrained key (kitchen_remodel, bathroom_remodel, ...). The lead's "Project Type"
// shown in the UI is DIFFERENT: it is free text in `leads.custom_fields.service` (e.g. "Bathroom Remodel") and is NOT a
// `projects.id` relationship. This module never creates a project link; it only maps free text onto the canonical key,
// as a FALLBACK classification signal when no project row carries a type. Same-project-type evidence boosts confidence in
// the pricing engine but is never required, so an unmapped value simply stays `null`.

export const PROJECT_TYPES = [
  "kitchen_remodel", "bathroom_remodel", "full_home_remodel", "home_addition", "roofing", "flooring", "painting", "hvac",
  "plumbing", "electrical", "landscaping", "commercial_renovation", "new_construction", "repair_maintenance",
] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

const PROJECT_TYPE_SET: ReadonlySet<string> = new Set(PROJECT_TYPES);

/** A canonical key from `projects.project_type`, or null. "other" (and anything unknown) carries no pricing signal. */
export function normalizeProjectType(value: unknown): ProjectType | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return PROJECT_TYPE_SET.has(v) ? (v as ProjectType) : null;
}

/** Explicit, boring phrase table (whole normalized phrase must match). Never learned, never model-generated. */
const PHRASES: ReadonlyArray<readonly [ProjectType, readonly string[]]> = [
  ["kitchen_remodel", ["kitchen remodel", "kitchen remodeling", "kitchen renovation", "kitchen", "remodel kitchen"]],
  ["bathroom_remodel", ["bathroom remodel", "bathroom remodeling", "bathroom renovation", "bath remodel", "bathroom", "remodel bathroom"]],
  ["full_home_remodel", ["full home remodel", "whole home remodel", "whole house remodel", "full house remodel", "home renovation", "whole home renovation"]],
  ["home_addition", ["home addition", "room addition", "addition"]],
  ["roofing", ["roofing", "roof replacement", "roof repair", "new roof"]],
  ["flooring", ["flooring", "floor installation", "new flooring"]],
  ["painting", ["painting", "interior painting", "exterior painting", "paint"]],
  ["hvac", ["hvac", "heating and cooling", "ac installation"]],
  ["plumbing", ["plumbing", "plumbing repair"]],
  ["electrical", ["electrical", "electrical work", "electrical repair"]],
  ["landscaping", ["landscaping", "landscape", "landscape design"]],
  ["commercial_renovation", ["commercial renovation", "commercial remodel"]],
  ["new_construction", ["new construction", "new build", "custom home"]],
  ["repair_maintenance", ["repair and maintenance", "repair maintenance", "maintenance", "handyman"]],
];

function cleanPhrase(text: string): string {
  return text.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Maps free text (e.g. leads.custom_fields.service) onto a canonical project type; null when it is not an exact known phrase. */
export function classifyProjectTypeFromText(text: unknown): ProjectType | null {
  if (typeof text !== "string") return null;
  const phrase = cleanPhrase(text);
  if (phrase === "" || phrase.length > 80) return null;
  const direct = normalizeProjectType(phrase.replace(/ /g, "_"));
  if (direct) return direct;
  for (const [type, phrases] of PHRASES) if (phrases.includes(phrase)) return type;
  return null;
}
