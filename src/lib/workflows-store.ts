// src/lib/workflows-store.ts
import { useEffect, useSyncExternalStore } from "react";
import { supabase } from "@/lib/supabase";
import type { WorkflowCategory } from "@/lib/mock-data";
import type { WfRfNode, WfRfEdge, WfNodeType, WfNodeCategory } from "@/lib/workflow-types";

export type WorkflowStatus = "active" | "paused" | "draft";

export type DbWorkflow = {
  id: string;
  orgId: string;
  name: string;
  description: string;
  status: WorkflowStatus;
  triggerEvent: string;
  triggerType: WfNodeType | null;
  category: WorkflowCategory;
  folder: string;
  ownerName: string;
  ownerInitials: string;
  nodes: WfRfNode[];
  edges: WfRfEdge[];
  runsCount: number;
  successRate: number;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DbWorkflowRun = {
  id: string;
  workflowId: string;
  contactName: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  status: "success" | "failed" | "running";
  failedAtNodeId?: string;
};

// ── Org helper ──────────────────────────────────────────────────────────────

async function getOrgId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
  if (profile?.organization_id) return profile.organization_id;
  const { data: membership } = await supabase
    .from("org_memberships").select("org_id").eq("member_id", user.id).maybeSingle();
  return membership?.org_id ?? null;
}

// ── Mappers ─────────────────────────────────────────────────────────────────

export function mapWorkflow(row: any): DbWorkflow {
  const rawNodes: any[] = Array.isArray(row.nodes) ? row.nodes : [];

  // Migrate old-format nodes ({ id, kind, title, subtitle }) to React Flow format
  const nodes: WfRfNode[] = rawNodes.map((n) => {
    if (n.type === "wfNode") return n as WfRfNode;
    // Old format — convert
    const kindMap: Record<string, WfNodeType> = {
      "trigger": "manual",
      "send-sms": "send_sms",
      "send-email": "send_email",
      "wait": "wait",
      "condition": "if_else",
      "create-task": "create_task",
      "update-stage": "update_status",
      "internal-note": "add_note",
      "webhook": "webhook",
    };
    const categoryMap: Record<string, WfNodeCategory> = {
      "trigger": "trigger",
      "send-sms": "action",
      "send-email": "action",
      "wait": "utility",
      "condition": "condition",
      "create-task": "action",
      "update-stage": "action",
      "internal-note": "action",
      "webhook": "utility",
    };
    const nodeType: WfNodeType = kindMap[n.kind] ?? "manual";
    return {
      id: n.id,
      type: "wfNode" as const,
      data: {
        nodeType,
        label: n.title ?? nodeType,
        subtitle: n.subtitle ?? "",
        config: {},
        category: (categoryMap[n.kind] ?? "utility") as WfNodeCategory,
      },
      position: { x: 300, y: 50 },
    };
  });

  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    description: row.description ?? "",
    status: row.status as WorkflowStatus,
    triggerEvent: row.trigger_event ?? "",
    triggerType: (row.trigger_type as WfNodeType | null) ?? null,
    category: (row.category ?? "Operations") as WorkflowCategory,
    folder: row.folder ?? "General",
    ownerName: row.owner_name ?? "",
    ownerInitials: row.owner_initials ?? "",
    nodes,
    edges: Array.isArray(row.edges) ? row.edges as WfRfEdge[] : [],
    runsCount: Number(row.runs_count ?? 0),
    successRate: Number(row.success_rate ?? 0),
    lastRunAt: row.last_run_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  };
}

function mapRun(row: any): DbWorkflowRun {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    contactName: row.contact_name ?? "",
    startedAt: row.started_at,
    endedAt: row.ended_at ?? null,
    durationMs: row.duration_ms ?? null,
    status: row.status as DbWorkflowRun["status"],
    failedAtNodeId: row.failed_at_node_id ?? undefined,
  };
}

// ── Store state ─────────────────────────────────────────────────────────────

let workflows: DbWorkflow[] = [];
let runs: DbWorkflowRun[] = [];
let loaded = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

async function fetchAll() {
  const orgId = await getOrgId();
  if (!orgId) { workflows = []; runs = []; loaded = true; emit(); return; }

  const [wfRes, runRes] = await Promise.all([
    supabase.from("workflows").select("*").eq("org_id", orgId).order("created_at", { ascending: false }),
    supabase.from("workflow_runs").select("*").eq("org_id", orgId).order("started_at", { ascending: false }).limit(200),
  ]);

  if (wfRes.error) console.error("[workflows-store] fetch:", wfRes.error.message);
  if (runRes.error) console.error("[workflows-store] runs:", runRes.error.message);

  workflows = (wfRes.data ?? []).map(mapWorkflow);
  runs = (runRes.data ?? []).map(mapRun);
  loaded = true;
  emit();
}

void fetchAll();

// ── Hooks ────────────────────────────────────────────────────────────────────

export function useWorkflows(): { workflows: DbWorkflow[]; runs: DbWorkflowRun[]; loading: boolean } {
  useEffect(() => { if (!loaded) void fetchAll(); }, []);

  const wf = useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => workflows, () => [],
  );
  const r = useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => runs, () => [],
  );

  return { workflows: wf, runs: r, loading: !loaded };
}

// ── Mutations ────────────────────────────────────────────────────────────────

export async function createWorkflow(input: {
  name: string;
  description?: string;
  category?: WorkflowCategory;
  folder?: string;
  triggerType: WfNodeType;
  nodes?: WfRfNode[];
  edges?: WfRfEdge[];
}): Promise<{ data: DbWorkflow | null; error: any }> {
  const orgId = await getOrgId();
  if (!orgId) return { data: null, error: new Error("Not authenticated") };

  const { data: { user } } = await supabase.auth.getUser();
  const { data: profile } = await supabase
    .from("profiles").select("first_name, last_name").eq("id", user?.id ?? "").maybeSingle();

  const ownerName = [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") || "Unknown";
  const ownerInitials = ownerName.split(" ").map((n: string) => n[0] ?? "").join("").slice(0, 2).toUpperCase();

  const { data, error } = await supabase
    .from("workflows")
    .insert({
      org_id: orgId,
      name: input.name,
      description: input.description ?? "",
      category: input.category ?? "Operations",
      folder: input.folder ?? "General",
      trigger_event: input.triggerType,
      trigger_type: input.triggerType,
      owner_name: ownerName,
      owner_initials: ownerInitials,
      status: "draft",
      nodes: input.nodes ?? [],
      edges: input.edges ?? [],
    })
    .select()
    .single();

  if (error) { console.error("[workflows-store] insert:", error.message); return { data: null, error }; }

  const wf = mapWorkflow(data);
  workflows = [wf, ...workflows];
  emit();
  return { data: wf, error: null };
}

export async function saveWorkflow(
  id: string,
  nodes: WfRfNode[],
  edges: WfRfEdge[],
  meta?: Partial<Pick<DbWorkflow, "name" | "status" | "triggerEvent" | "triggerType" | "folder" | "category" | "description">>,
): Promise<{ error: any }> {
  const update: Record<string, any> = { nodes, edges, updated_at: new Date().toISOString() };
  if (meta?.name !== undefined) update.name = meta.name;
  if (meta?.status !== undefined) update.status = meta.status;
  if (meta?.triggerEvent !== undefined) update.trigger_event = meta.triggerEvent;
  if (meta?.triggerType !== undefined) { update.trigger_type = meta.triggerType; update.trigger_event = meta.triggerType; }
  if (meta?.folder !== undefined) update.folder = meta.folder;
  if (meta?.category !== undefined) update.category = meta.category;
  if (meta?.description !== undefined) update.description = meta.description;

  const { error } = await supabase.from("workflows").update(update).eq("id", id);
  if (!error) {
    workflows = workflows.map((w) => w.id === id ? { ...w, nodes, edges, ...(meta ?? {}) } : w);
    emit();
  }
  return { error };
}

export async function updateWorkflowStatus(id: string, status: WorkflowStatus): Promise<{ error: any }> {
  const { error } = await supabase.from("workflows").update({ status, updated_at: new Date().toISOString() }).eq("id", id);
  if (!error) { workflows = workflows.map((w) => w.id === id ? { ...w, status } : w); emit(); }
  return { error };
}

export async function deleteWorkflow(id: string): Promise<{ error: any }> {
  const { error } = await supabase.from("workflows").delete().eq("id", id);
  if (!error) { workflows = workflows.filter((w) => w.id !== id); emit(); }
  return { error };
}

export function reloadWorkflows() { loaded = false; void fetchAll(); }
