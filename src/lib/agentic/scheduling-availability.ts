// src/lib/agentic/scheduling-availability.ts
//
// Scheduling foundation — Phase 1. A channel-agnostic availability/
// conflict-detection core, extracted (not imported) from the proven
// timezone math already live in netlify/functions/lib/voice-scheduling.ts,
// with the Vapi-specific and natural-language-parsing parts deliberately
// left behind.
//
// LOCATION (code-review correction, same pass): this file was originally
// placed under netlify/functions/lib/, then IMPORTED from
// src/lib/agentic/handlers.ts — a new, backward dependency edge (every
// other netlify/functions/lib file that needs trusted server logic
// imports it FROM src/lib/agentic, e.g. sms-compliance.ts importing
// sendTwilioSms; never the reverse). That edge was found, during review,
// to have zero structural guard against a future accidental import of
// handlers.ts from a React component, which would then try to pull a
// Node-targeted dependency into the browser bundle with no compile-time
// signal. This module has no Netlify-specific shape at all (just
// SupabaseClient + pure Intl math, the same profile as sms-transport.ts/
// whatsapp-transport.ts) — moving it here is a genuine layering fix, not
// cosmetic: it restores the repo's one real, structural safety guarantee
// (src/lib/agentic is the ONLY tree both the Vite browser build and every
// Netlify function's own esbuild bundle can reach; netlify/functions/lib
// is NEVER part of the Vite build graph at all, by construction of how
// this app is built — two separate bundlers for two separate deployables).
// netlify/functions/lib/scheduling-offer-state.ts (which still legitimately
// lives under netlify/functions/lib/, since nothing in src/ needs it)
// imports this file's SlotCandidate type across that boundary — the
// correct direction, unchanged.
//
// ── AUDIT PERFORMED BEFORE WRITING THIS ──────────────────────────────────
//
// Read netlify/functions/lib/voice-scheduling.ts (1252 lines) in full.
// PORTED VERBATIM (pure, dependency-free, no Vapi/telephone concept in
// them at all): the Intl.DateTimeFormat-based local-time/UTC-offset math
// (buildWallClockISO/getUTCOffsetString/localParts, here renamed/adapted
// slightly — see below). NOT ported, by design:
//   - parseNaturalDate/parseTime — natural-language parsing. This module's
//     whole point (per this phase's explicit requirement) is to operate on
//     deterministic STRUCTURED inputs (an ISO date, a duration in
//     minutes) — never on "tomorrow afternoon"-style text. Any natural-
//     language understanding is a model/agent-layer concern, for a LATER
//     phase, that must call this module with already-resolved structured
//     values, never the reverse.
//   - voice_call_scheduling_state / vapi_call_id / claimBooking/
//     reclaimStaleBooking/releaseBooking — all telephone-call-scoped
//     idempotency. Out of scope for this module; booking idempotency for
//     the new schedule_appointment action reuses the EXISTING
//     agent_executions/agent_approval_requests mechanism (see that
//     action's own handler), not a new claim table.
//   - getBookedHoursForDay/isSlotFree's HOUR-BUCKET conflict model (one
//     appointment per whole hour, matched by local hour equality only).
//     This module instead does genuine START/END INTERVAL overlap — see
//     CONFLICT RULE below — a deliberate correctness improvement now
//     possible because appointments.ends_at exists (Phase 10.3), which it
//     did not when voice-scheduling.ts's hour-bucket model was built.
//
// BUSINESS HOURS: intentionally duplicated, not shared, from
// voice-scheduling.ts's `BUSINESS_HOURS = [8..18]` constant (effectively
// an 08:00-19:00 local window for 60-minute slots). Per this phase's own
// instruction not to broadly refactor Voice just for code reuse, and not
// to introduce a business-hours settings table yet, this module defines
// its OWN BUSINESS_START_MINUTES/BUSINESS_END_MINUTES constants below,
// numerically equivalent to Voice's real effective window. If business
// hours ever become configurable, this is the one place in this module
// that needs to change — Voice's own constant is untouched by this file.
//
// ── CRITICAL SAFETY INVARIANT: FAIL CLOSED ───────────────────────────────
//
// voice-scheduling.ts's isSlotFree() deliberately fails OPEN on a query
// error ("the write itself is still the final arbiter" — true for Voice,
// because Voice always re-checks again immediately before its own
// insert). This module does NOT reproduce that choice: every function
// here returns a typed `availability_check_failed` (or equivalent)
// outcome on ANY database error, invalid timezone, malformed input, or
// unexpected state — and EVERY caller (getAvailableSlots, and especially
// the schedule_appointment action handler) MUST treat that outcome as
// "no slot may be booked," never as "assume free." An availability
// problem must never silently become a double-booking.

import type { SupabaseClient } from "@supabase/supabase-js";

// ── Business hours (local time, minutes since midnight) ─────────────────
//
// Numerically equivalent to voice-scheduling.ts's BUSINESS_HOURS = [8..18]
// with DEFAULT_DURATION_MIN = 60 (last bookable hour starts at 18:00,
// ends by 19:00) — see this file's header for why this is a deliberate,
// documented duplication rather than a shared import.
export const BUSINESS_START_MINUTES = 8 * 60; // 08:00 local
export const BUSINESS_END_MINUTES = 19 * 60; // 19:00 local

/** Default candidate-slot spacing for getAvailableSlots(), minutes. */
export const DEFAULT_SLOT_INTERVAL_MINUTES = 30;

/** Default appointment duration, matching voice-scheduling.ts's own default. */
export const DEFAULT_DURATION_MINUTES = 60;

// ── Pure timezone/wall-clock math (ported from voice-scheduling.ts) ─────

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** True only for a string Intl actually recognizes as an IANA timezone.
 * Never throws. Empty/null/undefined is never valid — callers must fail
 * closed rather than fall back to UTC (see this file's header and the
 * resolveOrgTimezone() doc comment below). */
export function isValidTimeZone(timeZone: string | null | undefined): timeZone is string {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Builds a bare (no offset/zone suffix) wall-clock ISO string for the
 * UTC calendar day carried by `date`'s UTC fields, at `hours:minutes`.
 * Ported verbatim from voice-scheduling.ts's buildWallClockISO(). */
function buildWallClockISO(date: Date, hours: number, minutes: number): string {
  const y = date.getUTCFullYear();
  const mo = pad2(date.getUTCMonth() + 1);
  const d = pad2(date.getUTCDate());
  return `${y}-${mo}-${d}T${pad2(hours)}:${pad2(minutes)}:00`;
}

/** Offset string (e.g. "-04:00") for `date` observed in `timeZone`. Ported
 * verbatim from voice-scheduling.ts's getUTCOffsetString(). */
function getUTCOffsetString(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10);
  let hh = get("hour");
  if (hh === 24) hh = 0;
  const localAsUTC = Date.UTC(get("year"), get("month") - 1, get("day"), hh, get("minute"), get("second"));
  const diffMins = Math.round((localAsUTC - date.getTime()) / 60000);
  const sign = diffMins >= 0 ? "+" : "-";
  const abs = Math.abs(diffMins);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** Local Y-M-D and minutes-since-midnight of an instant, observed in
 * `timeZone`. Extends voice-scheduling.ts's localParts() with minute
 * precision (needed here for non-hour-aligned durations; Voice only ever
 * needed whole hours). */
export function localDateTimeParts(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number; minutesOfDay: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10);
  let hour = get("hour");
  if (hour === 24) hour = 0;
  return { year: get("year"), month: get("month"), day: get("day"), minutesOfDay: hour * 60 + get("minute") };
}

/**
 * Resolves a structured (local calendar date, local minutes-of-day) pair
 * to a single absolute UTC instant in `timeZone`. The deterministic,
 * structured-input equivalent of voice-scheduling.ts's resolveSlotInstant()
 * — this version never parses natural language; `dateYMD` must already be
 * a plain "YYYY-MM-DD" string and `minutesOfDay` a plain integer. Returns
 * null for a malformed date string or an invalid timezone — callers must
 * treat null as a hard failure (see this file's FAIL CLOSED header), never
 * as "assume midnight" or "assume UTC."
 */
export function resolveLocalInstant(dateYMD: string, minutesOfDay: number, timeZone: string): Date | null {
  if (!isValidTimeZone(timeZone)) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateYMD);
  if (!m) return null;
  const [, yStr, moStr, dStr] = m;
  const y = parseInt(yStr, 10);
  const mo = parseInt(moStr, 10);
  const d = parseInt(dStr, 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (minutesOfDay < 0 || minutesOfDay >= 24 * 60 || !Number.isInteger(minutesOfDay)) return null;

  const hours = Math.floor(minutesOfDay / 60);
  const minutes = minutesOfDay % 60;
  // getUTCOffsetString/buildWallClockISO both key off a Date's UTC fields
  // carrying the intended calendar day — Date.UTC(y, mo-1, d) gives exactly
  // that, with no local-timezone-of-the-server involvement at any point.
  const dayAsUtc = new Date(Date.UTC(y, mo - 1, d));
  const wallClock = buildWallClockISO(dayAsUtc, hours, minutes);
  const offset = getUTCOffsetString(new Date(wallClock + "Z"), timeZone);
  const instant = new Date(wallClock + offset);
  if (isNaN(instant.getTime())) return null;
  return instant;
}

// ── Org timezone resolution (fail closed, never UTC fallback) ───────────

export type ResolveOrgTimezoneResult =
  | { status: "resolved"; timeZone: string }
  | { status: "org_not_found" }
  | { status: "invalid_timezone"; rawValue: string | null }
  | { status: "lookup_failed"; reason: string };

export type AvailabilityDeps = { supabase: SupabaseClient };

/**
 * `organizations.timezone` is the ONE authoritative timezone source (see
 * this phase's architecture audit — never the browser/device, never a
 * silent UTC default). Fails closed on every uncertain case: org not
 * found, timezone column null/blank, timezone string not a real IANA
 * zone Intl recognizes, or the query itself erroring. There is
 * deliberately no fallback value anywhere in this function.
 */
export async function resolveOrgTimezone(deps: AvailabilityDeps, orgId: string): Promise<ResolveOrgTimezoneResult> {
  const { data, error } = await deps.supabase.from("organizations").select("timezone").eq("id", orgId).maybeSingle();
  if (error) {
    console.error("[scheduling-availability] org timezone lookup failed:", error.message);
    return { status: "lookup_failed", reason: error.message };
  }
  if (!data) return { status: "org_not_found" };
  const raw = (data as { timezone: string | null }).timezone;
  if (!isValidTimeZone(raw)) return { status: "invalid_timezone", rawValue: raw };
  return { status: "resolved", timeZone: raw };
}

// ── Business-hours fit ───────────────────────────────────────────────────

/**
 * True only when [start, end) falls entirely within ONE local calendar day
 * and within [BUSINESS_START_MINUTES, BUSINESS_END_MINUTES) of that day,
 * observed in `timeZone`. A slot that crosses midnight, or that starts/ends
 * outside the business window, is never considered fitting — never
 * partially allowed.
 */
export function isWithinBusinessHours(start: Date, end: Date, timeZone: string): boolean {
  const startParts = localDateTimeParts(start, timeZone);
  const endParts = localDateTimeParts(end, timeZone);
  const sameDay = startParts.year === endParts.year && startParts.month === endParts.month && startParts.day === endParts.day;
  if (!sameDay) return false;
  return (
    startParts.minutesOfDay >= BUSINESS_START_MINUTES &&
    endParts.minutesOfDay <= BUSINESS_END_MINUTES &&
    endParts.minutesOfDay > startParts.minutesOfDay
  );
}

// ── Conflict detection ────────────────────────────────────────────────────

/** Rows this module needs from `appointments` to evaluate overlap. */
type BlockingAppointmentRow = {
  id: string;
  scheduled_at: string;
  ends_at: string | null;
  duration_min: number | null;
  assigned_to: string | null;
};

/** Mirrors the Phase 10.3 backfill convention exactly
 * (`ends_at = scheduled_at + coalesce(duration_min, 60) minutes`) for any
 * row that, for whatever reason, still has a null ends_at at read time —
 * belt-and-suspenders consistency with the DB's own backfill, never a
 * second, divergent default. */
function effectiveEnd(row: BlockingAppointmentRow): Date {
  if (row.ends_at) return new Date(row.ends_at);
  const minutes = row.duration_min ?? DEFAULT_DURATION_MINUTES;
  return new Date(new Date(row.scheduled_at).getTime() + minutes * 60_000);
}

/**
 * CONFLICT RULE (per this phase's explicit spec): a requested [start, end)
 * conflicts with an existing non-cancelled appointment when
 *   existing.start < requested.end  AND  existing.end > requested.start
 * — genuine interval overlap, not an hour-bucket match.
 *
 * ASSIGNEE SCOPE — the one real product decision this module makes. See
 * findConflict()'s own doc comment below for the final, corrected rule
 * and the exact five-combination table (an earlier version of this
 * comment described an incomplete rule that had a real logical hole,
 * found and fixed during code review before anything was committed).
 */
/**
 * CODE-REVIEW CORRECTION (final, deterministic assignee-conflict rule —
 * see this module's own CONFLICT RULE comment above, which previously
 * described an incomplete version of this): an existing row and a
 * requested slot conflict UNLESS both sides name a SPECIFIC, DIFFERENT
 * assignee. Equivalently: they do NOT conflict only when
 * `row.assigned_to && assignedTo && row.assigned_to !== assignedTo`.
 *
 * This was found, during review, to have a real logical hole in its
 * previous form: an UNASSIGNED existing appointment (row.assigned_to ===
 * null — "someone from the business will handle this, TBD") did NOT
 * block a NEW request that named a specific assignee, even though an
 * unassigned appointment represents exactly the kind of generic,
 * org-wide capacity commitment a named booking could double-book against.
 * The five combinations and this rule's result for each:
 *   assigned A    vs assigned A    -> CONFLICT   (same specific person)
 *   assigned A    vs assigned B    -> free        (two different, specific people)
 *   unassigned    vs assigned B    -> CONFLICT   (fixed by this pass)
 *   assigned A    vs unassigned    -> CONFLICT   (unchanged — already correct)
 *   unassigned    vs unassigned    -> CONFLICT   (unchanged — org-wide shared resource)
 * This is the conservative, safe default for a first production slice:
 * it can never allow two appointments on the same resource/timeslot
 * unless it can PROVE (two distinct, explicitly named people) that they
 * are genuinely different resources.
 */
function findConflict(rows: BlockingAppointmentRow[], start: Date, end: Date, assignedTo: string | null | undefined): string | null {
  for (const row of rows) {
    const provablyDifferentAssignees = !!row.assigned_to && !!assignedTo && row.assigned_to !== assignedTo;
    if (provablyDifferentAssignees) continue;
    const existingStart = new Date(row.scheduled_at);
    const existingEnd = effectiveEnd(row);
    if (existingStart.getTime() < end.getTime() && existingEnd.getTime() > start.getTime()) {
      return row.id;
    }
  }
  return null;
}

async function fetchBlockingAppointments(
  deps: AvailabilityDeps,
  orgId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<{ rows: BlockingAppointmentRow[] } | { error: string }> {
  const { data, error } = await deps.supabase
    .from("appointments")
    .select("id, scheduled_at, ends_at, duration_min, assigned_to")
    .eq("org_id", orgId)
    .neq("status", "cancelled")
    .gte("scheduled_at", windowStart.toISOString())
    .lt("scheduled_at", windowEnd.toISOString());
  if (error) return { error: error.message };
  return { rows: (data ?? []) as BlockingAppointmentRow[] };
}

// ── validateSlotAvailability — the authoritative, single-slot check ─────

export type ValidateSlotParams = {
  orgId: string;
  /** Absolute UTC instant, ISO 8601 — already resolved, never raw natural language. */
  start: string;
  end: string;
  /** Already-resolved, already-validated org timezone — see resolveOrgTimezone(). */
  timeZone: string;
  assignedTo?: string | null;
  /** Reserved for a future reschedule flow (excludes the appointment being
   * moved from its own conflict check) — accepted now, per this phase's
   * forward-compatible API shape, but unused: no caller in Phases 1-3
   * reschedules anything. */
  excludeAppointmentId?: string | null;
  /** Injectable for tests; defaults to the real current time. */
  now?: Date;
};

export type ValidateSlotResult =
  | { status: "available" }
  | { status: "conflict"; conflictingAppointmentId: string }
  | { status: "outside_business_hours" }
  | { status: "invalid_range" }
  | { status: "in_past" }
  | { status: "availability_check_failed"; reason: string };

/**
 * The ONE authoritative "is this exact slot bookable right now" check.
 * Called both by getAvailableSlots() (to filter candidates) and — THIS IS
 * THE NON-NEGOTIABLE PART — by the schedule_appointment action handler,
 * called AGAIN immediately before every real insert, never trusting a
 * slot that was merely offered or validated earlier. FAILS CLOSED: any
 * database error, invalid timezone, or malformed start/end becomes
 * `availability_check_failed`, never `available`.
 */
export async function validateSlotAvailability(deps: AvailabilityDeps, params: ValidateSlotParams): Promise<ValidateSlotResult> {
  const { orgId, assignedTo, excludeAppointmentId } = params;
  const now = params.now ?? new Date();

  if (!isValidTimeZone(params.timeZone)) {
    return { status: "availability_check_failed", reason: "invalid_timezone" };
  }

  const start = new Date(params.start);
  const end = new Date(params.end);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return { status: "availability_check_failed", reason: "malformed_start_or_end" };
  }
  if (!(start.getTime() < end.getTime())) {
    return { status: "invalid_range" };
  }
  // 1-minute grace, matching voice-scheduling.ts's slotIsInPast() exactly.
  if (start.getTime() < now.getTime() - 60_000) {
    return { status: "in_past" };
  }
  if (!isWithinBusinessHours(start, end, params.timeZone)) {
    return { status: "outside_business_hours" };
  }

  // Window-bound the query generously (±1 day) around the requested
  // instant — same safety margin voice-scheduling.ts's own isSlotFree()
  // uses — so a timezone's local day never falls outside the UTC query
  // window no matter the offset.
  const windowStart = new Date(start.getTime() - 24 * 3600_000);
  const windowEnd = new Date(start.getTime() + 24 * 3600_000);
  const fetched = await fetchBlockingAppointments(deps, orgId, windowStart, windowEnd);
  if ("error" in fetched) {
    console.error("[scheduling-availability] conflict query failed — failing CLOSED:", fetched.error);
    return { status: "availability_check_failed", reason: fetched.error };
  }

  const rows = excludeAppointmentId ? fetched.rows.filter((r) => r.id !== excludeAppointmentId) : fetched.rows;
  const conflictId = findConflict(rows, start, end, assignedTo);
  if (conflictId) return { status: "conflict", conflictingAppointmentId: conflictId };
  return { status: "available" };
}

// ── getAvailableSlots — candidate generation for a single local day ─────

export type SlotCandidate = {
  start: string;
  end: string;
  timeZone: string;
  assignedTo?: string | null;
  appointmentType?: string | null;
};

export type GetAvailableSlotsParams = {
  orgId: string;
  /** Plain "YYYY-MM-DD" — structured, never natural language. */
  date: string;
  durationMinutes: number;
  /** Already-resolved, already-validated org timezone. */
  timeZone: string;
  assignedTo?: string | null;
  appointmentType?: string | null;
  slotIntervalMinutes?: number;
  now?: Date;
};

export type GetAvailableSlotsResult =
  | { status: "ok"; slots: SlotCandidate[] }
  | { status: "availability_check_failed"; reason: string };

/**
 * Generates candidate start times every `slotIntervalMinutes` (default
 * DEFAULT_SLOT_INTERVAL_MINUTES) across the business-hours window of the
 * given LOCAL calendar day, and returns only the ones that pass
 * validateSlotAvailability()'s full check. A single appointments query
 * covers the whole day (not one query per candidate). FAILS CLOSED: any
 * error fetching appointments for the day returns
 * `availability_check_failed` with an EMPTY slot list implied — never a
 * partially-wrong list of "maybe free" candidates.
 *
 * This function's own output is NEVER itself proof a slot stays
 * available — see this file's header. Every candidate it returns is
 * re-validated by validateSlotAvailability() again at booking time.
 */
export async function getAvailableSlots(deps: AvailabilityDeps, params: GetAvailableSlotsParams): Promise<GetAvailableSlotsResult> {
  const { orgId, durationMinutes, timeZone, assignedTo, appointmentType } = params;
  const now = params.now ?? new Date();
  const interval = params.slotIntervalMinutes ?? DEFAULT_SLOT_INTERVAL_MINUTES;

  if (!isValidTimeZone(timeZone)) return { status: "availability_check_failed", reason: "invalid_timezone" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.date)) return { status: "availability_check_failed", reason: "malformed_date" };
  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0 || durationMinutes > 24 * 60) {
    return { status: "availability_check_failed", reason: "invalid_duration" };
  }
  if (!Number.isInteger(interval) || interval <= 0) {
    return { status: "availability_check_failed", reason: "invalid_slot_interval" };
  }

  // Resolve the local day's own midnight instant once, purely to bound the
  // query window — reuses resolveLocalInstant() rather than a second,
  // divergent date-math path.
  const dayStart = resolveLocalInstant(params.date, 0, timeZone);
  if (!dayStart) return { status: "availability_check_failed", reason: "malformed_date_or_timezone" };

  const windowStart = new Date(dayStart.getTime() - 24 * 3600_000);
  const windowEnd = new Date(dayStart.getTime() + 48 * 3600_000);
  const fetched = await fetchBlockingAppointments(deps, orgId, windowStart, windowEnd);
  if ("error" in fetched) {
    console.error("[scheduling-availability] day-availability query failed — failing CLOSED:", fetched.error);
    return { status: "availability_check_failed", reason: fetched.error };
  }

  const slots: SlotCandidate[] = [];
  for (let minutesOfDay = BUSINESS_START_MINUTES; minutesOfDay + durationMinutes <= BUSINESS_END_MINUTES; minutesOfDay += interval) {
    const start = resolveLocalInstant(params.date, minutesOfDay, timeZone);
    if (!start) continue; // defensive only — timezone/date already validated above
    const end = new Date(start.getTime() + durationMinutes * 60_000);

    if (start.getTime() < now.getTime() - 60_000) continue; // in the past
    if (!isWithinBusinessHours(start, end, timeZone)) continue; // defensive — loop bounds should already guarantee this

    const conflictId = findConflict(fetched.rows, start, end, assignedTo);
    if (conflictId) continue;

    slots.push({
      start: start.toISOString(),
      end: end.toISOString(),
      timeZone,
      assignedTo: assignedTo ?? null,
      appointmentType: appointmentType ?? null,
    });
  }

  return { status: "ok", slots };
}
