/// <reference types="node" />
// netlify/functions/change-order-create-revision.ts
//
// Security audit (round 4), Parts 4 + 8 — dedicated, permission-checked
// entry point for creating a Change Order revision. Same trust-boundary
// pattern as send/cancel/apply-schedule-impact: authenticate the bearer
// token, resolve org_id server-side, check the change_orders "create"
// permission, then call create_project_change_order_revision()
// (service_role-only) with the already-verified org_id/actor_user_id.
// The RPC itself derives the new version/change_order_number from the
// real, advisory-lock-guarded parent row — never from anything this
// function or the browser could supply.
import type { Handler, HandlerEvent, HandlerResponse } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

import { resolveChangeOrderPermissionServer } from "../../src/lib/change-order-permissions";

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function json(statusCode: number, body: Record<string, unknown>): HandlerResponse {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}

function getBearerToken(event: HandlerEvent): string | null {
  const authorization = event.headers.authorization ?? event.headers.Authorization;
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export const handler: Handler = async (event): Promise<HandlerResponse> => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: "The Change Order service is not configured correctly." });
  }

  const accessToken = getBearerToken(event);
  if (!accessToken) return json(401, { error: "Unauthorized" });

  const { data: { user }, error: authError } = await admin.auth.getUser(accessToken);
  if (authError || !user) return json(401, { error: "Invalid token" });

  let body: { changeOrderId?: string } = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch { body = {}; }
  const { changeOrderId } = body;
  if (!changeOrderId) return json(400, { error: "changeOrderId is required" });

  try {
    const { data: profile } = await admin.from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
    const orgId = profile?.organization_id;
    if (!orgId) return json(403, { error: "No organization was found for this user." });

    const permission = await resolveChangeOrderPermissionServer(admin, user.id, orgId, "create");
    if (!permission) return json(403, { error: "You do not have permission to create Change Orders." });

    const { data, error } = await admin.rpc("create_project_change_order_revision", {
      p_parent_change_order_id: changeOrderId,
      p_org_id: orgId,
      p_actor_user_id: user.id,
    });
    if (error) return json(409, { error: error.message });

    return json(200, { ok: true, result: data });
  } catch (error) {
    console.error("[change-order-create-revision] Unhandled failure", error);
    return json(500, { error: "The revision could not be created because of an unexpected server error." });
  }
};
