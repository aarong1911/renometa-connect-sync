// src/lib/tag-utils.ts
//
// Shared normalization for contacts.labels (text[]) — Phase 9.3, extended
// to fix duplicate filter chips caused by case/separator variants (e.g.
// "lead"/"Lead", "vip"/"VIP", "new_lead"/"New Lead" all being treated as
// three distinct tags instead of one). No tag-table/color architecture is
// introduced here, per Priority 4 — this only cleans up what's already a
// plain string array.
//
// Two distinct concepts, used consistently everywhere tags are touched:
//   - comparison key  (tagComparisonKey)  — what makes two tags "the same"
//   - display label   (tagDisplayLabel /
//                       buildCanonicalTagOptions) — what to actually show

// THE canonical Contact tag catalog — moved here from contacts.tsx (Conversations
// Cleanup audit) after finding Conversations (src/routes/inbox.tsx) had grown
// its own, second, hardcoded default tag list ("managedTags") that had
// silently diverged: it included "Estimate Sent"/"Hot" (never part of this
// list, never recognized by Contacts) and was missing Architect/Client/
// Homeowner/Lead/Past Client/Prospect/Vendor entirely — so Conversations'
// "Assign tags" picker could invent tags Contacts doesn't know about while
// omitting real canonical ones. Both pages must import THIS single array
// rather than keep their own copy, or they will drift apart again.
export const CANONICAL_CONTACT_TAGS = [
  "Architect",
  "Client",
  "Follow Up",
  "Homeowner",
  "Lead",
  "Needs Reply",
  "New Lead",
  "Past Client",
  "Prospect",
  "Vendor",
  "VIP",
] as const;

/**
 * Canonical comparison keys (see tagComparisonKey) for tags that represent a
 * DERIVED CRM relationship — the Contact's connection to a real Lead
 * opportunity record — NOT a manually-assignable Contact label.
 *
 * They stay in CANONICAL_CONTACT_TAGS so legacy rows that already carry a
 * literal "Lead"/"New Lead" label still normalise, dedupe, colour, and
 * FILTER correctly (and so those historical labels are never destructively
 * removed). But `isManuallyAssignableTag()` excludes them from every
 * manual tag PICKER: a person is a Lead because a Lead record links to
 * them (leads.contact_id), not because someone typed "Lead" as a tag —
 * see contacts.tsx's derived Lead badge and inbox's useLeads()-derived
 * indicator. Removing them from the pickers is what stops the
 * "manually adding a Lead tag looks like it should create a Lead" model
 * confusion found in S3 live testing.
 */
export const DERIVED_RELATIONSHIP_TAG_KEYS: ReadonlySet<string> = new Set(["lead", "new lead"]);

/** False for derived-relationship tags ("Lead"/"New Lead") — those are shown automatically from real Lead records and must never appear as a manual pick option. */
export function isManuallyAssignableTag(key: string): boolean {
  return !DERIVED_RELATIONSHIP_TAG_KEYS.has(key);
}

/**
 * Canonical comparison key: trims whitespace, lowercases, treats
 * underscores/hyphens as spaces, and collapses repeated whitespace. Two
 * tags with the same key are considered the same tag everywhere in this
 * app (filtering, dedup on write, duplicate-chip collapsing).
 *
 * "VIP" / "vip" / " Vip "        → "vip"
 * "New Lead" / "new_lead" / "new-lead" → "new lead"
 */
export function tagComparisonKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "new_lead" → "New Lead", "follow-up" → "Follow Up", "vip" → "Vip". Single-value fallback formatter — has no other variant to compare against, so it can't know "vip" should render as the all-caps acronym "VIP"; that preference only happens in buildCanonicalTagOptions()/normalizeTags(), which see every real stored variant and can prefer an already-well-cased one. */
export function tagDisplayLabel(value: string): string {
  const spaced = value.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!spaced) return "";
  return spaced
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** True if a raw tag value already looks like a deliberately-cased, human-readable label — no underscore/hyphen separators, and at least one uppercase letter (so "VIP", "New Lead", "Lead" all qualify; "vip", "new_lead", "lead" don't). */
function looksAlreadyReadable(value: string): boolean {
  return !/[_-]/.test(value) && /[A-Z]/.test(value);
}

/**
 * Picks one display label to represent a group of raw tag variants that
 * all share the same comparison key. Prefers an existing variant that
 * already looks readable (see looksAlreadyReadable) — e.g. given
 * ["vip", "VIP"], picks the real "VIP" rather than synthesizing "Vip".
 * Only falls back to synthesizing via tagDisplayLabel() when none of the
 * real variants look readable on their own.
 */
function pickDisplayLabel(variants: string[]): string {
  const trimmed = variants.map((v) => v.trim()).filter(Boolean);
  if (trimmed.length === 0) return "";
  const readable = trimmed.find(looksAlreadyReadable);
  if (readable) return readable;
  return tagDisplayLabel(trimmed[0]);
}

/**
 * Normalizes a raw tag list for WRITING: trims, drops empties, and
 * de-duplicates by tagComparisonKey (so "vip" and "VIP" in the same list
 * collapse into one entry) — picking the best-looking real variant among
 * the duplicates as the stored casing, via the same preference rule
 * buildCanonicalTagOptions() uses for filter-chip labels, so a tag typed
 * once keeps a sensible display casing rather than always being forced to
 * whichever variant happened to appear first.
 */
export function normalizeTags(rawTags: string[]): string[] {
  const groups = new Map<string, string[]>();
  const order: string[] = [];
  for (const raw of rawTags) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = tagComparisonKey(trimmed);
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key)!.push(trimmed);
  }
  return order.map((key) => pickDisplayLabel(groups.get(key)!));
}

/** Splits a comma/semicolon-delimited string into normalized tags — used by the inline tag editor's "add" input. */
export function parseTagInput(raw: string): string[] {
  return normalizeTags(raw.split(/[,;]+/));
}

export type CanonicalTagOption = { key: string; label: string };

/**
 * Builds the deduplicated set of tag filter options across every loaded
 * contact's real `tags` — one chip per canonical comparison key, labeled
 * with the best-looking real variant seen anywhere in the data (see
 * pickDisplayLabel). Sorted alphabetically by label for a stable, readable
 * chip row.
 */
export function buildCanonicalTagOptions(contacts: { tags: string[] }[]): CanonicalTagOption[] {
  const groups = new Map<string, string[]>();
  for (const c of contacts) {
    for (const raw of c.tags) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const key = tagComparisonKey(trimmed);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(trimmed);
    }
  }
  return [...groups.entries()]
    .map(([key, variants]) => ({ key, label: pickDisplayLabel(variants) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * True if any of a contact's raw labels matches the given canonical key
 * (as produced by tagComparisonKey/buildCanonicalTagOptions) — the filter-
 * matching counterpart to buildCanonicalTagOptions's chip generation.
 * Never a direct case-sensitive `.includes()` check.
 */
export function contactHasCanonicalTag(labels: string[], selectedKey: string): boolean {
  return labels.some((t) => tagComparisonKey(t) === selectedKey);
}

// ── Deterministic tag chip colors ────────────────────────────────────────
//
// Redesigned palette (tag-color follow-up pass) — the original 12-entry
// hash palette clustered visually (multiple near-identical greens/blues,
// red/pink over-represented). This is a deliberately curated 10-family
// palette, ORDERED so that consecutive entries alternate warm/cool hues —
// combined with assignTagColors() below assigning colors by sorted
// position rather than raw hash, two tags that render next to each other
// (alphabetically, as the filter row and buildCanonicalTagOptions already
// sort) are guaranteed to land on different, visually-distant palette
// entries instead of risking two similar hues next to each other purely by
// hash coincidence. No black, no beige; readable in both light and dark
// mode.
const TAG_COLOR_PALETTE = [
  { name: "blue", bg: "bg-blue-100", text: "text-blue-700", border: "border-blue-200", dot: "bg-blue-500", dark: "dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-800/60" },
  { name: "amber", bg: "bg-amber-100", text: "text-amber-800", border: "border-amber-200", dot: "bg-amber-500", dark: "dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-800/60" },
  { name: "violet", bg: "bg-violet-100", text: "text-violet-700", border: "border-violet-200", dot: "bg-violet-500", dark: "dark:bg-violet-500/15 dark:text-violet-300 dark:border-violet-800/60" },
  { name: "emerald", bg: "bg-emerald-100", text: "text-emerald-700", border: "border-emerald-200", dot: "bg-emerald-500", dark: "dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-800/60" },
  { name: "rose", bg: "bg-rose-100", text: "text-rose-700", border: "border-rose-200", dot: "bg-rose-500", dark: "dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-800/60" },
  { name: "cyan", bg: "bg-cyan-100", text: "text-cyan-700", border: "border-cyan-200", dot: "bg-cyan-500", dark: "dark:bg-cyan-500/15 dark:text-cyan-300 dark:border-cyan-800/60" },
  { name: "orange", bg: "bg-orange-100", text: "text-orange-700", border: "border-orange-200", dot: "bg-orange-500", dark: "dark:bg-orange-500/15 dark:text-orange-300 dark:border-orange-800/60" },
  { name: "indigo", bg: "bg-indigo-100", text: "text-indigo-700", border: "border-indigo-200", dot: "bg-indigo-500", dark: "dark:bg-indigo-500/15 dark:text-indigo-300 dark:border-indigo-800/60" },
  { name: "teal", bg: "bg-teal-100", text: "text-teal-700", border: "border-teal-200", dot: "bg-teal-500", dark: "dark:bg-teal-500/15 dark:text-teal-300 dark:border-teal-800/60" },
  { name: "slate", bg: "bg-slate-200", text: "text-slate-700", border: "border-slate-300", dot: "bg-slate-500", dark: "dark:bg-slate-500/20 dark:text-slate-300 dark:border-slate-700/60" },
] as const;

function hashTagKey(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export type TagColorClasses = { chip: string; selectedChip: string; dot: string };

function classesFromPaletteEntry(c: (typeof TAG_COLOR_PALETTE)[number]): TagColorClasses {
  const base = `${c.bg} ${c.text} ${c.dark} border ${c.border}`;
  return {
    chip: base,
    selectedChip: `${base} ring-2 ring-offset-1 ring-current`,
    dot: c.dot,
  };
}

/**
 * Deterministic color classes for a SINGLE tag, keyed by its canonical
 * comparison key (tagComparisonKey) — a hash-based fallback for contexts
 * that don't have the full set of currently-visible tags on hand (so
 * can't use assignTagColors' better sorted-position distribution). Prefer
 * assignTagColors() whenever rendering a list of tags together.
 */
export function tagColorClasses(tagKey: string): TagColorClasses {
  return classesFromPaletteEntry(TAG_COLOR_PALETTE[hashTagKey(tagKey) % TAG_COLOR_PALETTE.length]);
}

/**
 * Assigns colors across a whole list of canonical tag keys at once, by
 * SORTED POSITION in the palette rather than per-key hash — this is what
 * prevents the "adjacent chips look the same" problem a pure hash can
 * produce (two unrelated keys hashing to neighboring or identical palette
 * slots). Keys are sorted first so the assignment is stable regardless of
 * the order the caller happened to build its list in; the same canonical
 * key always gets the same color for a given organization's tag universe,
 * and stays stable across renders/reloads as long as the same set of tags
 * exists. Use this for the filter row, table, and drawer — anywhere more
 * than one tag renders together — and fall back to tagColorClasses() only
 * for a single tag in isolation.
 */
export function assignTagColors(tagKeys: string[]): Map<string, TagColorClasses> {
  const uniqueSorted = [...new Set(tagKeys)].sort((a, b) => a.localeCompare(b));
  const map = new Map<string, TagColorClasses>();
  uniqueSorted.forEach((key, i) => {
    map.set(key, classesFromPaletteEntry(TAG_COLOR_PALETTE[i % TAG_COLOR_PALETTE.length]));
  });
  return map;
}
