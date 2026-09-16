// netlify/functions/ai-sms-compliance-settings.ts
//
// AI-2C.1. Server-side authoritative read/write for
// organizations.ai_center_settings.smsCompliance.helpReply — the
// operator-authored, plain-text deterministic reply sent when a contact
// texts HELP/INFO (see netlify/functions/lib/sms-compliance.ts's
// sendHelpReplyIfConfigured()).
//
// Modeled directly on netlify/functions/ai-emergency-pause.ts's existing
// pattern (same authorization helper, same merge-not-replace semantics on
// the shared ai_center_settings jsonb column) — a new, narrowly-scoped
// endpoint rather than extending ai-emergency-pause.ts itself, so each
// endpoint keeps one simple, exhaustively-validated body shape instead of
// mixing two unrelated settings domains under one loosening validation
// rule. See the server-authorization skill's "Privileged JSONB settings"
// section.
//
// AUTHORIZATION: owner/admin only, via the canonical
// resolveOrgAndAuthority() — never trusts a client-supplied orgId/role.
// This is the same privilege tier as Emergency Pause (an org-wide AI
// Center operational/compliance setting).
//
// AI-2C.1 completion pass: POST body is now `{ helpReply: string | null }`
// — a non-empty plain-text string configures the reply; `null` is the
// explicit "disable the HELP reply" signal, which removes `helpReply`
// (and `smsCompliance` itself, if left empty) from `ai_center_settings`
// rather than storing an empty string. GET mirrors this: an unconfigured
// reply comes back as `helpReply: null`, not `""`. This closes the
// original gap (the endpoint could accept a new reply but had no
// supported way to remove one) without a new column/table/boolean — the
// runtime (sendHelpReplyIfConfigured()) already treated "no helpReply
// key" as "send nothing," so disabling is just restoring that exact
// state.

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

// Matches sendSmsInput's own body max (src/lib/agentic/action-registry.ts)
// — the same underlying SMS transport, so the same real limit, not an
// invented one.
const HELP_REPLY_MAX_LENGTH = 1600;

type AICenterSettings = { smsCompliance?: { helpReply?: string }; [key: string]: unknown };

function parseAICenterSettings(value: unknown): AICenterSettings {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as AICenterSettings;
  }
  return {};
}

/** Plain text only — rejects anything that looks like an HTML/markup tag. SMS has no rich-text concept. */
function containsHtmlLikeMarkup(value: string): boolean {
  return /[<>]/.test(value);
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
      body: JSON.stringify({ error: "Only an organization owner or admin may view or change SMS compliance reply settings." }),
    };
  }

  if (event.httpMethod === "GET") {
    const { data, error } = await supabaseAdmin
      .from("organizations")
      .select("ai_center_settings")
      .eq("id", orgId)
      .maybeSingle();
    if (error) {
      console.error("[ai-sms-compliance-settings] GET lookup failed:", error);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to load SMS compliance settings." }) };
    }
    const settings = parseAICenterSettings(data?.ai_center_settings);
    // null (not "") signals "disabled/unconfigured" distinctly from a
    // configured empty string, which can no longer even be saved (see the
    // POST validation below) — the GET response and the disable affordance
    // share the same null vocabulary.
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ helpReply: typeof settings.smsCompliance?.helpReply === "string" ? settings.smsCompliance.helpReply : null }),
    };
  }

  // POST — accepts ONLY { helpReply: string | null }, nothing else.
  //   - a non-empty plain-text string: trim, validate, save as the
  //     configured reply.
  //   - null: explicit disable — removes helpReply (and smsCompliance
  //     entirely, if it would otherwise be left empty) from
  //     ai_center_settings, restoring the exact "no reply configured"
  //     runtime state sendHelpReplyIfConfigured() already treats as safe.
  let reqBody: unknown;
  try {
    reqBody = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid JSON body." }) };
  }
  const isPlainObject = typeof reqBody === "object" && reqBody !== null && !Array.isArray(reqBody);
  const hasExactlyHelpReplyKey = isPlainObject && Object.keys(reqBody as Record<string, unknown>).length === 1 && "helpReply" in (reqBody as Record<string, unknown>);
  const rawHelpReply = hasExactlyHelpReplyKey ? (reqBody as Record<string, unknown>).helpReply : undefined;
  const isValidShape = hasExactlyHelpReplyKey && (rawHelpReply === null || typeof rawHelpReply === "string");
  if (!isValidShape) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Body must be exactly { helpReply: string | null }." }) };
  }

  let nextHelpReply: string | null;
  if (rawHelpReply === null) {
    nextHelpReply = null;
  } else {
    const trimmed = (rawHelpReply as string).trim();
    if (trimmed.length === 0) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "helpReply cannot be empty — send null to disable the HELP reply instead." }) };
    }
    if (trimmed.length > HELP_REPLY_MAX_LENGTH) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `helpReply must be at most ${HELP_REPLY_MAX_LENGTH} characters.` }) };
    }
    if (containsHtmlLikeMarkup(trimmed)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "helpReply must be plain text (no < or > characters)." }) };
    }
    nextHelpReply = trimmed;
  }

  const { data: currentRow, error: readError } = await supabaseAdmin
    .from("organizations")
    .select("ai_center_settings")
    .eq("id", orgId)
    .maybeSingle();
  if (readError) {
    console.error("[ai-sms-compliance-settings] POST pre-read failed:", readError);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to update SMS compliance settings." }) };
  }

  const currentSettings = parseAICenterSettings(currentRow?.ai_center_settings);
  let nextSettings: AICenterSettings;

  if (nextHelpReply !== null) {
    nextSettings = { ...currentSettings, smsCompliance: { ...currentSettings.smsCompliance, helpReply: nextHelpReply } };
  } else {
    // Disable: drop helpReply, preserving any other smsCompliance keys
    // that may exist in the future; drop smsCompliance itself only if
    // that leaves it with nothing left in it. Every OTHER top-level
    // ai_center_settings key (e.g. emergencyPaused) is always preserved
    // via the {...restSettings} spread regardless of this branch.
    const { smsCompliance: currentSmsCompliance, ...restSettings } = currentSettings;
    const remainingSmsCompliance = { ...currentSmsCompliance };
    delete remainingSmsCompliance.helpReply;
    const hasRemainingSmsComplianceKeys = Object.keys(remainingSmsCompliance).length > 0;
    nextSettings = hasRemainingSmsComplianceKeys
      ? { ...restSettings, smsCompliance: remainingSmsCompliance }
      : { ...restSettings };
  }

  const { error: writeError } = await supabaseAdmin
    .from("organizations")
    .update({ ai_center_settings: nextSettings })
    .eq("id", orgId);
  if (writeError) {
    console.error("[ai-sms-compliance-settings] POST write failed:", writeError);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to update SMS compliance settings." }) };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ helpReply: nextHelpReply }) };
};
