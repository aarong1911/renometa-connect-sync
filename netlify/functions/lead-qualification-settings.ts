// netlify/functions/lead-qualification-settings.ts
//
// Live Lead Qualification — Phase AI-3A. Owner/admin-gated read/write for
// `organizations.ai_center_settings.agents.lead_qualification` — the
// per-agent enabled flag and autonomy level lib/ai/lead-qualification-
// dispatch.ts and src/lib/agentic/policy-resolver.ts both read. Same
// authority-gating pattern as ai-emergency-pause.ts (server-resolved
// owner/admin check, never trusted from the client) — this is a org-wide
// safety/operational setting, not a per-lead action.
//
// Deliberately narrow: accepts ONLY { enabled: boolean, defaultAutonomyLevel?: 1|2 }
// and merges it under `ai_center_settings.agents.lead_qualification`,
// preserving every other key already in `ai_center_settings` (including
// `emergencyPaused` and any other agent's own settings) — never a
// wholesale overwrite of the jsonb column. Level 3+ is rejected here even
// though AgentPolicy's type allows up to 4 — see lead-qualification-
// dispatch.ts's own header: this phase only supports Level 1/2 for this
// agent; broadening past that is a deliberate later decision, not
// something this settings endpoint should silently allow yet.

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

const AGENT_KEY = "lead_qualification";

type StoredSettings = { emergencyPaused?: boolean; agents?: Record<string, { enabled?: boolean; defaultAutonomyLevel?: number }>; [key: string]: unknown };

function parseSettings(value: unknown): StoredSettings {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as StoredSettings;
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

  const { orgId, isOwnerOrAdmin } = await resolveOrgAndAuthority(supabaseAdmin, user.id);
  if (!orgId) return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: "Could not resolve your organization." }) };
  if (!isOwnerOrAdmin) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: "Only an organization owner or admin may view or change Lead Qualification settings." }) };
  }

  const { data, error } = await supabaseAdmin.from("organizations").select("ai_center_settings").eq("id", orgId).maybeSingle();
  if (error) {
    console.error("[lead-qualification-settings] lookup failed:", error.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to load Lead Qualification settings." }) };
  }
  const current = parseSettings(data?.ai_center_settings);
  const currentAgent = current.agents?.[AGENT_KEY] ?? {};

  if (event.httpMethod === "GET") {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ enabled: currentAgent.enabled === true, defaultAutonomyLevel: currentAgent.defaultAutonomyLevel === 2 ? 2 : 1 }),
    };
  }

  let reqBody: unknown;
  try {
    reqBody = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid JSON body." }) };
  }
  if (typeof reqBody !== "object" || reqBody === null || Array.isArray(reqBody)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid request body." }) };
  }
  const body = reqBody as Record<string, unknown>;
  const allowedKeys = new Set(["enabled", "defaultAutonomyLevel"]);
  if (typeof body.enabled !== "boolean" || Object.keys(body).some((k) => !allowedKeys.has(k))) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Body must be { enabled: boolean, defaultAutonomyLevel?: 1 | 2 }." }) };
  }
  if (body.defaultAutonomyLevel !== undefined && body.defaultAutonomyLevel !== 1 && body.defaultAutonomyLevel !== 2) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "defaultAutonomyLevel must be 1 or 2 in this phase." }) };
  }

  const nextAgentSettings = { enabled: body.enabled, defaultAutonomyLevel: (body.defaultAutonomyLevel as 1 | 2 | undefined) ?? currentAgent.defaultAutonomyLevel ?? 1 };
  const nextSettings: StoredSettings = { ...current, agents: { ...current.agents, [AGENT_KEY]: nextAgentSettings } };

  const { error: updateError } = await supabaseAdmin.from("organizations").update({ ai_center_settings: nextSettings }).eq("id", orgId);
  if (updateError) {
    console.error("[lead-qualification-settings] update failed:", updateError.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to save Lead Qualification settings." }) };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify(nextAgentSettings) };
};
