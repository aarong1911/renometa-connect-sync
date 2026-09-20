// netlify/functions/lib/ai/tools/types.ts
//
// AI Center — Phase AI-1B. Types for the AI Tool Registry: a thin,
// AI-facing adapter over the existing Gen-2 Agentic Foundation
// (src/lib/agentic/action-registry.ts + action-executor.ts). See
// registry.ts for the implementation and the ai-center skill's "Tool
// Registry" / "Tool Execution Security" sections for the architecture this
// implements.
//
// Nothing here duplicates the underlying action system's vocabulary
// (RiskLevel, AutonomyLevel, Actor, ActionContext, etc.) — those are
// imported directly from src/lib/agentic/types so there is exactly one
// definition of each concept in the codebase.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ActionCategory,
  Actor,
  AutonomyLevel,
  RiskLevel,
} from "../../../../../src/lib/agentic/types";

// ── Tool metadata (discovery) ───────────────────────────────────────────

/** A minimal, non-authoritative description of one top-level input field,
 * for future model tool-definitions / prompting only. This is NOT a
 * validator — action-executor.ts's real Zod schema (inside
 * action-registry.ts) is the sole enforcement mechanism regardless of what
 * this descriptor says. Hand-maintained per allowlisted tool in
 * registry.ts; a drift here only degrades model UX, never security, since
 * every execution is re-validated against the real schema either way. */
export type AIToolArgumentDescriptor = {
  name: string;
  type: "string" | "number" | "boolean" | "enum";
  required: boolean;
  description: string;
  /** Present only when type is "enum". */
  enumValues?: string[];
};

/** Provider-neutral, AI-facing metadata for one tool. Deliberately excludes
 * internal execution details (Zod schema instance, handler reference,
 * timeout/retry policy, idempotency mechanics) — those stay behind
 * executeAITool() so no caller outside this module ever needs them. */
export type AIToolDefinition = {
  /** Same value as the underlying action's `key` — what a model must pass
   * back as `toolName` to invoke it. Stable, never reused. */
  name: string;
  displayName: string;
  description: string;
  category: ActionCategory;
  riskLevel: RiskLevel;
  /** True if this tool always/sometimes requires human approval before its
   * effect takes place — set expectations for the orchestrator/model, not
   * a promise of immediate effect. */
  requiresApproval: boolean;
  arguments: AIToolArgumentDescriptor[];
};

// ── Execution ────────────────────────────────────────────────────────────

/** What a model/orchestrator may supply when asking to run a tool: the
 * tool's name and its arguments — nothing else. There is deliberately no
 * field here for orgId, actor, autonomy level, approval state, or any
 * other trust-sensitive value; see AIToolTrustedContext below and the
 * "MODEL SAFETY" section this type exists to satisfy. */
export type AIToolExecutionRequest = {
  toolName: string;
  /** Raw, model-supplied arguments. Never trusted directly — re-validated
   * by the underlying action's Zod schema inside executeAITool(). */
  input: unknown;
};

/** Everything needed to authorize and execute a tool call that must come
 * from trusted server-side state, never from model output. The
 * orchestrator (not yet built) is responsible for resolving all of these
 * fields before calling executeAITool() — e.g. from the caller's verified
 * bearer token, the agent_instances row's autonomy_level, and an
 * already-created agent_executions row. */
export type AIToolTrustedContext = {
  supabase: SupabaseClient;
  orgId: string;
  actor: Actor;
  /** Must reference an existing agent_executions row — executeStep()
   * writes an agent_execution_steps row against it and will throw if the
   * execution id is invalid. Creating that row is the orchestrator's job,
   * not this registry's. */
  executionId: string;
  /** 1-based position of this tool call within the execution, for
   * agent_execution_steps.sequence. */
  sequence: number;
  autonomyLevel: AutonomyLevel;
  agentInstanceId?: string | null;
  /** Required for any allowlisted tool with `idempotent: true` if the
   * caller wants duplicate-suppression; omit for pure reads. */
  idempotencyKey?: string;
  targetEntityType?: string;
  targetEntityId?: string;
  /** Human-readable one-liner surfaced on the resulting approval request,
   * if this tool ends up requiring approval. */
  approvalSummary?: string;
};

export type AIToolExecutionStatus = "completed" | "approval_required" | "denied" | "failed";

/** Normalized, provider-neutral result. Never carries a stack trace, a raw
 * database error, or any field the underlying action-executor didn't
 * already consider safe to record on an execution step. */
export type AIToolExecutionResult = {
  status: AIToolExecutionStatus;
  toolName: string;
  /** Present only when status is "completed". */
  output?: unknown;
  /** Present only when status is "approval_required". */
  approvalRequestId?: string;
  /** Present only when status is "denied" or "failed". Sanitized —
   * suitable to show a model or surface in a UI. */
  error?: string;
};
