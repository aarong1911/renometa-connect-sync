// src/lib/phone.ts
//
// Shared US phone-number formatting/normalization — the one place phone
// digit-parsing lives, so Calendar/Appointments and every other consumer
// format identically instead of hand-rolling a regex each.
//
// Storage convention: this project stores phone numbers as the FORMATTED
// display string "(XXX) XXX-XXXX" directly in the database (confirmed live
// in contacts.phone, and in new-contact-dialog.tsx which saves
// formatPhone()'s output as-is) — not digits-only, not E.164. formatUsPhone
// is written to be safe to store directly, matching that existing
// convention, rather than introducing a second incompatible format.

/**
 * Strips everything but digits, and drops a leading US country code ("1")
 * when the result would otherwise be 11 digits — so "14344444334" and
 * "+14344444334" both normalize to the same 10 digits as "4344444334".
 * Never throws on null/undefined.
 */
export function normalizePhone(value: string | null | undefined): string {
  if (!value) return "";
  let digits = value.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits;
}

/**
 * Formats a US phone number as (XXX) XXX-XXXX — safe to call progressively
 * while typing (partial input formats without corrupting what's typed so
 * far) and identically for a complete/already-formatted stored value
 * (idempotent — re-formatting "(434) 444-4334" returns the same string).
 * Handles a leading "1" or "+1" country code. A number that is clearly not
 * a 10-digit US number (more than 10 digits after stripping any leading US
 * country code) is returned as a readable digit-only fallback rather than
 * mangled into an incorrect US-shaped string. Never throws on null/undefined.
 */
export function formatUsPhone(value: string | null | undefined): string {
  if (!value) return "";
  const raw = value.replace(/\D/g, "");
  const digits = raw.length === 11 && raw.startsWith("1") ? raw.slice(1) : raw;

  if (digits.length === 0) return "";
  if (digits.length > 10) return raw; // clearly non-US — safe readable fallback, not mangled

  const p1 = digits.slice(0, 3);
  const p2 = digits.slice(3, 6);
  const p3 = digits.slice(6, 10);
  if (digits.length <= 3) return `(${p1}`;
  if (digits.length <= 6) return `(${p1}) ${p2}`;
  return `(${p1}) ${p2}-${p3}`;
}

/** E.164 form ("+14344444334") for a complete 10-digit US number, or null if the input isn't a complete 10-digit US number. Not used for storage (see header) — available for any integration (e.g. Twilio) that needs it. */
export function toE164UsPhone(value: string | null | undefined): string | null {
  const digits = normalizePhone(value);
  if (digits.length !== 10) return null;
  return `+1${digits}`;
}
