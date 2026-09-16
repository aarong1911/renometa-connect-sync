// netlify/functions/ai-sms-reply-mode-settings.ts
//
// AI-2D. Server-side authoritative read/write for
// organizations.ai_center_settings.smsReplies.mode — the one user-facing
// setting for AI-2D: "Review before sending" vs "Send automatically" for
// AI-generated replies to a trusted inbound SMS conversation. See
// netlify/functions/lib/sms-reply-mode.ts for the fail-closed parse this
// endpoint's GET reuses, and src/lib/agentic/action-executor.ts /
// ai-twilio-sms-orchestrate-background.ts for how this setting is
// actually enforced at send time (never here — this endpoint only reads
// and writes configuration).
//
// Modeled directly on ai-emergency-pause.ts / ai-sms-compliance-
// settings.ts's existing pattern — a new, narrowly-scoped endpoint (owner/
// admin only, exact-shape body, merge-not-replace on the shared
// ai_center_settings jsonb column) rather than folding a third settings
// domain into either of those.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgAndAuthority } from "./lib/resolve-org";
import { parseSmsReplyMode, type SmsReplyMode } from "./lib/sms-reply-mode";

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

type AICenterSettings = { smsReplies?: { mode?: string }; [key: string]: unknown };

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
  // user id — never accepted from the request.
  const { orgId, isOwnerOrAdmin } = await resolveOrgAndAuthority(supabaseAdmin, user.id);
  if (!orgId) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: "Could not resolve your organization." }) };
  }
  if (!isOwnerOrAdmin) {
    return {
      statusCode: 403,
      headers: CORS,
      body: JSON.stringify({ error: "Only an organization owner or admin may view or change AI SMS reply mode." }),
    };
  }

  if (event.httpMethod === "GET") {
    const { data, error } = await supabaseAdmin
      .from("organizations")
      .select("ai_center_settings")
      .eq("id", orgId)
      .maybeSingle();
    if (error) {
      console.error("[ai-sms-reply-mode-settings] GET lookup failed:", error);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to load AI SMS reply mode." }) };
    }
    const settings = parseAICenterSettings(data?.ai_center_settings);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ mode: parseSmsReplyMode(settings.smsReplies) }) };
  }

  // POST — accepts ONLY { mode: "review" | "automatic" }, nothing else.
  let reqBody: unknown;
  try {
    reqBody = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid JSON body." }) };
  }
  const isPlainObject = typeof reqBody === "object" && reqBody !== null && !Array.isArray(reqBody);
  const hasExactlyModeKey = isPlainObject && Object.keys(reqBody as Record<string, unknown>).length === 1 && "mode" in (reqBody as Record<string, unknown>);
  const rawMode = hasExactlyModeKey ? (reqBody as Record<string, unknown>).mode : undefined;
  if (!hasExactlyModeKey || (rawMode !== "review" && rawMode !== "automatic")) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Body must be exactly { mode: "review" | "automatic" }.' }) };
  }
  const nextMode = rawMode as SmsReplyMode;

  const { data: currentRow, error: readError } = await supabaseAdmin
    .from("organizations")
    .select("ai_center_settings")
    .eq("id", orgId)
    .maybeSingle();
  if (readError) {
    console.error("[ai-sms-reply-mode-settings] POST pre-read failed:", readError);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to update AI SMS reply mode." }) };
  }

  const currentSettings = parseAICenterSettings(currentRow?.ai_center_settings);
  const nextSettings: AICenterSettings = {
    ...currentSettings,
    smsReplies: { ...currentSettings.smsReplies, mode: nextMode },
  };

  const { error: writeError } = await supabaseAdmin
    .from("organizations")
    .update({ ai_center_settings: nextSettings })
    .eq("id", orgId);
  if (writeError) {
    console.error("[ai-sms-reply-mode-settings] POST write failed:", writeError);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to update AI SMS reply mode." }) };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ mode: nextMode }) };
};
