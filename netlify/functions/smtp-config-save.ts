// netlify/functions/smtp-config-save.ts
//
// Saves the org's Gmail SMTP (App Password) sending configuration.
// Replaces writing organizations.integration_settings.gmail.appPassword in
// plaintext from the browser — the password now only ever exists as
// ciphertext in organization_integration_secrets, written server-side.
//
// Blank/omitted appPassword means "keep the existing saved password" —
// this endpoint never overwrites a secret with blank/null/masked text; it
// simply doesn't touch the secret at all in that case.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { setOrgSecret } from "./lib/org-secret-store";

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  let reqBody: { email?: string; appPassword?: string };
  try {
    reqBody = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const email = (reqBody.email ?? "").trim();
  if (!email || !EMAIL_RE.test(email)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Enter a valid Gmail address" }) };
  }

  // Google's UI displays an App Password as "xxxx xxxx xxxx xxxx" for
  // readability — Gmail's SMTP AUTH expects the bare 16-character value.
  // Strip all whitespace before validating/storing so a pasted, spaced
  // password never gets saved in the form that breaks SMTP auth.
  const rawPassword = (reqBody.appPassword ?? "").trim();
  const cleanedPassword = rawPassword.replace(/\s+/g, "");

  if (cleanedPassword) {
    if (cleanedPassword.length < 16) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "App Password must be at least 16 characters" }) };
    }
    const result = await setOrgSecret(supabaseAdmin, orgId, "gmail", "smtp_app_password", cleanedPassword);
    if (!result.ok) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: result.error }) };
    }
  } else {
    // Blank appPassword means "keep the existing saved password" — but
    // only if one actually exists (either already-migrated encrypted, or
    // still-legacy plaintext). A brand-new configuration with no password
    // anywhere yet must not be silently marked configured.
    const { data: existingSecret } = await supabaseAdmin
      .from("organization_integration_secrets")
      .select("id")
      .eq("organization_id", orgId)
      .eq("provider", "gmail")
      .eq("secret_type", "smtp_app_password")
      .maybeSingle();

    const { data: orgRowForCheck } = await supabaseAdmin
      .from("organizations")
      .select("integration_settings")
      .eq("id", orgId)
      .maybeSingle();
    const hasLegacyPlaintext = !!orgRowForCheck?.integration_settings?.gmail?.appPassword;

    if (!existingSecret && !hasLegacyPlaintext) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "App Password is required" }) };
    }
  }

  // Non-secret metadata only from here — email + a marker that this
  // integration is configured, no password of any form.
  const { data: orgRow, error: readErr } = await supabaseAdmin
    .from("organizations")
    .select("integration_settings")
    .eq("id", orgId)
    .maybeSingle();
  if (readErr) {
    console.error("[smtp-config-save] org read failed:", readErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to save configuration" }) };
  }

  const existing: Record<string, any> = orgRow?.integration_settings ?? {};
  // Migration cleanup: any legacy plaintext appPassword is removed the
  // moment this endpoint is used to save/update — email is the only
  // secret-free field kept here going forward.
  const nextGmail = { email, configured: true };
  const { error: writeErr } = await supabaseAdmin
    .from("organizations")
    .update({ integration_settings: { ...existing, gmail: nextGmail } })
    .eq("id", orgId);

  if (writeErr) {
    console.error("[smtp-config-save] org write failed:", writeErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to save configuration" }) };
  }

  // Never return the password in any form.
  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, email }) };
};
