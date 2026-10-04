// netlify/functions/lead-qualification-trigger.ts
//
// Live Lead Qualification — Phase AI-3A. The production entry point for
// running Lead Qualification against a REAL CRM lead, not the Test
// Console. Backs the Leads page's "Run Lead Qualification" action.
//
// Authorization: any authenticated org member may trigger a run for a real
// lead already in their own org (same authority level as any other
// CRM-visible action on a lead they can already see — this is not a
// privileged settings change, see lead-qualification-settings.ts for that).
// The lead id is looked up server-side, scoped to the resolved org
// (`.eq("id", leadId).eq("org_id", orgId)`) — a lead id for another org
// behaves like "not found," never revealing it exists elsewhere.
//
// All policy (emergency pause, per-agent enabled flag, autonomy level),
// idempotency (agent_executions.idempotency_key), context-building, model
// invocation, and approval creation happen inside
// lib/ai/lead-qualification-dispatch.ts — this file only authenticates,
// resolves the org, validates the lead belongs to it, and calls that
// shared core exactly like every other thin Netlify handler in this repo.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { dispatchLeadQualification } from "./lib/ai/lead-qualification-dispatch";
import { isValidInvocationId } from "./lib/ai/lead-trigger";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const resolved = await resolveOrgFromBearerToken(supabaseAdmin, event.headers.authorization);
  if (!resolved) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized" }) };
  const { orgId } = resolved;

  let reqBody: { leadId?: unknown; invocationId?: unknown } = {};
  try {
    reqBody = event.body ? JSON.parse(event.body) : {};
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid JSON body." }) };
  }
  const leadId = typeof reqBody.leadId === "string" ? reqBody.leadId : null;
  if (!leadId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "leadId is required." }) };
  }
  // One id per intentional click, resent unchanged on a retry of that same
  // click — see lib/ai/lead-trigger.ts's buildManualRunIdempotencyKey. Shape
  // only is validated here; identity/authorization always come from the
  // resolved bearer token above, never from this value.
  if (!isValidInvocationId(reqBody.invocationId)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "A valid invocationId is required." }) };
  }
  const invocationId = reqBody.invocationId;

  // Server-resolved, org-scoped lookup — never trusts a client-claimed
  // contactId alongside leadId; the real linkage (if any) comes from the
  // lead row itself.
  const { data: lead, error: leadError } = await supabaseAdmin
    .from("leads")
    .select("id, contact_id")
    .eq("id", leadId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (leadError) {
    console.error("[lead-qualification-trigger] lead lookup failed:", leadError.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Could not load the lead." }) };
  }
  if (!lead) {
    // Same response whether the lead doesn't exist or belongs to another
    // org — never reveals cross-org existence.
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: "Lead not found." }) };
  }

  const result = await dispatchLeadQualification({
    supabase: supabaseAdmin,
    orgId,
    source: "manual_run",
    leadId: lead.id,
    contactId: lead.contact_id ?? undefined,
    actorId: resolved.userId,
    invocationId,
  });

  if (result.status === "failed") {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: result.error }) };
  }
  if (result.status === "skipped") {
    const messages: Record<string, string> = {
      // Manual runs dedupe on the client-generated invocationId (see
      // lib/ai/lead-trigger.ts's buildManualRunIdempotencyKey) — a genuine
      // duplicate submission of the SAME click, not a permanent "already ran
      // for this lead" lock; a fresh click (new invocationId) always works.
      duplicate: "This click was already submitted for this lead.",
      disabled: "Lead Qualification is not enabled for this organization yet. Turn it on in AI Center settings.",
      emergency_paused: "AI Center is currently emergency-paused for this organization.",
      not_live_eligible: "This trigger is not eligible to run.",
      channel_not_supported: "This channel is not yet supported for Lead Qualification actions.",
      associated_with_inbound_message: "This lead's inbound message will be handled by the messaging trigger instead.",
    };
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: "skipped", reason: result.reason, message: messages[result.reason] }) };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };
};
