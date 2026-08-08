/// <reference types="node" />
// netlify/functions/change-order-apply-schedule-impact.ts
//
// Security audit (round 3) — server-side, permission-checked entry point
// for applying an approved Change Order's schedule impact to its Project.
// apply_project_change_order_schedule_impact() is service_role-only (see
// the "8. TRUST ARCHITECTURE" comment in 20260815_project_change_orders.sql)
// — this function is the entire trust boundary: authenticate the bearer
// token, resolve org_id server-side, check the change_orders "apply
// schedule impact" permission, then call the RPC with the service-role
// key and the already-verified org_id/actor_user_id.
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

  let body: { changeOrderId?: string; newCompletionDate?: string } = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch { body = {}; }
  const { changeOrderId, newCompletionDate } = body;
  if (!changeOrderId || !newCompletionDate) return json(400, { error: "changeOrderId and newCompletionDate are required" });

  try {
    const { data: profile } = await admin.from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
    const orgId = profile?.organization_id;
    if (!orgId) return json(403, { error: "No organization was found for this user." });

    const permission = await resolveChangeOrderPermissionServer(admin, user.id, orgId, "applyScheduleImpact");
    if (!permission) return json(403, { error: "You do not have permission to apply schedule impact for Change Orders." });

    const { data, error } = await admin.rpc("apply_project_change_order_schedule_impact", {
      p_change_order_id: changeOrderId,
      p_org_id: orgId,
      p_actor_user_id: user.id,
      p_new_completion_date: newCompletionDate,
    });
    if (error) return json(409, { error: error.message });

    return json(200, { ok: true, result: data });
  } catch (error) {
    console.error("[change-order-apply-schedule-impact] Unhandled failure", error);
    return json(500, { error: "Schedule impact could not be applied because of an unexpected server error." });
  }
};
