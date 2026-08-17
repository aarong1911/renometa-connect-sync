// netlify/functions/marketing-campaign-cancel.ts
//
// Trusted cancel path for a scheduled/queued/paused campaign. Queries the
// LIVE `campaigns` / `campaign_recipients` tables (reconciled, not
// duplicated — see 20260829_marketing_campaigns_foundation.sql). Per the
// Phase 14.1 hardening pass, an ordinary authenticated UPDATE can no
// longer move a campaigns row out of 'draft' at all (RLS + the
// enforce_campaigns_write_guard() trigger both require
// old.status = new.status = 'draft' for any client-authored write) — so
// canceling a scheduled/queued/paused campaign has to go through this
// service_role-backed function instead of a direct client UPDATE.
//
// 'paused' was added by 20260831_campaign_pause_resume.sql — a paused
// campaign is still fully cancelable (it has no in-flight provider
// attempt by definition; pausing while 'sending' lets that one already-
// claimed batch finish before the row settles at 'paused').
//
// The status transition is done with a single UPDATE whose WHERE clause
// re-checks status = 'scheduled' OR 'queued' OR 'paused' server-side, so a
// race against marketing-campaign-process-queue.ts (which may be
// promoting the same campaign to 'sending' at the same moment) resolves
// safely: if the worker got there first, this update matches zero rows
// and the caller is told the campaign can no longer be canceled, rather
// than silently canceling a campaign that has already started sending.
// Cancel intentionally still refuses 'sending' directly — the existing
// backend already rejects that (unsafe: an in-flight provider attempt may
// exist), and nothing about pause/resume changes that analysis.

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

  // Atomic, race-safe transition: only matches a row still genuinely
  // cancelable at the instant this runs. paused_at/paused_from_status are
  // ALWAYS explicitly cleared here, regardless of source status — a bug
  // found live-testing Paused -> Canceled: writing only status='canceled'
  // left a paused row's paused_at/paused_from_status non-null while
  // status <> 'paused', violating campaigns_status_check's sibling
  // constraint campaigns_paused_fields_require_paused_status
  // (20260831_campaign_pause_resume.sql — that constraint is correct and
  // caught a real bug here; it is not weakened or touched). Scheduled/
  // queued rows already have both fields null, so clearing them
  // unconditionally is a no-op for those paths and identical in effect to
  // the pre-existing behavior — one UPDATE, not two, so no intermediate
  // constraint-violating row state is ever written.
  const { data: updated, error: updateErr } = await supabaseAdmin
    .from("campaigns")
    .update({ status: "canceled", paused_at: null, paused_from_status: null })
    .eq("id", campaignId)
    .eq("org_id", orgId) // never trust a cross-org campaign id
    .in("status", ["scheduled", "queued", "paused"])
    .select()
    .maybeSingle();

  if (updateErr) {
    console.error("[marketing-campaign-cancel]", updateErr.message);
    // A Postgres check-constraint violation (23514) here means the update
    // itself was rejected as invalid, not that something broke server-side
    // — that's a domain conflict, not an internal error, so it gets a 409
    // with a generic message rather than a raw-Postgres-detail 500. Any
    // other DB error still surfaces as 500.
    if (updateErr.code === "23514") {
      return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: "Campaign could not be canceled in its current state" }) };
    }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to cancel campaign" }) };
  }
  if (!updated) {
    // Either the campaign doesn't exist/belong to this org, or it has
    // already moved past scheduled/queued (sending/completed/failed) —
    // distinguish for a clearer error without leaking cross-org existence.
    const { data: existing } = await supabaseAdmin
      .from("campaigns")
      .select("status")
      .eq("id", campaignId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (!existing) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: "Campaign not found" }) };
    }
    return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: `Campaign is already ${existing.status} — cannot cancel` }) };
  }

  // Any recipients that hadn't been picked up yet are excluded rather than
  // left dangling in 'queued' forever. Recipients already 'sending'/'sent'/
  // 'failed' are untouched — canceling does not retroactively rewrite what
  // already happened.
  await supabaseAdmin
    .from("campaign_recipients")
    .update({ status: "excluded", excluded_reason: "Campaign canceled" })
    .eq("campaign_id", campaignId)
    .eq("status", "queued");

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, campaign: updated }) };
};
