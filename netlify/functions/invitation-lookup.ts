/// <reference types="node" />
// netlify/functions/invitation-lookup.ts
//
// Public (token-based) invitation lookup for the invitee page (/auth/callback?token=...). Replaces the browser's direct anonymous
// SELECT on the invitations table, which the database allowed for EVERY invitation. POST { token } -> one invitation with minimal,
// non-secret fields, or { status: "invalid" | "used" | "expired" }. All logic lives in lib/invitation-lookup.ts.

import type { Handler, HandlerResponse } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { lookupInvitation } from "./lib/invitation-lookup";

const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });

const HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const respond = (statusCode: number, body: Record<string, unknown>): HandlerResponse => ({ statusCode, headers: HEADERS, body: JSON.stringify(body) });

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: HEADERS, body: "" };
  if (event.httpMethod !== "POST") return respond(405, { error: "Method not allowed" });
  let body: unknown;
  try { body = JSON.parse(event.body ?? "{}"); } catch { return respond(400, { error: "Invalid JSON body." }); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => k !== "token")) return respond(400, { error: "Body must be exactly { token }." });
  const result = await lookupInvitation(admin, (body as { token?: unknown }).token);
  return respond(200, result as unknown as Record<string, unknown>);
};
