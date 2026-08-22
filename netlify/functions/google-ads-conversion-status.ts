// netlify/functions/google-ads-conversion-status.ts
//
// Phase 3, Step 7A: read-only status summary for the Marketing → Paid Ads
// → Google Ads "Conversion Feedback" card — counts of
// google_ads_conversion_events grouped by export_status for the caller's
// org. No gclid, no per-event detail — just counts, matching Part 14's
// "keep it compact, don't display gclid in the normal UI" requirement.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { googleAdsCorsHeaders } from "./lib/google-ads-cors";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const STATUSES = ["pending", "ready", "exported", "failed", "ineligible"] as const;

export const handler: Handler = async (event) => {
  const headers = googleAdsCorsHeaders(event, "GET, OPTIONS");

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const resolved = await resolveOrgFromBearerToken(supabaseAdmin, event.headers.authorization);
  if (!resolved) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  }
  const { orgId } = resolved;

  const { data, error } = await supabaseAdmin
    .from("google_ads_conversion_events")
    .select("export_status")
    .eq("organization_id", orgId);

  if (error) {
    console.error("[google-ads-conversion-status] lookup failed", error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "server_configuration" }) };
  }

  const counts: Record<(typeof STATUSES)[number], number> = {
    pending: 0,
    ready: 0,
    exported: 0,
    failed: 0,
    ineligible: 0,
  };
  for (const row of data ?? []) {
    const status = row.export_status as (typeof STATUSES)[number];
    if (status in counts) counts[status] += 1;
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, counts, total: (data ?? []).length }),
  };
};
