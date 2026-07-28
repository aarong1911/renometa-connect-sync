// src/lib/lead-source.ts
//
// Shared display-label helper for `leads.source` — a free-text column
// (no CHECK constraint, confirmed in the Phase 9 audit) that different
// ingestion paths write in different casings/spellings today ("Website",
// "manual", "Gmail", etc). This does NOT rewrite any stored value — it
// only maps a raw value to a readable label for display, and unknown
// values still render (Title Cased) rather than being hidden or
// misrepresented. The raw value remains available for filtering.

const KNOWN_SOURCE_LABELS: Record<string, string> = {
  website: "Website",
  manual: "Manual",
  referral: "Referral",
  gmail: "Gmail",
  whatsapp: "WhatsApp",
  messenger: "Messenger",
  instagram: "Instagram",
  voice_ai: "Voice AI",
  "voice ai": "Voice AI",
  meta_lead_ads: "Meta Lead Ads",
  "meta lead ads": "Meta Lead Ads",
  import: "Import",
  angi: "Angi",
  thumbtack: "Thumbtack",
  "google ads": "Google Ads",
  "walk-in": "Walk-in",
  "social media": "Social Media",
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
