// src/lib/ai-center-store.ts
// Manages agent_instances + tool_definitions from Supabase.
// Follows the useSyncExternalStore pattern used throughout this project.

import { useEffect, useSyncExternalStore } from "react";
import { supabase } from "@/lib/supabase";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AgentCategory = "sales" | "ops" | "financials" | "marketing" | "internal";

export type AgentDefinition = {
  id: string;
  name: string;
  description: string;
  category: AgentCategory;
  icon: string;
  trigger_type: "scheduled" | "event" | "manual";
  trigger_config: Record<string, any>;
  system_prompt: string;
  data_sources: any[];
  actions: any[];
  model: string;
  created_at: string;
};

export type AgentInstance = {
  id: string;
  org_id: string;
  agent_definition_id: string;
  is_enabled: boolean;
  config_overrides: Record<string, any>;
  runs_this_week: number;
  success_rate: number;
  hours_saved: number;
  last_run_at: string | null;
  created_at: string;
  definition: AgentDefinition;
};

export type ToolFieldDef = {
  key: string;
  label: string;
  type: "text" | "number" | "textarea" | "select" | "date" | "image";
  placeholder?: string;
  prefix?: string;
  suffix?: string;
  options?: string[];
};

export type ToolDefinition = {
  id: string;
  name: string;
  description: string;
  category: "sales" | "crm" | "operations";
  icon: string;
  input_schema: ToolFieldDef[];
  system_prompt: string;
  model: string;
  created_at: string;
};

export type AgentRun = {
  id: string;
  agent_instance_id: string;
  org_id: string;
  status: "running" | "completed" | "failed";
  trigger_data: Record<string, any>;
  actions_taken: any[];
  result_summary: string | null;
  tokens_used: number | null;
  cost_usd: number | null;
  started_at: string;
  completed_at: string | null;
};

// ── State ─────────────────────────────────────────────────────────────────────

type State = {
  instances: AgentInstance[];
  tools: ToolDefinition[];
  loading: boolean;
  orgId: string | null;
};

let state: State = { instances: [], tools: [], loading: true, orgId: null };
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function setState(patch: Partial<State>) {
  state = { ...state, ...patch };
  emit();
}

// ── Org ID helper ─────────────────────────────────────────────────────────────

async function resolveOrgId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
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

// ── Data loading ──────────────────────────────────────────────────────────────

async function load() {
  setState({ loading: true });

  const orgId = await resolveOrgId();
  if (!orgId) {
    setState({ loading: false, orgId: null });
    return;
  }

  // Load agent_definitions and tool_definitions in parallel
  const [{ data: definitions }, { data: toolDefs }] = await Promise.all([
    supabase.from("agent_definitions").select("*").order("created_at"),
    supabase.from("tool_definitions").select("*").order("created_at"),
  ]);

  if (!definitions?.length) {
    // Definitions are empty. Either:
    //   a) SQL migration wasn't run yet
    //   b) RLS is blocking reads (run the RLS policies in the migration SQL)
    // Try seeding once per page session via the Netlify function.
    const SEED_KEY = "ai-center-seed-attempted";
    if (!sessionStorage.getItem(SEED_KEY)) {
      sessionStorage.setItem(SEED_KEY, "1");
      try {
        const res = await fetch("/.netlify/functions/seed-definitions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        if (res.ok) {
          // Definitions were seeded — reload once to pick them up
          await load();
          return;
        }
      } catch {
        // Function unavailable (pnpm dev without netlify dev)
      }
    }
    setState({ loading: false, orgId, instances: [], tools: [] });
    return;
  }

  // Ensure agent_instances exist for this org for every definition
  const { data: existingInstances } = await supabase
    .from("agent_instances")
    .select("*")
    .eq("org_id", orgId);

  const existingDefIds = new Set((existingInstances ?? []).map((i: any) => i.agent_definition_id));
  const missingDefs = (definitions ?? []).filter((d: any) => !existingDefIds.has(d.id));

  if (missingDefs.length > 0) {
    await supabase.from("agent_instances").insert(
      missingDefs.map((d: any) => ({
        org_id: orgId,
        agent_definition_id: d.id,
        is_enabled: false,
      })),
    );
  }

  // Reload instances after ensuring all exist
  const { data: instances } = await supabase
    .from("agent_instances")
    .select("*")
    .eq("org_id", orgId);

  // Build AgentInstance[] with joined definition
  const definitionMap = new Map((definitions ?? []).map((d: any) => [d.id, d]));
  const joined: AgentInstance[] = (instances ?? [])
    .map((inst: any): AgentInstance | null => {
      const def = definitionMap.get(inst.agent_definition_id);
      if (!def) return null;
      return { ...inst, definition: def };
    })
    .filter((x: AgentInstance | null): x is AgentInstance => x !== null);

  setState({
    loading: false,
    orgId,
    instances: joined,
    tools: (toolDefs ?? []) as ToolDefinition[],
  });
}

// ── Realtime subscription ─────────────────────────────────────────────────────

let subscribed = false;

function subscribe() {
  if (subscribed) return;
  subscribed = true;

  // Remove any existing channel with this name before re-subscribing (HMR safety)
  supabase.removeChannel(supabase.channel("ai-center"));

  supabase
    .channel("ai-center")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "agent_instances" },
      () => { load(); },
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "agent_runs" },
      () => {
        if (state.orgId) load();
      },
    )
    .subscribe();
}

// ── Auth listener ─────────────────────────────────────────────────────────────

supabase.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT") {
    setState({ instances: [], tools: [], loading: false, orgId: null });
    subscribed = false;
  } else if (event === "SIGNED_IN") {
    subscribe();
    load();
  }
});

// Initial load
subscribe();
load();

// ── Public API ────────────────────────────────────────────────────────────────

export function useAICenterAgents(): {
  instances: AgentInstance[];
  loading: boolean;
} {
  useEffect(() => {
    if (!subscribed) { subscribe(); load(); }
  }, []);

  const snap = useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => state,
    () => state,
  );
  return { instances: snap.instances, loading: snap.loading };
}

export function useAICenterTools(): {
  tools: ToolDefinition[];
  loading: boolean;
} {
  useEffect(() => {
    if (!subscribed) { subscribe(); load(); }
  }, []);

  const snap = useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => state,
    () => state,
  );
  return { tools: snap.tools, loading: snap.loading };
}

// ── Toggle agent enabled ──────────────────────────────────────────────────────

export async function toggleAgent(instanceId: string, enabled: boolean): Promise<void> {
  // Optimistic update
  setState({
    instances: state.instances.map((inst) =>
      inst.id === instanceId ? { ...inst, is_enabled: enabled } : inst,
    ),
  });

  const { error } = await supabase
    .from("agent_instances")
    .update({ is_enabled: enabled })
    .eq("id", instanceId);

  if (error) {
    // Revert optimistic update
    setState({
      instances: state.instances.map((inst) =>
        inst.id === instanceId ? { ...inst, is_enabled: !enabled } : inst,
      ),
    });
    throw error;
  }
}

// ── Run an agent manually ─────────────────────────────────────────────────────

export async function runAgentManually(
  agentDefinitionId: string,
  triggerData: Record<string, any> = {},
): Promise<{ success: boolean; error?: string; runId?: string }> {
  const orgId = state.orgId;
  if (!orgId) return { success: false, error: "Not authenticated" };

  const res = await fetch("/.netlify/functions/run-agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentDefinitionId, orgId, triggerData: { ...triggerData, manual: true } }),
  });
  const data = await res.json();
  if (!res.ok) return { success: false, error: data.error ?? "Agent failed" };
  return { success: true, runId: data.runId };
}

// ── Fetch recent runs for an instance ────────────────────────────────────────

export async function fetchRecentRuns(instanceId: string, limit = 10): Promise<AgentRun[]> {
  const { data } = await supabase
    .from("agent_runs")
    .select("*")
    .eq("agent_instance_id", instanceId)
    .order("started_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as AgentRun[];
}

// ── Run a tool ────────────────────────────────────────────────────────────────

export async function runTool(
  toolDefinitionId: string,
  input: Record<string, string>,
): Promise<{ output: string; sections: Record<string, string>; error?: string }> {
  const orgId = state.orgId;
  if (!orgId) return { output: "", sections: {}, error: "Not authenticated" };

  const { data: { user } } = await supabase.auth.getUser();
  const userId = user?.id;

  const res = await fetch("/.netlify/functions/run-tool", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ toolDefinitionId, orgId, userId, input }),
  });
  const data = await res.json();
  if (!res.ok) return { output: "", sections: {}, error: data.error ?? "Tool failed" };
  return { output: data.output ?? "", sections: data.sections ?? {} };
}

// ── Reload ────────────────────────────────────────────────────────────────────

export function reloadAICenter() {
  load();
}