// netlify/functions/lib/ai/scheduling-date-intent.ts
//
// LIVE BUG FIX: a real production-preview Scheduling turn proved the
// model cannot be trusted to convert natural-language weekday intent
// into an authoritative calendar date. Organization timezone was
// America/New_York, the real business-local date was Saturday 2026-10-11,
// and the customer said "Thursday afternoon" — the correct upcoming
// Thursday is 2026-10-15, but the decision model's own calendar
// arithmetic produced 2026-10-16 (a Friday). get_availability itself,
// and the slot-ranking logic, were both correct given the date they were
// handed — the defect was letting the model perform calendar arithmetic
// at all.
//
// THE FIX: the model may only express a structured, semantic DATE INTENT
// (see DateIntent below) — never a model-computed relative date. This
// module is the one place that intent is resolved into a real, concrete
// "YYYY-MM-DD", deterministically, from organizations.timezone and a
// trusted server `now` — never from browser/model/server-machine-local
// time. Reuses scheduling-availability.ts's own proven, DST-safe local-
// time helpers (isValidTimeZone, localDateTimeParts) rather than
// duplicating timezone math — see this file's own imports.
//
// Pure and dependency-free beyond that one reused module: no Supabase,
// no model calls, no network. Every calendar-day computation below stays
// entirely in a UTC-anchored "pure calendar date" space (see
// resolveDateIntent()'s own comment) precisely so it can never be
// perturbed by DST, the browser's timezone, or the server machine's own
// local timezone.

import { isValidTimeZone, localDateTimeParts } from "../../../../src/lib/agentic/scheduling-availability";

// ── Date intent (MODEL-OWNED semantic content only) ─────────────────────

export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export type DateIntent =
  /** The customer stated (or the model normalized without any relative
   * calendar arithmetic) an explicit calendar date, e.g. "October 22" ->
   * {kind:"explicit_date", date:"2026-10-22"}. Still independently
   * validated below — a syntactically well-formed but impossible date
   * (e.g. "2026-02-30") fails closed, never silently rolled into a
   * different real date. */
  | { kind: "explicit_date"; date: string }
  /** "today" / "tomorrow" — resolved relative to the org-local calendar
   * date, never the model's own notion of "today". */
  | { kind: "relative_day"; value: "today" | "tomorrow" }
  /** A bare or "next"-qualified weekday reference — see
   * resolveDateIntent()'s own header for the exact, documented semantics
   * of each occurrence value. */
  | { kind: "weekday"; weekday: Weekday; occurrence: "next_occurrence" | "next_week" };

export type ResolveDateIntentResult =
  | { status: "resolved"; date: string }
  | { status: "invalid_timezone" }
  | { status: "invalid_intent"; reason: string }
  | { status: "invalid_explicit_date"; reason: string };

const WEEKDAY_INDEX: Record<Weekday, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatYMD(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Adds `days` to a pure UTC-anchored calendar date (never a real
 * instant/wall-clock value — see resolveDateIntent()'s own header).
 * `Date.UTC` itself correctly normalizes month/year overflow (e.g. day 32
 * of a 31-day month rolls into the next month), which is exactly what
 * makes this timezone-safe and DST-irrelevant: no wall-clock offset is
 * ever consulted for this arithmetic. */
function addCalendarDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Day-of-week (0=Sunday..6=Saturday) of a pure UTC-anchored calendar
 * date. Safe for the same reason addCalendarDays() is — this never
 * touches a real timezone offset, it only asks "what weekday does this
 * calendar date fall on," which is a timezone-independent fact once the
 * (year, month, day) tuple itself is already correctly resolved to the
 * organization's own local calendar day (see resolveDateIntent()). */
function dayOfWeek(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Strictly validates a "YYYY-MM-DD" string represents a REAL calendar
 * date — not just a syntactically matching string. A value like
 * "2026-02-30" matches the regex but isn't a real date; Date.UTC()
 * itself would silently roll it into March, so the fix is to roll-trip
 * and compare: if the normalized (year, month, day) doesn't match what
 * was asked for, the input was never valid in the first place. */
function parseAndValidateExplicitDate(value: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const roundTripped = addCalendarDays(year, month, day, 0);
  if (roundTripped.year !== year || roundTripped.month !== month || roundTripped.day !== day) return null;
  return { year, month, day };
}

/**
 * The one trusted resolver that turns a model-supplied semantic DateIntent
 * into an authoritative "YYYY-MM-DD" — organizations.timezone and a
 * trusted server `now` are the only inputs that matter; the model's own
 * "today" belief, the browser's timezone, and the server machine's local
 * timezone are all irrelevant and never consulted.
 *
 * TIMEZONE-SAFETY APPROACH: `now` (a real instant) is converted to the
 * organization's own LOCAL calendar date exactly once, via
 * localDateTimeParts() (the same DST-safe Intl.DateTimeFormat-based
 * helper scheduling-availability.ts's own availability math uses). From
 * that point on, every computation below (tomorrow, next Thursday, next
 * week) is PURE CALENDAR-DATE ARITHMETIC in a UTC-anchored scratch space
 * (addCalendarDays/dayOfWeek) — no further timezone offset is ever
 * consulted, so DST transitions occurring between `now` and the target
 * date can never perturb the result; there is no wall-clock math left to
 * perturb. This is deliberately different from — and does not reuse —
 * resolveLocalInstant()'s own job (converting a calendar date back into
 * a real UTC instant for booking); this module only ever produces a
 * calendar date, never an instant.
 *
 * WEEKDAY SEMANTICS (documented product decisions, both tested):
 *   - "weekday" + occurrence:"next_occurrence": the NEAREST upcoming
 *     occurrence of that weekday, INCLUSIVE of today. If today itself
 *     already is the requested weekday, this resolves to TODAY (0 days
 *     ahead) — chosen as the more natural, customer-friendly reading of
 *     a bare weekday name ("Thursday" said on a Thursday most plausibly
 *     means today), and because this exact case is independently and
 *     explicitly expressed by a customer saying "today" if they want the
 *     unambiguous relative_day:"today" intent instead.
 *   - "weekday" + occurrence:"next_week": the "next_occurrence" date for
 *     that weekday, PLUS exactly 7 days — guaranteeing "next Thursday" is
 *     always a full week further out than bare "Thursday", regardless of
 *     today's own weekday, without needing to define an inherently
 *     arbitrary Sunday-start-vs-Monday-start "calendar week" boundary.
 *
 * FAILS CLOSED on every uncertain case (invalid timezone, an intent shape
 * this function doesn't recognize, or a syntactically-matching but
 * impossible explicit date) — never guesses, never defaults to today/UTC.
 */
export function resolveDateIntent(params: { dateIntent: DateIntent; timeZone: string; now: Date }): ResolveDateIntentResult {
  const { dateIntent, timeZone, now } = params;

  if (!isValidTimeZone(timeZone)) {
    return { status: "invalid_timezone" };
  }

  if (dateIntent.kind === "explicit_date") {
    const parsed = parseAndValidateExplicitDate(dateIntent.date);
    if (!parsed) {
      return { status: "invalid_explicit_date", reason: `"${dateIntent.date}" is not a real calendar date` };
    }
    return { status: "resolved", date: formatYMD(parsed.year, parsed.month, parsed.day) };
  }

  // Both remaining kinds are relative to the org-local "today" — resolve
  // that once, here, via the same DST-safe helper scheduling-availability.ts
  // relies on for its own local-time math.
  const todayParts = localDateTimeParts(now, timeZone);
  const today = { year: todayParts.year, month: todayParts.month, day: todayParts.day };

  if (dateIntent.kind === "relative_day") {
    if (dateIntent.value === "today") {
      return { status: "resolved", date: formatYMD(today.year, today.month, today.day) };
    }
    if (dateIntent.value === "tomorrow") {
      const tomorrow = addCalendarDays(today.year, today.month, today.day, 1);
      return { status: "resolved", date: formatYMD(tomorrow.year, tomorrow.month, tomorrow.day) };
    }
    return { status: "invalid_intent", reason: `Unrecognized relative_day value: "${(dateIntent as { value: string }).value}"` };
  }

  if (dateIntent.kind === "weekday") {
    const targetDow = WEEKDAY_INDEX[dateIntent.weekday];
    if (targetDow === undefined) {
      return { status: "invalid_intent", reason: `Unrecognized weekday: "${dateIntent.weekday}"` };
    }
    const todayDow = dayOfWeek(today.year, today.month, today.day);
    // Nearest upcoming occurrence, inclusive of today — see this
    // function's own "WEEKDAY SEMANTICS" header for why diff=0 means
    // today, not next week.
    const nearestDiff = (targetDow - todayDow + 7) % 7;
    const totalDiff = dateIntent.occurrence === "next_week" ? nearestDiff + 7 : nearestDiff;
    if (dateIntent.occurrence !== "next_occurrence" && dateIntent.occurrence !== "next_week") {
      return { status: "invalid_intent", reason: `Unrecognized occurrence: "${(dateIntent as { occurrence: string }).occurrence}"` };
    }
    const resolved = addCalendarDays(today.year, today.month, today.day, totalDiff);
    return { status: "resolved", date: formatYMD(resolved.year, resolved.month, resolved.day) };
  }

  return { status: "invalid_intent", reason: `Unrecognized dateIntent kind: "${(dateIntent as { kind: string }).kind}"` };
}
