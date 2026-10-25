/// <reference types="node" />
// netlify/functions/ai-test-console-access.ts
//
// Tells the AI Center UI whether the CURRENT user may see the internal Test Console. Returns ONLY { allowed: boolean }.
// Authenticated (bearer token -> verified Supabase user); the user id is read server-side and checked against the server-only
// allowlist (lib/test-console-access.ts). The allowlist, any id, and the configuration are never returned. This is a UI
// convenience: the real enforcement is in ai-orchestrate.ts, which applies the same check to the same user id.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { isTestConsoleUser } from "./lib/test-console-access";

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin = createClient(supabaseUrl || "http://invalid.local", serviceRoleKey || "missing", { auth: { autoRefreshToken: false, persistSession: false } });

const HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (statusCode: number, body: Record<string, unknown>) => ({ statusCode, headers: HEADERS, body: JSON.stringify(body) });

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: HEADERS, body: "" };
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });
  if (!supabaseUrl || !serviceRoleKey) return json(500, { error: "Server misconfigured." });

  const token = (event.headers.authorization ?? event.headers.Authorization)?.slice(7);
  if (!token) return json(401, { error: "Unauthorized" });
  const { data: { user } } = await supabaseAdmin.auth.getUser(token);
  if (!user) return json(401, { error: "Unauthorized" });

  return json(200, { allowed: isTestConsoleUser(user.id) });
};
