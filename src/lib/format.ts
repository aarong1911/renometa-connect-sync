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

// ── DATE-ONLY business dates (Phase 13.4 follow-up) ─────────────────────
//
// formatDate/formatDateShort above are for real timestamps (created_at,
// updated_at, activity/event times) — they intentionally render in UTC so
// server and client agree (see the SSR comment at the top of this file),
// which means the moment shown genuinely shifts with the viewer's/server's
// clock the way a real timestamp should.
//
// invoice issue_date/due_date, a manually recorded payment's business
// date, estimate/contract dates, and any other YYYY-MM-DD SQL `date`
// column are a different concept entirely: a calendar date with no time
// component. `new Date("2026-09-06").toLocaleDateString()` parses that as
// UTC midnight and then renders it in the *viewer's local* timezone —
// in any timezone west of UTC (e.g. EDT, UTC-4) that rolls back to the
// previous calendar day (Sep 5), which is the exact bug this fixes.
//
// formatDateOnly/formatDateOnlyShort below read only the leading
// YYYY-MM-DD of whatever string they're given — for a pure date-only
// column that's the whole value; for a timestamptz column being treated
// as a business date (invoice_payments.paid_at, recorded from a plain
// <input type="date">) it's that value's calendar-date portion, and any
// time-of-day/offset is deliberately ignored. The same calendar date
// renders identically no matter the viewer's timezone.
function parseDateOnly(value: string | null | undefined): { year: number; month: number; day: number } | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/** A local-midnight Date for a DATE-ONLY value's calendar day — safe to compare against other local Dates (bucket boundaries, `new Date()`) without any UTC/local shift. This is NOT a real instant; never use it for a genuine timestamp. */
export function dateOnlyToLocalDate(value: string | null | undefined): Date | null {
  const parts = parseDateOnly(value);
  if (!parts) return null;
  return new Date(parts.year, parts.month - 1, parts.day);
}

const dateOnlyFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const dateOnlyShortFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

export function formatDateOnly(value: string | null | undefined, fallback = "No date"): string {
  const d = dateOnlyToLocalDate(value);
  if (!d) return fallback;
  return dateOnlyFmt.format(d);
}
export function formatDateOnlyShort(value: string | null | undefined, fallback = "No date"): string {
  const d = dateOnlyToLocalDate(value);
  if (!d) return fallback;
  return dateOnlyShortFmt.format(d);
}

/**
 * Today's date as a YYYY-MM-DD value suitable for a plain
 * `<input type="date">` default — built from the viewer's LOCAL calendar
 * components. `new Date().toISOString().split("T")[0]` (seen elsewhere in
 * this codebase) instead reads the UTC calendar date, which is a day
 * ahead of local "today" for part of the evening in any negative-UTC-
 * offset timezone (e.g. after 8pm EDT) — a date-only input should never
 * default to tomorrow.
 */
export function todayDateOnlyValue(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Compact currency for KPI tiles ($22.1k, $1.4m) — falls back to full formatMoney below $1,000 so small/zero amounts never render as "$0.0k". */
export function formatCompactMoney(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${value < 0 ? "-" : ""}$${(abs / 1_000_000).toFixed(1)}m`;
  if (abs >= 1_000) return `${value < 0 ? "-" : ""}$${(abs / 1_000).toFixed(abs >= 100_000 ? 0 : 1)}k`;
  return formatMoney(value);
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
