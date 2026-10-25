/// <reference types="node" />
// netlify/functions/estimate-suggest-pricing.ts
//
// Pricing Intelligence P4 — staff "Suggest Pricing" on an open estimate. POST { estimateId }.
//
// READ ONLY and STAFF ONLY: nothing is written, no approval is created, no model is called. The organization and user come from
// the bearer token (never the body); the body is exactly { estimateId }. Only roles that can work on estimates may call it
// (the customer-facing portal "viewer" and field workers cannot). All logic lives in lib/estimate-suggest-pricing.ts.

import type { Handler, HandlerResponse } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgAndAuthority } from "./lib/resolve-org";
import { suggestPricingForEstimate } from "./lib/estimate-suggest-pricing";

const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });

const CORS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Roles that work on estimates / pricing. viewer (portal client) and field_worker are excluded. */
export const SUGGEST_PRICING_ROLES = ["owner", "admin", "office_manager", "estimator", "sales", "project_manager", "accountant"] as const;

const respond = (statusCode: number, body: Record<string, unknown>): HandlerResponse => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return respond(405, { error: "Method not allowed" });

  const token = (event.headers.authorization ?? event.headers.Authorization)?.slice(7);
  if (!token) return respond(401, { error: "Unauthorized" });
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return respond(401, { error: "Invalid token" });

  const { orgId, role } = await resolveOrgAndAuthority(admin, user.id);
  if (!orgId) return respond(403, { error: "Could not resolve your organization." });
  if (!role || !(SUGGEST_PRICING_ROLES as readonly string[]).includes(role)) return respond(403, { error: "You do not have access to pricing suggestions." });

  let body: unknown;
  try { body = JSON.parse(event.body ?? "{}"); } catch { return respond(400, { error: "Invalid JSON body." }); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => k !== "estimateId")) return respond(400, { error: "Body must be exactly { estimateId }." });

  const result = await suggestPricingForEstimate(admin, { orgId, userId: user.id }, (body as { estimateId?: unknown }).estimateId);
  if (!result.ok) return respond(result.status, { error: result.error });
  if (result.kind === "all_priced") return respond(200, { ok: true, kind: "all_priced", message: result.message });
  return respond(200, { ok: true, kind: "suggestions", pricing: result.pricing, requestedItems: result.requestedItems, capped: result.capped });
};
