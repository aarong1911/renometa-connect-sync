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

const DEBUG_VERSION = "agentic-approval-fix-v3";
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

async function resolveOrgAndAuthority(userId: string): Promise<{ orgId: string | null; isOwnerOrAdmin: boolean }> {
  const { data: profile } = await supabaseAdmin.from("profiles").select("organization_id").eq("id", userId).maybeSingle();
  if (profile?.organization_id) {
    // A user whose profile directly carries organization_id is the
    // account's own owner/creator per this codebase's established
    // org-resolution convention — always treated as authorized.
    return { orgId: profile.organization_id, isOwnerOrAdmin: true };
  }
  const { data: membership } = await supabaseAdmin.from("org_memberships").select("org_id, role").eq("member_id", userId).maybeSingle();
  if (!membership) return { orgId: null, isOwnerOrAdmin: false };
  return { orgId: membership.org_id, isOwnerOrAdmin: membership.role === "owner" || membership.role === "admin" };
}

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

  const { orgId, isOwnerOrAdmin } = await resolveOrgAndAuthority(user.id);
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
    // underlying write twice even if this endpoint is called twice.
    idempotencyKey: approval.action_key === "create_follow_up_task"
      ? `create_follow_up_task:${approval.target_entity_id}:${new Date(approval.requested_at).toISOString().slice(0, 10)}`
      : undefined,
  });

  // Only mark the approval executed when the underlying write is actually
  // PROVEN done — never merely assumed. action-executor.ts's
  // claimIdempotencySlot() only reports "already_succeeded" (surfaced here
  // as execResult.status === "skipped") when a prior attempt's REAL
  // handler output was recorded in agent_action_idempotency.result_snapshot
  // — an orphaned/never-completed prior claim is reclaimed and actually
  // executed instead (see action-executor.ts's root-cause comment), so a
  // "skipped" result here can never again be a false positive for a note
  // that was never written.
  const duplicateResult = execResult.status === "skipped"
    ? (execResult.output as { reason?: string; result?: unknown } | undefined)
    : undefined;
  const isDuplicateOfRealExecution = duplicateResult?.reason === "duplicate_suppressed";

  if (execResult.status === "succeeded" || isDuplicateOfRealExecution) {
    const realResult = (isDuplicateOfRealExecution ? duplicateResult?.result : execResult.output) as { noteId?: string } | undefined;
    const noteId = realResult?.noteId;

    // A "success" response is only ever built from a real, proven noteId —
    // never from an assumption. If the handler's own output shape ever
    // changes and stops including a noteId, this reports failure rather
    // than a false success (Step 2 requirement: "a response without a
    // real noteId must not be treated as success").
    if (!noteId) {
      logCheckpoint("missing_note_id", { approvalId: reqBody.approvalId, executionId: approval.execution_id, stepId: approval.execution_step_id, status: execResult.status });
      await supabaseAdmin.from("agent_approval_requests").update({ status: "failed" }).eq("id", reqBody.approvalId);
      await supabaseAdmin.from("agent_executions").update({ status: "failed", error: "Handler completed without a verifiable note id.", completed_at: new Date().toISOString() }).eq("id", approval.execution_id).eq("status", "awaiting_approval");
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, status: "failed", error: "Could not verify the note was created. Please try again.", debugVersion: DEBUG_VERSION }) };
    }

    logCheckpoint("note_insert_succeeded", { approvalId: reqBody.approvalId, executionId: approval.execution_id, stepId: approval.execution_step_id, noteId, alreadyExecuted: isDuplicateOfRealExecution });
    await markApprovalExecuted(supabaseAdmin, reqBody.approvalId, orgId);
    logCheckpoint("approval_marked_executed", { approvalId: reqBody.approvalId, executionId: approval.execution_id, noteId });
    await supabaseAdmin.from("agent_executions").update({ status: "succeeded", completed_at: new Date().toISOString() }).eq("id", approval.execution_id).eq("status", "awaiting_approval");
    logCheckpoint("execution_finalized", { approvalId: reqBody.approvalId, executionId: approval.execution_id, stepId: approval.execution_step_id, noteId, status: "succeeded" });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        status: isDuplicateOfRealExecution ? "already_executed" : "executed",
        approvalId: reqBody.approvalId,
        executionId: approval.execution_id,
        stepId: approval.execution_step_id,
        noteId,
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
