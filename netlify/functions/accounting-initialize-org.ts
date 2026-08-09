/// <reference types="node" />
// netlify/functions/accounting-initialize-org.ts
//
// Phase 13.6 Part 20 — the "precise remaining integration point" flagged in
// Phase 13.5C: createOrganization() (src/lib/auth.ts) inserts the
// organizations row directly from the browser, so it cannot itself call the
// service_role-only seed_default_chart_of_accounts() RPC. This trusted
// endpoint is that missing link — called from onboarding.tsx right after
// createOrganization() succeeds.
//
// Trust model: the org id is resolved SERVER-SIDE from the caller's own
// profile (the same profiles.organization_id-first, then org_memberships
// convention every other trusted function in this codebase uses) — never
// accepted from the request body. A brand-new org's creator profile row is
// written with organization_id set in the same onboarding flow (see
// src/lib/auth.ts), so by the time this is called the caller's own profile
// already resolves to the org they just created; there is no way to target
// a different org through this endpoint.
//
// Gives the new org exactly: an accounting_settings row + the 36-account
// default Chart of Accounts, status left at 'not_initialized'. Never
// backfills, never activates live posting — that stays a deliberate,
// separate action (accounting-backfill.ts) an owner/admin takes later.
// Idempotent (ensureAccountingInitialized's own upsert + ON CONFLICT DO
// NOTHING) — safe to call more than once, safe to retry on failure.

import type { Handler, HandlerEvent, HandlerResponse } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { ensureAccountingInitialized } from "../lib/accounting";

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

function json(statusCode: number, body: Record<string, unknown>): HandlerResponse {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}

export const handler: Handler = async (event: HandlerEvent): Promise<HandlerResponse> => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  const token = event.headers.authorization?.slice(7) ?? event.headers.Authorization?.slice(7);
  if (!token) return json(401, { error: "Unauthorized" });
  const { data: { user }, error: authError } = await admin.auth.getUser(token);
  if (authError || !user) return json(401, { error: "Invalid token" });

  const { data: profile, error: profileError } = await admin
    .from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
  if (profileError) return json(500, { error: `Could not load profile: ${profileError.message}` });
  const orgId = profile?.organization_id;
  if (!orgId) return json(403, { error: "No organization was found for this user." });

  try {
    await ensureAccountingInitialized(admin, orgId);
  } catch (err) {
    return json(500, { error: err instanceof Error ? err.message : "Could not initialize accounting for this organization." });
  }

  return json(200, { ok: true, orgId });
};
