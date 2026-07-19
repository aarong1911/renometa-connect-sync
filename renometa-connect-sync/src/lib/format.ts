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

export function formatDate(iso: string) {
  return dateFmt.format(new Date(iso));
}
export function formatDateShort(iso: string) {
  return dateShortFmt.format(new Date(iso));
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
 * Strips non-digits, caps at 10 digits, and progressively formats.
 */
export function formatPhone(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 10);
  const p1 = digits.slice(0, 3);
  const p2 = digits.slice(3, 6);
  const p3 = digits.slice(6, 10);
  if (digits.length === 0) return "";
  if (digits.length <= 3) return `(${p1}`;
  if (digits.length <= 6) return `(${p1}) ${p2}`;
  return `(${p1}) ${p2}-${p3}`;
}
