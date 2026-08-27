// netlify/functions/meta-ads-select-account.ts
//
// Authenticated ad-account-selection endpoint — Phase 1A / Step 1 (Part D).
// Accepts ONLY an adAccountId from the browser; it is never trusted
// directly — every selection is validated against a FRESH live Meta
// discovery call before being persisted, never against the request body
// alone and never against a previously-stored value. Update is scoped by
// connection id + org_id + product together, so one organization can never
// select (or overwrite) another organization's Meta Ads connection.
//
// POST { adAccountId: string }
//
// Never logs or returns: access_token, encrypted token, META_APP_SECRET,
// OAuth state, or nonce.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { metaAdsCorsHeaders } from "./lib/meta-ads-cors";
import { loadMetaAdsConnection } from "./lib/meta-ads-context";
import { discoverMetaAdsAccounts, validateSelectableMetaAdAccount } from "./lib/meta-ads-api";
import { MetaGraphApiError } from "./lib/meta-graph-api";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

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

  let reqBody: { adAccountId?: unknown };
  try {
    reqBody = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }
  const submittedAdAccountId = typeof reqBody.adAccountId === "string" ? reqBody.adAccountId.trim() : "";
  if (!submittedAdAccountId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "adAccountId is required" }) };
  }

  const connResult = await loadMetaAdsConnection(supabaseAdmin, orgId);
  if (!connResult.ok) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "No connected Meta Ads account found — connect Meta Ads in Settings → Integrations first" }),
    };
  }

  let discovery;
  try {
    discovery = await discoverMetaAdsAccounts(connResult.connection.accessToken);
  } catch (e) {
    const safe = e instanceof MetaGraphApiError ? e.toSafeJSON() : { message: "unknown" };
    console.error("[meta-ads-select-account] discovery failed", safe);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: "Could not verify your Meta ad accounts right now — please try again" }),
    };
  }

  const validation = validateSelectableMetaAdAccount(discovery.adAccounts, submittedAdAccountId);
  if (!validation.ok) {
    return {
      statusCode: 403,
      headers,
      body: JSON.stringify({ error: "That Meta ad account is not accessible from this connection" }),
    };
  }
  const account = validation.account;

  // Scoped by connection id + org_id + product together — a concurrent
  // disconnect/reconnect changing the row between the lookup above and
  // this write means zero rows match, handled as 409 below, never a write
  // to a row that may no longer represent this org's current connection.
  const { data: updated, error: updateErr } = await supabaseAdmin
    .from("meta_connections")
    .update({
      ad_account_id: account.id,
      ad_account_name: account.name,
      updated_at: new Date().toISOString(),
    })
    .eq("id", connResult.connection.connectionId)
    .eq("org_id", orgId)
    .eq("product", "ads")
    .select("id")
    .maybeSingle();

  if (updateErr) {
    console.error("[meta-ads-select-account] update failed:", updateErr.code);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Could not save your account selection" }) };
  }
  if (!updated) {
    return { statusCode: 409, headers, body: JSON.stringify({ error: "Your Meta Ads connection changed — please try again" }) };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      selectedAdAccountId: account.id,
      selectedAdAccountName: account.name,
    }),
  };
};
