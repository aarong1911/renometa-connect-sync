// src/lib/appointment-status.ts
//
// Phase 10.3 — canonical appointment configuration. The ONE place status/
// type/source labels, order, icons, colors, and lifecycle (completed_at/
// cancelled_at) rules are defined, mirroring src/lib/task-status.ts's
// pattern for Tasks. Matches the live `appointments_status_check`,
// `appointments_appointment_type_check`, and `appointments_source_check`
// constraints added by supabase/migrations/20260807_calendar_appointments_completion.sql
// — the database's own canonical values are used end-to-end, no separate
// frontend vocabulary.

import {
  CalendarClock, CalendarCheck, Clock3, CircleCheck, CircleX, UserX,
  MessagesSquare, Calculator, MapPinned, Wrench, MessageSquareReply, UsersRound, Calendar,
  type LucideIcon,
} from "lucide-react";

export type AppointmentStatus =
  | "scheduled"
  | "confirmed"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "no_show";

export type AppointmentType =
  | "consultation"
  | "estimate"
  | "site_visit"
  | "service"
  | "follow_up"
  | "internal"
  | "other";

export type AppointmentSource =
  | "manual"
  | "lead"
  | "contact"
  | "company"
  | "deal"
  | "project"
  | "inbox"
  | "ai_chat"
  | "ai_voice"
  | "workflow"
  | "google_calendar"
  | "api"
  // Legacy literal values already written by live code before Phase 10.3 —
  // grandfathered by the DB check constraint, never rejected or silently
  // remapped. See the 20260807 migration header.
  | "Voice AI"
  | "Manual";

export type AppointmentEntityType = "lead" | "contact" | "company" | "deal" | "project";

export const APPOINTMENT_STATUS_ORDER: AppointmentStatus[] = [
  "scheduled", "confirmed", "in_progress", "completed", "cancelled", "no_show",
];

export const APPOINTMENT_STATUS_LABELS: Record<AppointmentStatus, string> = {
  scheduled: "Scheduled",
  confirmed: "Confirmed",
  in_progress: "In Progress",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No Show",
};

export const APPOINTMENT_STATUS_ICONS: Record<AppointmentStatus, LucideIcon> = {
  scheduled: CalendarClock,
  confirmed: CalendarCheck,
  in_progress: Clock3,
  completed: CircleCheck,
  cancelled: CircleX,
  no_show: UserX,
};

/** Soft-accent tint per status — matches the Task/Pipeline soft-badge pattern (no saturated fills, no beige). */
export const APPOINTMENT_STATUS_TINT: Record<AppointmentStatus, { icon: string; badge: string; chip: string }> = {
  scheduled: {
    icon: "text-blue-600 dark:text-blue-400",
    badge: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/40 dark:bg-blue-500/10 dark:text-blue-400",
    chip: "bg-blue-50 text-blue-700 border-blue-200/70 dark:bg-blue-500/10 dark:text-blue-400 dark:border-blue-900/40",
  },
  confirmed: {
    icon: "text-cyan-600 dark:text-cyan-400",
    badge: "border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-900/40 dark:bg-cyan-500/10 dark:text-cyan-400",
    chip: "bg-cyan-50 text-cyan-700 border-cyan-200/70 dark:bg-cyan-500/10 dark:text-cyan-400 dark:border-cyan-900/40",
  },
  in_progress: {
    icon: "text-amber-600 dark:text-amber-400",
    badge: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/40 dark:bg-amber-500/10 dark:text-amber-400",
    chip: "bg-amber-50 text-amber-700 border-amber-200/70 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-900/40",
  },
  completed: {
    icon: "text-emerald-600 dark:text-emerald-400",
    badge: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-500/10 dark:text-emerald-400",
    chip: "bg-emerald-50 text-emerald-700 border-emerald-200/70 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-900/40",
  },
  cancelled: {
    icon: "text-rose-600 dark:text-rose-400",
    badge: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/40 dark:bg-rose-500/10 dark:text-rose-400",
    chip: "bg-rose-50 text-rose-700 border-rose-200/70 line-through dark:bg-rose-500/10 dark:text-rose-400 dark:border-rose-900/40",
  },
  no_show: {
    icon: "text-violet-600 dark:text-violet-400",
    badge: "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900/40 dark:bg-violet-500/10 dark:text-violet-400",
    chip: "bg-violet-50 text-violet-700 border-violet-200/70 dark:bg-violet-500/10 dark:text-violet-400 dark:border-violet-900/40",
  },
};

export const APPOINTMENT_TYPE_ORDER: AppointmentType[] = [
  "consultation", "estimate", "site_visit", "service", "follow_up", "internal", "other",
];

export const APPOINTMENT_TYPE_LABELS: Record<AppointmentType, string> = {
  consultation: "Consultation",
  estimate: "Estimate",
  site_visit: "Site Visit",
  service: "Service",
  follow_up: "Follow Up",
  internal: "Internal",
  other: "Other",
};

export const APPOINTMENT_TYPE_ICONS: Record<AppointmentType, LucideIcon> = {
  consultation: MessagesSquare,
  estimate: Calculator,
  site_visit: MapPinned,
  service: Wrench,
  follow_up: MessageSquareReply,
  internal: UsersRound,
  other: Calendar,
};

export const APPOINTMENT_SOURCE_LABELS: Record<AppointmentSource, string> = {
  manual: "Manual",
  lead: "Lead",
  contact: "Contact",
  company: "Account",
  deal: "Deal",
  project: "Project",
  inbox: "Inbox",
  ai_chat: "AI Chat",
  ai_voice: "Voice AI",
  workflow: "Workflow",
  google_calendar: "Google Calendar",
  api: "API",
  "Voice AI": "Voice AI",
  "Manual": "Manual",
};

export const APPOINTMENT_ENTITY_TYPE_LABELS: Record<AppointmentEntityType, string> = {
  lead: "Lead",
  contact: "Contact",
  company: "Account",
  deal: "Deal",
  project: "Project",
};

// ── Meeting Location (replaces the old free-text "Meeting URL" field) ──────
//
// No dedicated columns were added for this — genuinely not required. The
// resolved location is written to the existing `address` column (or left
// null for a remote-only meeting), the existing `meeting_url` column keeps
// its exact original meaning (populated only for meetingMode="video"), and
// the *choice* the user made (which is not otherwise reconstructable from
// address/meeting_url alone) is stored in the existing `metadata` jsonb
// column as { meetingLocationType, meetingLocationLabel, meetingMode }.
// See getMeetingLocationFromAppointment() below for the backward-compat
// read path for appointments created before this existed.

export type MeetingLocationType = "property_address" | "office" | "other";
export type MeetingMode = "in_person" | "phone" | "video";

export const MEETING_LOCATION_TYPE_LABELS: Record<MeetingLocationType, string> = {
  property_address: "Property Address",
  office: "Office",
  other: "Other",
};

export const MEETING_MODE_LABELS: Record<MeetingMode, string> = {
  in_person: "In-person",
  phone: "Phone",
  video: "Video meeting",
};

export type MeetingLocationMeta = {
  meetingLocationType: MeetingLocationType;
  meetingLocationLabel?: string;
  meetingMode?: MeetingMode;
};

/**
 * Backward-compatible resolver for appointments written before Meeting
 * Location existed (no metadata.meetingLocationType). Rule (as specified):
 * default to "property_address" when an address is present, otherwise to
 * "other"/"video" when a meeting_url is present, otherwise "other" with no
 * further assumption.
 */
export function getMeetingLocationFromAppointment(a: {
  address: string | null;
  meetingUrl: string | null;
  metadata: Record<string, unknown>;
}): MeetingLocationMeta {
  const meta = a.metadata as Partial<MeetingLocationMeta> | null | undefined;
  if (meta?.meetingLocationType) {
    return {
      meetingLocationType: meta.meetingLocationType,
      meetingLocationLabel: meta.meetingLocationLabel,
      meetingMode: meta.meetingMode,
    };
  }
  if (a.address) return { meetingLocationType: "property_address" };
  if (a.meetingUrl) return { meetingLocationType: "other", meetingMode: "video" };
  return { meetingLocationType: "other" };
}

/**
 * The address to DISPLAY / USE for an appointment, honoring the
 * inherit-vs-override tri-state (appointments.address_is_override, surfaced
 * as `addressIsOverride`). Pure — the caller supplies the linked Contact's
 * *current* address (from the shared Contacts query), so an inheriting
 * appointment tracks Contact address edits with no DB rewrite.
 *
 * Semantics only apply in "property_address" meeting mode. Office / "other"
 * modes return `appointment.address` unchanged.
 *
 *   addressIsOverride === true  → appointment.address (explicit override)
 *   addressIsOverride === false → contactAddress ?? appointment.address
 *   addressIsOverride == null   → appointment.address (legacy / authoritative)
 */
export function resolveAppointmentAddress(
  appointment: {
    address: string | null;
    addressIsOverride: boolean | null;
    meetingUrl: string | null;
    metadata: Record<string, unknown>;
  },
  contactAddress: string | null | undefined,
): string | null {
  const { meetingLocationType } = getMeetingLocationFromAppointment(appointment);
  if (meetingLocationType !== "property_address") return appointment.address ?? null;
  if (appointment.addressIsOverride === false) {
    return (contactAddress?.trim() || null) ?? appointment.address ?? null;
  }
  return appointment.address ?? null;
}

/** An appointment counts as "active" (not yet in a terminal state) for KPI/filter purposes. */
export function isActiveAppointmentStatus(status: AppointmentStatus): boolean {
  return status !== "completed" && status !== "cancelled" && status !== "no_show";
}

/** Terminal states never transition further without an explicit reopen/restore action. */
export function isTerminalAppointmentStatus(status: AppointmentStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "no_show";
}

/**
 * Central lifecycle rule for completed_at/cancelled_at — the ONE place this
 * is decided, used by the edit form, Confirm/Start/Complete/Reopen/Cancel/
 * Restore/No Show actions, the status selector, server writers, and
 * workflow/AI writers, so none of them duplicate or disagree on the rule.
 */
export function getAppointmentStatusPatch(
  nextStatus: AppointmentStatus,
  current?: { completedAt?: string | null; cancelledAt?: string | null },
): { status: AppointmentStatus; completedAt: string | null; cancelledAt: string | null } {
  if (nextStatus === "completed") {
    return { status: nextStatus, completedAt: current?.completedAt ?? new Date().toISOString(), cancelledAt: null };
  }
  if (nextStatus === "cancelled") {
    return { status: nextStatus, completedAt: null, cancelledAt: current?.cancelledAt ?? new Date().toISOString() };
  }
  // scheduled, confirmed, in_progress, no_show — neither timestamp applies.
  return { status: nextStatus, completedAt: null, cancelledAt: null };
}
