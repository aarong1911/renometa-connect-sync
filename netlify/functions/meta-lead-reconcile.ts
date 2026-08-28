// netlify/functions/meta-lead-reconcile.ts
//
// Manual "sync recent leads" reconciliation trigger — Phase 1B / Step 2.
// This is a FALLBACK path, never the primary one: the Meta webhook
// (meta-webhook.ts) is the primary, near-real-time ingestion path. This
// endpoint exists for missed/failed webhook deliveries, and calls the
// EXACT SAME ingestion function (processMetaLeadgenEvent, via
// reconcileMetaLeadAds) the webhook uses — there is no second CRM-creation
// implementation anywhere in this feature.
//
// POST { window?: "1h" | "6h" | "24h" | "72h" | "7d" } (defaults to "24h")
//
// Authenticated RenoMeta user only. The org — and therefore the Page/
// connection/token used — is resolved entirely server-side from the
// bearer token; the request body accepts ONLY the reconciliation window,
// never an org/page/form/ad-account ID as an authorization input.
//
// Never returns access_token, encrypted token, lead PII (email/phone/full
// name/custom answers), or raw Meta error text — only a bounded, safe
// summary plus per-lead errorCode (never the lead's own data) on failure.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { metaAdsCorsHeaders } from "./lib/meta-ads-cors";
import { reconcileMetaLeadAds, META_RECONCILE_WINDOWS, type MetaReconcileWindow } from "./lib/meta-lead-ads";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

function isValidWindow(v: unknown): v is MetaReconcileWindow {
  return typeof v === "string" && (META_RECONCILE_WINDOWS as readonly string[]).includes(v);
}

export const handler: Handler = async (event) => {
  const headers = metaAdsCorsHeaders(event, "POST, OPTIONS");
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const resolved = await resolveOrgFromBearerToken(supabaseAdmin, event.headers.authorization);
  if (!resolved) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  }
  const { orgId } = resolved;

  let reqBody: { window?: unknown };
  try {
    reqBody = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const window: MetaReconcileWindow = isValidWindow(reqBody.window) ? reqBody.window : "24h";
  if (reqBody.window !== undefined && !isValidWindow(reqBody.window)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `window must be one of: ${META_RECONCILE_WINDOWS.join(", ")}` }) };
  }

  const result = await reconcileMetaLeadAds(supabaseAdmin, orgId, window);

  if (!result.ok) {
    const statusCode = result.errorCode === "reconnect_required" ? 409 : result.errorCode === "permission_required" ? 403 : result.errorCode === "not_connected" ? 200 : 500;
    return {
      statusCode,
      headers,
      body: JSON.stringify(
        result.errorCode === "not_connected"
          ? { connected: false, errorCode: result.errorCode }
          : { error: "Could not sync Meta Lead Ads leads right now", errorCode: result.errorCode },
      ),
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok: true,
      window,
      formsScanned: result.formsScanned,
      leadsDiscovered: result.leadsDiscovered,
      created: result.created,
      matched: result.matched,
      duplicates: result.duplicates,
      failed: result.failed,
      // Only metaLeadId + a fixed internal errorCode — never PII.
      failures: result.failures,
      truncated: result.truncated,
    }),
  };
};
