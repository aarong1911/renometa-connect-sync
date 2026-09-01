// src/lib/projects-store.ts
//
// Platform State Sync Phase S4B — Projects shared server state.
//
// BEFORE S4B: a module-level `projects` array + a listener Set + `emit()` +
// `useSyncExternalStore`, hydrated once by a top-level `void fetchProjects()`
// call at import time. No realtime coverage; every mutation patched the
// singleton locally after its own DB write.
//
// AFTER S4B: one TanStack Query per org (`queryKeys.projects(orgId)`).
// `useProjects()` keeps its EXACT public shape — `{ projects, loading,
// reload }`, not a bare array (unlike useContacts()/useDeals()/useLeads())
// — as a thin wrapper over `useQuery`. `useProjectsLoading()` and
// `getProjectName()` are preserved too. Every consumer (Projects page,
// Command Center Active Projects KPI + Needs Attention Projects rollup,
// Deal drawer's "Create Project", Files, Calendar, Tasks' project picker,
// entity pickers, insights) reads the same cached list. The imperative
// mutation functions (`createProject`/`updateProject`/`updateProjectStatus`)
// keep their exact signatures; after a confirmed DB write they patch +
// invalidate the shared client (query-client.ts / getQueryClient()) instead
// of mutating the singleton. The central RealtimeBridge now also
// invalidates `queryKeys.projects(orgId)` on any `projects` row change.
//
// UNCHANGED by S4B:
//  - `mapProjectRow` normalisation (same server-side join for client_name —
//    `contacts!client_id(full_name)` — same owner-profile join)
//  - the completion_percentage / status transition rules in project-status.ts
//  - the "Project marked Completed" / "progress updated" system notes
//  - `triggerWorkflow("project_status_changed", …)`
//  - Tasks' own architecture (still a separate useSyncExternalStore store,
//    S4C) — Projects reads NO task data itself; task counts/overdue/next-
//    task shown on Project cards are computed by the CONSUMING components
//    from useTasks(), not from this store
//  - Contact avatar resolution — Project surfaces (Projects page, Command
//    Center) already resolve a linked Contact's avatar_url/avatar_key by
//    joining the separately-loaded useContacts() list client-side (the
//    Project type itself carries no avatar fields, only client_id/
//    client_name), so avatar freshness was already independent of this
//    store; only `client_name` (embedded via the server-side join at fetch
//    time) depended on the old refreshProjects() bridge — see PART 19 below.

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { getQueryClient } from "@/lib/query-client";
import { useOrgId } from "@/lib/org-id";
import { queryKeys } from "@/lib/query-keys";
import type { ProjectType, ProjectPriority, BudgetRange } from "@/lib/project-status";
import { getProgressAfterStageChange, isProgressManual } from "@/lib/project-status";

// Canonical runtime status union (S4B audit): confirmed against actual DB
// writes AND UI (STATUS_SELECT_OPTIONS in projects.index.tsx offers all 8;
// PROJECT_STATUS_LABELS in project-status.ts labels all 8) — NOT stale.
// "planning"/"contracted"/"pre-construction"/"active"/"punch-list" are the
// normal board-progression statuses; "on-hold"/"cancelled"/"completed" are
// reachable via the Edit form's status select but aren't columns on the
// Projects board. No correction needed here; see the S4B report.
export type ProjectStatus =
  | "planning"
  | "contracted"
  | "pre-construction"
  | "active"
  | "punch-list"
  | "on-hold"
  | "completed"
  | "cancelled";

export type Project = {
  id: string;
  name: string;
  client_id: string;
  client_name: string;
  status: ProjectStatus;
  address: string | null;
  budget_total: number;
  actual_cost: number;
  /** null = never manually set (display falls back to a stage-derived default — see getProjectDisplayProgress in project-status.ts); a real stored number, including 0, is a manual value and displayed as-is. */
  completion_percentage: number | null;
  start_date: string | null;
  end_date: string | null;
  slug: string | null;
  description: string | null;
  // Phase — Project Creation Enhancements. Nullable/defaulted so existing
  // rows written before supabase/migrations/20260808_project_creation_enhancements.sql
  // continue to render safely (see the migration report's compatibility notes).
  projectType: ProjectType | null;
  customProjectType: string | null;
  priority: ProjectPriority;
  budgetRange: BudgetRange | null;
  ownerId: string | null;
  ownerName: string | null;
  leadId: string | null;
  dealId: string | null;
  /** projects.estimate_id — written by createProject() on Estimate→Project conversion but, until now, never read back onto this type; needed so Project detail can show/link the originating Estimate and so conversion handlers can detect an existing Project by estimate_id, not just the estimate's own converted_project_id flag. */
  estimateId: string | null;
};

async function getOrgId(): Promise<string | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("organization_id")
    .eq("id", user.id)
    .maybeSingle();

  if (profile?.organization_id) return profile.organization_id;

  const { data: membership } = await supabase
    .from("org_memberships")
    .select("org_id")
    .eq("member_id", user.id)
    .maybeSingle();

  return membership?.org_id ?? null;
}

const VALID_PRIORITIES: ProjectPriority[] = ["low", "normal", "high", "urgent"];

export function mapProjectRow(row: any): Project {
  const ownerProfile = row.owner_profile;
  const ownerName = ownerProfile
    ? `${ownerProfile.first_name ?? ""} ${ownerProfile.last_name ?? ""}`.trim() || ownerProfile.email || null
    : null;

  return {
    id: row.id,
    name: row.name,
    client_id: row.client_id,
    client_name: row.contacts?.full_name ?? row.client_name ?? "",
    status: row.status as ProjectStatus,
    address: row.address ?? null,
    budget_total: Number(row.budget_total ?? 0),
    actual_cost: Number(row.actual_cost ?? 0),
    completion_percentage: typeof row.completion_percentage === "number" ? row.completion_percentage : null,
    start_date: row.start_date ?? null,
    end_date: row.end_date ?? null,
    slug: row.slug ?? null,
    description: row.description ?? null,
    projectType: (row.project_type as ProjectType | null) ?? null,
    customProjectType: row.custom_project_type ?? null,
    priority: (VALID_PRIORITIES as string[]).includes(row.priority) ? (row.priority as ProjectPriority) : "normal",
    budgetRange: (row.budget_range as BudgetRange | null) ?? null,
    ownerId: row.owner_id ?? null,
    ownerName,
    leadId: row.lead_id ?? null,
    dealId: row.deal_id ?? null,
    estimateId: row.estimate_id ?? null,
  };
}

const PROJECT_SELECT = "*, contacts!client_id(full_name), owner_profile:profiles!owner_id(first_name,last_name,email)";

/**
 * The Projects list queryFn — org-scoped, newest-first, with client_name
 * and owner name resolved via the same server-side joins the pre-S4B store
 * used. Self-contained (no React, no other query's cache) so it is safe to
 * run from `useQuery` or an imperative `refetchQueries`.
 */
export async function fetchProjectsForOrg(orgId: string): Promise<Project[]> {
  const { data, error } = await supabase
    .from("projects")
    .select(PROJECT_SELECT)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[projects-store] fetch failed:", JSON.stringify(error, null, 2));
    throw error;
  }
  return (data ?? []).map(mapProjectRow);
}

// ── Query cache helpers ──────────────────────────────────────────────────

const qc = () => getQueryClient();

/** Read the currently-cached Projects list (any org key — normally exactly one). Read-only; used by mutations that need to resolve the pre-write row. */
function getCachedProjects(): Project[] {
  const entries = qc().getQueriesData<Project[]>({ queryKey: ["projects"] });
  for (const [, data] of entries) {
    if (Array.isArray(data)) return data;
  }
  return [];
}

/** Immediately reflect a CONFIRMED change into the cached Projects list(s) — only ever called with real persisted data, never speculatively. */
function patchProjectsCache(fn: (list: Project[]) => Project[]) {
  qc().setQueriesData<Project[]>({ queryKey: ["projects"] }, (old) => (Array.isArray(old) ? fn(old) : old));
}

function invalidateProjects() {
  void qc().invalidateQueries({ queryKey: ["projects"] });
}

/** A new Project affects Command Center's Recent Activity (projects.created_at) and the "vs last month" baseline — not needed for status/edit writes, which the Active Projects KPI and Needs Attention rollup already pick up by reading useProjects() directly. */
function invalidateProjectsWithDashboard() {
  void qc().invalidateQueries({ queryKey: ["projects"] });
  void qc().invalidateQueries({ queryKey: ["dashboard"] });
}

// ── Public hook (unchanged shape: { projects, loading, reload }) ──────────

function useProjectsQuery() {
  const orgId = useOrgId();
  return useQuery({
    queryKey: orgId ? queryKeys.projects(orgId) : ["projects", "_pending"],
    queryFn: () => fetchProjectsForOrg(orgId as string),
    enabled: !!orgId,
    // Projects change less often than Deals/Leads — realtime + mutation
    // invalidation are the primary freshness path, staleTime just caps
    // redundant refetches on remount/focus churn.
    staleTime: 75_000,
  });
}

export function useProjects(): { projects: Project[]; loading: boolean; reload: () => void } {
  const query = useProjectsQuery();
  return {
    projects: query.data ?? [],
    loading: query.isLoading,
    reload: () => { void query.refetch(); },
  };
}

export function useProjectsLoading(): boolean {
  return useProjectsQuery().isLoading;
}

export function getProjectName(projectId: string): string {
  return getCachedProjects().find((project) => project.id === projectId)?.name ?? "Unassigned";
}

export async function refreshProjects(): Promise<void> {
  await qc().refetchQueries({ queryKey: ["projects"] });
}

// ── Imperative mutations (unchanged signatures) ─────────────────────────────

export async function updateProjectStatus(
  id: string,
  status: ProjectStatus,
): Promise<{ error: any }> {
  const prev = getCachedProjects().find((p) => p.id === id);
  const nextProgress = getProgressAfterStageChange({ currentProgress: prev?.completion_percentage, nextStatus: status });

  // Ordinary stage movement never writes completion_percentage (stays
  // whatever it already was, including null) — only "completed" forces a
  // real 100, which is the one case getProgressAfterStageChange returns a
  // value different from what's already stored. See project-status.ts.
  const payload: Record<string, any> = { status };
  if (status === "completed") payload.completion_percentage = nextProgress;

  const { error } = await supabase.from("projects").update(payload).eq("id", id);
  if (!error && prev) {
    if (status === "completed" && prev.completion_percentage !== 100) {
      await supabase.from("project_notes").insert({
        project_id: id, author: "System", body: "Project marked Completed — progress set to 100%.",
      }).then(({ error: noteErr }) => { if (noteErr) console.error("[projects-store] completion note failed:", noteErr); });
    }
    patchProjectsCache((list) =>
      list.map((p) => (p.id === id ? { ...p, status, completion_percentage: status === "completed" ? nextProgress : p.completion_percentage } : p)),
    );
    invalidateProjects();
    const { triggerWorkflow } = await import("@/lib/trigger-workflow");
    triggerWorkflow("project_status_changed", {
      project: { id, name: prev.name }, fromStage: prev.status, toStage: status,
      previousProgress: prev.completion_percentage, completionPercentage: status === "completed" ? nextProgress : prev.completion_percentage,
      progressSource: status === "completed" ? "stage-completed" : (isProgressManual(prev) ? "manual" : "stage-derived"),
      occurredAt: new Date().toISOString(),
    });
  }
  return { error };
}

export type CreateProjectInput = {
  name: string;
  client_id: string;
  status: ProjectStatus;
  address?: string;
  /** Authoritative numeric figure — a documented midpoint when budgetRange is a bracket, the exact typed value when budgetRange is "custom", or omitted for "not_specified". See budgetRangeMidpoint() in src/lib/project-status.ts. */
  budget_total?: number;
  budgetRange?: BudgetRange;
  start_date?: string;
  end_date?: string;
  description?: string;
  projectType?: ProjectType;
  customProjectType?: string;
  priority?: ProjectPriority;
  ownerId?: string | null;
  leadId?: string | null;
  dealId?: string | null;
  /** projects.estimate_id — set when a Project is created via "Convert to Project" from an approved estimate (Phase 10.4). */
  estimateId?: string | null;
};

export async function createProject(input: CreateProjectInput): Promise<{ error: any; project?: Project }> {
  const orgId = await getOrgId();
  if (!orgId) return { error: new Error("Not authenticated") };

  const payload: Record<string, any> = {
    org_id: orgId,
    name: input.name,
    client_id: input.client_id,
    status: input.status,
    // completion_percentage DEFAULTs to 0 (not null) at the DB level —
    // explicitly overriding it to null on every create is what lets new
    // Projects distinguish "never set" (stage-derived display) from a
    // genuine manual 0, per the Phase 13.4 progress model. Manual/Estimate/
    // Deal creation all intentionally start with no stored progress.
    completion_percentage: null,
  };

  if (input.address) payload.address = input.address;
  if (input.budget_total !== undefined) payload.budget_total = input.budget_total;
  if (input.budgetRange) payload.budget_range = input.budgetRange;
  if (input.start_date) payload.start_date = input.start_date;
  if (input.end_date) payload.end_date = input.end_date;
  if (input.description) payload.description = input.description;
  if (input.projectType) payload.project_type = input.projectType;
  if (input.customProjectType) payload.custom_project_type = input.customProjectType;
  if (input.priority) payload.priority = input.priority;
  if (input.ownerId !== undefined) payload.owner_id = input.ownerId;
  if (input.leadId !== undefined) payload.lead_id = input.leadId;
  if (input.dealId !== undefined) payload.deal_id = input.dealId;
  if (input.estimateId !== undefined) payload.estimate_id = input.estimateId;

  const { data, error } = await supabase
    .from("projects")
    .insert(payload)
    .select(PROJECT_SELECT)
    .single();

  if (error || !data) {
    console.error("[projects-store] insert failed:", JSON.stringify(error, null, 2));
    return { error: error ?? new Error("No row returned") };
  }

  const project = mapProjectRow(data);
  patchProjectsCache((list) => [project, ...list.filter((p) => p.id !== project.id)]);
  invalidateProjectsWithDashboard();
  return { error: null, project };
}

export type UpdateProjectInput = Partial<{
  name: string;
  /** projects.client_id is NOT NULL — never pass an empty string; omit the key entirely if it shouldn't change. */
  clientId: string;
  /** null clears to Unassigned — the column allows it (ON DELETE SET NULL FK). */
  ownerId: string | null;
  projectType: ProjectType;
  customProjectType: string | null;
  description: string | null;
  /** null clears back to "never set" (display falls back to the stage default); a number 0-100 is a manual value — see project-status.ts. */
  completionPercentage: number | null;
  address: string | null;
  /** null clears the date — omit the key to leave it unchanged. */
  startDate: string | null;
  endDate: string | null;
  budgetTotal: number;
  actualCost: number;
  priority: ProjectPriority;
}>;

/** Canonical partial-update writer for an existing Project — Phase 13.5 expanded this to the full editable field set (Phase 13.2's Description/Scope + Project Type and 13.4's Completion Percentage were the only fields before). Status is deliberately NOT here — updateProjectStatus() owns status transitions, progress-on-completion, and the one status activity note, so callers changing status must call that separately rather than smuggling `status` through this payload (see the Phase 13.5 report). */
export async function updateProject(id: string, patch: UpdateProjectInput): Promise<{ error: any; project?: Project }> {
  const prev = getCachedProjects().find((p) => p.id === id);
  const payload: Record<string, any> = {};
  if (patch.name !== undefined) payload.name = patch.name;
  if (patch.clientId !== undefined) payload.client_id = patch.clientId;
  if (patch.ownerId !== undefined) payload.owner_id = patch.ownerId;
  if (patch.projectType !== undefined) payload.project_type = patch.projectType;
  if (patch.customProjectType !== undefined) payload.custom_project_type = patch.customProjectType || null;
  if (patch.description !== undefined) payload.description = patch.description || null;
  if (patch.completionPercentage !== undefined) {
    payload.completion_percentage = patch.completionPercentage === null
      ? null
      : Math.min(100, Math.max(0, Math.round(patch.completionPercentage)));
  }
  if (patch.address !== undefined) payload.address = patch.address || null;
  if (patch.startDate !== undefined) payload.start_date = patch.startDate || null;
  if (patch.endDate !== undefined) payload.end_date = patch.endDate || null;
  if (patch.budgetTotal !== undefined) payload.budget_total = Math.max(0, patch.budgetTotal);
  if (patch.actualCost !== undefined) payload.actual_cost = Math.max(0, patch.actualCost);
  if (patch.priority !== undefined) payload.priority = patch.priority;

  const { data, error } = await supabase
    .from("projects")
    .update(payload)
    .eq("id", id)
    .select(PROJECT_SELECT)
    .single();

  if (error || !data) {
    console.error("[projects-store] update failed:", JSON.stringify(error, null, 2));
    return { error: error ?? new Error("No row returned") };
  }

  const project = mapProjectRow(data);
  patchProjectsCache((list) => list.map((p) => (p.id === id ? project : p)));
  invalidateProjects();

  // One activity note per manual progress change — never alongside the
  // separate "marked Completed" note updateProjectStatus() writes, since
  // this path (the Edit form) and that one (status transitions) never fire
  // for the same change.
  if (patch.completionPercentage !== undefined && prev && prev.completion_percentage !== project.completion_percentage) {
    const from = prev.completion_percentage === null ? "unset" : `${prev.completion_percentage}%`;
    const to = project.completion_percentage === null ? "unset" : `${project.completion_percentage}%`;
    await supabase.from("project_notes").insert({
      project_id: id, author: "System", body: `Project progress updated — ${from} to ${to}.`,
    }).then(({ error: noteErr }) => { if (noteErr) console.error("[projects-store] progress note failed:", noteErr); });
  }

  return { error: null, project };
}
