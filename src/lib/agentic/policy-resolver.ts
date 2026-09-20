// src/lib/agentic/policy-resolver.ts
//
// AI-1L. The ONE centralized, server-side resolver for AgentPolicy.
// action-executor.ts calls this unconditionally on every
// executeStep()/executeApprovedStep() invocation — no caller (AI Center's
// orchestrator, ai-orchestrate.ts, the legacy agent-execute.ts
// proof-of-concept) constructs or threads a policy value itself, and
// there is no parameter anywhere for one to be passed in through.
//
// ── PERSISTENCE LOCATION ─────────────────────────────────────────────────
//
// `organizations.ai_center_settings` (jsonb, added by
// supabase/migrations/20260913_ai_center_org_settings.sql) is the
// dedicated, org-wide AI Center operational/safety settings column.
// Currently supports one key:
//
//   organizations.ai_center_settings.emergencyPaused: boolean
//
// CORRECTION-PASS HISTORY (kept for context, not because either prior
// location is still read): `agent_instances.policy` was inspected and
// rejected — it is never read/written by any code path and is keyed to
// the LEGACY `agent_definitions` table, which has no row at all for the
// new orchestrator's agent keys ("reception"/"lead_qualification"). A
// first correction pass then used `organizations.integration_settings.
// aiCenter.emergencyPaused` as an interim, zero-migration stopgap. A
// read-only live check (before this cleanup pass) confirmed ZERO
// organizations ever had that interim key set (0 of 17 orgs scanned), so
// it was removed cleanly rather than kept as a second, competing source —
// this file no longer reads `integration_settings` at all.
//
// This is deliberately ORG-LEVEL ONLY today — `agentKey` is accepted in
// this file's params for forward compatibility with a future per-agent
// policy source (a small dedicated table keyed by (org_id, agent_key)
// would be the right shape for that), but nothing reads it yet.
//
// ── DEPLOYMENT ORDERING (read before deploying) ──────────────────────────
//
// This code assumes `organizations.ai_center_settings` already exists.
// Deploy order MUST be: (1) apply the migration, (2) deploy this code.
// If reversed, every `select ai_center_settings` here fails with Postgres
// error 42703 ("column does not exist") — which this function treats
// exactly like any other lookup failure: fail SAFE, resolving to
// `emergencyPaused: true`. That is a deliberate choice, not an oversight:
// unlike 20260908_appointment_sms_reminder_settings.sql's own runtime
// fallback (which treats a missing column as "feature disabled, proceed
// normally" — safe for a reminder feature), this file's safety semantics
// require the opposite default. A special-cased "missing column = not
// paused" fallback would silently reintroduce exactly the "assume
// emergencyPaused=false" risk this whole enforcement effort exists to
// close. The practical consequence of deploying code before the migration
// is that ALL mutating/outbound AI-executed actions become temporarily
// blocked (read-only actions still work — see checkEmergencyPause() in
// action-executor.ts) until the migration is applied — inconvenient, but
// safe, and easily avoided by applying the migration first.

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveAgentPolicy, type AgentPolicy } from "./policies";

export type ResolveExecutionPolicyParams = {
  /** Server-side (service-role or equivalent) Supabase client. */
  supabase: SupabaseClient;
  /** Trusted org id — the caller must already have resolved this from a
   * verified source (e.g. resolve-org.ts). NEVER derived from a model,
   * tool argument, or request body. */
  orgId: string;
  /** Reserved for a future per-agent policy source — not read from
   * anywhere today; see this file's header. */
  agentKey?: string;
};

/**
 * The ONE place a real AgentPolicy is loaded for an execution. Always
 * resolves to a complete, safe AgentPolicy via resolveAgentPolicy() (which
 * itself always forces `enforceOptOut: true` regardless of what's
 * stored — opt-out is not configurable via `ai_center_settings`, by
 * design, and this function does not attempt to make it so) — never
 * throws, never returns a partial/undefined policy.
 *
 * FAIL-SAFE CONTRACT: a genuine lookup failure (a Supabase `error` —
 * network/DB issue, OR the column not existing yet, see this file's
 * "DEPLOYMENT ORDERING" note) resolves to `emergencyPaused: true`, NOT the
 * default `false`. Combined with action-executor.ts's
 * checkEmergencyPause() (which already exempts `riskLevel: "read"`
 * actions), this means a lookup failure can never accidentally allow a
 * mutating or outbound action through, while read-only actions remain
 * completely unaffected even while the lookup itself is failing. By
 * contrast, "org row found but `ai_center_settings` is `{}` (or has no
 * `emergencyPaused` key)" is NOT a failure — that is the normal, expected
 * state for every org today (confirmed live: all 17 existing
 * organizations default to `{}` immediately after the migration is
 * applied), and correctly resolves to the safe default
 * (emergencyPaused: false), preserving AI-1J/AI-1K's existing tested
 * behavior. Only an actual boolean `true` engages the pause — any other
 * value (a stray string, a number, `null`) is treated as not-paused by
 * resolveAgentPolicy()'s own `=== true` check.
 */
export async function resolveExecutionPolicy(params: ResolveExecutionPolicyParams): Promise<AgentPolicy> {
  const { supabase, orgId } = params;

  const { data, error } = await supabase
    .from("organizations")
    .select("ai_center_settings")
    .eq("id", orgId)
    .maybeSingle();

  if (error) {
    console.error(
      "[agentic/policy-resolver] resolveExecutionPolicy lookup failed — failing safe (emergencyPaused=true):",
      error,
    );
    return resolveAgentPolicy({ emergencyPaused: true });
  }

  const aiCenterSettings = (data?.ai_center_settings ?? {}) as Partial<AgentPolicy>;
  return resolveAgentPolicy(aiCenterSettings);
}
