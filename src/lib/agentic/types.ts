// src/lib/agentic/types.ts
//
// Phase 9.6 — Agentic Architecture Readiness. Shared types for the action
// registry / execution / approval / usage / event pipeline. Deliberately
// environment-agnostic: nothing here imports a concrete Supabase client
// instance, so this module is safe to import from both browser code
// (src/routes, src/lib) and Netlify functions. Handlers receive whichever
// client the caller already has (the browser anon client for read-only UI
// previews, the service-role admin client inside Netlify functions for
// anything that writes) — see action-registry.ts.
//
// This file defines the VOCABULARY the rest of Phase 9.6 is built from. It
// does not implement business logic itself.

import type { SupabaseClient } from "@supabase/supabase-js";

// ── Actor model (Priority 2) ────────────────────────────────────────────
// Every execution records who/what actually caused it — never represented
// as if a human user performed an automated action.
export const ACTOR_TYPES = ["user", "agent", "workflow", "integration", "system"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export type Actor = {
  actorType: ActorType;
  /** UUID for a user/agent-instance, a stable string key for workflow/integration/system actors. */
  actorId: string | null;
  /** Free-text origin, e.g. "contacts_page_manual_run", "schedule.daily", "gmail_webhook". */
  source?: string;
};

// ── Risk levels (Priority 3) ────────────────────────────────────────────
export const RISK_LEVELS = ["read", "low", "medium", "high", "prohibited"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Ordinal so callers can compare/gate ("this instance may run at most 'medium'"). */
export const RISK_LEVEL_ORDER: Record<RiskLevel, number> = {
  read: 0,
  low: 1,
  medium: 2,
  high: 3,
  prohibited: 4,
};

// ── Autonomy levels (Priority 4) ────────────────────────────────────────
// Stored server-side on agent_instances.autonomy_level — NEVER accepted
// as an override from a client request. See autonomy.ts.
export const AUTONOMY_LEVELS = [1, 2, 3, 4] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const AUTONOMY_LEVEL_LABELS: Record<AutonomyLevel, string> = {
  1: "Recommend",
  2: "Prepare",
  3: "Limited execution",
  4: "Managed autonomy",
};

// ── Execution / step status vocabulary (Priority 7) ─────────────────────
export const EXECUTION_STATUSES = [
  "queued", "running", "awaiting_approval", "succeeded", "partially_succeeded",
  "failed", "cancelled", "paused", "expired",
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const STEP_STATUSES = [
  "pending", "running", "awaiting_approval", "succeeded", "failed", "skipped", "cancelled",
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const STEP_TYPES = ["read", "propose", "approval", "write", "notify"] as const;
export type StepType = (typeof STEP_TYPES)[number];

// ── Approval status vocabulary (Priority 5) ─────────────────────────────
export const APPROVAL_STATUSES = [
  "pending", "approved", "rejected", "expired", "cancelled", "executed", "failed",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

// ── Action registry shape (Priority 1) ───────────────────────────────────
export type ActionCategory =
  | "context" | "task" | "note" | "communication" | "lead" | "deal" | "scheduling";

/** Which actor kinds are allowed to invoke this action at all — independent of risk/approval. */
export type SupportedActorType = ActorType;

export type RetryPolicy = {
  maxAttempts: number;
  backoffSeconds: number;
};

export type ActionContext = {
  supabase: SupabaseClient;
  orgId: string;
  actor: Actor;
  /** Set once an execution row exists — handlers may be called in a dry-run/preview mode without one. */
  executionId?: string;
};

export type ActionHandlerResult<TOutput = unknown> = {
  ok: boolean;
  output?: TOutput;
  error?: string;
};

export type ActionHandler<TInput = unknown, TOutput = unknown> = (
  ctx: ActionContext,
  input: TInput,
) => Promise<ActionHandlerResult<TOutput>>;

export type ActionDefinition<TInput = unknown, TOutput = unknown> = {
  /** Stable, never-reused key — this is what gets persisted in execution/approval rows. */
  key: string;
  displayName: string;
  description: string;
  category: ActionCategory;
  riskLevel: RiskLevel;
  /** A role check beyond plain org membership, if any (e.g. "owner_or_admin"). Undefined = any org member. */
  requiredPermission?: "owner_or_admin" | "org_member";
  supportedActorTypes: SupportedActorType[];
  /** Zod schema (kept as `unknown`-typed here to avoid a hard zod import in every consumer of types.ts). */
  inputSchema: { parse: (value: unknown) => TInput };
  resultSchema?: { parse: (value: unknown) => TOutput };
  requiresApproval: boolean;
  minimumAutonomyLevel: AutonomyLevel;
  idempotent: boolean;
  timeoutMs: number;
  retryPolicy: RetryPolicy;
  /** True once a real handler exists (Priority 1: "do not make every action executable yet"). */
  isExecutable: boolean;
  /** Undefined for proposal-only / not-yet-executable actions. */
  handler?: ActionHandler<TInput, TOutput>;
};
