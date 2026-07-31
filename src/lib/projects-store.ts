// src/lib/projects-store.ts
import { useEffect, useSyncExternalStore } from "react";
import { supabase } from "@/lib/supabase";
import type { ProjectType, ProjectPriority, BudgetRange } from "@/lib/project-status";

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
  completion_percentage: number;
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

function mapProject(row: any): Project {
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
    completion_percentage: Number(row.completion_percentage ?? 0),
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

  projects = (data ?? []).map(mapProject);
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
  const { error } = await supabase.from("projects").update({ status }).eq("id", id);
  if (!error && prev) {
    const { triggerWorkflow } = await import("@/lib/trigger-workflow");
    triggerWorkflow("project_status_changed", { project: { id, name: prev.name }, fromStage: prev.status, toStage: status });
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
};

export async function createProject(input: CreateProjectInput): Promise<{ error: any; project?: Project }> {
  const orgId = await getOrgId();
  if (!orgId) return { error: new Error("Not authenticated") };

  const payload: Record<string, any> = {
    org_id: orgId,
    name: input.name,
    client_id: input.client_id,
    status: input.status,
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

  const { data, error } = await supabase
    .from("projects")
    .insert(payload)
    .select("*, contacts!client_id(full_name), owner_profile:profiles!owner_id(first_name,last_name,email)")
    .single();

  if (error || !data) {
    console.error("[projects-store] insert failed:", JSON.stringify(error, null, 2));
    return { error: error ?? new Error("No row returned") };
  }

  const project = mapProject(data);
  projects = [project, ...projects];
  emit();
  return { error: null, project };
}
