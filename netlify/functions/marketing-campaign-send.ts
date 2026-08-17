// netlify/functions/marketing-campaign-send.ts
//
// Trusted transition point from a draft Campaign into the send pipeline.
// Queries the LIVE `campaigns` / `campaign_recipients` tables (reconciled,
// not duplicated — see 20260829_marketing_campaigns_foundation.sql).
// Does NOT loop over recipients and call the email/SMS provider
// synchronously in this request (mandatory per Phase 14.1 spec — no bulk
// sending from a normal HTTP request). Instead it:
//   1. Validates the campaign belongs to the caller's org and is still a
//      draft.
//   2. Resolves the audience via the same whitelisted filter resolver used
//      by marketing-audience-preview.ts (single source of truth).
//   3. Snapshots eligible recipients into campaign_recipients
//      (status='queued', destination = the canonical snapshotted send
//      target) — excluded contacts are recorded too, with a reason, so
//      the Campaign Detail view can show them.
//   4. Sets the campaign to 'queued' (send now) or 'scheduled' (send
//      later) — RLS + the campaigns write-guard trigger both block a
//      client from doing either of these status writes directly; only
//      this service_role-backed function can.
//
// Actual dispatch to Twilio/Gmail happens in
// marketing-campaign-process-queue.ts, a scheduled function that claims
// due work in bounded batches — see that file for the idempotency model.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { validateAudienceFilters, resolveAudienceContacts, splitByChannelEligibility } from "../../src/lib/marketing-audience";

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

function toE164(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === "1") return `+${digits}`;
  return raw.startsWith("+") ? raw : `+${digits}`;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };

  const resolved = await resolveOrgFromBearerToken(supabaseAdmin, event.headers.authorization);
  if (!resolved) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized" }) };
  const { orgId } = resolved;

  let reqBody: { campaignId?: string; mode?: "now" | "schedule"; scheduledAt?: string };
  try {
    reqBody = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { campaignId, mode, scheduledAt } = reqBody;
  if (!campaignId || (mode !== "now" && mode !== "schedule")) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "campaignId and mode ('now'|'schedule') are required" }) };
  }
  if (mode === "schedule" && !scheduledAt) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "scheduledAt is required when mode is 'schedule'" }) };
  }

  try {
    const { data: campaign, error: campErr } = await supabaseAdmin
      .from("campaigns")
      .select("*")
      .eq("id", campaignId)
      .eq("org_id", orgId) // never trust a cross-org campaign id
      .maybeSingle();
    if (campErr || !campaign) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: "Campaign not found" }) };
    }
    if (campaign.status !== "draft") {
      return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: `Campaign is already ${campaign.status} — cannot re-send` }) };
    }
    if (campaign.campaign_type === "email" && !campaign.subject) {
      return { statusCode: 422, headers: CORS, body: JSON.stringify({ error: "Email subject is required" }) };
    }
    if (!campaign.content?.trim()) {
      return { statusCode: 422, headers: CORS, body: JSON.stringify({ error: "Message content cannot be empty" }) };
    }

    // Verify the org actually has a configured provider for this channel
    // before queuing anything — matches send-inbox-message.ts's checks.
    const { data: org } = await supabaseAdmin.from("organizations").select("integration_settings").eq("id", orgId).maybeSingle();
    if (campaign.campaign_type === "sms") {
      const twilio = org?.integration_settings?.twilio;
      if (!twilio?.accountSid || !twilio?.authToken || !twilio?.phoneNumber) {
        return { statusCode: 422, headers: CORS, body: JSON.stringify({ error: "Twilio not configured — go to Settings → Integrations → Twilio" }) };
      }
    } else {
      const gmail = org?.integration_settings?.gmail;
      if (!gmail?.email) {
        return { statusCode: 422, headers: CORS, body: JSON.stringify({ error: "Gmail not configured — go to Settings → Integrations → Gmail" }) };
      }
    }

    let filters = validateAudienceFilters(campaign.target_audience);
    if (campaign.segment_id) {
      const { data: segment } = await supabaseAdmin
        .from("marketing_segments")
        .select("filters")
        .eq("id", campaign.segment_id)
        .eq("org_id", orgId)
        .maybeSingle();
      if (segment) filters = validateAudienceFilters(segment.filters);
    }

    const contacts = await resolveAudienceContacts(supabaseAdmin, orgId, filters);
    const { eligible, excluded } = splitByChannelEligibility(contacts, campaign.campaign_type);

    if (eligible.length === 0) {
      return { statusCode: 422, headers: CORS, body: JSON.stringify({ error: "No eligible recipients — nothing to send" }) };
    }

    const now = new Date().toISOString();
    const recipientRows = [
      ...eligible.map((c) => ({
        org_id: orgId,
        campaign_id: campaignId,
        contact_id: c.id,
        destination: campaign.campaign_type === "email" ? c.email! : toE164(c.phone!),
        contact_email: c.email ?? null,
        contact_name: c.full_name,
        contact_phone: c.phone ?? null,
        status: "queued" as const,
        queued_at: now,
      })),
      ...excluded.map((e) => ({
        org_id: orgId,
        campaign_id: campaignId,
        contact_id: e.contact.id,
        destination: campaign.campaign_type === "email" ? (e.contact.email ?? "") : (e.contact.phone ?? ""),
        contact_email: e.contact.email ?? null,
        contact_name: e.contact.full_name,
        contact_phone: e.contact.phone ?? null,
        status: "excluded" as const,
        excluded_reason: e.reason,
      })),
    ];

    // Idempotent re-send-of-same-draft protection: clear any prior snapshot
    // for this campaign before inserting (a campaign only reaches this path
    // from draft, so any existing rows are from an earlier aborted attempt,
    // never a completed send).
    await supabaseAdmin.from("campaign_recipients").delete().eq("campaign_id", campaignId);
    const { error: insertErr } = await supabaseAdmin.from("campaign_recipients").insert(recipientRows);
    if (insertErr) throw new Error(`Failed to snapshot recipients: ${insertErr.message}`);

    const newStatus = mode === "now" ? "queued" : "scheduled";
    const { data: updatedCampaign, error: updateErr } = await supabaseAdmin
      .from("campaigns")
      .update({
        status: newStatus,
        scheduled_at: mode === "schedule" ? scheduledAt : now,
        total_recipients: eligible.length,
        recipients_excluded: excluded.length,
      })
      .eq("id", campaignId)
      .select()
      .single();
    if (updateErr) throw new Error(`Failed to update campaign status: ${updateErr.message}`);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: true, campaign: updatedCampaign, recipientsQueued: eligible.length, recipientsExcluded: excluded.length }),
    };
  } catch (err: any) {
    console.error("[marketing-campaign-send]", err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
