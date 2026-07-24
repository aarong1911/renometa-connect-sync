// netlify/functions/gmail-disconnect.ts
//
// Disconnects the org's Gmail connection. Best-effort revokes the token
// with Google, then DEACTIVATES (not deletes) the integrations row —
// status set to "disconnected", token fields cleared — preserving
// provider_account_email/last_sync_at history and, per the requirement,
// never touching gmail_messages (a user's synced email history is not lost
// just because the live connection is disconnected).

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { decryptBytea } from "./lib/gmail-token-crypto";

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

  const authToken = event.headers.authorization?.slice(7);
  if (!authToken) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized" }) };
  }
  const { data: { user } } = await supabaseAdmin.auth.getUser(authToken);
  if (!user) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Invalid token" }) };
  }

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("organization_id")
    .eq("id", user.id)
    .maybeSingle();
  let orgId: string | null = profile?.organization_id ?? null;
  if (!orgId) {
    const { data: membership } = await supabaseAdmin
      .from("org_memberships")
      .select("org_id")
      .eq("member_id", user.id)
      .maybeSingle();
    orgId = membership?.org_id ?? null;
  }
  if (!orgId) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: "No organization found for this user" }) };
  }

  const { data: integration, error: loadErr } = await supabaseAdmin
    .from("integrations")
    .select("id, access_token_encrypted, refresh_token_encrypted")
    .eq("org_id", orgId)
    .eq("provider", "gmail")
    .maybeSingle();

  if (loadErr) {
    console.error("[gmail-disconnect] lookup failed:", loadErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to load Gmail connection" }) };
  }
  if (!integration) {
    // Already disconnected/never connected — treat as success, not an error.
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
  }

  // Best-effort revoke with Google — revoking the refresh token also
  // invalidates its associated access tokens. Never block the local
  // disconnect on this: a token that's already invalid/expired will fail
  // to revoke, which is fine — the goal (this app no longer has usable
  // access) is achieved either way.
  const tokenToRevoke = integration.refresh_token_encrypted ?? integration.access_token_encrypted;
  if (tokenToRevoke) {
    try {
      const plain = decryptBytea(tokenToRevoke);
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(plain)}`, { method: "POST" });
    } catch (e: any) {
      console.warn("[gmail-disconnect] token revoke failed (continuing):", e.message);
    }
  }

  const { error: updateErr } = await supabaseAdmin
    .from("integrations")
    .update({
      status: "disconnected",
      access_token_encrypted: null,
      refresh_token_encrypted: null,
      token_expires_at: null,
      sync_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", integration.id);

  if (updateErr) {
    console.error("[gmail-disconnect] update failed:", updateErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to disconnect Gmail" }) };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
};
