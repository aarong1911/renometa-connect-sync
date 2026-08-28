// netlify/functions/meta-lead-forms.ts
//
// Read-only Meta Lead Ads form discovery — Phase 1B / Step 2. Authenticated
// RenoMeta user only; the connected Page is resolved entirely server-side
// from the org's own "lead_ads" product meta_connections row. No page_id
// is ever accepted from the browser.
//
// GET, no request body.
//
// Never returns access_token, encrypted token, OAuth state, raw Graph
// errors, or any lead answer data (this is FORM metadata only, never
// individual leads).

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { metaAdsCorsHeaders } from "./lib/meta-ads-cors";
import { decryptMetaAccessToken } from "./lib/meta-token-crypto";
import { discoverMetaLeadForms, getMetaPageAccessToken, MetaPageTokenMissingError } from "./lib/meta-lead-ads";
import { MetaGraphApiError, metaGraphRequest } from "./lib/meta-graph-api";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

interface LeadAdsConnectionRow {
  page_id: string | null;
  page_name: string | null;
  access_token: string | null;
}

function classifyFormsError(e: unknown): "reconnect_required" | "permission_required" | "temporarily_unavailable" {
  if (e instanceof MetaPageTokenMissingError) return "permission_required";
  if (e instanceof MetaGraphApiError) {
    if (e.metaType === "OAuthException" || e.metaCode === 190) return "reconnect_required";
    if (e.metaCode === 200 || e.metaCode === 10) return "permission_required";
  }
  return "temporarily_unavailable";
}

export const handler: Handler = async (event) => {
  const headers = metaAdsCorsHeaders(event, "GET, OPTIONS");
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const resolved = await resolveOrgFromBearerToken(supabaseAdmin, event.headers.authorization);
  if (!resolved) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  }
  const { orgId } = resolved;

  const { data: connection, error: connErr } = (await supabaseAdmin
    .from("meta_connections")
    .select("page_id, page_name, access_token")
    .eq("org_id", orgId)
    .eq("product", "lead_ads")
    .maybeSingle()) as unknown as { data: LeadAdsConnectionRow | null; error: any };

  if (connErr) {
    console.error("[meta-lead-forms] connection lookup failed:", connErr.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Could not look up your Meta Lead Ads connection" }) };
  }
  if (!connection || !connection.page_id || !connection.access_token) {
    return { statusCode: 200, headers, body: JSON.stringify({ connected: false, forms: [] }) };
  }

  let userAccessToken: string;
  try {
    userAccessToken = decryptMetaAccessToken(connection.access_token);
  } catch {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Could not read your Meta Lead Ads credentials — try reconnecting", errorCode: "reconnect_required" }) };
  }

  // Page-scoped Lead Ads reads (leadgen_forms discovery, Page name lookup)
  // reject the stored long-lived USER token with OAuthException/190 —
  // confirmed via live testing. A transient Page access token is derived
  // ONCE here from that user token and reused for both calls below; it is
  // never persisted, never logged, and never returned to the browser. See
  // getMetaPageAccessToken in lib/meta-lead-ads.ts (the same helper
  // ensureMetaLeadgenSubscription already used for the Page subscription
  // call) for the derivation itself.
  let pageAccessToken: string;
  try {
    pageAccessToken = await getMetaPageAccessToken(userAccessToken, connection.page_id);
  } catch (e) {
    const errorCode = classifyFormsError(e);
    if (e instanceof MetaGraphApiError) {
      console.error("[meta-lead-forms] page token derivation failed", {
        httpStatus: e.httpStatus,
        metaType: e.metaType,
        metaCode: e.metaCode,
        metaErrorSubcode: e.metaErrorSubcode,
        fbTraceId: e.fbTraceId,
      });
    }
    const statusCode = errorCode === "reconnect_required" ? 409 : errorCode === "permission_required" ? 403 : 503;
    return {
      statusCode,
      headers,
      body: JSON.stringify({ error: "Could not verify your Meta Lead Ads connection right now — please try again", errorCode }),
    };
  }

  // Confirms the Page name is still current (profile names can change) —
  // a single cheap call, not a full re-discovery. Best-effort: falls back
  // to the stored page_name if this fails for a reason that isn't itself
  // fatal to form discovery below.
  let pageName = connection.page_name;
  try {
    const pageInfo = await metaGraphRequest<{ name?: string }>({
      path: `/${connection.page_id}`,
      accessToken: pageAccessToken,
      query: { fields: "name" },
    });
    if (typeof pageInfo.name === "string") pageName = pageInfo.name;
  } catch {
    // Non-fatal — proceed with the stored name.
  }

  try {
    const forms = await discoverMetaLeadForms(pageAccessToken, connection.page_id);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        connected: true,
        page: { id: connection.page_id, name: pageName },
        forms: forms.map((f) => ({ id: f.formId, name: f.name, status: f.status, createdTime: f.createdTime })),
      }),
    };
  } catch (e) {
    const errorCode = classifyFormsError(e);
    if (e instanceof MetaGraphApiError) {
      console.error("[meta-lead-forms] form discovery failed", {
        httpStatus: e.httpStatus,
        metaType: e.metaType,
        metaCode: e.metaCode,
        metaErrorSubcode: e.metaErrorSubcode,
        fbTraceId: e.fbTraceId,
      });
    }
    const statusCode = errorCode === "reconnect_required" ? 409 : errorCode === "permission_required" ? 403 : 503;
    return {
      statusCode,
      headers,
      body: JSON.stringify({ error: "Could not load Meta Lead Ads forms right now — please try again", errorCode }),
    };
  }
};
