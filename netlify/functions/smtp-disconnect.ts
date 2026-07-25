// netlify/functions/smtp-disconnect.ts
//
// Disconnects ONLY the Gmail SMTP (App Password) sending configuration —
// deletes the encrypted secret and clears the non-secret metadata, but
// never touches the `integrations` table (Gmail OAuth inbox-sync
// connection), which stays connected exactly as-is.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { deleteOrgSecret } from "./lib/org-secret-store";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const resolved = await resolveOrgFromBearerToken(supabaseAdmin, event.headers.authorization);
  if (!resolved) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized" }) };
  }
  const { orgId } = resolved;

  const secretResult = await deleteOrgSecret(supabaseAdmin, orgId, "gmail", "smtp_app_password");
  if (!secretResult.ok) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: secretResult.error }) };
  }

  const { data: orgRow, error: readErr } = await supabaseAdmin
    .from("organizations")
    .select("integration_settings")
    .eq("id", orgId)
    .maybeSingle();
  if (readErr) {
    console.error("[smtp-disconnect] org read failed:", readErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to disconnect" }) };
  }

  const existing: Record<string, any> = { ...(orgRow?.integration_settings ?? {}) };
  delete existing.gmail;
  const { error: writeErr } = await supabaseAdmin
    .from("organizations")
    .update({ integration_settings: existing })
    .eq("id", orgId);

  if (writeErr) {
    console.error("[smtp-disconnect] org write failed:", writeErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to disconnect" }) };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
};
