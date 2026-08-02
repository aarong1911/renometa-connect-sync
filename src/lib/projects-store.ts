// src/lib/projects-store.ts
import { useEffect, useSyncExternalStore } from "react";
import { supabase } from "@/lib/supabase";
import type { ProjectType, ProjectPriority, BudgetRange } from "@/lib/project-status";
import { getProgressAfterStageChange, isProgressManual } from "@/lib/project-status";

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

let projects: Project[] = [];
let loaded = false;

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

async function fetchProjects() {
  const orgId = await getOrgId();

  if (!orgId) {
    projects = [];
    loaded = true;
    emit();
    return;
  }

  const { data, error } = await supabase
    .from("projects")
    .select("*, contacts!client_id(full_name), owner_profile:profiles!owner_id(first_name,last_name,email)")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[projects-store] fetch failed:", JSON.stringify(error, null, 2));
    loaded = true;
    emit();
    return;
  }

  projects = (data ?? []).map(mapProjectRow);
  loaded = true;
  emit();
}

void fetchProjects();

export function useProjects(): { projects: Project[]; loading: boolean; reload: () => void } {
  useEffect(() => {
    if (!loaded) void fetchProjects();
  }, []);

  const data = useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    () => projects,
    () => [],
  );

  return { projects: data, loading: !loaded, reload: () => void fetchProjects() };
}

export function useProjectsLoading(): boolean {
  return !loaded;
}

export function getProjectName(projectId: string): string {
  return projects.find((project) => project.id === projectId)?.name ?? "Unassigned";
}

export function getProjects(): Project[] { return projects; }

export async function refreshProjects() {
  await fetchProjects();
}

export async function updateProjectStatus(
  id: string,
  status: ProjectStatus,
): Promise<{ error: any }> {
  const prev = projects.find((p) => p.id === id);
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
    projects = projects.map((p) => (p.id === id ? { ...p, status, completion_percentage: status === "completed" ? nextProgress : p.completion_percentage } : p));
    emit();
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
    .select("*, contacts!client_id(full_name), owner_profile:profiles!owner_id(first_name,last_name,email)")
    .single();

  if (error || !data) {
    console.error("[projects-store] insert failed:", JSON.stringify(error, null, 2));
    return { error: error ?? new Error("No row returned") };
  }

  const project = mapProjectRow(data);
  projects = [project, ...projects];
  emit();
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
  const prev = projects.find((p) => p.id === id);
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
    .select("*, contacts!client_id(full_name), owner_profile:profiles!owner_id(first_name,last_name,email)")
    .single();

  if (error || !data) {
    console.error("[projects-store] update failed:", JSON.stringify(error, null, 2));
    return { error: error ?? new Error("No row returned") };
  }

  const project = mapProjectRow(data);
  projects = projects.map((p) => (p.id === id ? project : p));
  emit();

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
