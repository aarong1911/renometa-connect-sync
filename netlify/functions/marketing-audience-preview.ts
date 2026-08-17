// netlify/functions/marketing-audience-preview.ts
//
// Authoritative Audience/Campaign recipient preview. Given either a saved
// segment_id or ad-hoc filters (validated against the whitelist in
// src/lib/marketing-audience.ts) plus a channel, resolves the exact set of
// org contacts that match, splits them into eligible/excluded, and returns
// counts + reasons. Used by the Audiences UI (live preview) and the
// Create Campaign "Review" step — never trust a client-computed count for
// what will actually be sent; this endpoint (and marketing-campaign-send.ts,
// which reuses the same resolver) is the single source of truth.

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

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };

  const resolved = await resolveOrgFromBearerToken(supabaseAdmin, event.headers.authorization);
  if (!resolved) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized" }) };
  const { orgId } = resolved;

  let reqBody: { channel?: "email" | "sms"; segmentId?: string; filters?: unknown };
  try {
    reqBody = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { channel, segmentId, filters: rawFilters } = reqBody;
  if (channel !== "email" && channel !== "sms") {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "channel must be 'email' or 'sms'" }) };
  }

  try {
    let filters = validateAudienceFilters(rawFilters);

    if (segmentId) {
      const { data: segment, error: segErr } = await supabaseAdmin
        .from("marketing_segments")
        .select("id, org_id, filters")
        .eq("id", segmentId)
        .eq("org_id", orgId) // never trust a cross-org segment id
        .maybeSingle();
      if (segErr || !segment) {
        return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: "Audience not found" }) };
      }
      filters = validateAudienceFilters(segment.filters);
    }

    const contacts = await resolveAudienceContacts(supabaseAdmin, orgId, filters);
    const { eligible, excluded } = splitByChannelEligibility(contacts, channel);

    const exclusionBreakdown: Record<string, number> = {};
    for (const e of excluded) exclusionBreakdown[e.reason] = (exclusionBreakdown[e.reason] ?? 0) + 1;

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        totalMatched: contacts.length,
        eligibleCount: eligible.length,
        excludedCount: excluded.length,
        exclusionBreakdown,
        eligiblePreview: eligible.slice(0, 50).map((c) => ({ id: c.id, name: c.full_name, destination: channel === "email" ? c.email : c.phone })),
        // destination added for the Review-step recipient preview (Phase
        // 14.1) — an excluded row still needs to show WHICH email/phone
        // was excluded (e.g. "Erran Glazer / aarong1911+0909@gmail.com /
        // Excluded / Unsubscribed"), not just the name+reason. Purely
        // additive: no change to eligibility logic, same already-resolved
        // contact object, just one more field surfaced.
        excludedPreview: excluded.slice(0, 50).map((e) => ({ id: e.contact.id, name: e.contact.full_name, destination: channel === "email" ? e.contact.email : e.contact.phone, reason: e.reason })),
      }),
    };
  } catch (err: any) {
    console.error("[marketing-audience-preview]", err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
