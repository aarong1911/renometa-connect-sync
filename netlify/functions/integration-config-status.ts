// netlify/functions/integration-config-status.ts
//
// Read-only, redacted connection status for the per-org API-key
// integrations in organizations.integration_settings (Twilio, Stripe,
// Jotform, plus the non-secret Gmail SMTP sender email). Replaces the
// browser selecting the whole integration_settings JSON, which shipped
// plaintext credentials to every caller. Never returns a secret value —
// see lib/integration-config.ts's redactIntegrationSettings().
//
// Owner only (resolveIntegrationManager, shared with the Gmail/SMTP
// endpoints), org resolved server-side from the bearer token.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveIntegrationManager } from "./lib/resolve-org";
import { redactIntegrationSettings } from "./lib/integration-config";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Cache-Control": "no-store",
};

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const auth = await resolveIntegrationManager(supabaseAdmin, event.headers.authorization);
  if (!auth.ok) return { statusCode: auth.statusCode, headers: CORS, body: JSON.stringify({ error: auth.error }) };

  const { data: orgRow, error } = await supabaseAdmin
    .from("organizations")
    .select("integration_settings")
    .eq("id", auth.orgId)
    .maybeSingle();
  if (error) {
    console.error("[integration-config-status] org read failed:", error.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to load integration status" }) };
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ integrations: redactIntegrationSettings(orgRow?.integration_settings) }),
  };
};
