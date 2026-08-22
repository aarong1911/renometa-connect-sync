// netlify/functions/lib/google-ads-lead-fields.ts
//
// Pure parsing/normalization for Google Ads lead-form submission fields —
// used by google-ads-lead-sync.ts. Kept separate from google-ads-api.ts
// (account/campaign reporting) since this is a distinct resource
// (lead_form_submission_data) with its own field shapes.
//
// Google lead forms can ask different questions per form/asset — never
// assume a fixed field set. Every raw field (standard or custom) is always
// preserved by the caller in raw_fields/raw_custom_fields regardless of
// whether it's individually normalized here (Part B7: "do not discard
// unknown fields").

export interface GoogleAdsLeadFormField {
  fieldType: string | null;
  fieldValue: string | null;
}

export interface GoogleAdsLeadFormCustomField {
  questionText: string | null;
  fieldValue: string | null;
}

export interface NormalizedGoogleAdsLeadFields {
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
}

// Google's REST JSON uses camelCase (fieldType/fieldValue). Safely handles
// a missing/malformed array rather than throwing.
export function parseGoogleAdsLeadFormFields(raw: unknown): GoogleAdsLeadFormField[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((f: any) => ({
    fieldType: typeof f?.fieldType === "string" ? f.fieldType : null,
    fieldValue: typeof f?.fieldValue === "string" ? f.fieldValue : null,
  }));
}

export function parseGoogleAdsLeadFormCustomFields(raw: unknown): GoogleAdsLeadFormCustomField[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((f: any) => ({
    questionText: typeof f?.questionText === "string" ? f.questionText : null,
    fieldValue: typeof f?.fieldValue === "string" ? f.fieldValue : null,
  }));
}

// Standard Google Ads lead-form field types that map onto a normalized
// column this app can actually use for CRM dedupe/creation today. Fields
// like CITY/POSTAL_CODE/COMPANY_NAME/JOB_TITLE are real Google field types
// but have no normalized column yet — they still arrive in raw_fields
// verbatim, just not individually extracted here.
const STANDARD_FIELD_MAP: Partial<Record<string, keyof NormalizedGoogleAdsLeadFields>> = {
  EMAIL: "email",
  PHONE_NUMBER: "phone",
  FIRST_NAME: "firstName",
  LAST_NAME: "lastName",
  FULL_NAME: "fullName",
};

export function normalizeGoogleAdsLeadFields(fields: GoogleAdsLeadFormField[]): NormalizedGoogleAdsLeadFields {
  const result: NormalizedGoogleAdsLeadFields = { email: null, phone: null, firstName: null, lastName: null, fullName: null };

  for (const f of fields) {
    if (!f.fieldType || !f.fieldValue) continue;
    const key = STANDARD_FIELD_MAP[f.fieldType];
    if (!key) continue;
    const value = f.fieldValue.trim();
    if (value.length === 0) continue;
    result[key] = value;
  }

  // Best-effort cross-derivation — never overwrites an explicit value the
  // form itself provided, only fills a gap when the form asked for one
  // shape (full name) but not the other (first/last), or vice versa.
  if (!result.fullName && (result.firstName || result.lastName)) {
    const joined = [result.firstName, result.lastName].filter(Boolean).join(" ").trim();
    result.fullName = joined.length > 0 ? joined : null;
  }
  if (result.fullName && !result.firstName && !result.lastName) {
    const parts = result.fullName.split(/\s+/).filter(Boolean);
    if (parts.length > 1) {
      result.firstName = parts[0];
      result.lastName = parts.slice(1).join(" ");
    } else if (parts.length === 1) {
      result.firstName = parts[0];
    }
  }

  return result;
}

// Lowercased/trimmed — matches the normalization CRM dedupe needs to
// compare reliably. Never mutates the raw stored value elsewhere.
export function normalizeGoogleAdsLeadEmail(email: string | null): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

// Preserves a leading "+" (E.164) if present, strips all other
// non-digit characters. Does not assume a specific country — Google lead
// forms don't guarantee E.164 formatting, so this is a best-effort
// normalization for dedupe matching, not a validator.
export function normalizeGoogleAdsLeadPhone(phone: string | null): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 0) return null;
  return hasPlus ? `+${digits}` : digits;
}

// The marker google-ads-lead-test-inject.ts writes into raw_fields for
// every synthetic dev-fixture submission (Phase 3, Step 6C.1) —
// { fieldType: "__renometa_test_fixture", fieldValue: "true" }. Used by
// the conversion-attribution foundation (Step 7A) to force
// export_status = 'ineligible' for any conversion event resolved from a
// synthetic submission, so a dev test fixture's fake gclid can never
// become exportable. Safe against a malformed/missing raw_fields value —
// returns false rather than throwing.
export function isSyntheticTestGoogleAdsSubmission(rawFields: unknown): boolean {
  if (!Array.isArray(rawFields)) return false;
  return rawFields.some(
    (f: any) => f?.fieldType === "__renometa_test_fixture" && f?.fieldValue === "true",
  );
}
