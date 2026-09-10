// netlify/functions/lib/voice-scheduling.ts
//
// Voice appointment scheduling subsystem — rebuilt from first principles.
//
// ─────────────────────────────────────────────────────────────────────────
// PRINCIPLE
// ─────────────────────────────────────────────────────────────────────────
// The LLM handles conversation only. This module owns transaction state.
// It never parses transcript text and never trusts the model's spoken
// words as proof of anything. There is exactly ONE authoritative state
// row per call — public.voice_call_scheduling_state, keyed by
// (vapi_call_id, org_id) — and every scheduling decision is made from it.
//
// The four tool entry points:
//   persistLeadLinkage        <- called from save_lead
//   handleCheckAvailability   <- check_availability
//   handleBookAppointment     <- book_appointment  (may receive {} )
//   handleRescheduleAppointment <- reschedule_appointment
//
// Live path for a write is deliberately minimal:
//   state lookup -> availability recheck -> DB write -> state consume -> response
// No SMTP, SMS, owner notifications, Google Calendar, pipeline deals or
// summaries happen here — those are the post-call lifecycle's job
// (vapi-webhook.ts handleEndOfCallReport).

import type { SupabaseClient } from '@supabase/supabase-js';

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

/** Bookable hours, 24h local. Matches the pre-rebuild behavior (8am–6pm). */
export const BUSINESS_HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18] as const;

export const DEFAULT_DURATION_MIN = 60;

/**
 * A confirmed slot in the call state is only usable for this long after it
 * was checked. A call rarely runs longer; a stale row is treated as "no
 * confirmed slot" and the model is told to check again.
 */
export const CONFIRMED_SLOT_TTL_MS = 30 * 60 * 1000;

// ─────────────────────────────────────────────
// Safe logging (no PII — only ids, tool name, state booleans, results)
// ─────────────────────────────────────────────
function slog(tool: string, msg: string, fields?: Record<string, unknown>) {
  console.log(`[voice-scheduling][${tool}] ${msg}`, fields ? JSON.stringify(fields) : '');
}
function slogError(tool: string, msg: string, fields?: Record<string, unknown>) {
  console.error(`[voice-scheduling][${tool}] ERROR ${msg}`, fields ? JSON.stringify(fields) : '');
}

// ─────────────────────────────────────────────
// Natural-language date / time parsing
// ─────────────────────────────────────────────

/**
 * @param refMinutesOfDay  Minutes-past-midnight of the requested time-of-day,
 *   when known. Only used to disambiguate a bare weekday that matches *today*:
 *   if the requested time has already passed, roll to the same weekday next
 *   week; otherwise "today" is a valid answer.
 */
export function parseNaturalDate(
  input: string,
  now: Date = new Date(),
  refMinutesOfDay?: number | null,
): Date | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  if (s === 'today') return new Date(today);
  if (s === 'tomorrow') {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return d;
  }

  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let i = 0; i < weekdays.length; i++) {
    if (s.includes(weekdays[i])) {
      // An unqualified weekday, "this <weekday>" and "next <weekday>" all
      // resolve to the NEXT upcoming occurrence (today included). The Sep 5
      // 2026 test call showed the model passing "next Tuesday" when the
      // caller only said "Tuesday", which pushed the booking a full week
      // out. The flow always reads the exact resolved date back to the
      // caller before booking, so collapsing "next" here is safe; only an
      // explicit "week after next" / "in two weeks" reaches the far week.
      const weekAfterNext = /week after next|in two weeks|in 2 weeks|two weeks from/.test(s);
      const d = new Date(today);
      let diff = (i - d.getDay() + 7) % 7; // 0..6, 0 = today
      if (diff === 0 && refMinutesOfDay != null) {
        const nowMin = now.getHours() * 60 + now.getMinutes();
        if (refMinutesOfDay <= nowMin) diff = 7; // requested time already passed today
      }
      if (weekAfterNext) diff += 7;
      d.setDate(d.getDate() + diff);
      return d;
    }
  }

  const inDays = s.match(/in\s+(\d+)\s+days?/);
  if (inDays) {
    const d = new Date(today);
    d.setDate(d.getDate() + parseInt(inDays[1], 10));
    return d;
  }

  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) {
    parsed.setHours(0, 0, 0, 0);
    // The legacy Date parser fills a MISSING year with 2001 — e.g.
    // `new Date("September 8")` -> 2001-09-08. That silently booked an
    // invisible past-dated appointment on the Sep 5 2026 call. When the
    // input carried no 4-digit year, re-anchor onto the current year (and
    // bump to next year only if that date has already clearly passed).
    if (!/\b\d{4}\b/.test(s) && parsed.getFullYear() !== today.getFullYear()) {
      parsed.setFullYear(today.getFullYear());
      if (parsed.getTime() < today.getTime() - 24 * 3600 * 1000) {
        parsed.setFullYear(today.getFullYear() + 1);
      }
    }
    return parsed;
  }

  const dayOfMonth = s.match(/\b(\d{1,2})(st|nd|rd|th)?\b/);
  if (dayOfMonth) {
    const day = parseInt(dayOfMonth[1], 10);
    const d = new Date(today);
    d.setDate(day);
    if (d < today) d.setMonth(d.getMonth() + 1);
    return d;
  }

  return null;
}

export function parseTime(input: string): { hours: number; minutes: number } | null {
  if (!input) return null;
  const s = input.trim().toLowerCase().replace(/\s+/g, '');

  const h24 = s.match(/^(\d{1,2}):?(\d{2})$/);
  if (h24) {
    const hours = parseInt(h24[1], 10);
    const minutes = parseInt(h24[2], 10);
    if (hours > 23 || minutes > 59) return null;
    return { hours, minutes };
  }

  const h12 = s.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
  if (h12) {
    let hours = parseInt(h12[1], 10);
    const mins = parseInt(h12[2] ?? '0', 10);
    const period = h12[3];
    if (hours < 1 || hours > 12 || mins > 59) return null;
    if (period === 'pm' && hours !== 12) hours += 12;
    if (period === 'am' && hours === 12) hours = 0;
    return { hours, minutes: mins };
  }

  return null;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Wall-clock ISO with NO zone, from the UTC fields of `date` + h:m. */
export function buildWallClockISO(date: Date, hours: number, minutes: number): string {
  const y = date.getUTCFullYear();
  const mo = pad2(date.getUTCMonth() + 1);
  const d = pad2(date.getUTCDate());
  return `${y}-${mo}-${d}T${pad2(hours)}:${pad2(minutes)}:00`;
}

/** Offset string (e.g. "-04:00") for `date` observed in `timezone`. */
export function getUTCOffsetString(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(date);
    const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
    let hh = get('hour');
    if (hh === 24) hh = 0;
    const localAsUTC = Date.UTC(get('year'), get('month') - 1, get('day'), hh, get('minute'), get('second'));
    const diffMins = Math.round((localAsUTC - date.getTime()) / 60000);
    const sign = diffMins >= 0 ? '+' : '-';
    const abs = Math.abs(diffMins);
    return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  } catch {
    return '+00:00';
  }
}

/** Local Y-M-D-H of an instant, observed in `timezone`. */
export function localParts(date: Date, timezone: string): { year: number; month: number; day: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
  let hour = get('hour');
  if (hour === 24) hour = 0;
  return { year: get('year'), month: get('month'), day: get('day'), hour };
}

/**
 * Resolve (natural date, natural time, timezone) to a single absolute
 * instant. Computed once at check time, stored on the state row, and
 * reused verbatim by book/reschedule so parsing can never drift.
 */
export function resolveSlotInstant(
  dateStr: string,
  timeStr: string,
  timezone: string,
  now: Date = new Date(),
): { iso: string; wallClock: string } | null {
  const time = parseTime(timeStr);
  if (!time) return null;
  const date = parseNaturalDate(dateStr, now, time.hours * 60 + time.minutes);
  if (!date) return null;
  const wallClock = buildWallClockISO(date, time.hours, time.minutes);
  const offset = getUTCOffsetString(new Date(wallClock + 'Z'), timezone);
  const instant = new Date(wallClock + offset);
  if (isNaN(instant.getTime())) return null;
  return { iso: instant.toISOString(), wallClock };
}

/** True when `iso` is meaningfully before `now` (1-minute grace). */
export function slotIsInPast(iso: string, now: Date): boolean {
  return new Date(iso).getTime() < now.getTime() - 60 * 1000;
}

export function formatHour(h: number): string {
  if (h === 12) return '12pm';
  if (h === 0) return '12am';
  return h > 12 ? `${h - 12}pm` : `${h}am`;
}

export function dayLabel(date: Date): string {
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

export function todayLabel(now: Date = new Date()): string {
  return now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function formatClockLabel(h: number, m: number): string {
  const period = h >= 12 ? 'pm' : 'am';
  let hr = h % 12;
  if (hr === 0) hr = 12;
  return m === 0 ? `${hr}${period}` : `${hr}:${pad2(m)}${period}`;
}

function formatSlotSpeech(dateStr: string, timeStr: string, now: Date): string {
  const d = parseNaturalDate(dateStr, now);
  const t = parseTime(timeStr);
  const dLabel = d ? dayLabel(d) : dateStr;
  const tLabel = t ? formatClockLabel(t.hours, t.minutes) : timeStr;
  return `${dLabel} at ${tLabel}`;
}

// ─────────────────────────────────────────────
// Dependencies (injected — keeps this module unit-testable)
// ─────────────────────────────────────────────

export interface SchedulingDeps {
  supabase: SupabaseClient;
  /** Resolve the org's IANA timezone (falls back to 'UTC'). */
  getOrgTimezone: (orgId: string) => Promise<string>;
  /** Upsert a contact and return its id (used only as a fallback when save_lead never ran). */
  upsertContact: (params: {
    tenantId: string; name: string; phone: string; email: string; address: string;
  }) => Promise<string | null>;
  /** Injectable clock for tests. */
  now?: () => Date;
}

const clock = (deps: SchedulingDeps) => (deps.now ? deps.now() : new Date());

// ─────────────────────────────────────────────
// State row
// ─────────────────────────────────────────────

export interface SchedulingState {
  vapi_call_id: string;
  org_id: string;
  contact_id: string | null;
  lead_id: string | null;
  action_type: 'book' | 'reschedule';
  selected_date: string | null;
  selected_time: string | null;
  selected_timezone: string | null;
  selected_slot_at: string | null;
  availability_status: 'available' | 'unavailable' | null;
  slot_checked_at: string | null;
  existing_appointment_id: string | null;
  consumed_at: string | null;
  resulting_appointment_id: string | null;
}

const STATE_TABLE = 'voice_call_scheduling_state';

async function loadState(deps: SchedulingDeps, vapiCallId: string, orgId: string): Promise<SchedulingState | null> {
  const { data, error } = await deps.supabase
    .from(STATE_TABLE)
    .select('*')
    .eq('vapi_call_id', vapiCallId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) {
    slogError('state', 'load failed', { vapiCallId, orgId });
    return null;
  }
  return (data as SchedulingState | null) ?? null;
}

/** Upsert only the given columns; PK-conflict preserves every other column. */
async function writeState(
  deps: SchedulingDeps,
  vapiCallId: string,
  orgId: string,
  patch: Partial<SchedulingState>,
): Promise<void> {
  const nowIso = clock(deps).toISOString();
  const { error } = await deps.supabase
    .from(STATE_TABLE)
    .upsert(
      { vapi_call_id: vapiCallId, org_id: orgId, updated_at: nowIso, ...patch },
      { onConflict: 'vapi_call_id,org_id' },
    );
  if (error) slogError('state', 'write failed', { vapiCallId, orgId, keys: Object.keys(patch) });
}

/**
 * Atomically claim the booking for this call. Exactly one concurrent
 * caller gets rows back; everyone else gets [] and must treat the booking
 * as already in progress / done.
 */
async function claimBooking(
  deps: SchedulingDeps,
  vapiCallId: string,
  orgId: string,
  actionType: 'book' | 'reschedule',
): Promise<'won' | 'lost' | 'error'> {
  const nowIso = clock(deps).toISOString();
  const { data, error } = await deps.supabase
    .from(STATE_TABLE)
    .update({ consumed_at: nowIso, action_type: actionType, updated_at: nowIso })
    .eq('vapi_call_id', vapiCallId)
    .eq('org_id', orgId)
    .is('consumed_at', null)
    .select('vapi_call_id');
  if (error) {
    // A genuine backend fault (e.g. the scheduling-state table is missing
    // because migration 20260911 was never applied). MUST NOT be reported
    // as "in progress" / success — the caller surfaces this as a hard
    // failure so the model never tells the caller they are booked.
    slogError('claim', 'claim update failed — is migration 20260911 applied?', { vapiCallId, orgId });
    return 'error';
  }
  const won = (data?.length ?? 0) > 0;
  slog('claim', won ? 'claim won' : 'claim lost (already consumed)', { vapiCallId, orgId, actionType });
  return won ? 'won' : 'lost';
}

/**
 * A claim older than this with no resulting appointment is treated as
 * abandoned — the invocation that made it timed out / was frozen before it
 * could insert. A retry may safely take it over.
 */
const STALE_CLAIM_MS = 20_000;

/**
 * Re-take a stale, never-completed claim so a retry can finish the booking
 * instead of looping on "one moment". Only matches rows whose claim is
 * older than STALE_CLAIM_MS AND that still have no appointment recorded, so
 * a genuine in-flight concurrent booking is never disturbed.
 */
async function reclaimStaleBooking(deps: SchedulingDeps, vapiCallId: string, orgId: string): Promise<boolean> {
  const nowMs = clock(deps).getTime();
  const cutoffIso = new Date(nowMs - STALE_CLAIM_MS).toISOString();
  const nowIso = new Date(nowMs).toISOString();
  const { data, error } = await deps.supabase
    .from(STATE_TABLE)
    .update({ consumed_at: nowIso, updated_at: nowIso })
    .eq('vapi_call_id', vapiCallId)
    .eq('org_id', orgId)
    .is('resulting_appointment_id', null)
    .lt('consumed_at', cutoffIso)
    .select('vapi_call_id');
  if (error) {
    slogError('claim', 'stale reclaim failed', { vapiCallId, orgId });
    return false;
  }
  const ok = (data?.length ?? 0) > 0;
  if (ok) slog('claim', 'stale claim reclaimed — prior invocation timed out', { vapiCallId, orgId });
  return ok;
}

/** Release a claim after a failed DB write so a retry can proceed. */
async function releaseBooking(deps: SchedulingDeps, vapiCallId: string, orgId: string): Promise<void> {
  const nowIso = clock(deps).toISOString();
  const { error } = await deps.supabase
    .from(STATE_TABLE)
    .update({ consumed_at: null, resulting_appointment_id: null, updated_at: nowIso })
    .eq('vapi_call_id', vapiCallId)
    .eq('org_id', orgId)
    .is('resulting_appointment_id', null);
  if (error) slogError('claim', 'release failed', { vapiCallId, orgId });
  else slog('claim', 'claim released after failed write', { vapiCallId, orgId });
}

async function markResult(
  deps: SchedulingDeps,
  vapiCallId: string,
  orgId: string,
  appointmentId: string,
): Promise<void> {
  const nowIso = clock(deps).toISOString();
  const { error } = await deps.supabase
    .from(STATE_TABLE)
    .update({ resulting_appointment_id: appointmentId, consumed_at: nowIso, updated_at: nowIso })
    .eq('vapi_call_id', vapiCallId)
    .eq('org_id', orgId);
  if (error) slogError('state', 'markResult failed', { vapiCallId, orgId, appointmentId });
}

// ─────────────────────────────────────────────
// Availability
// ─────────────────────────────────────────────

/** Hours (local, in tz) already taken on the local calendar day of `targetDate`. */
async function getBookedHoursForDay(
  deps: SchedulingDeps,
  orgId: string,
  targetDate: Date,
  timezone: string,
): Promise<number[]> {
  // targetDate carries the intended day in its UTC fields (see buildWallClockISO).
  const y = targetDate.getUTCFullYear();
  const m = targetDate.getUTCMonth();
  const d = targetDate.getUTCDate();
  const windowStart = new Date(Date.UTC(y, m, d) - 24 * 3600 * 1000);
  const windowEnd = new Date(Date.UTC(y, m, d) + 48 * 3600 * 1000);

  const { data, error } = await deps.supabase
    .from('appointments')
    .select('scheduled_at')
    .eq('org_id', orgId)
    .neq('status', 'cancelled')
    .gte('scheduled_at', windowStart.toISOString())
    .lt('scheduled_at', windowEnd.toISOString());

  if (error) {
    slogError('availability', 'day query failed', { orgId });
    return [];
  }

  const targetY = y;
  const targetM = m + 1;
  const targetD = d;
  const hours: number[] = [];
  for (const row of data ?? []) {
    const lp = localParts(new Date(row.scheduled_at as string), timezone);
    if (lp.year === targetY && lp.month === targetM && lp.day === targetD) hours.push(lp.hour);
  }
  return hours;
}

/** Is `instantIso` still free? Re-run immediately before every write. */
async function isSlotFree(
  deps: SchedulingDeps,
  orgId: string,
  instantIso: string,
  timezone: string,
  excludeAppointmentId?: string | null,
): Promise<boolean> {
  const instant = new Date(instantIso);
  const target = localParts(instant, timezone);
  const windowStart = new Date(instant.getTime() - 24 * 3600 * 1000).toISOString();
  const windowEnd = new Date(instant.getTime() + 24 * 3600 * 1000).toISOString();

  let q = deps.supabase
    .from('appointments')
    .select('id, scheduled_at')
    .eq('org_id', orgId)
    .neq('status', 'cancelled')
    .gte('scheduled_at', windowStart)
    .lt('scheduled_at', windowEnd);
  if (excludeAppointmentId) q = q.neq('id', excludeAppointmentId);

  const { data, error } = await q;
  if (error) {
    // Fail open — the write itself is still the final arbiter.
    slogError('availability', 'revalidation query failed (failing open)', { orgId });
    return true;
  }

  for (const row of data ?? []) {
    const lp = localParts(new Date(row.scheduled_at as string), timezone);
    if (lp.year === target.year && lp.month === target.month && lp.day === target.day && lp.hour === target.hour) {
      return false;
    }
  }
  return true;
}

/**
 * Find an appointment THIS Voice booking flow already created for this exact
 * confirmed slot — the case where an earlier invocation inserted the
 * appointment but crashed before markResult wrote resulting_appointment_id.
 *
 * Matched by the authoritative tuple (org_id, contact_id, scheduled_at,
 * source='Voice AI', not cancelled). scheduled_at is the verbatim
 * selected_slot_at instant, so this is an exact match, not an hour bucket.
 * Requires a contact_id: without one, a Voice appointment at the same slot
 * cannot be safely distinguished from a different caller's booking, so we
 * do NOT adopt it (the caller-facing "slot taken" path handles that).
 */
async function findExistingVoiceBooking(
  deps: SchedulingDeps,
  params: { orgId: string; contactId: string | null; slotIso: string },
): Promise<string | null> {
  if (!params.contactId) return null;

  const { data, error } = await deps.supabase
    .from('appointments')
    .select('id')
    .eq('org_id', params.orgId)
    .eq('contact_id', params.contactId)
    .eq('scheduled_at', params.slotIso)
    .eq('source', 'Voice AI')
    .neq('status', 'cancelled')
    .limit(1)
    .maybeSingle();
  if (error) {
    slogError('book_appointment', 'existing-booking lookup failed', { orgId: params.orgId });
    return null;
  }
  return (data?.id as string | undefined) ?? null;
}

// ─────────────────────────────────────────────
// Result type
// ─────────────────────────────────────────────

export interface SchedulingResult {
  /** Text handed back to the model as the tool result. */
  speech: string;
  /** True only when a DB write actually succeeded this invocation or a prior one. */
  ok: boolean;
  appointmentId?: string;
  /** Set for observability / tests — which branch produced the result. */
  outcome:
    | 'need_date'
    | 'bad_date'
    | 'slot_available'
    | 'slot_unavailable'
    | 'slot_list'
    | 'booked'
    | 'already_booked'
    | 'book_in_progress'
    | 'missing_slot'
    | 'slot_taken'
    | 'slot_in_past'
    | 'write_failed'
    | 'rescheduled'
    | 'already_rescheduled'
    | 'no_appointment'
    | 'ambiguous_appointment'
    | 'lead_linked';
}

// ─────────────────────────────────────────────
// save_lead linkage
// ─────────────────────────────────────────────

export async function persistLeadLinkage(
  deps: SchedulingDeps,
  params: { vapiCallId: string; orgId: string; contactId: string | null; leadId: string | null },
): Promise<void> {
  const { vapiCallId, orgId, contactId, leadId } = params;
  const patch: Partial<SchedulingState> = {};
  if (contactId) patch.contact_id = contactId;
  if (leadId) patch.lead_id = leadId;
  if (Object.keys(patch).length === 0) return;
  await writeState(deps, vapiCallId, orgId, patch);
  slog('save_lead', 'linkage persisted to scheduling state', {
    vapiCallId, orgId, hasContact: !!contactId, hasLead: !!leadId,
  });
}

// ─────────────────────────────────────────────
// check_availability
// ─────────────────────────────────────────────

export async function handleCheckAvailability(
  deps: SchedulingDeps,
  params: { vapiCallId: string; orgId: string; date: string; time: string },
): Promise<SchedulingResult> {
  const now = clock(deps);
  const { vapiCallId, orgId } = params;
  const dateInput = (params.date ?? '').trim();
  const timeInput = (params.time ?? '').trim();
  const today = todayLabel(now);

  slog('check_availability', 'called', { vapiCallId, orgId, hasDate: !!dateInput, hasTime: !!timeInput });

  if (!dateInput) {
    return {
      ok: true, outcome: 'need_date',
      speech: `Today is ${today}. We schedule Monday through Saturday, 8am to 6pm. What day works best?`,
    };
  }

  const requested = parseTime(timeInput);
  const refMin = requested ? requested.hours * 60 + requested.minutes : null;

  const targetDate = parseNaturalDate(dateInput, now, refMin);
  if (!targetDate) {
    return {
      ok: true, outcome: 'bad_date',
      speech: `Today is ${today}. I couldn't understand that date — try "next Monday" or "April 15th".`,
    };
  }

  const tz = await deps.getOrgTimezone(orgId).catch(() => 'UTC');
  const bookedHours = await getBookedHoursForDay(deps, orgId, targetDate, tz);
  const freeSlots = (BUSINESS_HOURS as readonly number[]).filter((h) => !bookedHours.includes(h));
  const label = dayLabel(targetDate);

  if (requested) {
    const reqHour = requested.hours;
    const inHours = (BUSINESS_HOURS as readonly number[]).includes(reqHour);

    if (inHours && !bookedHours.includes(reqHour)) {
      const resolved = resolveSlotInstant(dateInput, timeInput, tz, now);
      if (!resolved) {
        return { ok: true, outcome: 'bad_date', speech: `I couldn't understand that time — try something like "10 AM".` };
      }
      if (slotIsInPast(resolved.iso, now)) {
        await writeState(deps, vapiCallId, orgId, {
          selected_date: dateInput, selected_time: timeInput, selected_timezone: tz,
          selected_slot_at: null, availability_status: 'unavailable', slot_checked_at: now.toISOString(),
        });
        slog('check_availability', 'requested slot is in the past', { vapiCallId, orgId, slotAt: resolved.iso });
        return {
          ok: true, outcome: 'slot_unavailable',
          speech: `${formatHour(reqHour)} on ${label} is already in the past. What upcoming day and time works?`,
        };
      }
      await writeState(deps, vapiCallId, orgId, {
        selected_date: dateInput,
        selected_time: timeInput,
        selected_timezone: tz,
        selected_slot_at: resolved.iso,
        availability_status: 'available',
        slot_checked_at: now.toISOString(),
      });
      slog('check_availability', 'slot available, persisted', { vapiCallId, orgId, slotAt: resolved.iso });
      return {
        ok: true, outcome: 'slot_available',
        speech: `${formatHour(reqHour)} on ${label} is available. Shall I book that?`,
      };
    }

    // Requested time not usable — record it as unavailable, clear the slot.
    await writeState(deps, vapiCallId, orgId, {
      selected_date: dateInput,
      selected_time: timeInput,
      selected_timezone: tz,
      selected_slot_at: null,
      availability_status: 'unavailable',
      slot_checked_at: now.toISOString(),
    });
    slog('check_availability', 'requested slot unavailable', { vapiCallId, orgId, reqHour });

    const near = [reqHour - 1, reqHour + 1, reqHour - 2, reqHour + 2].filter((h) => freeSlots.includes(h));
    if (near.length) {
      return {
        ok: true, outcome: 'slot_unavailable',
        speech: `${formatHour(reqHour)} isn't available on ${label}. The closest ${
          near.length === 1 ? 'opening is' : 'openings are'
        } ${near.slice(0, 2).map(formatHour).join(' or ')}. Would either work?`,
      };
    }
    if (freeSlots.length === 0) {
      const next = new Date(targetDate);
      next.setUTCDate(next.getUTCDate() + 1);
      return {
        ok: true, outcome: 'slot_unavailable',
        speech: `We're fully booked on ${label}. Would ${dayLabel(next)} work instead?`,
      };
    }
    return {
      ok: true, outcome: 'slot_unavailable',
      speech: `${formatHour(reqHour)} isn't available on ${label}. Openings: ${freeSlots.map(formatHour).join(', ')}. Which works?`,
    };
  }

  // No specific time — list openings, do NOT record a usable slot.
  if (freeSlots.length === 0) {
    const next = new Date(targetDate);
    next.setUTCDate(next.getUTCDate() + 1);
    return { ok: true, outcome: 'slot_list', speech: `We're fully booked on ${label}. Would ${dayLabel(next)} work instead?` };
  }
  const morning = freeSlots.filter((h) => h < 12).map(formatHour);
  const afternoon = freeSlots.filter((h) => h >= 12).map(formatHour);
  const parts: string[] = [];
  if (morning.length) parts.push(`morning: ${morning.join(', ')}`);
  if (afternoon.length) parts.push(`afternoon: ${afternoon.join(', ')}`);
  return {
    ok: true, outcome: 'slot_list',
    speech: `On ${label} we have openings — ${parts.join('; ')}. What time works best?`,
  };
}

// ─────────────────────────────────────────────
// book_appointment
// ─────────────────────────────────────────────

export interface BookArgs {
  date?: string;
  time?: string;
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
  service?: string;
  budget?: string;
  timeline?: string;
  notes?: string;
}

function isSlotStateUsable(state: SchedulingState | null, now: Date): boolean {
  if (!state) return false;
  if (state.availability_status !== 'available') return false;
  if (!state.selected_slot_at || !state.selected_date || !state.selected_time) return false;
  if (!state.slot_checked_at) return false;
  const age = now.getTime() - new Date(state.slot_checked_at).getTime();
  return age >= 0 && age <= CONFIRMED_SLOT_TTL_MS;
}

export async function handleBookAppointment(
  deps: SchedulingDeps,
  params: { vapiCallId: string; orgId: string; args: BookArgs; callerPhone: string | null },
): Promise<SchedulingResult> {
  const now = clock(deps);
  const { vapiCallId, orgId, args, callerPhone } = params;

  const argDate = String(args.date ?? '').trim();
  const argTime = String(args.time ?? '').trim();

  slog('book_appointment', 'called', {
    vapiCallId, orgId, hasArgDate: !!argDate, hasArgTime: !!argTime,
  });

  let state = await loadState(deps, vapiCallId, orgId);
  slog('book_appointment', 'state loaded', {
    vapiCallId, stateFound: !!state,
    consumed: !!state?.consumed_at, hasResult: !!state?.resulting_appointment_id,
    slotUsable: isSlotStateUsable(state, now),
  });

  // ── Idempotency: this call already booked ──────────────────────────────
  if (state?.resulting_appointment_id && state.consumed_at && state.action_type !== 'reschedule') {
    slog('book_appointment', 'idempotent hit — already booked', {
      vapiCallId, appointmentId: state.resulting_appointment_id,
    });
    return {
      ok: true, outcome: 'already_booked', appointmentId: state.resulting_appointment_id,
      speech: `You're all set — this appointment is already booked${
        state.selected_date && state.selected_time
          ? ` for ${formatSlotSpeech(state.selected_date, state.selected_time, now)}`
          : ''
      }. Nothing more is needed.`,
    };
  }

  // NOTE: the live path is kept deliberately short (state lookup ->
  // revalidate -> claim -> insert -> mark). It does NOT resolve the
  // internal voice_calls.id, look up existing appointments by voice_call_id,
  // resolve the org timezone (the confirmed slot is already an absolute
  // instant on the state row), or write voice_calls.contact_id. Those are
  // handled off the hot path (handleToolCalls audit / end-of-call linkage)
  // so book_appointment always returns to Vapi well within its tool
  // timeout. Idempotency is the state row's job (consumed_at +
  // resulting_appointment_id), checked above.

  // ── Resolve the slot to write ─────────────────────────────────────────
  let slotIso: string | null = null;
  let slotDateStr = '';
  let slotTimeStr = '';
  let tz = state?.selected_timezone ?? (await deps.getOrgTimezone(orgId).catch(() => 'UTC'));

  if (argDate && argTime) {
    const resolved = resolveSlotInstant(argDate, argTime, tz, now);
    if (!resolved) {
      return {
        ok: false, outcome: 'bad_date',
        speech: `I couldn't understand that date or time. Say it like "Tuesday at 10 AM".`,
      };
    }
    slotIso = resolved.iso;
    slotDateStr = argDate;
    slotTimeStr = argTime;
    // Keep the state's newest-wins slot in sync with what we're about to book.
    await writeState(deps, vapiCallId, orgId, {
      selected_date: argDate, selected_time: argTime, selected_timezone: tz,
      selected_slot_at: resolved.iso, availability_status: 'available', slot_checked_at: now.toISOString(),
    });
    state = await loadState(deps, vapiCallId, orgId);
  } else if (isSlotStateUsable(state, now) && state) {
    slotIso = state.selected_slot_at;
    slotDateStr = state.selected_date ?? '';
    slotTimeStr = state.selected_time ?? '';
    tz = state.selected_timezone ?? tz;
    slog('book_appointment', 'using confirmed slot from call state', { vapiCallId, slotAt: slotIso });
  } else {
    slog('book_appointment', 'no usable slot — asking model to check first', { vapiCallId });
    return {
      ok: false, outcome: 'missing_slot',
      speech:
        `No confirmed appointment time is on file for this call. Call check_availability with the caller's ` +
        `requested date and time first; once it returns "available" and the caller agrees, call book_appointment again.`,
    };
  }

  // ── Reject a past-dated slot (bad parse, stale confirmation, etc.) ────
  if (slotIsInPast(slotIso!, now)) {
    slog('book_appointment', 'resolved slot is in the past — refusing', { vapiCallId, slotAt: slotIso });
    await writeState(deps, vapiCallId, orgId, { availability_status: 'unavailable', selected_slot_at: null });
    return {
      ok: false, outcome: 'slot_in_past',
      speech:
        `That time is in the past, so I can't book it. Ask the caller for an upcoming date and time, ` +
        `then call check_availability again.`,
    };
  }

  // ── Revalidate immediately before the write ───────────────────────────
  const stillFree = await isSlotFree(deps, orgId, slotIso!, tz);
  slog('book_appointment', 'revalidation', { vapiCallId, slotAt: slotIso, stillFree });
  if (!stillFree) {
    // The slot might be occupied by THIS call's own earlier booking (a
    // prior invocation inserted it but crashed before markResult). If so,
    // that's "already booked", not a conflict — repair the state row.
    const ownPrior = await findExistingVoiceBooking(deps, {
      orgId, contactId: state?.contact_id ?? null, slotIso: slotIso!,
    });
    if (ownPrior) {
      await markResult(deps, vapiCallId, orgId, ownPrior);
      slog('book_appointment', 'slot taken by this call\'s own prior insert — adopting', { vapiCallId, appointmentId: ownPrior });
      return {
        ok: true, outcome: 'already_booked', appointmentId: ownPrior,
        speech: `You're all set — this appointment is already booked. Nothing more is needed.`,
      };
    }
    await writeState(deps, vapiCallId, orgId, { availability_status: 'unavailable', selected_slot_at: null });
    return {
      ok: false, outcome: 'slot_taken',
      speech:
        `That time was just taken by another booking. Ask the caller for a different time, ` +
        `then call check_availability again before booking.`,
    };
  }

  // ── Resolve contact (reuse save_lead's; only upsert as a fallback) ─────
  let contactId = state?.contact_id ?? null;
  if (!contactId) {
    contactId = await deps.upsertContact({
      tenantId: orgId,
      name: String(args.name ?? ''),
      phone: String(args.phone ?? callerPhone ?? ''),
      email: String(args.email ?? ''),
      address: String(args.address ?? ''),
    });
    if (contactId) await writeState(deps, vapiCallId, orgId, { contact_id: contactId });
  }

  // ── Atomic claim ─────────────────────────────────────────────────────
  const claim = await claimBooking(deps, vapiCallId, orgId, 'book');
  if (claim === 'error') {
    // Backend fault (most likely: scheduling-state table absent). Never
    // present this as success — the model must not tell the caller they
    // are booked.
    return {
      ok: false, outcome: 'write_failed',
      speech:
        `I couldn't complete the booking in our system just now, so it is NOT booked. ` +
        `Tell the caller our team will call them back shortly to finish scheduling.`,
    };
  }
  if (claim === 'lost') {
    const fresh = await loadState(deps, vapiCallId, orgId);
    let priorId = fresh?.resulting_appointment_id ?? null;

    // The claim owner may have inserted the appointment but crashed before
    // markResult (so resulting_appointment_id is still null). Look for it by
    // the authoritative (org, contact, slot, source) key BEFORE reclaiming,
    // so a stale-claim retry can never insert a second appointment for a
    // slot this call already booked.
    if (!priorId) {
      priorId = await findExistingVoiceBooking(deps, { orgId, contactId, slotIso: slotIso! });
      if (priorId) {
        await markResult(deps, vapiCallId, orgId, priorId); // repair the state row
        slog('book_appointment', 'stale claim — appointment already exists, adopting', { vapiCallId, appointmentId: priorId });
      }
    }

    if (priorId) {
      return {
        ok: true, outcome: 'already_booked', appointmentId: priorId,
        speech: `You're all set — this appointment is already booked. Nothing more is needed.`,
      };
    }

    // consumed_at is set, no appointment exists anywhere — the invocation
    // that first claimed it timed out / was frozen BEFORE its insert.
    // Reclaim a STALE claim so this retry finishes the booking instead of
    // looping forever on "one moment".
    const reclaimed = await reclaimStaleBooking(deps, vapiCallId, orgId);
    if (!reclaimed) {
      return {
        ok: false, outcome: 'book_in_progress',
        speech:
          `That booking is still being finalized by another request. Wait a few seconds, ` +
          `then call book_appointment one more time.`,
      };
    }
    slog('book_appointment', 'proceeding after reclaiming a stale claim', { vapiCallId });
  }

  // ── DB write ─────────────────────────────────────────────────────────
  // voice_call_id is linked off the hot path (end-of-call) — see note above.
  const endsAt = new Date(new Date(slotIso!).getTime() + DEFAULT_DURATION_MIN * 60 * 1000).toISOString();
  const service = String(args.service ?? 'Consultation') || 'Consultation';
  const noteParts = [
    args.budget && `Budget: ${args.budget}`,
    args.timeline && `Timeline: ${args.timeline}`,
    args.notes && String(args.notes),
  ].filter(Boolean);

  slog('book_appointment', 'db write start', { vapiCallId, slotAt: slotIso });
  const { data: appt, error: apptErr } = await deps.supabase
    .from('appointments')
    .insert({
      org_id: orgId,
      contact_id: contactId,
      contact_name: String(args.name ?? '') || null,
      contact_phone: String(args.phone ?? callerPhone ?? '') || null,
      contact_email: String(args.email ?? '') || null,
      address: String(args.address ?? '') || null,
      service,
      title: service,
      budget: String(args.budget ?? '') || null,
      notes: noteParts.join(' | ') || null,
      scheduled_at: slotIso,
      ends_at: endsAt,
      duration_min: DEFAULT_DURATION_MIN,
      time_zone: tz,
      source: 'Voice AI',
      status: 'scheduled',
      voice_call_id: null,
    })
    .select('id')
    .single();

  if (apptErr || !appt?.id) {
    slogError('book_appointment', 'db write FAILED', { vapiCallId, code: (apptErr as any)?.code });
    await releaseBooking(deps, vapiCallId, orgId);
    return {
      ok: false, outcome: 'write_failed',
      speech:
        `I've got your details, but I couldn't confirm the appointment in our system just now. ` +
        `Our team will call you shortly to lock in the time — I have not booked it yet.`,
    };
  }

  await markResult(deps, vapiCallId, orgId, appt.id as string);
  slog('book_appointment', 'db write success', { vapiCallId, appointmentId: appt.id, consumed: true });

  return {
    ok: true, outcome: 'booked', appointmentId: appt.id as string,
    speech: `You're all set. I booked your free on-site estimate for ${
      formatSlotSpeech(slotDateStr, slotTimeStr, now)
    }. Our estimator will call before arriving.`,
  };
}

// ─────────────────────────────────────────────
// reschedule_appointment
// ─────────────────────────────────────────────

export interface RescheduleArgs {
  new_date?: string;
  new_time?: string;
  /** Optional — the existing appointment's date, used only to disambiguate when the caller has several. */
  current_date?: string;
  name?: string;
  phone?: string;
}

interface CandidateAppt {
  id: string;
  scheduled_at: string;
  time_zone: string | null;
  duration_min: number | null;
}

async function resolveContactIdForCall(
  deps: SchedulingDeps,
  state: SchedulingState | null,
  vapiCallId: string,
  orgId: string,
  callerPhone: string | null,
): Promise<string | null> {
  if (state?.contact_id) return state.contact_id;
  const rowId = await resolveVoiceCallRowId(deps, vapiCallId);
  if (rowId) {
    const { data } = await deps.supabase.from('voice_calls').select('contact_id').eq('id', rowId).maybeSingle();
    if (data?.contact_id) return data.contact_id as string;
  }
  if (callerPhone) {
    const { data } = await deps.supabase
      .from('contacts').select('id').eq('org_id', orgId).eq('phone', callerPhone).maybeSingle();
    if (data?.id) return data.id as string;
  }
  return null;
}

export async function handleRescheduleAppointment(
  deps: SchedulingDeps,
  params: { vapiCallId: string; orgId: string; args: RescheduleArgs; callerPhone: string | null },
): Promise<SchedulingResult> {
  const now = clock(deps);
  const { vapiCallId, orgId, args, callerPhone } = params;
  const newDate = String(args.new_date ?? '').trim();
  const newTime = String(args.new_time ?? '').trim();
  const currentDateHint = String(args.current_date ?? '').trim();

  slog('reschedule_appointment', 'called', {
    vapiCallId, orgId, hasNewDate: !!newDate, hasNewTime: !!newTime, hasCurrentHint: !!currentDateHint,
  });

  const state = await loadState(deps, vapiCallId, orgId);

  // ── Identify the appointment being moved ──────────────────────────────
  let target: CandidateAppt | null = null;

  if (state?.existing_appointment_id) {
    const { data } = await deps.supabase
      .from('appointments')
      .select('id, scheduled_at, time_zone, duration_min')
      .eq('id', state.existing_appointment_id)
      .eq('org_id', orgId)
      .neq('status', 'cancelled')
      .maybeSingle();
    if (data) target = data as CandidateAppt;
  }

  if (!target) {
    const contactId = await resolveContactIdForCall(deps, state, vapiCallId, orgId, callerPhone);
    if (!contactId) {
      return {
        ok: false, outcome: 'no_appointment',
        speech:
          `I can't find this caller in our system, so there's no existing appointment to move. ` +
          `If they want a new appointment, use check_availability and book_appointment instead.`,
      };
    }

    const { data: rows, error } = await deps.supabase
      .from('appointments')
      .select('id, scheduled_at, time_zone, duration_min')
      .eq('org_id', orgId)
      .eq('contact_id', contactId)
      .in('status', ['scheduled', 'confirmed'])
      .gte('scheduled_at', new Date(now.getTime() - 3600 * 1000).toISOString())
      .order('scheduled_at', { ascending: true });

    if (error) {
      slogError('reschedule_appointment', 'candidate query failed', { vapiCallId, orgId });
      return {
        ok: false, outcome: 'write_failed',
        speech: `I had trouble looking that up. Our team will follow up to reschedule — nothing has changed yet.`,
      };
    }

    let candidates = (rows ?? []) as CandidateAppt[];

    if (candidates.length === 0) {
      return {
        ok: false, outcome: 'no_appointment',
        speech: `I don't see an upcoming appointment for this caller to reschedule. Would they like to book a new one?`,
      };
    }

    if (candidates.length > 1 && currentDateHint) {
      const hintDate = parseNaturalDate(currentDateHint, now);
      if (hintDate) {
        const hy = hintDate.getUTCFullYear(), hm = hintDate.getUTCMonth() + 1, hd = hintDate.getUTCDate();
        candidates = candidates.filter((c) => {
          const lp = localParts(new Date(c.scheduled_at), c.time_zone || 'UTC');
          return lp.year === hy && lp.month === hm && lp.day === hd;
        });
      }
    }

    if (candidates.length === 0) {
      return {
        ok: false, outcome: 'no_appointment',
        speech: `I couldn't match an existing appointment to that date. Ask the caller which day their current appointment is on.`,
      };
    }

    if (candidates.length > 1) {
      const list = candidates
        .map((c) => {
          const d = new Date(c.scheduled_at);
          return d.toLocaleString('en-US', {
            weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
            hour12: true, timeZone: c.time_zone || 'UTC',
          });
        })
        .join('; ');
      slog('reschedule_appointment', 'ambiguous — multiple upcoming appointments', { vapiCallId, count: candidates.length });
      return {
        ok: false, outcome: 'ambiguous_appointment',
        speech:
          `This caller has ${candidates.length} upcoming appointments: ${list}. ` +
          `Ask which one to move, then call reschedule_appointment again with current_date set to that day.`,
      };
    }

    target = candidates[0];
    await writeState(deps, vapiCallId, orgId, {
      existing_appointment_id: target.id,
      action_type: 'reschedule',
      contact_id: contactId,
    });
  }

  // ── Resolve the new slot ─────────────────────────────────────────────
  const tz = state?.selected_timezone ?? target.time_zone ?? (await deps.getOrgTimezone(orgId).catch(() => 'UTC'));
  let newSlotIso: string | null = null;
  let newSlotDateStr = '';
  let newSlotTimeStr = '';

  if (newDate && newTime) {
    const resolved = resolveSlotInstant(newDate, newTime, tz, now);
    if (!resolved) {
      return { ok: false, outcome: 'bad_date', speech: `I couldn't understand that new date or time. Say it like "Thursday at 2 PM".` };
    }
    newSlotIso = resolved.iso;
    newSlotDateStr = newDate;
    newSlotTimeStr = newTime;
  } else if (isSlotStateUsable(state, now) && state) {
    newSlotIso = state.selected_slot_at;
    newSlotDateStr = state.selected_date ?? '';
    newSlotTimeStr = state.selected_time ?? '';
  } else {
    return {
      ok: false, outcome: 'missing_slot',
      speech:
        `No new time is confirmed yet. Call check_availability with the caller's requested new date and time; ` +
        `once it returns "available" and the caller agrees, call reschedule_appointment again.`,
    };
  }

  // ── Reject a past-dated new slot ─────────────────────────────────────
  if (slotIsInPast(newSlotIso!, now)) {
    slog('reschedule_appointment', 'new slot is in the past — refusing', { vapiCallId, slotAt: newSlotIso });
    await writeState(deps, vapiCallId, orgId, { availability_status: 'unavailable', selected_slot_at: null });
    return {
      ok: false, outcome: 'slot_in_past',
      speech:
        `That new time is in the past, so I can't move it there. Ask the caller for an upcoming date and time, ` +
        `then call check_availability again.`,
    };
  }

  // ── Idempotency: already at the target instant ───────────────────────
  if (Math.abs(new Date(target.scheduled_at).getTime() - new Date(newSlotIso!).getTime()) < 60 * 1000) {
    await markResult(deps, vapiCallId, orgId, target.id);
    slog('reschedule_appointment', 'idempotent hit — already at target slot', { vapiCallId, appointmentId: target.id });
    return {
      ok: true, outcome: 'already_rescheduled', appointmentId: target.id,
      speech: `That's already done — the appointment is set for ${
        newSlotDateStr && newSlotTimeStr ? formatSlotSpeech(newSlotDateStr, newSlotTimeStr, now) : 'the new time'
      }. Nothing more is needed.`,
    };
  }

  // ── Revalidate the new slot (excluding the appointment being moved) ──
  const stillFree = await isSlotFree(deps, orgId, newSlotIso!, tz, target.id);
  slog('reschedule_appointment', 'revalidation', { vapiCallId, slotAt: newSlotIso, stillFree });
  if (!stillFree) {
    await writeState(deps, vapiCallId, orgId, { availability_status: 'unavailable', selected_slot_at: null });
    return {
      ok: false, outcome: 'slot_taken',
      speech: `That new time was just taken. Ask the caller for another time, then call check_availability again.`,
    };
  }

  // ── DB write ─────────────────────────────────────────────────────────
  const endsAt = new Date(new Date(newSlotIso!).getTime() + (target.duration_min ?? DEFAULT_DURATION_MIN) * 60 * 1000).toISOString();
  slog('reschedule_appointment', 'db write start', { vapiCallId, appointmentId: target.id, slotAt: newSlotIso });
  const { error: updErr } = await deps.supabase
    .from('appointments')
    .update({ scheduled_at: newSlotIso, ends_at: endsAt, time_zone: tz })
    .eq('id', target.id)
    .eq('org_id', orgId);

  if (updErr) {
    slogError('reschedule_appointment', 'db write FAILED', { vapiCallId, appointmentId: target.id, code: (updErr as any)?.code });
    return {
      ok: false, outcome: 'write_failed',
      speech:
        `I couldn't update the appointment just now, so it is still at the original time. ` +
        `Our team will follow up to move it — please don't consider it changed yet.`,
    };
  }

  await markResult(deps, vapiCallId, orgId, target.id);
  slog('reschedule_appointment', 'db write success', { vapiCallId, appointmentId: target.id, consumed: true });

  return {
    ok: true, outcome: 'rescheduled', appointmentId: target.id,
    speech: `Done. I moved your appointment to ${
      newSlotDateStr && newSlotTimeStr ? formatSlotSpeech(newSlotDateStr, newSlotTimeStr, now) : 'the new time'
    }. Our estimator will call before arriving.`,
  };
}

// ─────────────────────────────────────────────
// Shared helper
// ─────────────────────────────────────────────

/** Map Vapi's call id to the internal voice_calls.id, or null if not written yet. */
async function resolveVoiceCallRowId(deps: SchedulingDeps, vapiCallId: string): Promise<string | null> {
  const { data } = await deps.supabase
    .from('voice_calls')
    .select('id')
    .eq('vapi_call_id', vapiCallId)
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}
