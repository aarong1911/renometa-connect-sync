/// <reference types="node" />
// netlify/functions/price-book.ts
//
// Pricing Intelligence P4 — trusted Price Book management endpoint (staff Settings → Price Book).
//
//   GET    ?q=&active=all|active|inactive   list / search this organization's entries
//   POST   { ...entry }                     create
//   PATCH  { id, patch: { ...fields } }     update, activate/deactivate (patch.active), mark reviewed (patch.reviewed)
//
// AUTHORIZATION: owner/admin only (the table carries internal cost data), via the canonical resolveOrgAndAuthority(). The
// organization and the user are ALWAYS resolved server-side from the bearer token — never from the request. Bodies are strict:
// no org id, reviewer id, normalized name, source or timestamp can be supplied. There is no DELETE (entries are soft-disabled).
// All logic lives in lib/price-book-service.ts.

import type { Handler, HandlerResponse } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgAndAuthority } from "./lib/resolve-org";
import { createPriceBookItem, listPriceBook, updatePriceBookItem, type ServiceResult } from "./lib/price-book-service";

const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });

const CORS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
};

const respond = (statusCode: number, body: Record<string, unknown>): HandlerResponse => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const fromResult = <T,>(r: ServiceResult<T>, key: string, okStatus = 200): HandlerResponse =>
  r.ok ? respond(okStatus, { ok: true, [key]: r.value }) : respond(r.status, { error: r.error, ...(r.details ? { details: r.details } : {}) });

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (!["GET", "POST", "PATCH"].includes(event.httpMethod)) return respond(405, { error: "Method not allowed" });

  const token = (event.headers.authorization ?? event.headers.Authorization)?.slice(7);
  if (!token) return respond(401, { error: "Unauthorized" });
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return respond(401, { error: "Invalid token" });

  const { orgId, isOwnerOrAdmin } = await resolveOrgAndAuthority(admin, user.id);
  if (!orgId) return respond(403, { error: "Could not resolve your organization." });
  if (!isOwnerOrAdmin) return respond(403, { error: "Only an organization owner or admin can manage the Price Book." });
  const ctx = { orgId, userId: user.id };

  if (event.httpMethod === "GET") {
    const params = event.queryStringParameters ?? {};
    const active = params.active === "active" || params.active === "inactive" ? params.active : "all";
    return fromResult(await listPriceBook(admin, orgId, { q: params.q ?? "", active }), "items");
  }

  let body: unknown;
  try { body = JSON.parse(event.body ?? "{}"); } catch { return respond(400, { error: "Invalid JSON body." }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return respond(400, { error: "Invalid request body." });

  if (event.httpMethod === "POST") return fromResult(await createPriceBookItem(admin, ctx, body), "item", 201);

  // PATCH — exactly { id, patch }
  const { id, patch, ...rest } = body as { id?: unknown; patch?: unknown };
  if (Object.keys(rest).length > 0 || typeof id !== "string") return respond(400, { error: "Body must be exactly { id, patch }." });
  return fromResult(await updatePriceBookItem(admin, ctx, id, patch), "item");
};
