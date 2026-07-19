// src/lib/projects-store.ts
import { useEffect, useSyncExternalStore } from "react";
import { supabase } from "@/lib/supabase";

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
  client_name: string;
  status: ProjectStatus;
  address: string | null;
  budget_total: number;
  actual_cost: number;
  completion_percentage: number;
  start_date: string | null;
  end_date: string | null;
  slug: string | null;
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

function mapProject(row: any): Project {
  return {
    id: row.id,
    name: row.name,
    client_name: row.contacts?.full_name ?? row.client_name ?? "",
    status: row.status as ProjectStatus,
    address: row.address ?? null,
    budget_total: Number(row.budget_total ?? 0),
    actual_cost: Number(row.actual_cost ?? 0),
    completion_percentage: Number(row.completion_percentage ?? 0),
    start_date: row.start_date ?? null,
    end_date: row.end_date ?? null,
    slug: row.slug ?? null,
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
    .select("*, contacts!client_id(full_name)")
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
  budget_total?: number;
  start_date?: string;
  end_date?: string;
};

export async function createProject(input: CreateProjectInput): Promise<{ error: any }> {
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
  if (input.start_date) payload.start_date = input.start_date;
  if (input.end_date) payload.end_date = input.end_date;

  const { error } = await supabase.from("projects").insert(payload);

  if (error) {
    console.error("[projects-store] insert failed:", JSON.stringify(error, null, 2));
    return { error };
  }

  await fetchProjects();
  return { error: null };
}
