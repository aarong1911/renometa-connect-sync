export type AgentConfig = {
  tone: "professional" | "friendly" | "casual" | "formal";
  autonomy: number;
  maxRunsPerDay: number;
  handoffThreshold: number;
  instructions: string;
  triggersEnabled: Record<string, boolean>;
  channelsEnabled: Record<string, boolean>;
  requireApproval: boolean;
  businessHoursOnly: boolean;
  weekendsEnabled: boolean;
};

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  tone: "professional",
  autonomy: 70,
  maxRunsPerDay: 50,
  handoffThreshold: 3,
  instructions: "",
  triggersEnabled: {},
  channelsEnabled: {},
  requireApproval: false,
  businessHoursOnly: false,
  weekendsEnabled: true,
};

const key = (id: string) => `agent-config:${id}`;

export function loadAgentConfig(id: string): AgentConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key(id));
    if (!raw) return null;
    return { ...DEFAULT_AGENT_CONFIG, ...JSON.parse(raw) } as AgentConfig;
  } catch {
    return null;
  }
}

export function saveAgentConfig(id: string, cfg: AgentConfig) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key(id), JSON.stringify(cfg));
  window.dispatchEvent(new CustomEvent("agent-config-change", { detail: { id } }));
}

export function clearAgentConfig(id: string) {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(key(id));
  window.dispatchEvent(new CustomEvent("agent-config-change", { detail: { id } }));
}

export function isAgentConfigured(id: string): boolean {
  const cfg = loadAgentConfig(id);
  if (!cfg) return false;
  const d = DEFAULT_AGENT_CONFIG;
  return (
    cfg.tone !== d.tone ||
    cfg.autonomy !== d.autonomy ||
    cfg.maxRunsPerDay !== d.maxRunsPerDay ||
    cfg.handoffThreshold !== d.handoffThreshold ||
    cfg.instructions.trim() !== "" ||
    cfg.requireApproval !== d.requireApproval ||
    cfg.businessHoursOnly !== d.businessHoursOnly ||
    cfg.weekendsEnabled !== d.weekendsEnabled ||
    Object.values(cfg.triggersEnabled).some((v) => v === false) ||
    Object.values(cfg.channelsEnabled).some((v) => v === false)
  );
}