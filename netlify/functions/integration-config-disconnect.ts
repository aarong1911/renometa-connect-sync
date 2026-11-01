// netlify/functions/integration-config-disconnect.ts
//
// Removes one API-key integration's configuration (Twilio, Stripe, Jotform)
// from organizations.integration_settings, server-side. Every other key in
// the JSON is left untouched. Gmail SMTP is not handled here — see
// smtp-disconnect.ts, which also deletes the encrypted App Password.
//
// Body: { provider: "twilio" | "stripe" | "jotform" }
// Owner only (resolveIntegrationManager, shared with the Gmail/SMTP
// endpoints); org resolved server-side, never from the body.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveIntegrationManager } from "./lib/resolve-org";
import { isManagedProvider } from "./lib/integration-config";

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
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const auth = await resolveIntegrationManager(supabaseAdmin, event.headers.authorization);
  if (!auth.ok) return { statusCode: auth.statusCode, headers: CORS, body: JSON.stringify({ error: auth.error }) };

  let reqBody: { provider?: unknown };
  try {
    reqBody = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const provider = reqBody.provider;
  if (!isManagedProvider(provider)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Unsupported integration" }) };
  }

  const { data: orgRow, error: readErr } = await supabaseAdmin
    .from("organizations")
    .select("integration_settings")
    .eq("id", auth.orgId)
    .maybeSingle();
  if (readErr) {
    console.error("[integration-config-disconnect] org read failed:", readErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to disconnect" }) };
  }
  if (!orgRow) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: "Organization not found" }) };

  const existing: Record<string, unknown> = { ...(orgRow.integration_settings ?? {}) };
  if (!(provider in existing)) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
  delete existing[provider];

  const { error: writeErr } = await supabaseAdmin
    .from("organizations")
    .update({ integration_settings: existing })
    .eq("id", auth.orgId);
  if (writeErr) {
    console.error("[integration-config-disconnect] org write failed:", writeErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to disconnect" }) };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
};
