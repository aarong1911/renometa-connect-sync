// src/lib/agentic/autonomy.ts
//
// Phase 9.6 — Priority 4. Autonomy is a SERVER-RESOLVED property of an
// org/agent-instance, never a value a client request is allowed to set
// directly. `resolveAutonomyLevel` is the only place that decides the
// effective level for an execution; callers pass in what they loaded from
// the database, not what a request body claimed.

import type { ActionDefinition, AutonomyLevel, RiskLevel } from "./types";
import { RISK_LEVEL_ORDER } from "./types";

export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = 1;

/**
 * Resolves the effective autonomy level for an execution. `instanceLevel`
 * is whatever is stored on `agent_instances.autonomy_level` for a real
 * agent instance, or undefined for the Phase 9.6 proof-of-concept (which
 * has no seeded instance and always runs at Level 1 or 2 — see
 * lead-follow-up-spec.ts). A client-requested level is only ever used as a
 * REQUEST, and only honored when it does not exceed the stored/default
 * level.
 */
export function resolveAutonomyLevel(instanceLevel: AutonomyLevel | undefined, requestedLevel?: AutonomyLevel): AutonomyLevel {
  const ceiling = instanceLevel ?? DEFAULT_AUTONOMY_LEVEL;
  if (requestedLevel === undefined) return ceiling;
  return (Math.min(requestedLevel, ceiling) as AutonomyLevel);
}

/** Prohibited-risk actions can never execute autonomously, at any autonomy level, ever. */
export function isRiskAutonomouslyExecutable(risk: RiskLevel): boolean {
  return risk !== "prohibited";
}

/**
 * Whether an action may execute WITHOUT a human approval step, given the
 * resolved autonomy level. Even when this returns true, the action's own
 * `requiresApproval` flag can still force an approval gate (e.g. send_sms
 * always requires approval regardless of autonomy, per its registry
 * entry) — this function only answers "is the autonomy level high enough
 * to consider auto-execution at all."
 */
export function autonomyAllowsAutoExecution(action: ActionDefinition, autonomyLevel: AutonomyLevel): boolean {
  if (!isRiskAutonomouslyExecutable(action.riskLevel)) return false;
  if (action.requiresApproval) return false;
  return autonomyLevel >= action.minimumAutonomyLevel;
}

/** True if this autonomy level is even allowed to attempt this action (before considering approval at all). */
export function autonomyAllowsAction(action: ActionDefinition, autonomyLevel: AutonomyLevel): boolean {
  if (action.riskLevel === "prohibited") return false;
  return autonomyLevel >= (action.riskLevel === "read" ? 1 : action.minimumAutonomyLevel) || action.requiresApproval;
}

/** Compares two risk levels — useful for a future org policy like "auto-execute up to risk level X". */
export function riskAtMost(risk: RiskLevel, ceiling: RiskLevel): boolean {
  return RISK_LEVEL_ORDER[risk] <= RISK_LEVEL_ORDER[ceiling];
}
