// netlify/functions/lib/meta-lead-normalization.ts
//
// Pure parsing/normalization for Meta Lead Ads (Instant Forms) field_data —
// used by meta-lead-ads.ts. Kept separate from that orchestration file the
// same way google-ads-lead-fields.ts is kept separate from
// google-ads-lead-sync.ts — a distinct, independently testable concern.
//
// Meta lead forms can ask different questions per form — never assume a
// fixed field set. Every raw field (standard or custom) is always
// preserved by the caller in raw_field_data regardless of whether it's
// individually normalized here (Part J: "do not discard custom questions").

import { formatUsPhone } from "../../../src/lib/phone";

export interface MetaFieldDatum {
  name: string;
  values: string[];
}

// Meta's field_data shape: [{ name, values: [...] }]. Safely handles a
// missing/malformed array rather than throwing.
export function parseMetaFieldData(raw: unknown): MetaFieldDatum[] {
  if (!Array.isArray(raw)) return [];
  const out: MetaFieldDatum[] = [];
  for (const f of raw) {
    if (!f || typeof f.name !== "string" || f.name.length === 0) continue;
    const values = Array.isArray(f.values) ? f.values.filter((v: unknown): v is string => typeof v === "string") : [];
    out.push({ name: f.name, values });
  }
  return out;
}

export interface NormalizedMetaLeadStandardFields {
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  /** Storage-ready DISPLAY format ("(XXX) XXX-XXXX") via formatUsPhone — matches this app's dominant contacts.phone storage convention, NOT E.164. See the Step 1 report for why this deliberately differs from google-ads-lead-fields.ts's own normalizeGoogleAdsLeadPhone. */
  phone: string | null;
  company: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

export interface NormalizedMetaLeadFields {
  standard: NormalizedMetaLeadStandardFields;
  /** Every field_data entry NOT recognized as a standard field, keyed by Meta's own field name, values preserved as arrays (never lossily joined). */
  customFields: Record<string, string[]>;
}

type StandardKey = keyof NormalizedMetaLeadStandardFields;

// Common Instant Forms question-key aliases (Part J: "do not overfit" —
// this is deliberately not exhaustive). Any field_data entry whose name
// doesn't match one of these is preserved verbatim in customFields, never
// discarded.
const STANDARD_FIELD_ALIASES: Record<string, StandardKey> = {
  full_name: "fullName",
  first_name: "firstName",
  last_name: "lastName",
  email: "email",
  phone_number: "phone",
  phone: "phone",
  company_name: "company",
  city: "city",
  state: "state",
  zip_code: "zip",
  postal_code: "zip",
};

export function normalizeMetaLeadFields(fields: MetaFieldDatum[]): NormalizedMetaLeadFields {
  const standard: NormalizedMetaLeadStandardFields = {
    fullName: null, firstName: null, lastName: null, email: null, phone: null, company: null, city: null, state: null, zip: null,
  };
  const customFields: Record<string, string[]> = {};

  for (const f of fields) {
    const key = STANDARD_FIELD_ALIASES[f.name.toLowerCase()];
    if (!key) {
      // Multi-value fields (e.g. a checkbox question with several selected
      // options) are preserved as arrays — never joined lossily.
      customFields[f.name] = f.values;
      continue;
    }
    const value = f.values[0]?.trim();
    if (!value) continue;

    if (key === "email") {
      standard.email = value.toLowerCase();
    } else if (key === "phone") {
      standard.phone = formatUsPhone(value);
    } else {
      standard[key] = value;
    }
  }

  // Best-effort cross-derivation — never overwrites an explicit value the
  // form itself provided, only fills a gap (mirrors
  // normalizeGoogleAdsLeadFields' identical convention).
  if (!standard.fullName && (standard.firstName || standard.lastName)) {
    const joined = [standard.firstName, standard.lastName].filter(Boolean).join(" ").trim();
    standard.fullName = joined.length > 0 ? joined : null;
  }
  if (standard.fullName && !standard.firstName && !standard.lastName) {
    const parts = standard.fullName.split(/\s+/).filter(Boolean);
    if (parts.length > 1) {
      standard.firstName = parts[0];
      standard.lastName = parts.slice(1).join(" ");
    } else if (parts.length === 1) {
      standard.firstName = parts[0];
    }
  }

  return { standard, customFields };
}

// ── Phone comparison helpers (mirrored from src/lib/identity-normalization.ts)
// ─────────────────────────────────────────────────────────────────────────
// Duplicated rather than imported: that file pulls in the browser Supabase
// client (@/lib/supabase) via the `@/` path alias, which does not resolve
// inside the Netlify Functions esbuild bundle — confirmed by inspecting
// every existing netlify/functions cross-import of src/lib/*, all of which
// use a relative path, never the @/ alias, and none of which pull in a
// module that itself imports @/lib/supabase. These two functions are pure
// (no imports of their own in the source file) and are mirrored here
// verbatim from that file's own documented Phase 9 audit findings: this
// codebase does not store phone numbers in one consistent format
// (formatUsPhone's "(XXX) XXX-XXXX" for manual/CSV contact creation vs.
// meta-webhook.ts's own E.164 "+1XXXXXXXXXX" for WhatsApp-created
// contacts) — a single-format exact-match query would silently miss real
// existing contacts. Keep in sync manually if
// src/lib/identity-normalization.ts's algorithm ever changes.

/**
 * Comparison-safe (NOT storage) phone normalization: strips all formatting
 * characters and, for an 11-digit number beginning with the US/Canada
 * country code "1", drops that leading digit. NOT full E.164 validation —
 * a genuinely different country's number that happens to be 11 digits and
 * starts with "1" would be mis-trimmed by this heuristic (documented known
 * limit in the source, not fixed here).
 */
export function normalizePhoneForComparison(raw: string | null | undefined): string {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

/**
 * Generates the small, bounded set of concrete stored-string variants a
 * 10-digit US number could plausibly appear as in this database today, so
 * a single indexed `.in("phone", ...)` query can catch every known real
 * stored format. A phone stored in some other exotic format is a known,
 * documented gap — not silently "fixed" with a full table scan.
 */
export function phoneStorageVariants(normalized: string): string[] {
  if (!normalized) return [];
  const variants = new Set<string>([normalized]);
  if (normalized.length === 10) {
    const p1 = normalized.slice(0, 3);
    const p2 = normalized.slice(3, 6);
    const p3 = normalized.slice(6, 10);
    variants.add(`(${p1}) ${p2}-${p3}`); // formatUsPhone() output
    variants.add(`+1${normalized}`); // E.164 (meta-webhook.ts WhatsApp contacts)
    variants.add(`1${normalized}`);
  }
  return [...variants];
}

// A short, factual, non-fabricated note distinguishing one Meta Ads lead
// from another for the SAME contact — mirrors
// google-ads-lead-ingestion.ts's buildGoogleAdsLeadNote exactly. Uses ONLY
// real, already-attributed data — never a fabricated service/project-type
// guess.
export function buildMetaLeadNote(campaignName: string | null): string {
  return campaignName ? `Meta Ads lead — Campaign: ${campaignName}` : "Meta Ads lead";
}
