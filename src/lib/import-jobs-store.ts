// src/lib/import-jobs-store.ts
//
// Stage 9.5, Priorities 6/7/8/9 — a thin, org-scoped wrapper around the new
// crm_import_jobs/crm_import_rows tables (supabase/migrations/
// 20260730_crm_import_history.sql). Every write here resolves org/user
// server-side via getOrgId()/auth.getUser() — never trusts a caller-
// supplied org id, matching the org-resolution precedence pattern used
// everywhere else in this codebase (profiles.organization_id →
// org_memberships fallback).
//
// Rollback is intentionally narrow (Priority 8): it only ever deletes rows
// this exact job logged with action:"created", re-verifies same-org, and
// re-runs each entity's own delete-safety guard immediately before
// deleting (not just at import time) so a record that gained a real
// business-record link since import is never silently removed. It never
// touches a pre-existing record, and it never attempts to "undo" an update
// — this stage's importers only ever create rows, never overwrite.

import { useEffect, useSyncExternalStore } from "react";
import { supabase } from "@/lib/supabase";
import { deleteLead } from "@/lib/leads-store";
import { deleteCompany } from "@/lib/companies-store";
import { normalizeEmail, normalizePhoneForComparison } from "@/lib/identity-normalization";

export type ImportEntityType = "lead" | "contact" | "company";
export type ImportRowAction = "created" | "skipped_duplicate" | "skipped_invalid" | "failed" | "rolled_back";

export type ImportJob = {
  id: string;
  org_id: string;
  entity_type: ImportEntityType;
  original_filename: string | null;
  status: "in_progress" | "completed" | "failed" | "rolled_back" | "partially_rolled_back";
  total_rows: number;
  created_rows: number;
  skipped_rows: number;
  failed_rows: number;
  created_by: string | null;
  created_by_name?: string;
  created_at: string;
  completed_at: string | null;
  metadata: Record<string, unknown>;
};

export type ImportRowLog = {
  source_row_number: number;
  entity_id: string | null;
  action: ImportRowAction;
  status: "ok" | "error";
  error_message?: string | null;
  source_data?: Record<string, unknown> | null;
};

async function getOrgAndUser(): Promise<{ orgId: string | null; userId: string | null }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { orgId: null, userId: null };
  const { data: profile } = await supabase
    .from("profiles")
    .select("organization_id")
    .eq("id", user.id)
    .maybeSingle();
  if (profile?.organization_id) return { orgId: profile.organization_id, userId: user.id };
  const { data: membership } = await supabase
    .from("org_memberships")
    .select("org_id")
    .eq("member_id", user.id)
    .maybeSingle();
  return { orgId: membership?.org_id ?? null, userId: user.id };
}

/** Bounded batch size for both inserts and row-log writes (Priority 6). */
export const IMPORT_BATCH_SIZE = 75;

export async function createImportJob(entityType: ImportEntityType, filename: string, totalRows: number): Promise<string | null> {
  const { orgId, userId } = await getOrgAndUser();
  if (!orgId) return null;
  const { data, error } = await supabase
    .from("crm_import_jobs")
    .insert({
      org_id: orgId,
      entity_type: entityType,
      original_filename: filename,
      status: "in_progress",
      total_rows: totalRows,
      created_by: userId,
    })
    .select("id")
    .single();
  if (error) {
    console.error("[import-jobs-store] createImportJob failed:", error);
    return null;
  }
  return data.id as string;
}

/** Logs a batch of row outcomes — one insert call per batch, not per row. */
export async function logImportRows(jobId: string, rows: ImportRowLog[]): Promise<void> {
  if (rows.length === 0) return;
  const { orgId } = await getOrgAndUser();
  if (!orgId) return;
  for (let i = 0; i < rows.length; i += IMPORT_BATCH_SIZE) {
    const batch = rows.slice(i, i + IMPORT_BATCH_SIZE).map((r) => ({
      import_job_id: jobId,
      org_id: orgId,
      source_row_number: r.source_row_number,
      entity_id: r.entity_id,
      action: r.action,
      status: r.status,
      error_message: r.error_message ?? null,
      source_data: r.source_data ?? null,
    }));
    const { error } = await supabase.from("crm_import_rows").insert(batch);
    if (error) console.error("[import-jobs-store] logImportRows batch failed:", error);
  }
}

export async function completeImportJob(
  jobId: string,
  counts: { created: number; skipped: number; failed: number },
  errors: string[] = [],
): Promise<void> {
  const status: ImportJob["status"] = counts.failed > 0 && counts.created === 0 ? "failed" : "completed";
  const { error } = await supabase
    .from("crm_import_jobs")
    .update({
      status,
      created_rows: counts.created,
      skipped_rows: counts.skipped,
      failed_rows: counts.failed,
      completed_at: new Date().toISOString(),
      metadata: { errors },
    })
    .eq("id", jobId);
  if (error) console.error("[import-jobs-store] completeImportJob failed:", error);
  emit();
}

// ── Reactive, org-scoped history list ──────────────────────────────────
let jobs: ImportJob[] = [];
let loaded = false;
const listeners = new Set<() => void>();
function emit() { for (const l of listeners) l(); }

export async function fetchImportHistory(): Promise<void> {
  const { orgId } = await getOrgAndUser();
  if (!orgId) return;
  const { data, error } = await supabase
    .from("crm_import_jobs")
    .select("*")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    console.error("[import-jobs-store] fetchImportHistory failed:", error);
    return;
  }
  jobs = (data ?? []) as ImportJob[];
  loaded = true;
  emit();
}

export function useImportHistory(): { jobs: ImportJob[]; loading: boolean; refresh: () => Promise<void> } {
  useEffect(() => { if (!loaded) void fetchImportHistory(); }, []);
  const list = useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => jobs,
    () => [],
  );
  return { jobs: list, loading: !loaded, refresh: fetchImportHistory };
}

export type RollbackResult = { rolledBack: number; skippedLinked: number; failed: number };

/**
 * Deletes only rows this job created, one entity-appropriate delete guard
 * at a time (Priority 8). `contactLinkedRecordCheck` is injected rather
 * than imported directly, since the real check
 * (countLinkedRecords in contacts.tsx) lives in a route file, not a store —
 * avoids introducing a route→store dependency cycle for one function.
 */
export async function rollbackImportJob(
  job: Pick<ImportJob, "id" | "org_id" | "entity_type">,
  contactLinkedRecordCheck?: (contactId: string, orgId: string) => Promise<{ label: string; count: number }[]>,
): Promise<RollbackResult> {
  const { orgId } = await getOrgAndUser();
  if (!orgId || orgId !== job.org_id) {
    return { rolledBack: 0, skippedLinked: 0, failed: 0 };
  }

  const { data: rows, error } = await supabase
    .from("crm_import_rows")
    .select("id, entity_id, action")
    .eq("import_job_id", job.id)
    .eq("org_id", orgId)
    .eq("action", "created");

  if (error || !rows) {
    console.error("[import-jobs-store] rollback row fetch failed:", error);
    return { rolledBack: 0, skippedLinked: 0, failed: 0 };
  }

  let rolledBack = 0;
  let skippedLinked = 0;
  let failed = 0;
  const rolledBackRowIds: string[] = [];

  for (const row of rows) {
    const entityId = row.entity_id as string | null;
    if (!entityId) continue;

    if (job.entity_type === "lead") {
      const result = await deleteLead(entityId);
      if (result.ok) { rolledBack++; rolledBackRowIds.push(row.id); }
      else if ((result as { blocked?: true }).blocked) skippedLinked++;
      else failed++;
    } else if (job.entity_type === "company") {
      const result = await deleteCompany(entityId);
      if (result.ok) { rolledBack++; rolledBackRowIds.push(row.id); }
      else skippedLinked++;
    } else if (job.entity_type === "contact") {
      if (contactLinkedRecordCheck) {
        const linked = await contactLinkedRecordCheck(entityId, orgId);
        if (linked.length > 0) { skippedLinked++; continue; }
      }
      const { error: delError } = await supabase.from("contacts").delete().eq("id", entityId).eq("org_id", orgId);
      if (delError) failed++;
      else { rolledBack++; rolledBackRowIds.push(row.id); }
    }
  }

  if (rolledBackRowIds.length > 0) {
    await supabase.from("crm_import_rows").update({ action: "rolled_back" }).in("id", rolledBackRowIds);
  }

  const newStatus: ImportJob["status"] = skippedLinked > 0 || failed > 0
    ? (rolledBack > 0 ? "partially_rolled_back" : "completed")
    : "rolled_back";
  await supabase.from("crm_import_jobs").update({ status: newStatus }).eq("id", job.id);
  await fetchImportHistory();

  return { rolledBack, skippedLinked, failed };
}

/**
 * Bounded prefetch-based duplicate detection for Contacts/Leads-linked-
 * contact imports (Priority 6/11) — replaces the old "skip the check
 * entirely above 200 rows" behavior. Instead of one query per row, this
 * pulls every same-org contact's normalized email/phone once, then checks
 * each CSV row against the in-memory set. Still bounded: only viable up to
 * CSV_MAX_SYNC_IMPORT_ROWS (the same cap synchronous import already
 * enforces), so it never becomes an unbounded full-table scan on its own —
 * it reads the same "all contacts" set fetchContacts() already loads.
 */
export async function prefetchContactIdentitySets(orgId: string): Promise<{ emails: Set<string>; phones: Set<string> }> {
  const { data, error } = await supabase.from("contacts").select("email, phone").eq("org_id", orgId);
  if (error) {
    console.error("[import-jobs-store] prefetchContactIdentitySets failed:", error);
    return { emails: new Set(), phones: new Set() };
  }
  const emails = new Set<string>();
  const phones = new Set<string>();
  for (const row of data ?? []) {
    const email = normalizeEmail(row.email);
    if (email) emails.add(email);
    const phone = normalizePhoneForComparison(row.phone);
    if (phone) phones.add(phone);
  }
  return { emails, phones };
}
