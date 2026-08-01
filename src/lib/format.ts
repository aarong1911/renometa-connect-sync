// SSR-safe formatters (UTC, en-US) to avoid hydration mismatches.
const dateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const dateShortFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const moneyFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** True for a value `new Date()` can actually format — rejects null/undefined/""/"Invalid Date"/malformed strings without throwing. Empty string is the case that bit us: `row.field ?? ""` mappers turn a null DB column into `""`, and `new Date("")` is an Invalid Date (unlike `new Date(null)`, which is the 1970 epoch) — Intl.DateTimeFormat.format() on an Invalid Date throws RangeError: Invalid time value. */
function isFormattableDate(value: unknown): value is string | Date {
  if (value === null || value === undefined || value === "") return false;
  const date = value instanceof Date ? value : new Date(value as string);
  return !Number.isNaN(date.getTime());
}

export function formatDate(iso: string | Date | null | undefined, fallback = "No date") {
  if (!isFormattableDate(iso)) return fallback;
  return dateFmt.format(iso instanceof Date ? iso : new Date(iso));
}
export function formatDateShort(iso: string | Date | null | undefined, fallback = "No date") {
  if (!isFormattableDate(iso)) return fallback;
  return dateShortFmt.format(iso instanceof Date ? iso : new Date(iso));
}
export function formatMoney(n: number) {
  return moneyFmt.format(n);
}

const NOW_UTC = Date.UTC(2026, 3, 18);
export function daysFromNow(iso: string) {
  return Math.round((new Date(iso).getTime() - NOW_UTC) / 86_400_000);
}

/**
 * Format a US phone number as (XXX) XXX-XXXX as the user types.
 * Re-exports src/lib/phone.ts's formatUsPhone — the single shared
 * implementation (also handles a leading "1"/"+1" country code, which this
 * export previously did not) — kept here so existing imports of
 * `formatPhone` from this module keep working unchanged.
 */
export { formatUsPhone as formatPhone } from "@/lib/phone";
