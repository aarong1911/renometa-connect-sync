/// <reference types="node" />
// netlify/functions/estimate-convert-deal.ts
//
// Phase 10.4 continuation — thin authenticated wrapper around the shared
// syncEstimateDeal() service, used ONLY by the manual "Convert to Deal" /
// "Retry Deal Sync" fallback in the Estimates UI. Every automatic
// integration point (estimate-send.ts, proposal-data.ts, proposal-action.ts)
// calls the same syncEstimateDeal() directly — this function exists purely
// so the browser has an authenticated HTTP entry point into that one
// implementation, never a second copy of the stage-resolution/creation
// logic.
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { syncEstimateDeal, type DealSyncTrigger } from "../lib/estimate-deal-sync";

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };

  const token = event.headers.authorization?.slice(7);
  if (!token) return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return { statusCode: 401, body: JSON.stringify({ error: "Invalid token" }) };

  const { estimateId, trigger } = JSON.parse(event.body ?? "{}") as { estimateId?: string; trigger?: DealSyncTrigger };
  if (!estimateId) return { statusCode: 400, body: JSON.stringify({ error: "estimateId required" }) };

  const { data: profile } = await admin.from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
  const orgId = profile?.organization_id;
  if (!orgId) return { statusCode: 403, body: JSON.stringify({ error: "No organization found for this user" }) };

  const { data: estimate } = await admin.from("estimates").select("id, status").eq("id", estimateId).eq("org_id", orgId).maybeSingle();
  if (!estimate) return { statusCode: 404, body: JSON.stringify({ error: "Estimate not found" }) };

  // The manual button only ever targets the estimate's own current
  // lifecycle status (defaulting to "approved", the only status that
  // showed Convert to Deal before this pass) — never a status the caller
  // picks arbitrarily, so a manual click can't move a Deal further than
  // the estimate's real status would automatically.
  const validTriggers: DealSyncTrigger[] = ["sent", "viewed", "changes_requested", "approved", "rejected"];
  const resolvedTrigger: DealSyncTrigger = trigger && validTriggers.includes(trigger) ? trigger : (validTriggers.includes(estimate.status as DealSyncTrigger) ? (estimate.status as DealSyncTrigger) : "approved");

  const result = await syncEstimateDeal(admin, { estimateId, orgId, trigger: resolvedTrigger, actorUserId: user.id });
  if (!result.ok) return { statusCode: 422, body: JSON.stringify({ error: result.error }) };
  if (result.skipped) return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true, reason: result.reason, dealId: result.dealId ?? null }) };

  return { statusCode: 200, body: JSON.stringify({ ok: true, dealId: result.dealId, stageId: result.stageId, created: result.created, moved: result.moved }) };
};
