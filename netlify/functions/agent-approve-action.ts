/// <reference types="node" />
// netlify/functions/agent-approve-action.ts
//
// Phase 9.6 (Priority 5) — approve or reject a pending
// agent_approval_requests row. Approving executes the underlying action
// EXACTLY ONCE: the proposed_input hash is re-validated immediately before
// execution (so it can't have been silently tampered with between request
// and approval), and the action's own idempotency guard
// (agent_action_idempotency) prevents a second approval-click or a retried
// request from executing twice.
//
// Only an org owner or admin may approve/reject (Priority 12) — enforced
// here AND at the RLS layer (the "org owners and admins approve or
// reject" policy on agent_approval_requests), so this check is defense in
// depth, not the only gate.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { approveRequest, rejectRequest, markApprovalExecuted } from "../../src/lib/agentic/approvals";
import { executeApprovedStep } from "../../src/lib/agentic/action-executor";
import type { Actor } from "../../src/lib/agentic/types";
import { resolveOrgAndAuthority } from "./lib/resolve-org";

const DEBUG_VERSION = "agentic-task-linkage-v1";
const serviceRoleConfigured = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// Structured, secret-free checkpoint logging — IDs and statuses only,
// never message content or credentials. Temporary for this debugging
// pass; safe to leave in place (low volume, no PII beyond internal UUIDs)
// but trim further once the live behavior is independently confirmed.
function logCheckpoint(checkpoint: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ checkpoint, debugVersion: DEBUG_VERSION, serviceRoleConfigured, ...fields }));
}

// ── AI-2B live-incident correction pass ──────────────────────────────────
//
// ROOT CAUSE of a real live bug: this file was originally written only
// for create_follow_up_task (the one action AI-2B's predecessor phases
// had wired end-to-end) and never generalized when send_sms became a
// second real, executable, approval-required action:
//
//   1. idempotencyKey below was hardcoded to
//      `action_key === "create_follow_up_task" ? ... : undefined` — for
//      any OTHER action key (send_sms included), executeApprovedStep()
//      received NO idempotency key at all, meaning its own
//      claimIdempotencySlot()/recordIdempotencyResult() machinery
//      (action-executor.ts, unmodified and correct) never ran for
//      send_sms — a duplicate/retried approve click had NO protection
//      against sending the SAME SMS twice via Twilio.
//
//   2. The "was this really a success" check further below required
//      `realResult?.taskId` to be present — again, a create_follow_up_
//      task-specific verification shape. A real, successful send_sms
//      call (Twilio accepted it, a real provider_message_id was
//      persisted to sms_meta_messages) returns `{providerMessageId}`,
//      not `{taskId}` — so `taskId` was always undefined for send_sms,
//      and this code WRONGLY marked a genuinely successful external SMS
//      send as `agent_approval_requests.status = "failed"`. Confirmed
//      live: a real approval (send_sms) whose SMS was verifiably
//      delivered (a real Twilio MessageSid was persisted to
//      sms_meta_messages) was shown as "Failed" in the Approvals UI
//      because of this exact code path — not because anything about the
//      send or the DB persistence actually failed.
//
// Both are fixed by generalizing per-action-key instead of hardcoding to
// one action. create_follow_up_task's own behavior (idempotency key
// shape, and its deliberately paranoid "must have a real taskId or it's
// not a real success" check) is preserved BYTE-FOR-BYTE — only send_sms
// (and, structurally, any future approval-required action) now gets its
// own correct treatment instead of silently falling through
// create_follow_up_task's assumptions.
export function idempotencyKeyFor(actionKey: string, approval: { target_entity_id?: string | null; requested_at: string; execution_id: string }): string | undefined {
  if (actionKey === "create_follow_up_task") {
    return `create_follow_up_task:v2:${approval.target_entity_id}:${new Date(approval.requested_at).toISOString().slice(0, 10)}`;
  }
  if (actionKey === "send_sms") {
    // Matches the exact key the AI-2A/AI-2B Twilio channel adapter
    // documents using (ai-twilio-sms-orchestrate-background.ts) — one
    // send per execution, ever, regardless of how many times this
    // endpoint is called for the same approval.
    return `sms_reply:${approval.execution_id}`;
  }
  if (actionKey === "send_whatsapp") {
    // AI-2E follow-up fix. Matches the exact key
    // meta-whatsapp-background.ts's processWhatsAppBackground() already
    // uses when it first proposes the send_whatsapp step
    // (`whatsapp_reply:${executionId}`) — one send per execution, ever,
    // regardless of how many times this endpoint is called for the same
    // approval. Without this case, executeApprovedStep() received NO
    // idempotency key for send_whatsapp (same root cause as the send_sms
    // incident this file's header describes), so a duplicate/retried
    // approve click had no protection against sending the same WhatsApp
    // message twice via the Meta Cloud API.
    return `whatsapp_reply:${approval.execution_id}`;
  }
  return undefined;
}

// ── Hardening pass: EXPLICIT per-action success verification ────────────
//
// The prior correction pass fixed the live send_sms bug with a single
// "else" branch trusting execResult.status === "succeeded" alone for any
// action other than create_follow_up_task. That is correct FOR SEND_SMS
// TODAY (see its own case below), but as a general design it silently
// verifies any future approval-required action the same way, without ever
// requiring that action's own real proof-of-success field to exist. This
// replaces that generic branch with an explicit allowlist: each known
// action key states exactly which field on its handler's real output
// counts as proof, and anything NOT explicitly listed here fails closed
// — it is never marked "executed" merely because executeApprovedStep()
// reported "succeeded". Adding a new approval-required, executable action
// in the future requires adding its own case here deliberately; there is
// no silent default that verifies it.
export type ActionVerification = { verified: true } | { verified: false; reason: string; publicError: string };

export function verifyActionSuccess(actionKey: string, realResult: Record<string, unknown> | undefined): ActionVerification {
  if (actionKey === "create_follow_up_task") {
    // UNCHANGED from before this pass: a "success" response is only ever
    // built from a real, proven taskId, never from an assumption.
    const taskId = realResult?.taskId;
    if (typeof taskId === "string" && taskId.length > 0) return { verified: true };
    return {
      verified: false,
      reason: "Handler completed without a verifiable task id.",
      publicError: "Could not verify the task was created. Please try again.",
    };
  }

  if (actionKey === "send_sms") {
    // The Twilio MessageSid returned by handlers.ts's sendSms() — the
    // same field persisted onto sms_meta_messages.provider_message_id.
    // Its presence is the real proof Twilio accepted the message; a
    // "succeeded" status with no id is treated as unverified, not
    // trusted.
    const providerMessageId = realResult?.providerMessageId;
    if (typeof providerMessageId === "string" && providerMessageId.length > 0) return { verified: true };
    return {
      verified: false,
      reason: "Handler completed without a verifiable Twilio message id.",
      publicError: "Could not verify the message was sent. Please try again.",
    };
  }

  if (actionKey === "send_whatsapp") {
    // AI-2E follow-up fix (same bug class as send_sms above, previously
    // unfixed here). The Meta Cloud API message id returned by
    // handlers.ts's sendWhatsapp() — the same field persisted onto
    // sms_meta_messages.provider_message_id. Its presence is the real
    // proof Meta accepted the message; success must NEVER be inferred
    // from execResult.status alone, transport return truthiness, approval
    // status, or the mere absence of a thrown exception — only a real,
    // non-empty provider message id counts as proof.
    const providerMessageId = realResult?.providerMessageId;
    if (typeof providerMessageId === "string" && providerMessageId.length > 0) return { verified: true };
    return {
      verified: false,
      reason: "Handler completed without a verifiable WhatsApp provider message id.",
      publicError: "Could not verify the message was sent. Please try again.",
    };
  }

  // Unknown/future approval-required action key — fail closed. This
  // endpoint must never mark an action "executed" without an explicit,
  // action-specific verification rule above; a new action key needs its
  // own case added here before approvals for it can ever succeed through
  // this endpoint.
  return {
    verified: false,
    reason: `No success-verification rule is configured for action key "${actionKey}".`,
    publicError: "Could not verify this action completed. Please try again.",
  };
}

// AI-1M security completion pass: this used to carry its own inline
// resolveOrgAndAuthority() that treated "profile.organization_id is set"
// as proof of owner/admin authority. Live data proved that assumption
// unsafe — profiles.organization_id is populated for every org member
// (viewer, project_manager, etc.), not just the owner/creator — so that
// shortcut granted approve/reject authority to any org member. Now uses
// the canonical resolveOrgAndAuthority() from lib/resolve-org.ts, which
// resolves authority from org_memberships.role exclusively (falling back
// to profiles.role === "owner" only when no membership row exists at
// all). See that file's header for the full rationale.

export const handler: Handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: "Method Not Allowed" };

  if (!serviceRoleConfigured) {
    logCheckpoint("config_error", { error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing" });
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Server misconfigured.", debugVersion: DEBUG_VERSION }) };
  }

  const authToken = event.headers.authorization?.slice(7);
  if (!authToken) return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized", debugVersion: DEBUG_VERSION }) };
  const { data: { user } } = await supabaseAdmin.auth.getUser(authToken);
  if (!user) return { statusCode: 401, headers, body: JSON.stringify({ error: "Invalid token", debugVersion: DEBUG_VERSION }) };

  const { orgId, isOwnerOrAdmin } = await resolveOrgAndAuthority(supabaseAdmin, user.id);
  if (!orgId) return { statusCode: 403, headers, body: JSON.stringify({ error: "Could not resolve your organization.", debugVersion: DEBUG_VERSION }) };
  if (!isOwnerOrAdmin) return { statusCode: 403, headers, body: JSON.stringify({ error: "Only an organization owner or admin may approve or reject agent actions.", debugVersion: DEBUG_VERSION }) };

  let reqBody: { approvalId?: string; decision?: "approve" | "reject"; rejectionReason?: string };
  try { reqBody = JSON.parse(event.body ?? "{}"); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON", debugVersion: DEBUG_VERSION }) }; }

  if (!reqBody.approvalId || (reqBody.decision !== "approve" && reqBody.decision !== "reject")) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "approvalId and decision ('approve'|'reject') are required.", debugVersion: DEBUG_VERSION }) };
  }

  logCheckpoint("authorization_passed", { approvalId: reqBody.approvalId, orgId, userId: user.id, decision: reqBody.decision });

  if (reqBody.decision === "reject") {
    const result = await rejectRequest(supabaseAdmin, reqBody.approvalId, orgId, user.id, reqBody.rejectionReason ?? "No reason given.");
    if (!result.ok) return { statusCode: 409, headers, body: JSON.stringify({ error: `Cannot reject: ${result.reason}`, debugVersion: DEBUG_VERSION }) };
    return { statusCode: 200, headers, body: JSON.stringify({ status: "rejected", debugVersion: DEBUG_VERSION }) };
  }

  // decision === "approve"
  const { data: pending } = await supabaseAdmin
    .from("agent_approval_requests")
    .select("*")
    .eq("id", reqBody.approvalId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!pending) return { statusCode: 404, headers, body: JSON.stringify({ error: "Approval request not found.", debugVersion: DEBUG_VERSION }) };

  logCheckpoint("approval_loaded", {
    approvalId: reqBody.approvalId, executionId: pending.execution_id, stepId: pending.execution_step_id,
    actionKey: pending.action_key, orgId, leadId: pending.target_entity_type === "lead" ? pending.target_entity_id : undefined,
  });

  const decision = await approveRequest(supabaseAdmin, reqBody.approvalId, orgId, user.id, pending.proposed_input);
  if (!decision.ok) {
    logCheckpoint("hash_verification_failed", { approvalId: reqBody.approvalId, reason: decision.reason });
    return { statusCode: 409, headers, body: JSON.stringify({ error: `Cannot approve: ${decision.reason}`, debugVersion: DEBUG_VERSION }) };
  }
  logCheckpoint("hash_verified", { approvalId: reqBody.approvalId, executionId: pending.execution_id, stepId: pending.execution_step_id });

  const approval = decision.approval as any;
  const actor: Actor = { actorType: "user", actorId: user.id, source: "agent_approve_action" };

  logCheckpoint("action_resolved", { approvalId: approval.id, executionId: approval.execution_id, stepId: approval.execution_step_id, actionKey: approval.action_key, orgId, leadId: approval.target_entity_id });

  const execResult = await executeApprovedStep({
    supabase: supabaseAdmin,
    orgId,
    actor,
    executionId: approval.execution_id,
    stepId: approval.execution_step_id,
    actionKey: approval.action_key,
    approvedInput: approval.proposed_input,
    // Re-derive the SAME idempotency key the original proposing step
    // would have used, so an approval can never execute the same
    // underlying write (or, for send_sms, the same Twilio send) twice
    // even if this endpoint is called twice — see idempotencyKeyFor()'s
    // own header for the live bug this generalization fixes.
    idempotencyKey: idempotencyKeyFor(approval.action_key, approval),
  });

  // Only mark the approval executed when the underlying write is actually
  // PROVEN done — never merely assumed. action-executor.ts's
  // claimIdempotencySlot() only reports "already_succeeded" (surfaced here
  // as execResult.status === "skipped") when a prior attempt's REAL
  // handler output was recorded in agent_action_idempotency.result_snapshot
  // — an orphaned/never-completed prior claim is reclaimed and actually
  // executed instead (see action-executor.ts's root-cause comment), so a
  // "skipped" result here can never again be a false positive for a task
  // that was never created. The "v2" idempotency key (see above) also
  // guarantees this can never match a pre-Phase-10.1 note-based snapshot —
  // there is no legacy {noteId}-only record this action key/key-version
  // pair could ever collide with.
  const duplicateResult = execResult.status === "skipped"
    ? (execResult.output as { reason?: string; result?: unknown } | undefined)
    : undefined;
  const isDuplicateOfRealExecution = duplicateResult?.reason === "duplicate_suppressed";

  if (execResult.status === "succeeded" || isDuplicateOfRealExecution) {
    const realResult = (isDuplicateOfRealExecution ? duplicateResult?.result : execResult.output) as Record<string, unknown> | undefined;
    const verification = verifyActionSuccess(approval.action_key, realResult);

    if (!verification.verified) {
      logCheckpoint("verification_failed", {
        approvalId: reqBody.approvalId, executionId: approval.execution_id, stepId: approval.execution_step_id,
        actionKey: approval.action_key, status: execResult.status, reason: verification.reason,
      });
      await supabaseAdmin.from("agent_approval_requests").update({ status: "failed" }).eq("id", reqBody.approvalId);
      await supabaseAdmin.from("agent_executions").update({ status: "failed", error: verification.reason, completed_at: new Date().toISOString() }).eq("id", approval.execution_id).eq("status", "awaiting_approval");
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, status: "failed", error: verification.publicError, debugVersion: DEBUG_VERSION }) };
    }

    logCheckpoint("action_verified", {
      approvalId: reqBody.approvalId, executionId: approval.execution_id, stepId: approval.execution_step_id,
      actionKey: approval.action_key, alreadyExecuted: isDuplicateOfRealExecution,
    });

    await markApprovalExecuted(supabaseAdmin, reqBody.approvalId, orgId);
    logCheckpoint("approval_marked_executed", { approvalId: reqBody.approvalId, executionId: approval.execution_id });
    await supabaseAdmin.from("agent_executions").update({ status: "succeeded", completed_at: new Date().toISOString() }).eq("id", approval.execution_id).eq("status", "awaiting_approval");
    logCheckpoint("execution_finalized", { approvalId: reqBody.approvalId, executionId: approval.execution_id, stepId: approval.execution_step_id, status: "succeeded" });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        status: isDuplicateOfRealExecution ? "already_executed" : "executed",
        approvalId: reqBody.approvalId,
        executionId: approval.execution_id,
        stepId: approval.execution_step_id,
        // Preserved for backward compatibility with any existing caller
        // that reads body.taskId/body.providerMessageId directly —
        // undefined for any other action key, exactly matching the
        // explicit per-action verification above.
        taskId: approval.action_key === "create_follow_up_task" && typeof realResult?.taskId === "string" ? realResult.taskId : undefined,
        providerMessageId:
          (approval.action_key === "send_sms" || approval.action_key === "send_whatsapp") && typeof realResult?.providerMessageId === "string"
            ? realResult.providerMessageId
            : undefined,
        result: realResult,
        debugVersion: DEBUG_VERSION,
      }),
    };
  }

  // Handler genuinely failed (or produced an unexpected status) — the
  // approval must NOT be marked executed, so a retry stays possible and
  // the UI can show a real error instead of a false "added" toast.
  logCheckpoint("handler_failed", { approvalId: reqBody.approvalId, executionId: approval.execution_id, stepId: approval.execution_step_id, error: execResult.error, status: execResult.status });
  await supabaseAdmin.from("agent_approval_requests").update({ status: "failed" }).eq("id", reqBody.approvalId);
  await supabaseAdmin.from("agent_executions").update({ status: "failed", error: execResult.error ?? "Approved action failed to execute.", completed_at: new Date().toISOString() }).eq("id", approval.execution_id).eq("status", "awaiting_approval");
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: false,
      status: "failed",
      approvalId: reqBody.approvalId,
      executionId: approval.execution_id,
      stepId: approval.execution_step_id,
      error: execResult.error ?? "Could not complete this action. Please try again.",
      debugVersion: DEBUG_VERSION,
    }),
  };
};
