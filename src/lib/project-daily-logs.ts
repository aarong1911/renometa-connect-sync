// src/lib/project-daily-logs.ts
//
// Phase 13.3A — Project Execution foundation. Domain layer for
// public.project_daily_logs (supabase/migrations/20260813_project_execution_daily_logs_photos.sql).
// Plain per-Project fetch (same pattern as project-planning.ts) — Daily
// Logs are always scoped to exactly one open Project detail view, no
// cross-page reactivity needed.
//
// Field/Portal readiness (Part 25/26/27): the projection helpers at the
// bottom (toFieldDailyLog/toPortalDailyLog) are unused by any route today
// — they exist so a future RenoMeta Field or Portal client can consume the
// exact same rows through a narrow, explicitly-safe view instead of a
// second data model. source is provenance metadata only and is never used
// for authorization (RLS + application permissions are the only
// authorization layer).
import { supabase } from "@/lib/supabase";
import { getOrgId } from "@/lib/contacts-store";

export type DailyLogStatus = "draft" | "published" | "archived";
export type ProjectExecutionSource = "connect" | "field" | "portal" | "automation" | "import";

export const DAILY_LOG_STATUS_LABELS: Record<DailyLogStatus, string> = {
  draft: "Draft",
  published: "Published",
  archived: "Archived",
};

export type ProjectDailyLog = {
  id: string;
  projectId: string;
  logDate: string; // date-only, yyyy-mm-dd
  title: string | null;
  summary: string;
  workCompleted: string | null;
  workPlannedNext: string | null;
  delaysIssues: string | null;
  safetyNotes: string | null;
  visitorNotes: string | null;
  weatherSummary: string | null;
  temperatureLow: number | null;
  temperatureHigh: number | null;
  crewCount: number | null;
  status: DailyLogStatus;
  isCustomerVisible: boolean;
  isFieldVisible: boolean;
  source: ProjectExecutionSource;
  createdBy: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, any>;
};

function mapRow(row: any): ProjectDailyLog {
  return {
    id: row.id,
    projectId: row.project_id,
    logDate: row.log_date,
    title: row.title ?? null,
    summary: row.summary,
    workCompleted: row.work_completed ?? null,
    workPlannedNext: row.work_planned_next ?? null,
    delaysIssues: row.delays_issues ?? null,
    safetyNotes: row.safety_notes ?? null,
    visitorNotes: row.visitor_notes ?? null,
    weatherSummary: row.weather_summary ?? null,
    temperatureLow: row.temperature_low ?? null,
    temperatureHigh: row.temperature_high ?? null,
    crewCount: row.crew_count ?? null,
    status: (row.status as DailyLogStatus) ?? "draft",
    isCustomerVisible: !!row.is_customer_visible,
    isFieldVisible: row.is_field_visible !== false,
    source: (row.source as ProjectExecutionSource) ?? "connect",
    createdBy: row.created_by ?? null,
    publishedAt: row.published_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
  };
}

function isMissingTableError(message: string | undefined): boolean {
  return !!message && (message.includes("does not exist") || message.includes("schema cache"));
}

export async function fetchProjectDailyLogs(projectId: string): Promise<{ logs: ProjectDailyLog[]; error: string | null }> {
  const { data, error } = await supabase
    .from("project_daily_logs")
    .select("*")
    .eq("project_id", projectId)
    .order("log_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) {
    if (isMissingTableError(error.message)) {
      return { logs: [], error: "Daily Logs aren't set up yet — deploy supabase/migrations/20260813_project_execution_daily_logs_photos.sql." };
    }
    console.error("[project-daily-logs] fetchProjectDailyLogs failed:", error);
    return { logs: [], error: error.message };
  }
  return { logs: (data ?? []).map(mapRow), error: null };
}

export type CreateDailyLogInput = {
  projectId: string;
  logDate: string;
  title?: string | null;
  summary: string;
  workCompleted?: string | null;
  workPlannedNext?: string | null;
  delaysIssues?: string | null;
  safetyNotes?: string | null;
  visitorNotes?: string | null;
  weatherSummary?: string | null;
  temperatureLow?: number | null;
  temperatureHigh?: number | null;
  crewCount?: number | null;
  isCustomerVisible?: boolean;
  isFieldVisible?: boolean;
  status?: DailyLogStatus;
};

/** Connect always writes source: 'connect' — see the module comment on why source is never an authorization signal. */
export async function createDailyLog(input: CreateDailyLogInput): Promise<{ log?: ProjectDailyLog; error: string | null }> {
  const orgId = await getOrgId();
  if (!orgId) return { error: "Not authenticated" };

  const { data: { user } } = await supabase.auth.getUser();
  const status = input.status ?? "draft";

  const { data, error } = await supabase
    .from("project_daily_logs")
    .insert({
      org_id: orgId,
      project_id: input.projectId,
      log_date: input.logDate,
      title: input.title?.trim() || null,
      summary: input.summary.trim(),
      work_completed: input.workCompleted?.trim() || null,
      work_planned_next: input.workPlannedNext?.trim() || null,
      delays_issues: input.delaysIssues?.trim() || null,
      safety_notes: input.safetyNotes?.trim() || null,
      visitor_notes: input.visitorNotes?.trim() || null,
      weather_summary: input.weatherSummary?.trim() || null,
      temperature_low: input.temperatureLow ?? null,
      temperature_high: input.temperatureHigh ?? null,
      crew_count: input.crewCount ?? null,
      status,
      is_customer_visible: input.isCustomerVisible ?? false,
      is_field_visible: input.isFieldVisible ?? true,
      source: "connect",
      created_by: user?.id ?? null,
      published_at: status === "published" ? new Date().toISOString() : null,
    })
    .select("*")
    .single();

  if (error || !data) {
    console.error("[project-daily-logs] createDailyLog failed:", error);
    return { error: error?.message ?? "Could not create Daily Log" };
  }
  return { log: mapRow(data), error: null };
}

export type UpdateDailyLogInput = Partial<Omit<CreateDailyLogInput, "projectId">>;

export async function updateDailyLog(id: string, patch: UpdateDailyLogInput): Promise<{ log?: ProjectDailyLog; error: string | null }> {
  const update: Record<string, any> = { updated_at: new Date().toISOString() };
  if (patch.logDate !== undefined) update.log_date = patch.logDate;
  if (patch.title !== undefined) update.title = patch.title?.trim() || null;
  if (patch.summary !== undefined) update.summary = patch.summary.trim();
  if (patch.workCompleted !== undefined) update.work_completed = patch.workCompleted?.trim() || null;
  if (patch.workPlannedNext !== undefined) update.work_planned_next = patch.workPlannedNext?.trim() || null;
  if (patch.delaysIssues !== undefined) update.delays_issues = patch.delaysIssues?.trim() || null;
  if (patch.safetyNotes !== undefined) update.safety_notes = patch.safetyNotes?.trim() || null;
  if (patch.visitorNotes !== undefined) update.visitor_notes = patch.visitorNotes?.trim() || null;
  if (patch.weatherSummary !== undefined) update.weather_summary = patch.weatherSummary?.trim() || null;
  if (patch.temperatureLow !== undefined) update.temperature_low = patch.temperatureLow;
  if (patch.temperatureHigh !== undefined) update.temperature_high = patch.temperatureHigh;
  if (patch.crewCount !== undefined) update.crew_count = patch.crewCount;
  if (patch.isCustomerVisible !== undefined) update.is_customer_visible = patch.isCustomerVisible;
  if (patch.isFieldVisible !== undefined) update.is_field_visible = patch.isFieldVisible;
  if (patch.status !== undefined) update.status = patch.status;

  const { data, error } = await supabase
    .from("project_daily_logs")
    .update(update)
    .eq("id", id)
    .select("*")
    .single();

  if (error || !data) {
    console.error("[project-daily-logs] updateDailyLog failed:", error);
    return { error: error?.message ?? "Could not update Daily Log" };
  }
  return { log: mapRow(data), error: null };
}

/** Idempotent — re-publishing an already-published log is a no-op success, never a second published_at/activity (Part 15). */
export async function publishDailyLog(log: ProjectDailyLog): Promise<{ log?: ProjectDailyLog; error: string | null }> {
  if (log.status === "published") return { log, error: null };
  const { data, error } = await supabase
    .from("project_daily_logs")
    .update({ status: "published", published_at: new Date().toISOString() })
    .eq("id", log.id)
    .select("*")
    .single();
  if (error || !data) {
    console.error("[project-daily-logs] publishDailyLog failed:", error);
    return { error: error?.message ?? "Could not publish Daily Log" };
  }
  return { log: mapRow(data), error: null };
}

export async function archiveDailyLog(id: string): Promise<{ log?: ProjectDailyLog; error: string | null }> {
  const { data, error } = await supabase
    .from("project_daily_logs")
    .update({ status: "archived" })
    .eq("id", id)
    .select("*")
    .single();
  if (error || !data) {
    console.error("[project-daily-logs] archiveDailyLog failed:", error);
    return { error: error?.message ?? "Could not archive Daily Log" };
  }
  return { log: mapRow(data), error: null };
}

/** Reopens an archived log back to Draft — mirrors the Task restore() pattern (no separate "unarchive" status). */
export async function restoreDailyLogToDraft(id: string): Promise<{ log?: ProjectDailyLog; error: string | null }> {
  const { data, error } = await supabase
    .from("project_daily_logs")
    .update({ status: "draft" })
    .eq("id", id)
    .select("*")
    .single();
  if (error || !data) {
    console.error("[project-daily-logs] restoreDailyLogToDraft failed:", error);
    return { error: error?.message ?? "Could not restore Daily Log" };
  }
  return { log: mapRow(data), error: null };
}

/** Deleting a Daily Log does not delete its linked photos — project_files.daily_log_id is ON DELETE SET NULL (Part 10/41), so photos remain in the Project gallery, unlinked. */
export async function deleteDailyLog(id: string): Promise<{ error: string | null }> {
  const { error } = await supabase.from("project_daily_logs").delete().eq("id", id);
  if (error) {
    console.error("[project-daily-logs] deleteDailyLog failed:", error);
    return { error: error.message };
  }
  return { error: null };
}

// ── Field/Portal-ready projections (Part 25/26/27) ───────────────────────
// Unused by any route today — kept small/pure/testable for a future
// RenoMeta Field or Portal client to import directly.

export type FieldDailyLog = {
  id: string;
  projectId: string;
  logDate: string;
  title: string | null;
  summary: string;
  workCompleted: string | null;
  workPlannedNext: string | null;
  delaysIssues: string | null;
  safetyNotes: string | null;
  visitorNotes: string | null;
  weatherSummary: string | null;
  crewCount: number | null;
  status: DailyLogStatus;
};

/** Field only ever sees field-visible logs — returns null otherwise so callers can't accidentally render a filtered-out record. */
export function toFieldDailyLog(log: ProjectDailyLog): FieldDailyLog | null {
  if (!log.isFieldVisible) return null;
  return {
    id: log.id, projectId: log.projectId, logDate: log.logDate, title: log.title, summary: log.summary,
    workCompleted: log.workCompleted, workPlannedNext: log.workPlannedNext, delaysIssues: log.delaysIssues,
    safetyNotes: log.safetyNotes, visitorNotes: log.visitorNotes, weatherSummary: log.weatherSummary,
    crewCount: log.crewCount, status: log.status,
  };
}

export type PortalDailyLog = {
  id: string;
  projectId: string;
  logDate: string;
  title: string | null;
  summary: string;
  workCompleted: string | null;
  workPlannedNext: string | null;
  weatherSummary: string | null;
};

/**
 * Portal-safe projection (Part 26) — record-level visibility only in this
 * phase (documented decision, see the migration header and Phase report).
 * When customer-visible, only this explicitly-safe field subset is ever
 * exposed: title/summary/work_completed/work_planned_next/weather_summary.
 * safety_notes, visitor_notes, delays_issues, metadata, and created_by are
 * NEVER included here, regardless of the record's visibility flag —
 * section-level customer visibility (e.g. "this summary is customer-safe
 * but this delay note isn't") is out of scope for Phase 13.3A.
 */
export function toPortalDailyLog(log: ProjectDailyLog): PortalDailyLog | null {
  if (!log.isCustomerVisible || log.status !== "published") return null;
  return {
    id: log.id, projectId: log.projectId, logDate: log.logDate, title: log.title, summary: log.summary,
    workCompleted: log.workCompleted, workPlannedNext: log.workPlannedNext, weatherSummary: log.weatherSummary,
  };
}
