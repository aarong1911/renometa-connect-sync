// netlify/functions/marketing-campaign-pause.ts
//
// Trusted pause path for a scheduled/queued/sending campaign. Requires
// supabase/migrations/20260831_campaign_pause_resume.sql to be applied
// first (status = 'paused' does not pass the live campaigns_status_check
// constraint until then) — this function will fail closed with a
// database constraint error against an unmigrated database, which is the
// correct behavior (never silently accept a status the schema doesn't
// support yet).
//
// Pause means "stop claiming NEW recipients for this campaign." It can
// never revoke a provider call already in flight — see the SENDING
// section below for the exact, deliberately conservative semantics.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };

  const resolved = await resolveOrgFromBearerToken(supabaseAdmin, event.headers.authorization);
  if (!resolved) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized" }) };
  const { orgId } = resolved;

  let reqBody: { campaignId?: string };
  try {
    reqBody = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid JSON" }) };
  }
  const { campaignId } = reqBody;
  if (!campaignId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "campaignId is required" }) };

  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from("campaigns")
    .select("id, status")
    .eq("id", campaignId)
    .eq("org_id", orgId) // never trust a cross-org campaign id
    .maybeSingle();

  if (fetchErr) {
    console.error("[marketing-campaign-pause] fetch failed:", fetchErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to load campaign" }) };
  }
  if (!existing) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: "Campaign not found" }) };

  // SENDING is deliberately the most conservative case. Pausing here
  // never resets or requeues a recipient already claimed into 'sending'
  // — that attempt is allowed to reach its own terminal outcome (sent/
  // failed) exactly as if no pause had happened. What pause actually
  // prevents is the worker claiming any FURTHER 'queued' recipients for
  // this campaign on its next tick — see the campaign-status re-check
  // added to marketing-campaign-process-queue.ts's claim step for the
  // other half of this guarantee. This endpoint's job is only to flip
  // the durable `campaigns.status` row the worker checks; it does not,
  // and cannot, cancel a Twilio/Gmail call already in flight.
  if (existing.status !== "scheduled" && existing.status !== "queued" && existing.status !== "sending") {
    return {
      statusCode: 409,
      headers: CORS,
      body: JSON.stringify({ error: `Campaign is ${existing.status} — cannot pause` }),
    };
  }

  const pausedFromStatus = existing.status; // 'scheduled' | 'queued' | 'sending'

  // Atomic, race-safe transition: only matches a row still genuinely in
  // the status we just read — if the worker (or another request) moved
  // it in between, this matches zero rows instead of silently pausing a
  // campaign that has since moved on (e.g. already completed).
  const { data: updated, error: updateErr } = await supabaseAdmin
    .from("campaigns")
    .update({ status: "paused", paused_at: new Date().toISOString(), paused_from_status: pausedFromStatus })
    .eq("id", campaignId)
    .eq("org_id", orgId)
    .eq("status", pausedFromStatus)
    .select()
    .maybeSingle();

  if (updateErr) {
    console.error("[marketing-campaign-pause] update failed:", updateErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to pause campaign" }) };
  }
  if (!updated) {
    return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: "Campaign status changed before pause could be applied — refresh and try again" }) };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, campaign: updated }) };
};
