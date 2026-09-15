// src/lib/agentic/action-executor.ts
//
// Phase 9.6 — the ONE code path allowed to actually call a registered
// action handler. Implements the full required pipeline (see Phase 9.6
// spec's "Core Architecture Principle"):
//
//   registered action → input validation → org/permission validation →
//   EMERGENCY PAUSE → OPT-OUT/COMMUNICATION POLICY (AI-1L) →
//   autonomy/approval decision → idempotency check → business operation →
//   execution/audit log → usage recording → result
//
// This module is imported by Netlify functions (service-role Supabase
// client) only. It is deliberately NOT imported by any React component —
// per the phase requirement "no action implementation inside React
// components," UI code only ever calls the Netlify functions over HTTP.
//
// ── AI-1L: centralized emergencyPaused / enforceOptOut enforcement ──────
//
// The earlier repository audit found `AgentPolicy.emergencyPaused` and
// `AgentPolicy.enforceOptOut` (src/lib/agentic/policies.ts) existed but
// had zero readers anywhere in the codebase — confirmed by a full-repo
// grep before this pass. This file is the single seam every AI-executed
// action already passes through (executeAITool() -> executeStep() ->
// handler, per netlify/functions/lib/ai/tools/registry.ts), so it is the
// correct, and only, place to enforce these — never per-agent, never in
// the orchestrator, never in individual handlers only.
//
// AI-1L CORRECTION PASS: the original AI-1L implementation accepted an
// OPTIONAL `policy` field on ExecuteStepParams/executeApprovedStep, which
// every real caller left unset — resolveAgentPolicy(undefined) was what
// actually ran, so emergencyPaused had no way to ever be persisted or
// engaged. Fixed by removing that optional field entirely: there is no
// longer any parameter for a caller to pass a policy through (accidentally
// or otherwise) — both executeStep() and executeApprovedStep() now call
// resolveExecutionPolicy() (policy-resolver.ts) UNCONDITIONALLY,
// themselves, using only the already-trusted `orgId`/`supabase` already
// required for everything else in this file. See policy-resolver.ts's own
// header for exactly where that policy is persisted today (an interim
// location — no migration was created without first surfacing that
// decision, per this task's explicit instruction) and its fail-safe
// contract on lookup failure.
//
// This is still SERVER-OWNED ONLY: nothing in this file, or anywhere
// upstream in AI Center (netlify/functions/lib/ai/orchestrator.ts,
// ai-orchestrate.ts), reads emergencyPaused/enforceOptOut from a model,
// request body, or tool argument — there is no field for either on
// AIChannelEvent, AITrustedContext, or any AI Center Zod schema to even
// carry one, and now not on ExecuteStepParams either.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionDefinition, Actor, AutonomyLevel, StepStatus, StepType } from "./types";
import { getActionDefinition } from "./action-registry";
import { autonomyAllowsAutoExecution } from "./autonomy";
import { createApprovalRequest } from "./approvals";
import { recordUsageEvent } from "./usage";
import type { AgentPolicy } from "./policies";
import { resolveExecutionPolicy } from "./policy-resolver";
import { splitByChannelEligibility, type AudienceContact } from "../marketing-audience";

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
  /**
   * AI-2A correction pass. Separates "this execution may autonomously
   * execute actions up to its own autonomyLevel" from "trusted server
   * code — never a model, never a request body — may PROPOSE a specific
   * action for explicit human approval, without granting the calling
   * execution's own autonomyLevel field elevated auto-execution power."
   *
   * ROOT CAUSE this fixes: the autonomy-floor check below
   * (`autonomyLevel < action.minimumAutonomyLevel`) ran unconditionally,
   * BEFORE the requiresApproval/approval-creation branch — so even an
   * action that unconditionally requires human approval (e.g. send_sms,
   * minimumAutonomyLevel 4) could never even reach "awaiting_approval"
   * unless the CALLING EXECUTION already carried autonomyLevel >= 4. A
   * channel adapter that only ever wants to propose one approval-gated
   * action was forced to set its entire execution's autonomyLevel to 4,
   * which would also (incorrectly) raise the ceiling for every OTHER
   * action that execution might touch (e.g. a future auto-executing tool
   * with a lower minimumAutonomyLevel).
   *
   * When `trustedProposal` is true AND `action.requiresApproval` is true,
   * the autonomy-floor check below is skipped for THIS action only — the
   * action still unconditionally lands in the approval-creation branch
   * (needsApproval is already forced true by requiresApproval, regardless
   * of autonomyLevel), it is never auto-executed, and every other check
   * (input validation, actor-type, emergency pause, outbound consent,
   * prohibited-risk) still runs exactly as before, in the same order. For
   * any action where `requiresApproval` is false, this flag has NO
   * effect — the normal autonomy floor still applies exactly as before,
   * so it can never be used to widen auto-execution eligibility, only to
   * reach the approval-creation branch for an already
   * approval-mandatory action.
   *
   * There is no field on any Zod tool-input schema, AIChannelEvent,
   * AITrustedContext, or HTTP request body that can set this — it is a
   * TypeScript-only parameter on this function's params type, settable
   * only by Netlify function code that imports executeStep() directly
   * (e.g. a channel adapter proposing a reply). See
   * ai-twilio-sms-orchestrate-background.ts for the one caller that uses
   * it today.
   */
  trustedProposal?: boolean;
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

// ── AI-1L: centralized policy checks ─────────────────────────────────────

export type PolicyCheckResult = { allowed: true } | { allowed: false; reason: string };

/** A pure read (riskLevel "read") is never blocked by an emergency pause —
 * the pause exists to stop the agent from DOING things, not from
 * answering what it already knows (per policies.ts's own comment:
 * "Emergency stop... checked before every execution, independent of
 * autonomy level"). Everything else (low/medium/high risk — i.e. any
 * write or communication) is blocked. Uses the action's existing
 * `riskLevel` metadata only — no action key is ever hard-coded here. */
export function checkEmergencyPause(action: ActionDefinition<unknown, unknown>, policy: AgentPolicy): PolicyCheckResult {
  if (!policy.emergencyPaused) return { allowed: true };
  if (action.riskLevel === "read") return { allowed: true };
  return {
    allowed: false,
    reason: "Blocked by emergency pause: autonomous actions are currently paused for this organization.",
  };
}

/**
 * Blocks outbound customer communication to a contact who has opted out,
 * per the REAL consent data model (src/lib/marketing-audience.ts's
 * `marketing_contact_preferences`-backed `splitByChannelEligibility()` —
 * reused as-is here, not re-implemented, so AI-driven sends and bulk
 * marketing sends can never silently diverge on what "eligible" means).
 *
 * Only applies to actions with `outboundChannel` set (see
 * ActionDefinition's own comment) — internal/read/draft-only actions
 * (get_lead_context, add_internal_note, draft_customer_reply) have no
 * such field and always pass through unaffected.
 *
 * FAIL CLOSED in every uncertain case: no contactId in the validated
 * input, a channel with no consent mechanism in this schema
 * (whatsapp/messenger/instagram/voice — none exist today), a contact
 * lookup that errors, or a contactId that doesn't resolve to a real
 * contact IN THIS ORG all block the action rather than allowing it. A
 * missing contact row is never distinguished from "belongs to a
 * different org" in the returned reason, so this check can't be used to
 * probe whether an id exists elsewhere.
 */
export async function checkOutboundConsent(
  supabase: SupabaseClient,
  orgId: string,
  action: ActionDefinition<unknown, unknown>,
  parsedInput: unknown,
  policy: AgentPolicy,
): Promise<PolicyCheckResult> {
  if (!policy.enforceOptOut) return { allowed: true };

  const channel = action.outboundChannel;
  if (!channel) return { allowed: true }; // not an outbound-communication action at all

  const SAFE_BLOCKED_REASON = "Could not verify recipient consent for this communication.";

  // Genuine business input for every currently-registered outbound
  // action (sendSmsInput/sendEmailInput both use `contactId`) — never
  // read from anywhere else. If a future outbound action doesn't carry
  // one, this fails closed rather than guessing another field name.
  const contactId =
    parsedInput && typeof parsedInput === "object" ? (parsedInput as Record<string, unknown>).contactId : undefined;
  if (typeof contactId !== "string" || !contactId) {
    return { allowed: false, reason: SAFE_BLOCKED_REASON };
  }

  if (channel !== "email" && channel !== "sms") {
    // No consent mechanism exists anywhere in the current schema for
    // whatsapp/messenger/instagram/voice — confirmed by repository audit
    // before this pass. Fail closed rather than assuming safe or
    // over-generalizing SMS/email opt-out onto a channel it was never
    // designed for.
    return { allowed: false, reason: SAFE_BLOCKED_REASON };
  }

  const [{ data: contactRow, error: contactError }, { data: prefRow, error: prefError }] = await Promise.all([
    supabase.from("contacts").select("id, full_name, email, phone").eq("id", contactId).eq("org_id", orgId).maybeSingle(),
    supabase
      .from("marketing_contact_preferences")
      .select("email_unsubscribed, email_suppressed, sms_status")
      .eq("contact_id", contactId)
      .eq("org_id", orgId)
      .maybeSingle(),
  ]);

  if (contactError || prefError) {
    console.error("[action-executor] checkOutboundConsent lookup failed:", contactError ?? prefError);
    return { allowed: false, reason: SAFE_BLOCKED_REASON };
  }
  if (!contactRow) {
    // Does not resolve to a real contact in THIS org — never trust a
    // model-supplied id, and never reveal (via a different message)
    // whether it belongs to another org.
    return { allowed: false, reason: SAFE_BLOCKED_REASON };
  }

  const audienceContact: AudienceContact = {
    id: contactRow.id,
    full_name: contactRow.full_name ?? "Unknown",
    email: contactRow.email ?? null,
    phone: contactRow.phone ?? null,
    email_unsubscribed: !!prefRow?.email_unsubscribed,
    email_suppressed: !!prefRow?.email_suppressed,
    sms_status: (prefRow?.sms_status as AudienceContact["sms_status"] | undefined) ?? "unknown",
  };

  const { eligible } = splitByChannelEligibility([audienceContact], channel);
  if (eligible.length > 0) return { allowed: true };
  return {
    allowed: false,
    reason: `Recipient is not eligible for ${channel} communication (opted out, suppressed, or missing contact info).`,
  };
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

  // ── AI-1L: emergency pause + opt-out/communication policy ────────────
  // Deliberately BEFORE the autonomy/approval decision below: a
  // policy-forbidden communication must never generate an approval
  // request (there is nothing for a human to usefully approve — the
  // action is not allowed to run regardless of who signs off), and must
  // never claim an idempotency slot (see the idempotency block further
  // down — a policy-blocked attempt must not prevent a later allowed
  // retry once the policy changes).
  //
  // Resolved fresh, unconditionally, from persisted org config — never
  // from a caller-supplied value (see this file's header "AI-1L
  // CORRECTION PASS" note and policy-resolver.ts).
  const policy = await resolveExecutionPolicy({ supabase, orgId });

  const pauseCheck = checkEmergencyPause(action, policy);
  if (!pauseCheck.allowed) {
    await finishStep(supabase, stepId, { status: "failed", error: pauseCheck.reason });
    return { stepId, status: "failed", error: pauseCheck.reason };
  }

  const consentCheck = await checkOutboundConsent(supabase, orgId, action, parsedInput, policy);
  if (!consentCheck.allowed) {
    await finishStep(supabase, stepId, { status: "failed", error: consentCheck.reason });
    return { stepId, status: "failed", error: consentCheck.reason };
  }

  if (action.riskLevel === "prohibited") {
    await finishStep(supabase, stepId, { status: "failed", error: "This action is prohibited for autonomous/agent execution." });
    return { stepId, status: "failed", error: "Action is prohibited." };
  }
  // AI-2A correction pass: `trustedProposal` (only ever set by trusted
  // server code, never derived from a model/request — see this file's
  // ExecuteStepParams doc comment) skips ONLY this floor check, and ONLY
  // for an action that unconditionally requires approval — see that
  // comment for the full reasoning.
  const skipAutonomyFloorForTrustedProposal = params.trustedProposal === true && action.requiresApproval === true;
  if (autonomyLevel < action.minimumAutonomyLevel && !skipAutonomyFloorForTrustedProposal) {
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

  // ── AI-1L: emergency pause + opt-out/communication policy ────────────
  // CRITICAL: resolved FRESH here, at execution time — never a value
  // carried over from when the approval request was created. An approval
  // can sit pending for an arbitrary amount of time; if emergency pause is
  // engaged (or a contact opts out) after the approval was requested but
  // before a human clicks "approve," this re-checks the CURRENT state
  // right before the handler runs, so approval can never become a way to
  // bypass a policy that's active right now. Same ordering rationale as
  // executeStep() — before idempotency, so a policy-blocked approval
  // attempt never consumes a slot that would block a later, allowed
  // retry. `approvedInput` is parsed defensively here only to extract a
  // contactId for the consent check; a parse failure here doesn't skip
  // the check, it just means checkOutboundConsent() fails closed on "no
  // contactId" — the try block below still re-parses properly and
  // handles a genuine validation failure on its own terms.
  const policy = await resolveExecutionPolicy({ supabase, orgId });
  const pauseCheck = checkEmergencyPause(action, policy);
  if (!pauseCheck.allowed) {
    await finishStep(supabase, stepId, { status: "failed", error: pauseCheck.reason });
    return { stepId, status: "failed", error: pauseCheck.reason };
  }
  let parsedForConsentCheck: unknown;
  try {
    parsedForConsentCheck = action.inputSchema.parse(approvedInput);
  } catch {
    parsedForConsentCheck = undefined;
  }
  const consentCheck = await checkOutboundConsent(supabase, orgId, action, parsedForConsentCheck, policy);
  if (!consentCheck.allowed) {
    await finishStep(supabase, stepId, { status: "failed", error: consentCheck.reason });
    return { stepId, status: "failed", error: consentCheck.reason };
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
