// netlify/functions/ai-emergency-pause.ts
//
// AI-1M security completion pass. Server-side authoritative read/write for
// organizations.ai_center_settings.emergencyPaused — the AI Center-wide
// mutation kill switch read by src/lib/agentic/policy-resolver.ts's
// resolveExecutionPolicy().
//
// WHY THIS EXISTS: no live RLS inspection was possible in this environment
// (no DATABASE_URL/psql, and pg_policies is not PostgREST-exposed, so
// there is no way to prove from here that UPDATE on `organizations` is
// already restricted to owner/admin). Absent that proof, a direct
// browser-authenticated `.update("organizations")` for a safety-critical,
// org-wide setting is not acceptable — any authenticated org member (not
// just owner/admin) may be able to write it. This endpoint is the
// server-side authorization gate: it independently resolves the caller's
// role from trusted tables (profiles/org_memberships, via
// resolveOrgAndAuthority()) and rejects anything but owner/admin with 403,
// regardless of what the frontend does or hides.
//
// This endpoint does NOT implement AI Center enforcement itself — it only
// gates who may persist the emergencyPaused flag. Enforcement remains
// solely in action-executor.ts/policy-resolver.ts, untouched by this file.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgAndAuthority } from "./lib/resolve-org";

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

type AICenterSettings = { emergencyPaused?: boolean; [key: string]: unknown };

function parseAICenterSettings(value: unknown): AICenterSettings {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as AICenterSettings;
  }
  return {};
}

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const token = event.headers.authorization?.slice(7);
  if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized" }) };

  const { data: { user } } = await supabaseAdmin.auth.getUser(token);
  if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Invalid token" }) };

  // Role and org are ALWAYS resolved server-side from the authenticated
  // user id — never accepted from the request (no orgId/userId/role body
  // fields are read anywhere in this handler).
  const { orgId, isOwnerOrAdmin } = await resolveOrgAndAuthority(supabaseAdmin, user.id);
  if (!orgId) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: "Could not resolve your organization." }) };
  }
  if (!isOwnerOrAdmin) {
    return {
      statusCode: 403,
      headers: CORS,
      body: JSON.stringify({ error: "Only an organization owner or admin may view or change Emergency Pause." }),
    };
  }

  if (event.httpMethod === "GET") {
    const { data, error } = await supabaseAdmin
      .from("organizations")
      .select("ai_center_settings")
      .eq("id", orgId)
      .maybeSingle();
    if (error) {
      console.error("[ai-emergency-pause] GET lookup failed:", error);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to load Emergency Pause state." }) };
    }
    const settings = parseAICenterSettings(data?.ai_center_settings);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ emergencyPaused: settings.emergencyPaused === true }),
    };
  }

  // POST — accepts ONLY { emergencyPaused: boolean }, nothing else.
  let reqBody: unknown;
  try {
    reqBody = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid JSON body." }) };
  }
  if (
    typeof reqBody !== "object" ||
    reqBody === null ||
    Array.isArray(reqBody) ||
    typeof (reqBody as Record<string, unknown>).emergencyPaused !== "boolean" ||
    Object.keys(reqBody as Record<string, unknown>).length !== 1
  ) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: "Body must be exactly { emergencyPaused: boolean }." }),
    };
  }
  const requestedValue = (reqBody as { emergencyPaused: boolean }).emergencyPaused;

  const { data: currentRow, error: readError } = await supabaseAdmin
    .from("organizations")
    .select("ai_center_settings")
    .eq("id", orgId)
    .maybeSingle();
  if (readError) {
    console.error("[ai-emergency-pause] POST pre-read failed:", readError);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to update Emergency Pause." }) };
  }

  const currentSettings = parseAICenterSettings(currentRow?.ai_center_settings);
  const nextSettings: AICenterSettings = { ...currentSettings, emergencyPaused: requestedValue };

  const { error: writeError } = await supabaseAdmin
    .from("organizations")
    .update({ ai_center_settings: nextSettings })
    .eq("id", orgId);
  if (writeError) {
    console.error("[ai-emergency-pause] POST write failed:", writeError);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to update Emergency Pause." }) };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ emergencyPaused: requestedValue }) };
};
