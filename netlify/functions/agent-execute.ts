/// <reference types="node" />
// netlify/functions/agent-execute.ts
//
// Phase 9.6 proof-of-concept endpoint (Priority 16): "Manual Lead
// Follow-Up Preparation." This is the ONLY entry point that creates an
// agent_executions row and calls the action-executor pipeline for this
// phase — there is no scheduled/background caller yet (see Phase 9.6
// report's background-job-strategy section).
//
// Security: this function always resolves org id from the caller's own
// auth token (never trusts a client-supplied org id), uses the
// service-role client for all writes (agent_executions/steps/approvals
// have no client-side INSERT policy — see the Phase 9.6 migration), and
// validates the target lead belongs to the caller's org before doing
// anything with it.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { executeStep } from "../../src/lib/agentic/action-executor";
import type { Actor } from "../../src/lib/agentic/types";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function resolveOrgId(userId: string): Promise<string | null> {
  const { data: profile } = await supabaseAdmin.from("profiles").select("organization_id").eq("id", userId).maybeSingle();
  if (profile?.organization_id) return profile.organization_id;
  const { data: membership } = await supabaseAdmin.from("org_memberships").select("org_id").eq("member_id", userId).maybeSingle();
  return membership?.org_id ?? null;
}

export const handler: Handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: "Method Not Allowed" };

  const authToken = event.headers.authorization?.slice(7);
  if (!authToken) return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  const { data: { user } } = await supabaseAdmin.auth.getUser(authToken);
  if (!user) return { statusCode: 401, headers, body: JSON.stringify({ error: "Invalid token" }) };

  const orgId = await resolveOrgId(user.id);
  if (!orgId) return { statusCode: 403, headers, body: JSON.stringify({ error: "Could not resolve your organization." }) };

  let reqBody: { flow?: string; leadId?: string };
  try { reqBody = JSON.parse(event.body ?? "{}"); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  if (reqBody.flow !== "lead_follow_up_prep_poc" || !reqBody.leadId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "flow must be 'lead_follow_up_prep_poc' and leadId is required" }) };
  }

  // Confirm the lead belongs to the caller's own org BEFORE creating an
  // execution row — never trust the client-supplied leadId's org scope.
  const { data: lead } = await supabaseAdmin.from("leads").select("id").eq("id", reqBody.leadId).eq("org_id", orgId).maybeSingle();
  if (!lead) return { statusCode: 404, headers, body: JSON.stringify({ error: "Lead not found in your organization." }) };

  const actor: Actor = { actorType: "user", actorId: user.id, source: "contacts_or_leads_manual_run" };
  // Phase 9.6 proof-of-concept always runs at autonomy Level 2 ("Prepare")
  // — drafts/proposals only, human approval required before any write
  // that isn't a plain internal note. This is NOT read from any client
  // input (Priority 4: never let a frontend-provided autonomy value
  // override server-side policy).
  const autonomyLevel = 2 as const;

  const { data: execution, error: execError } = await supabaseAdmin
    .from("agent_executions")
    .insert({
      org_id: orgId,
      agent_key: "lead_follow_up_prep_poc",
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      source: actor.source,
      trigger_event: "manual.run_requested",
      status: "running",
      autonomy_level: autonomyLevel,
      target_entity_type: "lead",
      target_entity_id: reqBody.leadId,
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (execError || !execution) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Could not start execution." }) };
  }

  const executionId = execution.id as string;
  const dayBucket = new Date().toISOString().slice(0, 10);

  try {
    const step1 = await executeStep({
      supabase: supabaseAdmin, orgId, actor, executionId, sequence: 1,
      actionKey: "get_lead_context", rawInput: { leadId: reqBody.leadId }, autonomyLevel,
      targetEntityType: "lead", targetEntityId: reqBody.leadId,
    });

    if (step1.status !== "succeeded") {
      await supabaseAdmin.from("agent_executions").update({
        status: "failed", error: step1.error ?? "Could not load lead context.", completed_at: new Date().toISOString(),
      }).eq("id", executionId);
      return { statusCode: 200, headers, body: JSON.stringify({ executionId, status: "failed", error: step1.error }) };
    }

    const step2 = await executeStep({
      supabase: supabaseAdmin, orgId, actor, executionId, sequence: 2,
      actionKey: "draft_customer_reply", rawInput: { leadId: reqBody.leadId, tone: "friendly" }, autonomyLevel,
      targetEntityType: "lead", targetEntityId: reqBody.leadId,
    });

    const step3 = await executeStep({
      supabase: supabaseAdmin, orgId, actor, executionId, sequence: 3,
      actionKey: "create_follow_up_task",
      rawInput: { leadId: reqBody.leadId, title: "Follow up on prepared response", dueDate: dayBucket },
      autonomyLevel,
      // One follow-up-task proposal per lead per day (Priority 8 —
      // duplicate-action prevention). Versioned "v2" so this never matches
      // a pre-Phase-10.1 idempotency row from the old note-based path —
      // those legacy rows are left untouched for audit history, and a
      // fresh real task can always be created under the new key rather
      // than being falsely blocked by an old, incomplete record (see
      // action-registry.ts / lead-tasks.ts).
      idempotencyKey: `create_follow_up_task:v2:${reqBody.leadId}:${dayBucket}`,
      targetEntityType: "lead", targetEntityId: reqBody.leadId,
      // Phase 10.1 — this now creates a real task linked to the lead, not a note.
      approvalSummary: `Create a follow-up task for this lead: "Follow up on prepared response".`,
    });

    const finalStatus = step3.status === "awaiting_approval" ? "awaiting_approval" : (step3.status === "succeeded" ? "succeeded" : "partially_succeeded");
    await supabaseAdmin.from("agent_executions").update({
      status: finalStatus,
      output_summary: { leadContext: step1.output, draft: step2.output, followUpTask: { status: step3.status, approvalRequestId: step3.approvalRequestId } },
      completed_at: finalStatus === "awaiting_approval" ? null : new Date().toISOString(),
    }).eq("id", executionId);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        executionId,
        status: finalStatus,
        leadContext: step1.output,
        draft: step2.output,
        followUpTask: { status: step3.status, approvalRequestId: step3.approvalRequestId },
        debugVersion: "agentic-task-linkage-v1",
      }),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error.";
    await supabaseAdmin.from("agent_executions").update({ status: "failed", error: message, completed_at: new Date().toISOString() }).eq("id", executionId);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Execution failed.", executionId, debugVersion: "agentic-task-linkage-v1" }) };
  }
};
