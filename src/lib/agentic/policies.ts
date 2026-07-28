// src/lib/agentic/policies.ts
//
// Phase 9.6 — Priority 11. Organization/agent-instance policy. Stored as
// the single `agent_instances.policy` jsonb column added by the Phase 9.6
// migration (per the instruction to prefer one JSONB field over a
// normalized table when the application already uses settings JSON safely
// — `organizations`/`agent_instances.config_overrides` already do this
// elsewhere in this codebase).
//
// This module only defines the shape and a safe-merge helper. No UI reads
// or writes real per-org values yet — every agent instance uses
// DEFAULT_AGENT_POLICY until an org explicitly configures one (a Phase 10+
// concern once a real production agent needs it).

export type AgentPolicy = {
  agentsEnabled: boolean;
  defaultAutonomyLevel: 1 | 2 | 3 | 4;
  /** 24h local-time strings, e.g. "08:00"–"18:00". Undefined = no restriction. */
  operatingHours?: { start: string; end: string };
  maxActionsPerHour: number;
  maxActionsPerDay: number;
  maxMessagesPerDay: number;
  allowedChannels: ("email" | "sms" | "whatsapp" | "messenger" | "instagram")[];
  monthlyCostLimitUsd: number | null;
  perRunCostLimitUsd: number | null;
  escalationRecipientUserIds: string[];
  /** Consent/opt-out enforcement is mandatory and not overridable — kept here only for visibility in the stored shape. */
  enforceOptOut: true;
  /** Emergency stop — checked before every execution, independent of autonomy level or is_enabled. */
  emergencyPaused: boolean;
};

export const DEFAULT_AGENT_POLICY: AgentPolicy = {
  agentsEnabled: true,
  defaultAutonomyLevel: 1,
  maxActionsPerHour: 20,
  maxActionsPerDay: 100,
  maxMessagesPerDay: 0, // No autonomous customer-facing sends by default — Phase 9.6 never sends anyway.
  allowedChannels: [],
  monthlyCostLimitUsd: 20,
  perRunCostLimitUsd: 1,
  escalationRecipientUserIds: [],
  enforceOptOut: true,
  emergencyPaused: false,
};

/** Merges a partial stored policy (jsonb) over the safe defaults — a missing/corrupt field never widens permissions beyond default. */
export function resolveAgentPolicy(stored: Partial<AgentPolicy> | null | undefined): AgentPolicy {
  if (!stored || typeof stored !== "object") return DEFAULT_AGENT_POLICY;
  return {
    ...DEFAULT_AGENT_POLICY,
    ...stored,
    // Never let a stored value relax the two safety-critical fields below
    // the built-in default via missing/malformed data — only an explicit
    // boolean overrides them.
    enforceOptOut: true,
    emergencyPaused: stored.emergencyPaused === true,
  };
}

export function isWithinOperatingHours(policy: AgentPolicy, now: Date = new Date()): boolean {
  if (!policy.operatingHours) return true;
  const hhmm = now.toTimeString().slice(0, 5);
  return hhmm >= policy.operatingHours.start && hhmm <= policy.operatingHours.end;
}
