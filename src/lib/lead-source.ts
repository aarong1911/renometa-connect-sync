// src/lib/lead-source.ts
//
// Shared display-label helper for `leads.source` — a free-text column
// (no CHECK constraint, confirmed in the Phase 9 audit) that different
// ingestion paths write in different casings/spellings today ("Website",
// "manual", "Gmail", etc). This does NOT rewrite any stored value — it
// only maps a raw value to a readable label for display, and unknown
// values still render (Title Cased) rather than being hidden or
// misrepresented. The raw value remains available for filtering.
//
// Lead Source Catalog Refinement pass: RenoMeta's built-in, selectable
// Lead sources are now exactly the 9 values in CanonicalLeadSource below
// (Google Ads, Meta Ads, Google Local Services Ads, Website Form,
// Chatbot, Voice AI, Phone Call, SMS, Email). Historical/legacy values
// (advertising, cold_call, referral, angi, thumbtack, walk_in,
// social_media, gmail, etc.) are NOT offered as new Add/Edit Lead
// choices, but remain fully readable — never deleted, corrupted, or
// hidden — via this same label map and the Leads filter's
// existing-values-only behavior (routes/leads.tsx).

const KNOWN_SOURCE_LABELS: Record<string, string> = {
  // ── The 9 canonical built-in sources ──────────────────────────────────
  // "website"/"website form" are legacy/alternate spellings of the same
  // renamed source — Website was renamed to Website Form in this pass, so
  // every spelling now labels the same way.
  website: "Website Form",
  "website form": "Website Form",
  website_form: "Website Form",
  "google ads": "Google Ads",
  google_ads: "Google Ads",
  "meta ads": "Meta Ads",
  meta_ads: "Meta Ads",
  "google local services ads": "Google Local Services Ads",
  "google lsa": "Google Local Services Ads",
  google_lsa: "Google Local Services Ads",
  chatbot: "Chatbot",
  voice_ai: "Voice AI",
  "voice ai": "Voice AI",
  "phone call": "Phone Call",
  phone_call: "Phone Call",
  sms: "SMS",
  email: "Email",

  // ── Legacy/historical values — no longer offered as built-in Add/Edit
  // Lead choices, but real historical rows may still carry them. Kept
  // readable/labeled, never hidden or corrupted (Step 6).
  manual: "Manual",
  gmail: "Gmail",
  whatsapp: "WhatsApp",
  messenger: "Messenger",
  instagram: "Instagram",
  meta_lead_ads: "Meta Lead Ads",
  "meta lead ads": "Meta Lead Ads",
  import: "Import",
  angi: "Angi",
  thumbtack: "Thumbtack",
  "walk-in": "Walk-in",
  walk_in: "Walk-in",
  "social media": "Social Media",
  social_media: "Social Media",
  cold_call: "Cold Call",
  advertising: "Advertising",
  referral: "Referral",
};

function titleCase(value: string): string {
  return value
    .trim()
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** Display label for a raw `leads.source` value. Known aliases get a canonical label; anything else is shown Title-Cased as-is rather than fabricated or hidden. */
export function leadSourceLabel(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "Unknown";
  const known = KNOWN_SOURCE_LABELS[trimmed.toLowerCase()];
  return known ?? titleCase(trimmed);
}

/**
 * Same function as leadSourceLabel(), exported under the name requested by
 * the lead-source normalization task — kept as an alias rather than a
 * second implementation so the two names can never drift.
 */
export const formatLeadSource = leadSourceLabel;

// ── Canonical machine values (Lead Source Catalog Refinement) ──────────
//
// public.leads.source remains free text with no CHECK constraint. This
// type is the exhaustive, intentionally SMALL set of built-in sources
// RenoMeta exposes in the Add/Edit Lead UI today — not an enforced DB
// constraint. Historical values outside this set (advertising, cold_call,
// referral, angi, thumbtack, walk_in, social_media, gmail, etc.) are
// real, valid, already-stored data — see KNOWN_SOURCE_LABELS above for
// how they're still displayed, and routes/leads.tsx for how the Leads
// filter still surfaces them when leads actually use them.
export type CanonicalLeadSource =
  | "google_ads"
  | "meta_ads"
  | "google_lsa"
  | "website_form"
  | "chatbot"
  | "voice_ai"
  | "phone_call"
  | "sms"
  | "email"
  | "messenger";

export const LEAD_SOURCE_LABELS: Record<CanonicalLeadSource, string> = {
  google_ads: "Google Ads",
  meta_ads: "Meta Ads",
  google_lsa: "Google Local Services Ads",
  website_form: "Website Form",
  chatbot: "Chatbot",
  voice_ai: "Voice AI",
  phone_call: "Phone Call",
  sms: "SMS",
  email: "Email",
  // Messenger Attribution + Avatar Consistency Cleanup — added as the 10th
  // built-in source now that Facebook Messenger creates real Leads
  // (source = "messenger", already the exact stored value — see
  // lib/meta-messenger-crm.ts). Appended last (after the 9 pre-existing
  // built-ins) so it renders at the end of the "Owned" channel group in the
  // Leads source filter without disturbing that group's existing order.
  messenger: "Messenger",
};

// Single ordered source-options export (Lead Source Filter Enhancement) —
// derived directly from LEAD_SOURCE_LABELS above rather than hand-written
// as a second array, so the two can never drift out of order/sync. Relies
// on string-keyed object property insertion order (guaranteed by the JS
// spec for non-integer-like keys, which every CanonicalLeadSource key is).
// This is Paid (Google Ads, Meta Ads, Google Local Services Ads) followed
// by Owned channels (Website Form, Chatbot, Voice AI, Phone Call, SMS,
// Email) — RenoMeta's product-model order, not alphabetical. Both the Add/
// Edit Lead source selector and the Leads source filter (routes/leads.tsx)
// reuse this one export rather than keeping parallel arrays.
export const CANONICAL_LEAD_SOURCE_OPTIONS: { value: CanonicalLeadSource; label: string }[] =
  (Object.keys(LEAD_SOURCE_LABELS) as CanonicalLeadSource[]).map((value) => ({
    value,
    label: LEAD_SOURCE_LABELS[value],
  }));

// Every currently-recognized spelling/casing variant mapped to its one
// canonical machine value. Keys are lowercase — lookups always lowercase
// the trimmed input first. Includes the 9 canonical built-ins PLUS the
// legacy built-ins from before this refinement pass (angi/thumbtack/
// walk_in/social_media/cold_call/referral/advertising) so any casing
// variant of THOSE historical values still normalizes consistently too —
// they are simply no longer offered as new Add/Edit Lead choices (see
// ADD_LEAD_SOURCE_OPTIONS in routes/leads.tsx).
const LEAD_SOURCE_CANONICAL_ALIASES: Record<string, string> = {
  // Google Ads
  "google ads": "google_ads",
  google_ads: "google_ads",
  // Meta Ads
  "meta ads": "meta_ads",
  meta_ads: "meta_ads",
  // Google Local Services Ads
  "google local services ads": "google_lsa",
  "google lsa": "google_lsa",
  google_lsa: "google_lsa",
  // Website Form — renamed from "Website" in this pass; every prior
  // spelling of the old source now normalizes to the new canonical value.
  website: "website_form",
  "website form": "website_form",
  website_form: "website_form",
  // Chatbot
  chatbot: "chatbot",
  // Voice AI
  "voice ai": "voice_ai",
  voice_ai: "voice_ai",
  // Phone Call
  "phone call": "phone_call",
  phone_call: "phone_call",
  // SMS
  sms: "sms",
  // Email
  email: "email",
  // Messenger
  messenger: "messenger",
  // Legacy built-ins (pre-refinement) — retained only for historical-data
  // casing consistency, never offered as new choices.
  "cold call": "cold_call",
  "cold-call": "cold_call",
  cold_call: "cold_call",
  referral: "referral",
  advertising: "advertising",
  angi: "angi",
  thumbtack: "thumbtack",
  "walk-in": "walk_in",
  walk_in: "walk_in",
  "social media": "social_media",
  social_media: "social_media",
};

/**
 * Normalizes a raw `leads.source` value to its canonical machine form —
 * e.g. "Google Ads" / "google ads" / "google_ads" -> "google_ads", and
 * (Lead Source Catalog Refinement) "Website" / "website" / "website form"
 * / "Website Form" / "website_form" -> "website_form". Trims whitespace,
 * then looks up the trimmed-lowercased value in the known alias table. An
 * unrecognized value is NEVER remapped to an unrelated known source —
 * it's returned trimmed but otherwise untouched, so a genuine custom or
 * historical source (e.g. "Yelp", "advertising") is preserved exactly
 * rather than being silently coerced into one of the 9 built-ins. Returns
 * an empty string for null/undefined/blank input — callers apply their
 * own fallback default (e.g. `normalizeLeadSource(x) || "website_form"`).
 */
export function normalizeLeadSource(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return trimmed;
  return LEAD_SOURCE_CANONICAL_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

/**
 * Canonical grouping key for a raw leads.source value — mirrors
 * contactSourceComparisonKey() below. Two raw values that resolve to the
 * same display label (e.g. "Website" / "website form" / "website_form")
 * share the same key, so the Leads source filter can dedupe its dropdown
 * options by this key instead of by raw string and never show the same
 * label twice.
 */
export function leadSourceComparisonKey(raw: string | null | undefined): string {
  return leadSourceLabel(raw).toLowerCase();
}

// ── Contacts source labels (Contacts UX pass) ───────────────────────────
//
// A separate small helper rather than widening leadSourceLabel() itself —
// `contacts.source` has its own set of raw values (advertising/cold_call/
// vendor/voice_agent/meta_lead_ads/etc, some overlapping with leads.source,
// some not) and leadSourceLabel() is already relied on by the Leads page
// and CSV export/import (Stage 9.5) — changing its alias table risks
// altering Lead-side display text that's already shipped and working.
const CONTACT_SOURCE_LABELS: Record<string, string> = {
  ...KNOWN_SOURCE_LABELS,
  // The Lead Source Catalog Refinement renamed leads' "website" label to
  // "Website Form" (see KNOWN_SOURCE_LABELS above) — contacts.source is a
  // separate entity/table and explicitly keeps its own original "Website"
  // label here, unaffected by that Lead-only rename (task scope: "Only
  // Lead-source labels").
  website: "Website",
  advertising: "Marketing",
  marketing: "Marketing",
  cold_call: "Cold Call",
  "cold-call": "Cold Call",
  "cold call": "Cold Call",
  vendor: "Vendor",
  voice_agent: "Voice Agent",
  "voice-agent": "Voice Agent",
  "voice agent": "Voice Agent",
  facebook_ad: "Facebook Ad",
  google_ads: "Google Ads",
};

/** Display label for a raw `contacts.source` value — same never-rewrite-the-stored-value contract as leadSourceLabel(), with contacts' own alias set. */
export function contactSourceLabel(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "Unknown";
  const known = CONTACT_SOURCE_LABELS[trimmed.toLowerCase()];
  return known ?? titleCase(trimmed);
}

/**
 * Canonical grouping key for a raw contact source value — two raw values
 * that resolve to the same display label (e.g. "advertising"/"marketing",
 * "cold_call"/"cold-call") share the same key, so a single dropdown option
 * can match every equivalent stored variant instead of listing duplicates.
 */
export function contactSourceComparisonKey(raw: string | null | undefined): string {
  return contactSourceLabel(raw).toLowerCase();
}
