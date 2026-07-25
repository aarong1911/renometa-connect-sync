// netlify/functions/smtp-config-status.ts
//
// Read-only SMTP (Gmail App Password) configuration status for Settings →
// Integrations. Never returns the password in any form — only whether one
// is configured, and the sender email.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";

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
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const resolved = await resolveOrgFromBearerToken(supabaseAdmin, event.headers.authorization);
  if (!resolved) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized" }) };
  }
  const { orgId } = resolved;

  const [{ data: secretRow }, { data: orgRow }] = await Promise.all([
    supabaseAdmin
      .from("organization_integration_secrets")
      .select("id, updated_at")
      .eq("organization_id", orgId)
      .eq("provider", "gmail")
      .eq("secret_type", "smtp_app_password")
      .maybeSingle(),
    supabaseAdmin
      .from("organizations")
      .select("integration_settings")
      .eq("id", orgId)
      .maybeSingle(),
  ]);

  const gmail = orgRow?.integration_settings?.gmail;
  const hasLegacyPlaintext = !!gmail?.appPassword;
  const configured = !!secretRow || hasLegacyPlaintext;

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      configured,
      email: gmail?.email ?? null,
      // Surfaced only so the UI/ops can tell "already migrated" apart from
      // "still running on legacy plaintext, will migrate on next send" —
      // never a value, just a boolean.
      usingLegacyPlaintext: hasLegacyPlaintext && !secretRow,
    }),
  };
};
