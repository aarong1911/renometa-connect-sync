/// <reference types="node" />
// netlify/functions/change-order-action.ts
//
// Phase 13.3B — public, anonymous, token-scoped customer approve/reject
// action for Change Orders. Mirrors proposal-action.ts's shape (POST
// { token, action, payload }) but delegates all of the actual state
// transition to the approve_project_change_order()/
// reject_project_change_order() SECURITY DEFINER RPCs added by
// 20260815_project_change_orders.sql — those functions re-hash and
// re-validate the token, lock the row, verify version/status/expiry, and
// apply the financial adjustment exactly once. This function is a thin,
// unauthenticated-safe wrapper: no direct table access, no logic
// duplicated between here and the database.
//
// Security audit (post-13.3B): the RPCs no longer accept a p_source
// parameter at all (a public caller invoking them directly, bypassing this
// function, must never be able to assert an arbitrary source) — every
// customer action is hardcoded server-side to "portal". ip/userAgent are
// captured here from Netlify's own request context (never from anything
// the client body could set) and passed through as best-effort audit
// context only, never represented as verified identity.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

function json(statusCode: number, body: Record<string, unknown>) {
  return { statusCode, headers: HEADERS, body: JSON.stringify(body) };
}

type ActionBody = {
  token?: string;
  action?: "approve" | "reject";
  payload?: {
    name?: string;
    email?: string;
    acknowledgment?: string;
    signature?: { name?: string; typedAt?: string } | null;
    reason?: string;
  };
};

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  let body: ActionBody = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch { return json(400, { error: "Invalid request body" }); }

  const { token, action, payload } = body;
  if (!token || token.length < 32) return json(404, { error: "Change Order not found" });
  if (action !== "approve" && action !== "reject") return json(400, { error: "Unsupported action" });

  const name = payload?.name?.trim();
  const email = payload?.email?.trim() || null;
  if (!name) return json(400, { error: "Name is required" });

  const ip = event.headers["x-nf-client-connection-ip"] ?? event.headers["client-ip"] ?? null;
  const userAgent = event.headers["user-agent"] ?? null;

  try {
    if (action === "approve") {
      const { data, error } = await supabaseAdmin.rpc("approve_project_change_order", {
        p_token: token,
        p_name: name,
        p_email: email,
        p_acknowledgment: payload?.acknowledgment ?? null,
        p_signature: payload?.signature ?? null,
        p_ip: ip,
        p_user_agent: userAgent,
      });
      if (error) return json(409, { error: error.message });
      return json(200, { ok: true, result: data });
    }

    const { data, error } = await supabaseAdmin.rpc("reject_project_change_order", {
      p_token: token,
      p_name: name,
      p_email: email,
      p_reason: payload?.reason ?? null,
      p_ip: ip,
      p_user_agent: userAgent,
    });
    if (error) return json(409, { error: error.message });
    return json(200, { ok: true, result: data });
  } catch (error) {
    console.error("[change-order-action] Unhandled failure", error);
    return json(500, { error: "The Change Order action could not be completed because of an unexpected server error." });
  }
};
