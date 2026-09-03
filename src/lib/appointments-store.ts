// src/lib/appointments-store.ts
//
// Platform State Sync Phase S4D — Calendar / Appointments shared server state.
//
// BEFORE S4D: this file was a bag of stateless async functions plus THREE
// instance-local hooks that each kept their own `useState` + `useEffect`
// fetch and their own `refresh()`:
//   - `calendar.tsx` held a private `useState<Appointment[]>` + a
//     `useCallback` range fetch (`listAppointments(rangeStart, rangeEnd)`)
//   - every `EntityAppointmentsPanel` (Contact/Lead/Deal/Project/Account)
//     had its own `useAppointmentsForEntity` list
//   - every `AppointmentDetailSheet` had its own `useAppointment(id)` row
// There was NO shared cache and NO realtime. The consequence (Phase 10.3
// gap): an appointment created/edited/deleted from an entity panel only
// refreshed THAT panel — the Calendar page and the Command Center's
// Bookings Today / Next Booking stayed stale until a remount/refocus.
//
// AFTER S4D: ONE TanStack Query per org (`queryKeys.appointments(orgId)`) —
// the whole org's appointment list, with every Calendar view (day/week/
// month/agenda), every entity panel, and every detail sheet derived from
// it CLIENT-SIDE (by date / status / entity). `useAppointments()` is the
// new shared hook; `useAppointment(id)` and `useAppointmentsForEntity(...)`
// keep their exact return shapes but are now pure slices of that one query.
// All mutations (`createAppointment` / `updateAppointment` /
// `deleteAppointment` + the status helpers that delegate to them) patch +
// invalidate `["appointments"]` AND `queryKeys.dashboard.summary(orgId)`
// (the Command Center's three appointment sub-queries) on the shared
// client — so no caller has to remember dashboard invalidation. The
// central RealtimeBridge also invalidates `["appointments"]` on any
// `appointments` row change.
//
// UNCHANGED by S4D:
//  - `mapRow` normalisation (same APPOINTMENT_COLUMNS select + assignee
//    join), timezone handling (`time_zone` stored verbatim; every render
//    formats with `toLocaleString({ timeZone })` — no UTC/local drift)
//  - `getAppointmentStatusPatch()` completed_at / cancelled_at lifecycle
//    (appointment-status.ts) — the one place status transitions resolve
//  - the Contact-autofill logic in appointment-dialog.tsx (form-level, not
//    here)
//  - `getAppointment` one-off read (still used by the "open Edit from
//    detail sheet" paths), `listAppointmentActivities` /
//    `useAppointmentActivities` (separate small per-appointment table),
//    `findAssigneeConflict` (pure), `getSessionContext` (pure)
//  - calendar-events.ts (pure Task/phase/milestone overlay mapping — never
//    touched appointments; Tasks stay their own S4C query)

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { getQueryClient } from "@/lib/query-client";
import { useOrgId } from "@/lib/org-id";
import { queryKeys } from "@/lib/query-keys";
import {
  getAppointmentStatusPatch,
  type AppointmentStatus, type AppointmentType, type AppointmentSource, type AppointmentEntityType,
} from "@/lib/appointment-status";

export type Appointment = {
  id: string;
  orgId: string;
  title: string;
  service: string | null;
  appointmentType: AppointmentType;
  status: AppointmentStatus;
  source: AppointmentSource;
  scheduledAt: string;
  endsAt: string;
  durationMin: number;
  timeZone: string;
  assignedTo: string | null;
  assigneeName: string | null;
  entityType: AppointmentEntityType | null;
  entityId: string | null;
  contactId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  address: string | null;
  /**
   * Property-address mode only (metadata.meetingLocationType ===
   * "property_address"). Tri-state, from appointments.address_is_override:
   *   null  → legacy row / unknown intent → `address` is authoritative,
   *           shown as-is, no Contact inheritance.
   *   false → explicitly inherit → display the linked Contact's *current*
   *           address; `address` is only a fallback snapshot.
   *   true  → explicit override → `address` is authoritative.
   * Office / "other" location modes ignore this entirely.
   */
  addressIsOverride: boolean | null;
  meetingUrl: string | null;
  notes: string | null;
  budget: string | null;
  reminderMinutes: number[] | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancellationReason: string | null;
  googleCalendarId: string | null;
  gcalEventId: string | null;
  googleSyncStatus: string | null;
  googleSyncedAt: string | null;
  googleLastError: string | null;
  voiceCallId: string | null;
  calendlyEventId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type AppointmentActivity = {
  id: string;
  appointmentId: string;
  actorId: string | null;
  activityType: string;
  summary: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

const APPOINTMENT_COLUMNS = `
  *,
  assignee_profile:profiles!appointments_assigned_to_fkey(first_name,last_name,email)
`;

const VALID_STATUSES: AppointmentStatus[] = [
  "scheduled", "confirmed", "in_progress", "completed", "cancelled", "no_show",
];
const VALID_TYPES: AppointmentType[] = [
  "consultation", "estimate", "site_visit", "service", "follow_up", "internal", "other",
];

function toAppStatus(status: string | null): AppointmentStatus {
  return (VALID_STATUSES as string[]).includes(status ?? "") ? (status as AppointmentStatus) : "scheduled";
}

function toAppType(type: string | null): AppointmentType {
  return (VALID_TYPES as string[]).includes(type ?? "") ? (type as AppointmentType) : "consultation";
}

export async function getSessionContext(): Promise<{ orgId: string | null; userId: string | null }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { orgId: null, userId: null };

  const { data: profile } = await supabase
    .from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
  if (profile?.organization_id) return { orgId: profile.organization_id, userId: user.id };

  const { data: membership } = await supabase
    .from("org_memberships").select("org_id").eq("member_id", user.id).maybeSingle();
  return { orgId: membership?.org_id ?? null, userId: user.id };
}

function mapRow(row: any): Appointment {
  const durationMin = row.duration_min ?? 60;
  const scheduledAt = row.scheduled_at;
  const endsAt = row.ends_at ?? new Date(new Date(scheduledAt).getTime() + durationMin * 60000).toISOString();

  const assigneeName =
    row.assignee_profile?.first_name || row.assignee_profile?.last_name
      ? `${row.assignee_profile?.first_name ?? ""} ${row.assignee_profile?.last_name ?? ""}`.trim()
      : row.assignee_profile?.email ?? null;

  return {
    id: row.id,
    orgId: row.org_id,
    title: row.title || row.service || "Appointment",
    service: row.service ?? null,
    appointmentType: toAppType(row.appointment_type),
    status: toAppStatus(row.status),
    source: (row.source ?? "manual") as AppointmentSource,
    scheduledAt,
    endsAt,
    durationMin,
    timeZone: row.time_zone || "America/New_York",
    assignedTo: row.assigned_to ?? null,
    assigneeName,
    entityType: (row.entity_type as AppointmentEntityType | null) ?? null,
    entityId: row.entity_id ?? null,
    contactId: row.contact_id ?? null,
    contactName: row.contact_name ?? null,
    contactPhone: row.contact_phone ?? null,
    contactEmail: row.contact_email ?? null,
    address: row.address ?? null,
    // Tri-state — a missing/NULL column stays null (legacy semantics), only
    // an explicit true/false is carried through.
    addressIsOverride: row.address_is_override === null || row.address_is_override === undefined
      ? null
      : Boolean(row.address_is_override),
    meetingUrl: row.meeting_url ?? null,
    notes: row.notes ?? null,
    budget: row.budget ?? null,
    reminderMinutes: row.reminder_minutes ?? null,
    completedAt: row.completed_at ?? null,
    cancelledAt: row.cancelled_at ?? null,
    cancelledBy: row.cancelled_by ?? null,
    cancellationReason: row.cancellation_reason ?? null,
    googleCalendarId: row.google_calendar_id ?? null,
    gcalEventId: row.gcal_event_id ?? null,
    googleSyncStatus: row.google_sync_status ?? null,
    googleSyncedAt: row.google_synced_at ?? null,
    googleLastError: row.google_last_error ?? null,
    voiceCallId: row.voice_call_id ?? null,
    calendlyEventId: row.calendly_event_id ?? null,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The Appointments list queryFn — the WHOLE org's appointments (org-scoped,
 * scheduled_at ascending), with assignee display resolved via the same
 * server-side `profiles` join the pre-S4D reads used. Self-contained (no
 * React, no other query's cache). Calendar views filter this to their
 * visible window client-side (never a query per date/view). Entity panels
 * filter it by (entity_type, entity_id).
 */
export async function fetchAppointmentsForOrg(orgId: string): Promise<Appointment[]> {
  const { data, error } = await supabase
    .from("appointments")
    .select(APPOINTMENT_COLUMNS)
    .eq("org_id", orgId)
    .order("scheduled_at", { ascending: true });

  if (error) {
    console.error("[appointments-store] fetch failed:", error);
    throw error;
  }
  return (data ?? []).map(mapRow);
}

// ── Query cache helpers ──────────────────────────────────────────────────

const qc = () => getQueryClient();

/** Immediately reflect a CONFIRMED change into the cached list(s) — only ever called AFTER a successful DB write, never speculatively, so no rollback path is needed. */
function patchAppointmentsCache(fn: (list: Appointment[]) => Appointment[]) {
  qc().setQueriesData<Appointment[]>({ queryKey: ["appointments"] }, (old) => (Array.isArray(old) ? fn(old) : old));
}

/**
 * Every appointment mutation (create / update / reschedule / status /
 * delete) can change the Command Center's Bookings Today count, its
 * Bookings sparkline, and its Next Booking card — all served by
 * dashboardSummaryQuery's own `appointments` sub-queries (index.tsx), not
 * by useAppointments(). So the shared list AND dashboard.summary are the
 * two real dependents; nothing else (contacts/leads/deals/projects/tasks
 * link TO an appointment but render none of its data).
 */
function invalidateAppointmentsWithDashboard() {
  void qc().invalidateQueries({ queryKey: ["appointments"] });
  void qc().invalidateQueries({ queryKey: ["dashboard"] });
}

// ── Public hooks ─────────────────────────────────────────────────────────

function useAppointmentsQuery() {
  const orgId = useOrgId();
  return useQuery({
    queryKey: orgId ? queryKeys.appointments(orgId) : ["appointments", "_pending"],
    queryFn: () => fetchAppointmentsForOrg(orgId as string),
    enabled: !!orgId,
    // Appointments change frequently — realtime + mutation invalidation are
    // the primary freshness path; staleTime just caps redundant refetches
    // on remount/focus churn. Background refetch keeps the prior list (no
    // Calendar blanking / event flicker).
    staleTime: 30_000,
  });
}

/** THE shared Appointments hook (S4D). One org-wide list; every Calendar view + entity panel filters it client-side. `reload()` forces a refetch of the shared query for every observer and resolves when it settles (so a "Refresh" button can await it). */
export function useAppointments(): { appointments: Appointment[]; loading: boolean; reload: () => Promise<void> } {
  const query = useAppointmentsQuery();
  return {
    appointments: query.data ?? [],
    loading: query.isLoading,
    reload: () => query.refetch().then(() => undefined),
  };
}

/**
 * One appointment by id — now a PURE slice of the shared list (the detail
 * sheet is only ever opened for an appointment already visible in a list,
 * so it's always cached). `{ appointment, loading, refresh }` shape kept;
 * `refresh` refetches the shared query. If an id somehow isn't cached yet
 * (e.g. a cross-tab create before realtime lands), `appointment` is null
 * until the next refetch — the sheet handles null gracefully.
 */
export function useAppointment(id: string | null | undefined) {
  const { appointments, loading, reload } = useAppointments();
  const appointment = id ? (appointments.find((a) => a.id === id) ?? null) : null;
  return { appointment, loading: loading && !appointment, refresh: reload };
}

/** One appointment by id — one-off (non-reactive) fetch. Used by "open Edit" flows that need the full row before the shared list may have it. */
export async function getAppointment(id: string): Promise<Appointment | null> {
  const { data, error } = await supabase
    .from("appointments")
    .select(APPOINTMENT_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("[appointments-store] getAppointment failed:", error);
    return null;
  }
  return data ? mapRow(data) : null;
}

/**
 * Org-scoped, entity-linked appointments for CRM detail panels
 * (Contact/Lead/Deal/Company/Project) — now a CLIENT-SIDE filter of the
 * shared list (was its own per-panel useState + fetch). `{ appointments,
 * loading, refresh }` shape kept.
 */
export function useAppointmentsForEntity(entityType: AppointmentEntityType, entityId: string | null | undefined) {
  const { appointments, loading, reload } = useAppointments();
  const filtered = entityId
    ? appointments.filter((a) => a.entityType === entityType && a.entityId === entityId)
    : [];
  return { appointments: filtered, loading: loading && filtered.length === 0, refresh: reload };
}

export type CreateAppointmentInput = {
  title: string;
  appointmentType: AppointmentType;
  status?: AppointmentStatus;
  source?: AppointmentSource;
  scheduledAt: string;
  endsAt: string;
  timeZone: string;
  assignedTo?: string | null;
  entityType?: AppointmentEntityType | null;
  entityId?: string | null;
  contactId?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  address?: string | null;
  /**
   * Property-address mode only. Pass an explicit true/false for every
   * appointment the app creates or edits — true = the address is an
   * appointment-specific override, false = inherit the linked Contact's
   * current address. Omitted → column left untouched (create: stays NULL /
   * legacy; update: unchanged). Never write null explicitly.
   */
  addressIsOverride?: boolean;
  meetingUrl?: string | null;
  notes?: string | null;
  reminderMinutes?: number[] | null;
  metadata?: Record<string, unknown>;
};

function minutesBetween(startIso: string, endIso: string): number {
  return Math.max(15, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000));
}

/** Contact stays the authoritative FK when entityType is "contact" — kept in sync so pre-existing contact_id-based reads (Contact related tab, Inbox context panel) keep working unchanged. */
function contactIdForEntity(input: { entityType?: AppointmentEntityType | null; entityId?: string | null; contactId?: string | null }): string | null {
  if (input.entityType === "contact" && input.entityId) return input.entityId;
  return input.contactId ?? null;
}

export async function createAppointment(input: CreateAppointmentInput): Promise<{ ok: true; appointment: Appointment } | { ok: false; error: string }> {
  const { orgId, userId } = await getSessionContext();
  if (!orgId) return { ok: false, error: "No organization found for the current user." };

  const typeIsNull = (input.entityType ?? null) === null;
  const idIsNull = (input.entityId ?? null) === null;
  if (typeIsNull !== idIsNull) {
    return { ok: false, error: "entityType and entityId must be provided together." };
  }

  const insertPayload: Record<string, unknown> = {
    org_id: orgId,
    title: input.title.trim(),
    service: input.title.trim(),
    appointment_type: input.appointmentType,
    status: input.status ?? "scheduled",
    source: input.source ?? "manual",
    scheduled_at: input.scheduledAt,
    ends_at: input.endsAt,
    duration_min: minutesBetween(input.scheduledAt, input.endsAt),
    time_zone: input.timeZone,
    assigned_to: input.assignedTo ?? null,
    entity_type: input.entityType ?? null,
    entity_id: input.entityId ?? null,
    contact_id: contactIdForEntity(input),
    contact_name: input.contactName?.trim() || null,
    contact_phone: input.contactPhone?.trim() || null,
    contact_email: input.contactEmail?.trim() || null,
    address: input.address?.trim() || null,
    ...(input.addressIsOverride !== undefined ? { address_is_override: input.addressIsOverride } : {}),
    meeting_url: input.meetingUrl?.trim() || null,
    notes: input.notes?.trim() || null,
    reminder_minutes: input.reminderMinutes ?? null,
    metadata: input.metadata ?? {},
  };
  void userId;

  const { data, error } = await supabase
    .from("appointments")
    .insert(insertPayload)
    .select(APPOINTMENT_COLUMNS)
    .single();

  if (error || !data) {
    console.error("[appointments-store] createAppointment failed:", error);
    return { ok: false, error: error?.message ?? "Could not create the appointment." };
  }
  const appointment = mapRow(data);
  patchAppointmentsCache((list) => [appointment, ...list.filter((a) => a.id !== appointment.id)]);
  invalidateAppointmentsWithDashboard();
  return { ok: true, appointment };
}

export type UpdateAppointmentInput = Partial<Omit<CreateAppointmentInput, "scheduledAt" | "endsAt">> & {
  scheduledAt?: string;
  endsAt?: string;
  cancellationReason?: string | null;
};

export async function updateAppointment(id: string, patch: UpdateAppointmentInput): Promise<{ ok: true; appointment: Appointment } | { ok: false; error: string }> {
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (patch.title !== undefined) { update.title = patch.title.trim(); update.service = patch.title.trim(); }
  if (patch.appointmentType !== undefined) update.appointment_type = patch.appointmentType;
  if (patch.source !== undefined) update.source = patch.source;
  if (patch.timeZone !== undefined) update.time_zone = patch.timeZone;
  if (patch.assignedTo !== undefined) update.assigned_to = patch.assignedTo;
  if (patch.contactName !== undefined) update.contact_name = patch.contactName?.trim() || null;
  if (patch.contactPhone !== undefined) update.contact_phone = patch.contactPhone?.trim() || null;
  if (patch.contactEmail !== undefined) update.contact_email = patch.contactEmail?.trim() || null;
  if (patch.address !== undefined) update.address = patch.address?.trim() || null;
  if (patch.addressIsOverride !== undefined) update.address_is_override = patch.addressIsOverride;
  if (patch.meetingUrl !== undefined) update.meeting_url = patch.meetingUrl?.trim() || null;
  if (patch.notes !== undefined) update.notes = patch.notes?.trim() || null;
  if (patch.reminderMinutes !== undefined) update.reminder_minutes = patch.reminderMinutes;
  if (patch.cancellationReason !== undefined) update.cancellation_reason = patch.cancellationReason;
  if (patch.metadata !== undefined) update.metadata = patch.metadata;

  if (patch.entityType !== undefined || patch.entityId !== undefined) {
    const typeIsNull = (patch.entityType ?? null) === null;
    const idIsNull = (patch.entityId ?? null) === null;
    if (typeIsNull !== idIsNull) return { ok: false, error: "entityType and entityId must be cleared/set together." };
    update.entity_type = patch.entityType ?? null;
    update.entity_id = patch.entityId ?? null;
    update.contact_id = contactIdForEntity(patch);
  }

  if (patch.scheduledAt !== undefined && patch.endsAt !== undefined) {
    update.scheduled_at = patch.scheduledAt;
    update.ends_at = patch.endsAt;
    update.duration_min = minutesBetween(patch.scheduledAt, patch.endsAt);
  } else if (patch.scheduledAt !== undefined) {
    update.scheduled_at = patch.scheduledAt;
  } else if (patch.endsAt !== undefined) {
    update.ends_at = patch.endsAt;
  }

  if (patch.status !== undefined) {
    const { data: current } = await supabase.from("appointments").select("completed_at, cancelled_at").eq("id", id).maybeSingle();
    const resolved = getAppointmentStatusPatch(patch.status, { completedAt: current?.completed_at ?? null, cancelledAt: current?.cancelled_at ?? null });
    update.status = resolved.status;
    update.completed_at = resolved.completedAt;
    update.cancelled_at = resolved.cancelledAt;
  }

  const { data, error } = await supabase
    .from("appointments")
    .update(update)
    .eq("id", id)
    .select(APPOINTMENT_COLUMNS)
    .single();

  if (error || !data) {
    console.error("[appointments-store] updateAppointment failed:", error);
    return { ok: false, error: error?.message ?? "Could not update the appointment." };
  }
  const appointment = mapRow(data);
  patchAppointmentsCache((list) => list.map((a) => (a.id === id ? appointment : a)));
  invalidateAppointmentsWithDashboard();
  return { ok: true, appointment };
}

export async function deleteAppointment(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.from("appointments").delete().eq("id", id);
  if (error) {
    console.error("[appointments-store] deleteAppointment failed:", error);
    return { ok: false, error: error.message };
  }
  patchAppointmentsCache((list) => list.filter((a) => a.id !== id));
  invalidateAppointmentsWithDashboard();
  return { ok: true };
}

async function setStatus(id: string, status: AppointmentStatus) {
  return updateAppointment(id, { status });
}

export const confirmAppointment = (id: string) => setStatus(id, "confirmed");
export const startAppointment = (id: string) => setStatus(id, "in_progress");
export const completeAppointment = (id: string) => setStatus(id, "completed");
export const reopenAppointment = (id: string) => setStatus(id, "scheduled");
export const restoreAppointment = (id: string) => setStatus(id, "scheduled");
export const markAppointmentNoShow = (id: string) => setStatus(id, "no_show");

export async function cancelAppointment(id: string, reason?: string | null) {
  return updateAppointment(id, { status: "cancelled", cancellationReason: reason ?? null });
}

function mapActivityRow(row: any): AppointmentActivity {
  return {
    id: row.id,
    appointmentId: row.appointment_id,
    actorId: row.actor_id ?? null,
    activityType: row.activity_type,
    summary: row.summary,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

export async function listAppointmentActivities(appointmentId: string): Promise<AppointmentActivity[]> {
  const { data, error } = await supabase
    .from("appointment_activities")
    .select("id, appointment_id, actor_id, activity_type, summary, metadata, created_at")
    .eq("appointment_id", appointmentId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[appointments-store] listAppointmentActivities failed:", error);
    return [];
  }
  return (data ?? []).map(mapActivityRow);
}

export function useAppointmentActivities(appointmentId: string | null | undefined) {
  const [activity, setActivity] = useState<AppointmentActivity[]>([]);
  const [loading, setLoading] = useState(!!appointmentId);

  useEffect(() => {
    if (!appointmentId) { setActivity([]); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    listAppointmentActivities(appointmentId).then((rows) => {
      if (!cancelled) { setActivity(rows); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [appointmentId]);

  return { activity, loading };
}

/** Client-side overlap check against an already-loaded window of appointments — used by the create/edit dialog for the non-blocking assignee-conflict warning. Excludes cancelled/no_show and the appointment being edited. */
export function findAssigneeConflict(
  appointments: Appointment[],
  assignedTo: string,
  scheduledAt: string,
  endsAt: string,
  excludeId?: string,
): Appointment | null {
  const newStart = new Date(scheduledAt).getTime();
  const newEnd = new Date(endsAt).getTime();
  return appointments.find((a) =>
    a.id !== excludeId &&
    a.assignedTo === assignedTo &&
    a.status !== "cancelled" && a.status !== "no_show" &&
    new Date(a.scheduledAt).getTime() < newEnd &&
    new Date(a.endsAt).getTime() > newStart,
  ) ?? null;
}
