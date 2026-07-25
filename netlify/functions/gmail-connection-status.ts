// netlify/functions/gmail-connection-status.ts
//
// Read-only, authenticated status check for the org's Gmail connection —
// used by Settings → Integrations to decide whether to show Connect,
// Reconnect, or Sync, and to display the connected account/last sync info.
// Never returns access_token_encrypted/refresh_token_encrypted — only a
// `hasRefreshToken` boolean, so the client can tell a renewable connection
// apart from one that will die once its access token expires, without ever
// seeing token material.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

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

  const { data: integration, error } = await supabaseAdmin
    .from("integrations")
    .select("status, provider_account_email, token_expires_at, refresh_token_encrypted, last_sync_at, last_sync_status, sync_error, config")
    .eq("org_id", orgId)
    .eq("provider", "gmail")
    .maybeSingle();

  if (error) {
    console.error("[gmail-connection-status] lookup failed:", error.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to load Gmail connection status" }) };
  }

  if (!integration) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        connected: false,
        accountEmail: null,
        accountPictureUrl: null,
        hasRefreshToken: false,
        tokenExpiresAt: null,
        lastSyncAt: null,
        lastSyncStatus: null,
        syncError: null,
      }),
    };
  }

  // Only ever this one safe, non-secret URL out of `config` — never the
  // whole config object, so nothing else stored there in the future is
  // exposed by this endpoint without a deliberate decision to do so.
  const pictureUrl = (integration.config && typeof integration.config === "object")
    ? (integration.config as Record<string, any>).picture_url ?? null
    : null;

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      connected: integration.status === "connected",
      accountEmail: integration.provider_account_email ?? null,
      accountPictureUrl: typeof pictureUrl === "string" ? pictureUrl : null,
      hasRefreshToken: !!integration.refresh_token_encrypted,
      tokenExpiresAt: integration.token_expires_at ?? null,
      lastSyncAt: integration.last_sync_at ?? null,
      lastSyncStatus: integration.last_sync_status ?? null,
      syncError: integration.sync_error ?? null,
    }),
  };
};
