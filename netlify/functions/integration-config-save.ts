// netlify/functions/integration-config-save.ts
//
// Saves one API-key integration's configuration (Twilio, Stripe, Jotform)
// into organizations.integration_settings, server-side. Replaces the
// browser reading the whole JSON, merging, and writing it back — which both
// exposed every stored credential and let any client overwrite them.
//
// Body: { provider: "twilio" | "stripe" | "jotform", fields: { ... } }
// A blank secret field keeps the stored secret (see
// lib/integration-config.ts's buildProviderConfig()). The response carries
// only the redacted status, never a secret.
//
// Owner only (resolveIntegrationManager, shared with the Gmail/SMTP
// endpoints); org resolved server-side, never from the body. Gmail
// SMTP is not handled here — see smtp-config-save.ts.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveIntegrationManager } from "./lib/resolve-org";
import { buildProviderConfig, isManagedProvider, redactIntegrationSettings } from "./lib/integration-config";

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

  let reqBody: { provider?: unknown; fields?: unknown };
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
    console.error("[integration-config-save] org read failed:", readErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to save configuration" }) };
  }
  if (!orgRow) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: "Organization not found" }) };

  const existing: Record<string, unknown> = orgRow.integration_settings ?? {};
  const built = buildProviderConfig(provider, existing[provider], reqBody.fields);
  if (!built.ok) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: built.error }) };

  const { error: writeErr } = await supabaseAdmin
    .from("organizations")
    .update({ integration_settings: { ...existing, [provider]: built.next } })
    .eq("id", auth.orgId);
  if (writeErr) {
    console.error("[integration-config-save] org write failed:", writeErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to save configuration" }) };
  }

  const status = redactIntegrationSettings({ [provider]: built.next })[provider];
  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, provider, status }) };
};
