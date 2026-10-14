// netlify/functions/ai-clarification-resolve.ts
//
// Owner answers (or dismisses) a Knowledge Clarification. POST only.
// Owner/admin only — same authority model as agent-approve-action.ts
// (resolveOrgAndAuthority; org + role from the verified bearer token, never
// the request). The send goes through the existing trusted outbound path
// (action-executor.ts's executeApprovedStep) inside
// lib/ai/knowledge-clarification.ts — this file does no provider calls.
// Failure semantics are documented in that file's header.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgAndAuthority } from "./lib/resolve-org";
import { processClarificationRequest } from "./lib/ai/knowledge-requests";

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
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };

  const token = event.headers.authorization?.slice(7);
  if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized" }) };
  const { data: { user } } = await supabaseAdmin.auth.getUser(token);
  if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Invalid token" }) };

  const { orgId, isOwnerOrAdmin } = await resolveOrgAndAuthority(supabaseAdmin, user.id);
  if (!orgId) return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: "Could not resolve your organization." }) };
  if (!isOwnerOrAdmin) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: "Only an organization owner or admin may answer knowledge questions." }) };
  }

  let reqBody: unknown;
  try { reqBody = JSON.parse(event.body ?? "{}"); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid JSON body." }) }; }

  try {
    const result = await processClarificationRequest(supabaseAdmin, { orgId, userId: user.id }, reqBody);
    return { statusCode: result.statusCode, headers: CORS, body: JSON.stringify(result.body) };
  } catch (err) {
    console.error("[ai-clarification-resolve] unexpected error:", err instanceof Error ? err.message : err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Could not process this answer. Please try again." }) };
  }
};
