// netlify/functions/meta-whatsapp-embedded-signup-config.ts
//
// WhatsApp Embedded Signup / coexistence, Phase 1 (2026-09). The ONLY
// endpoint the Phase 2 frontend may call to learn what to pass into
// FB.login({config_id, ...}) — returns exclusively the values Meta itself
// already serves back to the browser as part of the Embedded Signup
// launch (app id, the dedicated WhatsApp Coexistence config_id, Graph API
// version). Never returns META_APP_SECRET, any access token, any
// encrypted token, or any other app_config_secrets key — this endpoint's
// entire job is to be a narrow, explicit allowlist of exactly 3 safe
// values, not a general config-read proxy.
//
// Same authority model as every other privileged Meta-connection endpoint
// in this codebase (meta-whatsapp-select-number.ts,
// meta-whatsapp-validate-number.ts): bearer-auth, org/role resolved
// server-side via resolveOrgAndAuthority(), owner/admin required — this
// mirrors the existing integration UX (only an owner/admin can start or
// complete a Meta connection today).
//
// GET only — this is a read, not a mutation.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgAndAuthority } from "./lib/resolve-org";
import { getAppConfigs } from "./lib/app-config-store";
import { META_GRAPH_API_VERSION } from "./lib/meta-graph-api";

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
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const token = event.headers.authorization?.slice(7);
  if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized" }) };

  const { data: { user } } = await supabaseAdmin.auth.getUser(token);
  if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Invalid token" }) };

  // Org/role ALWAYS resolved server-side — never accepted from the
  // request (there is no request body/query input to this endpoint at
  // all beyond the bearer token, by design).
  const { orgId, isOwnerOrAdmin } = await resolveOrgAndAuthority(supabaseAdmin, user.id);
  if (!orgId) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: "Could not resolve your organization." }) };
  }
  if (!isOwnerOrAdmin) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: "Only an organization owner or admin may connect WhatsApp." }) };
  }

  const metaConfig = await getAppConfigs(supabaseAdmin, ["META_APP_ID", "META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID"]);
  const appId = metaConfig.META_APP_ID;
  const embeddedSignupConfigId = metaConfig.META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID;

  if (!appId || !embeddedSignupConfigId) {
    console.error("[meta-whatsapp-embedded-signup-config] not configured — missing META_APP_ID or META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID");
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "WhatsApp Embedded Signup is not configured on the server yet." }) };
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      appId,
      embeddedSignupConfigId,
      graphApiVersion: META_GRAPH_API_VERSION,
    }),
  };
};
