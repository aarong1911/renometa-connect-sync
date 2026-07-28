// src/lib/agentic/action-executor.ts
//
// Phase 9.6 — the ONE code path allowed to actually call a registered
// action handler. Implements the full required pipeline (see Phase 9.6
// spec's "Core Architecture Principle"):
//
//   registered action → input validation → org/permission validation →
//   autonomy/approval decision → idempotency check → business operation →
//   execution/audit log → usage recording → result
//
// This module is imported by Netlify functions (service-role Supabase
// client) only. It is deliberately NOT imported by any React component —
// per the phase requirement "no action implementation inside React
// components," UI code only ever calls the Netlify functions over HTTP.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Actor, AutonomyLevel, StepStatus, StepType } from "./types";
import { getActionDefinition } from "./action-registry";
import { autonomyAllowsAutoExecution } from "./autonomy";
import { createApprovalRequest } from "./approvals";
import { recordUsageEvent } from "./usage";

export type ExecuteStepParams = {
  supabase: SupabaseClient;
  orgId: string;
  actor: Actor;
  executionId: string;
  agentInstanceId?: string | null;
  sequence: number;
  actionKey: string;
  rawInput: unknown;
  autonomyLevel: AutonomyLevel;
  /** Required for any action with `idempotent: true`; omitted for pure reads. */
  idempotencyKey?: string;
  targetEntityType?: string;
  targetEntityId?: string;
  /** Human-readable one-liner for an approval request's `summary` column, if this step ends up requiring approval. */
  approvalSummary?: string;
};

export type ExecuteStepResult = {
  stepId: string;
  status: StepStatus;
  output?: unknown;
  approvalRequestId?: string;
  error?: string;
};

function stepTypeFor(riskLevel: string, requiresApproval: boolean): StepType {
  if (riskLevel === "read") return "read";
  if (requiresApproval) return "propose";
  return "write";
}

async function insertStep(supabase: SupabaseClient, orgId: string, executionId: string, sequence: number, actionKey: string, stepType: StepType, inputSnapshot: unknown) {
  const { data, error } = await supabase
    .from("agent_execution_steps")
    .insert({
      execution_id: executionId,
      org_id: orgId,
      sequence,
      step_type: stepType,
      action_key: actionKey,
      status: "running",
      input_snapshot: inputSnapshot ?? {},
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(`Could not create execution step: ${error.message}`);
  return data.id as string;
}

async function finishStep(supabase: SupabaseClient, stepId: string, patch: Record<string, unknown>) {
  await supabase
    .from("agent_execution_steps")
    .update({ completed_at: new Date().toISOString(), ...patch })
    .eq("id", stepId);
}

export type IdempotencyOutcome =
  | { outcome: "claimed" }
  | { outcome: "already_succeeded"; result: unknown }
  | { outcome: "blocked_incomplete" };

/**
 * Claims an idempotency slot, OR proves out whether a prior claim on the
 * same key actually finished.
 *
 * ROOT-CAUSE FIX (live debugging, this pass): `agent_action_idempotency`
 * previously only recorded that a slot had been CLAIMED, never whether
 * the handler that claimed it actually SUCCEEDED (`result_snapshot` was
 * defined in the schema but written by no code path at all — confirmed
 * by a full-repo search). That meant "a row exists for this key" was
 * being treated as proof of a real prior success, when in fact it only
 * proved someone had attempted it once. A stale row left behind by an
 * earlier bug (idempotency claimed at proposal time, before the fix in
 * the previous pass) permanently poisoned every later approval attempt
 * for the same lead/day — the approval kept reporting "already executed"
 * forever, because the mere existence of the old row was trusted, and no
 * note was ever actually inserted. Proven live: an
 * `agent_action_idempotency` row from the very first (pre-fix) test run
 * had `result_snapshot: null`, and every subsequent approval for that
 * same lead/day found that row, treated its existence as success, and
 * never called the handler again.
 *
 * Fix: a claim attempt that hits an existing row now inspects that row's
 * `result_snapshot`. A populated snapshot proves a real prior success —
 * its actual result is returned so the caller can report genuine
 * "already executed" with the real output (e.g. the real note id), never
 * a fabricated one. A null snapshot proves the prior claim never
 * completed (crash, timeout, or — as found live — a bug that claimed the
 * slot without ever running the handler); that row is atomically
 * reclaimed (a conditional UPDATE that only succeeds if the snapshot is
 * still null) so the handler can actually run now, instead of the
 * approval silently reporting a success that never happened.
 */
async function claimIdempotencySlot(supabase: SupabaseClient, orgId: string, actionKey: string, idempotencyKey: string, executionId: string): Promise<IdempotencyOutcome> {
  const { data: inserted, error: insertError } = await supabase
    .from("agent_action_idempotency")
    .upsert(
      { org_id: orgId, action_key: actionKey, idempotency_key: idempotencyKey, execution_id: executionId },
      { onConflict: "org_id,action_key,idempotency_key", ignoreDuplicates: true },
    )
    .select("id");
  if (insertError) throw new Error(`Idempotency check failed: ${insertError.message}`);
  if ((inserted ?? []).length > 0) return { outcome: "claimed" };

  // Conflict — a row for this key already exists. Find out whether it
  // represents a real completed success or an orphaned claim.
  const { data: existing, error: readError } = await supabase
    .from("agent_action_idempotency")
    .select("result_snapshot")
    .eq("org_id", orgId)
    .eq("action_key", actionKey)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (readError) throw new Error(`Idempotency check failed: ${readError.message}`);

  if (existing?.result_snapshot != null) {
    return { outcome: "already_succeeded", result: existing.result_snapshot };
  }

  // result_snapshot is null — the prior claim never actually completed.
  // Atomically reclaim it (only succeeds if still null, so a genuinely
  // concurrent success can't be clobbered) and let this attempt execute
  // for real.
  const { data: reclaimed, error: reclaimError } = await supabase
    .from("agent_action_idempotency")
    .update({ execution_id: executionId, created_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("action_key", actionKey)
    .eq("idempotency_key", idempotencyKey)
    .is("result_snapshot", null)
    .select("id");
  if (reclaimError) throw new Error(`Idempotency reclaim failed: ${reclaimError.message}`);
  if ((reclaimed ?? []).length > 0) return { outcome: "claimed" };

  // Someone else reclaimed or completed it in the instant between our
  // read and our reclaim attempt — re-check once rather than guess.
  const { data: recheck } = await supabase
    .from("agent_action_idempotency")
    .select("result_snapshot")
    .eq("org_id", orgId)
    .eq("action_key", actionKey)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (recheck?.result_snapshot != null) return { outcome: "already_succeeded", result: recheck.result_snapshot };
  return { outcome: "blocked_incomplete" };
}

/**
 * Best-effort release of a claimed idempotency slot after its handler
 * failed — without this, a transient failure would permanently "use up"
 * the slot and every future retry would be silently treated as an
 * already-completed duplicate, even though nothing ever actually
 * succeeded. Failure to release is logged, not thrown — the caller's own
 * failure result still stands either way.
 */
async function releaseIdempotencySlot(supabase: SupabaseClient, orgId: string, actionKey: string, idempotencyKey: string): Promise<void> {
  const { error } = await supabase
    .from("agent_action_idempotency")
    .delete()
    .eq("org_id", orgId)
    .eq("action_key", actionKey)
    .eq("idempotency_key", idempotencyKey);
  if (error) console.error("[action-executor] releaseIdempotencySlot failed:", error);
}

/** Records the real handler output on a claimed slot so a future duplicate attempt can prove (not assume) success. */
async function recordIdempotencyResult(supabase: SupabaseClient, orgId: string, actionKey: string, idempotencyKey: string, result: unknown): Promise<void> {
  const { error } = await supabase
    .from("agent_action_idempotency")
    .update({ result_snapshot: result ?? {} })
    .eq("org_id", orgId)
    .eq("action_key", actionKey)
    .eq("idempotency_key", idempotencyKey);
  if (error) console.error("[action-executor] recordIdempotencyResult failed:", error);
}

/**
 * Executes (or proposes) exactly one registered action as one execution
 * step. Never throws for an expected business-rule outcome (unknown
 * action, bad input, duplicate, insufficient autonomy) — those are all
 * returned as a normal `ExecuteStepResult` with a failed/skipped status so
 * the execution row can record a complete, honest history either way.
 */
export async function executeStep(params: ExecuteStepParams): Promise<ExecuteStepResult> {
  const { supabase, orgId, actor, executionId, sequence, actionKey, rawInput, autonomyLevel } = params;

  const action = getActionDefinition(actionKey);
  if (!action) {
    const stepId = await insertStep(supabase, orgId, executionId, sequence, actionKey, "write", rawInput);
    await finishStep(supabase, stepId, { status: "failed", error: "Unknown action key." });
    return { stepId, status: "failed", error: "Unknown action key." };
  }

  const stepType = stepTypeFor(action.riskLevel, action.requiresApproval);
  const stepId = await insertStep(supabase, orgId, executionId, sequence, actionKey, stepType, rawInput);

  // ── Input validation ────────────────────────────────────────────────
  let parsedInput: unknown;
  try {
    parsedInput = action.inputSchema.parse(rawInput);
  } catch {
    await finishStep(supabase, stepId, { status: "failed", error: "Input failed validation." });
    return { stepId, status: "failed", error: "Input failed validation." };
  }

  // ── Actor-type / risk validation ────────────────────────────────────
  if (!action.supportedActorTypes.includes(actor.actorType)) {
    await finishStep(supabase, stepId, { status: "failed", error: `Actor type '${actor.actorType}' is not permitted to invoke '${actionKey}'.` });
    return { stepId, status: "failed", error: "Actor type not permitted for this action." };
  }
  if (action.riskLevel === "prohibited") {
    await finishStep(supabase, stepId, { status: "failed", error: "This action is prohibited for autonomous/agent execution." });
    return { stepId, status: "failed", error: "Action is prohibited." };
  }
  if (autonomyLevel < action.minimumAutonomyLevel) {
    await finishStep(supabase, stepId, { status: "failed", error: `Requires autonomy level ${action.minimumAutonomyLevel}, current is ${autonomyLevel}.` });
    return { stepId, status: "failed", error: "Autonomy level insufficient." };
  }
  if (!action.isExecutable && !action.requiresApproval) {
    await finishStep(supabase, stepId, { status: "failed", error: "Action is registered but not yet executable in this phase." });
    return { stepId, status: "failed", error: "Action not yet executable." };
  }

  // ── Approval decision ────────────────────────────────────────────────
  // IMPORTANT (bug fix): the idempotency slot for the actual WRITE must
  // NOT be claimed here when an action only reaches the proposal stage.
  // It used to be claimed above, before this check — which meant an
  // approval-gated action (e.g. create_follow_up_task) permanently
  // consumed its idempotency key at proposal time, before its handler had
  // ever run. When the human later approved it, executeApprovedStep()'s
  // own idempotency check found the key already claimed and silently
  // skipped calling the handler, while agent-approve-action.ts still
  // reported success — so the approval showed "executed" but no note was
  // ever created. The write's idempotency key is now only ever claimed
  // immediately before a handler actually runs (see the Execute block
  // below, and executeApprovedStep()).
  const needsApproval = action.requiresApproval || !autonomyAllowsAutoExecution(action, autonomyLevel);
  if (needsApproval) {
    const { data: approval, error } = await createApprovalRequest(supabase, {
      orgId,
      agentInstanceId: params.agentInstanceId,
      executionId,
      executionStepId: stepId,
      actionKey,
      targetEntityType: params.targetEntityType,
      targetEntityId: params.targetEntityId,
      proposedInput: parsedInput,
      summary: params.approvalSummary ?? `${action.displayName} requested.`,
      riskLevel: action.riskLevel,
      requestedBy: actor,
    });
    if (error || !approval) {
      await finishStep(supabase, stepId, { status: "failed", error: "Could not create approval request." });
      return { stepId, status: "failed", error: "Could not create approval request." };
    }
    await finishStep(supabase, stepId, { status: "awaiting_approval", approval_request_id: approval.id });
    return { stepId, status: "awaiting_approval", approvalRequestId: approval.id };
  }

  // ── Idempotency (claimed only immediately before a handler call) ──────
  if (action.idempotent && params.idempotencyKey) {
    const idempotency = await claimIdempotencySlot(supabase, orgId, actionKey, params.idempotencyKey, executionId);
    if (idempotency.outcome === "already_succeeded") {
      await finishStep(supabase, stepId, { status: "skipped", output_snapshot: { reason: "duplicate_suppressed", result: idempotency.result } });
      return { stepId, status: "skipped", output: { reason: "duplicate_suppressed", result: idempotency.result } };
    }
    if (idempotency.outcome === "blocked_incomplete") {
      await finishStep(supabase, stepId, { status: "failed", error: "A previous attempt for this action did not finish. Please try again." });
      return { stepId, status: "failed", error: "A previous attempt for this action did not finish. Please try again." };
    }
  }

  // ── Execute ───────────────────────────────────────────────────────────
  if (!action.handler) {
    await finishStep(supabase, stepId, { status: "failed", error: "Action has no handler configured." });
    return { stepId, status: "failed", error: "Action has no handler configured." };
  }

  try {
    const result = await action.handler({ supabase, orgId, actor, executionId }, parsedInput);
    if (!result.ok) {
      if (action.idempotent && params.idempotencyKey) await releaseIdempotencySlot(supabase, orgId, actionKey, params.idempotencyKey);
      await finishStep(supabase, stepId, { status: "failed", error: result.error ?? "Action failed." });
      return { stepId, status: "failed", error: result.error ?? "Action failed." };
    }

    // Deterministic-stub actions still flow through the real usage ledger
    // so the pipeline is genuinely end-to-end — always zero-cost/labeled,
    // never presented as a real model call.
    if (actionKey === "draft_customer_reply") {
      await recordUsageEvent(supabase, {
        orgId, executionId, executionStepId: stepId,
        provider: "internal", model: "deterministic-stub-v1",
        inputTokens: 0, outputTokens: 0,
      });
    }

    if (action.idempotent && params.idempotencyKey) await recordIdempotencyResult(supabase, orgId, actionKey, params.idempotencyKey, result.output ?? {});
    await finishStep(supabase, stepId, { status: "succeeded", output_snapshot: result.output ?? {} });
    return { stepId, status: "succeeded", output: result.output };
  } catch (err) {
    if (action.idempotent && params.idempotencyKey) await releaseIdempotencySlot(supabase, orgId, actionKey, params.idempotencyKey);
    const message = err instanceof Error ? err.message : "Unexpected error.";
    await finishStep(supabase, stepId, { status: "failed", error: message });
    return { stepId, status: "failed", error: message };
  }
}

/**
 * Re-executes an already-approved step, called only from
 * agent-approve-action.ts after the approval hash has been re-validated.
 * Bypasses the approval gate (it's already been granted) but still runs
 * through idempotency + the same handler-invocation/audit/usage path.
 */
export async function executeApprovedStep(params: {
  supabase: SupabaseClient;
  orgId: string;
  actor: Actor;
  executionId: string;
  stepId: string;
  actionKey: string;
  approvedInput: unknown;
  idempotencyKey?: string;
}): Promise<ExecuteStepResult> {
  const { supabase, orgId, actor, executionId, stepId, actionKey, approvedInput } = params;
  const action = getActionDefinition(actionKey);
  if (!action || !action.handler) {
    await finishStep(supabase, stepId, { status: "failed", error: "Action has no handler configured." });
    return { stepId, status: "failed", error: "Action has no handler configured." };
  }

  if (action.idempotent && params.idempotencyKey) {
    const idempotency = await claimIdempotencySlot(supabase, orgId, actionKey, params.idempotencyKey, executionId);
    if (idempotency.outcome === "already_succeeded") {
      await finishStep(supabase, stepId, { status: "skipped", output_snapshot: { reason: "duplicate_suppressed", result: idempotency.result } });
      return { stepId, status: "skipped", output: { reason: "duplicate_suppressed", result: idempotency.result } };
    }
    if (idempotency.outcome === "blocked_incomplete") {
      await finishStep(supabase, stepId, { status: "failed", error: "A previous attempt for this action did not finish. Please try again." });
      return { stepId, status: "failed", error: "A previous attempt for this action did not finish. Please try again." };
    }
  }

  try {
    const parsed = action.inputSchema.parse(approvedInput);
    const result = await action.handler({ supabase, orgId, actor, executionId }, parsed);
    if (!result.ok) {
      if (action.idempotent && params.idempotencyKey) await releaseIdempotencySlot(supabase, orgId, actionKey, params.idempotencyKey);
      await finishStep(supabase, stepId, { status: "failed", error: result.error ?? "Action failed." });
      return { stepId, status: "failed", error: result.error ?? "Action failed." };
    }
    if (action.idempotent && params.idempotencyKey) await recordIdempotencyResult(supabase, orgId, actionKey, params.idempotencyKey, result.output ?? {});
    await finishStep(supabase, stepId, { status: "succeeded", output_snapshot: result.output ?? {} });
    return { stepId, status: "succeeded", output: result.output };
  } catch (err) {
    if (action.idempotent && params.idempotencyKey) await releaseIdempotencySlot(supabase, orgId, actionKey, params.idempotencyKey);
    const message = err instanceof Error ? err.message : "Unexpected error.";
    await finishStep(supabase, stepId, { status: "failed", error: message });
    return { stepId, status: "failed", error: message };
  }
}
