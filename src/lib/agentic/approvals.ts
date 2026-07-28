// src/lib/agentic/approvals.ts
//
// Phase 9.6 — Priority 5. Approval-request creation, hashing, and the
// approve/reject/expire transitions. All writes here assume the caller is
// using a server-side (service-role) Supabase client — see
// netlify/functions/agent-execute.ts and agent-approve-action.ts. Nothing
// here is called from a React component.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Actor, RiskLevel } from "./types";

/** Stable SHA-256 hash of the proposed input — used to detect any change between request and approval. */
export async function hashProposedInput(input: unknown): Promise<string> {
  const json = JSON.stringify(input, Object.keys(input as object).sort());
  const bytes = new TextEncoder().encode(json);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type CreateApprovalRequestInput = {
  orgId: string;
  agentInstanceId?: string | null;
  executionId: string;
  executionStepId?: string | null;
  actionKey: string;
  targetEntityType?: string | null;
  targetEntityId?: string | null;
  proposedInput: unknown;
  summary: string;
  riskLevel: RiskLevel;
  requestedBy: Actor;
  /** Defaults to 24h if not given — every approval must expire (Priority 5). */
  expiresInMs?: number;
};

const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export async function createApprovalRequest(supabase: SupabaseClient, input: CreateApprovalRequestInput) {
  const hash = await hashProposedInput(input.proposedInput);
  const expiresAt = new Date(Date.now() + (input.expiresInMs ?? DEFAULT_APPROVAL_TTL_MS)).toISOString();

  return supabase
    .from("agent_approval_requests")
    .insert({
      org_id: input.orgId,
      agent_instance_id: input.agentInstanceId ?? null,
      execution_id: input.executionId,
      execution_step_id: input.executionStepId ?? null,
      action_key: input.actionKey,
      target_entity_type: input.targetEntityType ?? null,
      target_entity_id: input.targetEntityId ?? null,
      proposed_input: input.proposedInput,
      proposed_input_hash: hash,
      summary: input.summary,
      risk_level: input.riskLevel,
      requested_by_actor_type: input.requestedBy.actorType,
      requested_by_actor_id: input.requestedBy.actorId,
      expires_at: expiresAt,
    })
    .select("*")
    .single();
}

export type ApprovalDecisionResult =
  | { ok: true; approval: Record<string, unknown> }
  | { ok: false; reason: "not_found" | "already_decided" | "expired" | "input_mismatch" };

/**
 * Marks an approval as approved. Does NOT execute the action — that's a
 * separate step (agent-approve-action.ts calls this, then re-validates the
 * hash again immediately before executing, per Priority 5: approved input
 * cannot be silently changed after approval).
 */
export async function approveRequest(
  supabase: SupabaseClient,
  approvalId: string,
  orgId: string,
  reviewerId: string,
  currentProposedInput: unknown,
): Promise<ApprovalDecisionResult> {
  const { data: existing, error } = await supabase
    .from("agent_approval_requests")
    .select("*")
    .eq("id", approvalId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (error || !existing) return { ok: false, reason: "not_found" };
  if (existing.status !== "pending") return { ok: false, reason: "already_decided" };
  if (existing.expires_at && new Date(existing.expires_at) < new Date()) {
    await supabase.from("agent_approval_requests").update({ status: "expired" }).eq("id", approvalId);
    return { ok: false, reason: "expired" };
  }

  const recomputedHash = await hashProposedInput(currentProposedInput ?? existing.proposed_input);
  if (recomputedHash !== existing.proposed_input_hash) return { ok: false, reason: "input_mismatch" };

  const { data: updated } = await supabase
    .from("agent_approval_requests")
    .update({ status: "approved", reviewed_by: reviewerId, reviewed_at: new Date().toISOString() })
    .eq("id", approvalId)
    .eq("org_id", orgId)
    .select("*")
    .single();

  return { ok: true, approval: updated };
}

export async function rejectRequest(
  supabase: SupabaseClient,
  approvalId: string,
  orgId: string,
  reviewerId: string,
  reason: string,
): Promise<ApprovalDecisionResult> {
  const { data: existing } = await supabase
    .from("agent_approval_requests")
    .select("id, status")
    .eq("id", approvalId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (!existing) return { ok: false, reason: "not_found" };
  if (existing.status !== "pending") return { ok: false, reason: "already_decided" };

  const { data: updated } = await supabase
    .from("agent_approval_requests")
    .update({ status: "rejected", reviewed_by: reviewerId, reviewed_at: new Date().toISOString(), rejection_reason: reason })
    .eq("id", approvalId)
    .eq("org_id", orgId)
    .select("*")
    .single();

  return { ok: true, approval: updated };
}

/** Marks this approval executed exactly once — called only after the underlying action has actually run successfully. */
export async function markApprovalExecuted(supabase: SupabaseClient, approvalId: string, orgId: string) {
  await supabase
    .from("agent_approval_requests")
    .update({ status: "executed" })
    .eq("id", approvalId)
    .eq("org_id", orgId)
    .eq("status", "approved"); // Only transitions from approved — never re-executes an already-executed row.
}
