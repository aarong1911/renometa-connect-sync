// netlify/functions/marketing-campaign-resume.ts
//
// Trusted resume path for a paused campaign. Requires
// supabase/migrations/20260831_campaign_pause_resume.sql to be applied
// first — see marketing-campaign-pause.ts's header for why.
//
// Resume target depends on paused_from_status:
//   - 'scheduled', scheduled_at still in the future -> back to 'scheduled'
//   - 'scheduled', scheduled_at already passed      -> 'queued' (the
//     worker's own "promote due scheduled campaigns" step would otherwise
//     never fire again for a campaign sitting in 'scheduled' with a past
//     scheduled_at only because it happened to be paused across that
//     boundary — resuming straight to 'queued' avoids relying on that,
//     and matches what would have already happened had it never paused)
//   - 'queued'                                       -> 'queued'
//   - 'sending'                                       -> 'queued', NEVER
//     'sending' — see the design note in the migration file. 'sending' is
//     a durable per-batch "attempt in flight" marker, not a state a
//     campaign should be placed into by an endpoint that isn't actually
//     claiming a batch right now.
//
// Never touches campaign_recipients — already-terminal recipient rows
// (sent/delivered/failed/excluded) are untouched, and any row still
// legitimately 'queued' just waits for the worker's next tick same as
// before the pause.

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
    .select("id, status, scheduled_at, paused_from_status")
    .eq("id", campaignId)
    .eq("org_id", orgId) // never trust a cross-org campaign id
    .maybeSingle();

  if (fetchErr) {
    console.error("[marketing-campaign-resume] fetch failed:", fetchErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to load campaign" }) };
  }
  if (!existing) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: "Campaign not found" }) };
  if (existing.status !== "paused") {
    return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: `Campaign is ${existing.status} — cannot resume` }) };
  }

  let nextStatus: "scheduled" | "queued";
  if (existing.paused_from_status === "scheduled") {
    const scheduledAt = existing.scheduled_at ? new Date(existing.scheduled_at) : null;
    nextStatus = scheduledAt && scheduledAt.getTime() > Date.now() ? "scheduled" : "queued";
  } else {
    // 'queued' or 'sending' both resume to 'queued' — never 'sending'.
    nextStatus = "queued";
  }

  // Atomic, race-safe transition — only matches a row still genuinely
  // 'paused' at the instant this runs.
  const { data: updated, error: updateErr } = await supabaseAdmin
    .from("campaigns")
    .update({ status: nextStatus, paused_at: null, paused_from_status: null })
    .eq("id", campaignId)
    .eq("org_id", orgId)
    .eq("status", "paused")
    .select()
    .maybeSingle();

  if (updateErr) {
    console.error("[marketing-campaign-resume] update failed:", updateErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to resume campaign" }) };
  }
  if (!updated) {
    return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: "Campaign status changed before resume could be applied — refresh and try again" }) };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, campaign: updated }) };
};
