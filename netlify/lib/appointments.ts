// netlify/lib/appointments.ts
//
// Phase 10.3 — canonical SERVER-SIDE appointment creation/update helper.
// The one place a Netlify function (workflow engine, agentic actions, any
// future server-originated appointment writer) creates or updates an
// appointment, instead of hand-rolling its own `.from("appointments")`
// call. Mirrors netlify/lib/tasks.ts's "validate, insert, throw" contract.
//
// Server-only: uses a service-role SupabaseClient passed in by the caller.
// Does NOT import src/lib/appointments-store.ts (browser-only, anon-client,
// React-hook-based) — browser and server write layers stay separate.
//
// IMPORTANT — Voice AI preservation: netlify/functions/vapi-webhook.ts and
// netlify/functions/lib/post-call-automation.ts already have working,
// independent appointment-creation + Google Calendar sync logic that
// predates this helper. They are intentionally NOT refactored to call this
// helper in this pass — the existing code inserts only a subset of columns
// (org_id, contact_name, service, scheduled_at, duration_min, status,
// source: 'Voice AI', gcal_event_id, voice_call_id) which the additive
// 20260807 migration leaves fully compatible (every new column is nullable
// with a safe default), so no behavior change was required or made there.
// This helper exists for NEW writers (workflow actions, the agentic
// schedule_appointment action, future AI Chat booking) to adopt going
// forward without inventing a third insertion shape.
//
// Does not insert appointment_activities rows directly — that table is
// written exclusively by the log_appointment_activity() DB trigger (see
// the 20260807 migration), so a server INSERT/UPDATE through this helper
// gets its activity history for free, with no risk of a duplicate event.

import type { SupabaseClient } from "@supabase/supabase-js";

export type ServerAppointmentStatus = "scheduled" | "confirmed" | "in_progress" | "completed" | "cancelled" | "no_show";
export type ServerAppointmentType = "consultation" | "estimate" | "site_visit" | "service" | "follow_up" | "internal" | "other";
export type ServerAppointmentSource =
  | "manual" | "lead" | "contact" | "company" | "deal" | "project"
  | "inbox" | "ai_chat" | "ai_voice" | "workflow" | "google_calendar" | "api";
export type ServerAppointmentEntityType = "lead" | "contact" | "company" | "deal" | "project";

const VALID_STATUSES: ServerAppointmentStatus[] = ["scheduled", "confirmed", "in_progress", "completed", "cancelled", "no_show"];
const VALID_TYPES: ServerAppointmentType[] = ["consultation", "estimate", "site_visit", "service", "follow_up", "internal", "other"];
const VALID_SOURCES: ServerAppointmentSource[] = [
  "manual", "lead", "contact", "company", "deal", "project", "inbox", "ai_chat", "ai_voice", "workflow", "google_calendar", "api",
];
const VALID_ENTITY_TYPES: ServerAppointmentEntityType[] = ["lead", "contact", "company", "deal", "project"];

export type ServerCreateAppointmentInput = {
  orgId: string;
  title: string;
  appointmentType?: ServerAppointmentType;
  status?: ServerAppointmentStatus;
  source: ServerAppointmentSource;
  scheduledAt: string;
  endsAt: string;
  timeZone: string;
  assignedTo?: string | null;
  entityType?: ServerAppointmentEntityType | null;
  entityId?: string | null;
  contactId?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  address?: string | null;
  notes?: string | null;
  /** Caller-supplied dedupe key (e.g. workflow-run id + node id) — checked against metadata.idempotencyKey before inserting. */
  idempotencyKey?: string | null;
};

function assertValidTimeRange(scheduledAt: string, endsAt: string) {
  const start = new Date(scheduledAt).getTime();
  const end = new Date(endsAt).getTime();
  if (Number.isNaN(start)) throw new Error("scheduledAt is not a valid date.");
  if (Number.isNaN(end)) throw new Error("endsAt is not a valid date.");
  if (end <= start) throw new Error("endsAt must be after scheduledAt.");
}

async function assertSameOrgAssignee(supabase: SupabaseClient, assignedTo: string, orgId: string) {
  const { data: membership } = await supabase
    .from("org_memberships").select("member_id").eq("member_id", assignedTo).eq("org_id", orgId).maybeSingle();
  if (membership) return;
  const { data: profile } = await supabase
    .from("profiles").select("id").eq("id", assignedTo).eq("organization_id", orgId).maybeSingle();
  if (!profile) throw new Error("Assignee is not a member of this organization.");
}

const ENTITY_TABLE: Record<ServerAppointmentEntityType, string> = {
  lead: "leads", contact: "contacts", company: "companies", deal: "deals", project: "projects",
};

async function assertSameOrgEntity(supabase: SupabaseClient, entityType: ServerAppointmentEntityType, entityId: string, orgId: string) {
  const table = ENTITY_TABLE[entityType];
  const { data, error } = await supabase.from(table).select("id").eq("id", entityId).eq("org_id", orgId).maybeSingle();
  if (error) throw new Error(`Could not verify the linked ${entityType}: ${error.message}`);
  if (!data) throw new Error(`Linked ${entityType} not found in this organization.`);
}

/**
 * Creates one real appointment row. Throws (never returns a fake success)
 * on any validation or insert failure.
 */
export async function createServerAppointment(
  supabase: SupabaseClient,
  input: ServerCreateAppointmentInput,
): Promise<{ appointmentId: string }> {
  if (!input.orgId) throw new Error("orgId is required to create an appointment.");
  if (!input.title || !input.title.trim()) throw new Error("Appointment title is required.");
  if (!input.timeZone) throw new Error("timeZone is required.");
  if (!VALID_SOURCES.includes(input.source)) throw new Error(`Unsupported appointment source: ${input.source}`);

  assertValidTimeRange(input.scheduledAt, input.endsAt);

  const status = input.status ?? "scheduled";
  if (!VALID_STATUSES.includes(status)) throw new Error(`Unsupported appointment status: ${status}`);

  const appointmentType = input.appointmentType ?? "consultation";
  if (!VALID_TYPES.includes(appointmentType)) throw new Error(`Unsupported appointment type: ${appointmentType}`);

  const entityType = input.entityType ?? null;
  const entityId = input.entityId ?? null;
  if ((entityType === null) !== (entityId === null)) {
    throw new Error("entityType and entityId must be provided together.");
  }
  if (entityType !== null) {
    if (!VALID_ENTITY_TYPES.includes(entityType)) throw new Error(`Unsupported appointment entity type: ${entityType}`);
    await assertSameOrgEntity(supabase, entityType, entityId as string, input.orgId);
  }

  if (input.assignedTo) {
    await assertSameOrgAssignee(supabase, input.assignedTo, input.orgId);
  }

  // Idempotency: if the caller supplies a key, refuse to double-create when
  // a prior attempt already succeeded (workflow retries, agentic re-runs).
  if (input.idempotencyKey) {
    const { data: existing } = await supabase
      .from("appointments")
      .select("id")
      .eq("org_id", input.orgId)
      .eq("metadata->>idempotencyKey", input.idempotencyKey)
      .maybeSingle();
    if (existing) return { appointmentId: existing.id as string };
  }

  const durationMin = Math.max(15, Math.round((new Date(input.endsAt).getTime() - new Date(input.scheduledAt).getTime()) / 60000));
  const contactId = entityType === "contact" ? entityId : (input.contactId ?? null);

  const insertPayload: Record<string, unknown> = {
    org_id: input.orgId,
    title: input.title.trim(),
    service: input.title.trim(),
    appointment_type: appointmentType,
    status,
    source: input.source,
    scheduled_at: input.scheduledAt,
    ends_at: input.endsAt,
    duration_min: durationMin,
    time_zone: input.timeZone,
    assigned_to: input.assignedTo ?? null,
    entity_type: entityType,
    entity_id: entityId,
    contact_id: contactId,
    contact_name: input.contactName?.trim() || null,
    contact_phone: input.contactPhone?.trim() || null,
    contact_email: input.contactEmail?.trim() || null,
    address: input.address?.trim() || null,
    notes: input.notes?.trim() || null,
    metadata: input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {},
  };

  const { data, error } = await supabase
    .from("appointments")
    .insert(insertPayload)
    .select("id")
    .single();

  if (error || !data) throw new Error(`Could not create the appointment: ${error?.message ?? "no row returned"}`);
  return { appointmentId: data.id as string };
}

export type ServerUpdateAppointmentInput = {
  orgId: string;
  status?: ServerAppointmentStatus;
  scheduledAt?: string;
  endsAt?: string;
  cancellationReason?: string | null;
};

/** Updates an existing appointment, org-scoped. Status lifecycle (completed_at/cancelled_at) is resolved the same way as the browser store — see src/lib/appointment-status.ts's getAppointmentStatusPatch for the single rule definition (duplicated here in minimal form since this file must not import browser code). */
export async function updateServerAppointment(
  supabase: SupabaseClient,
  appointmentId: string,
  input: ServerUpdateAppointmentInput,
): Promise<void> {
  if (!input.orgId) throw new Error("orgId is required to update an appointment.");

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (input.scheduledAt !== undefined && input.endsAt !== undefined) {
    assertValidTimeRange(input.scheduledAt, input.endsAt);
    update.scheduled_at = input.scheduledAt;
    update.ends_at = input.endsAt;
    update.duration_min = Math.max(15, Math.round((new Date(input.endsAt).getTime() - new Date(input.scheduledAt).getTime()) / 60000));
  }

  if (input.status !== undefined) {
    if (!VALID_STATUSES.includes(input.status)) throw new Error(`Unsupported appointment status: ${input.status}`);
    update.status = input.status;
    update.completed_at = input.status === "completed" ? new Date().toISOString() : null;
    update.cancelled_at = input.status === "cancelled" ? new Date().toISOString() : null;
    if (input.status === "cancelled" && input.cancellationReason !== undefined) {
      update.cancellation_reason = input.cancellationReason;
    }
  }

  const { data, error } = await supabase
    .from("appointments")
    .update(update)
    .eq("id", appointmentId)
    .eq("org_id", input.orgId)
    .select("id");

  if (error) throw new Error(`Could not update the appointment: ${error.message}`);
  if (!data || data.length === 0) throw new Error("Appointment not found in this organization.");
}
