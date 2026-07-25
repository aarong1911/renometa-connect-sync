// netlify/functions/lib/resolve-org.ts
//
// Shared bearer-token -> organization resolution for the new SMTP secret
// endpoints (smtp-config-save.ts, smtp-config-status.ts,
// smtp-disconnect.ts). Same precedence already used throughout this repo
// (profiles.organization_id first, org_memberships fallback) — extracted
// here only for these new endpoints so they don't each carry their own
// copy; existing functions' own inline copies are left untouched.
//
// Deliberately never accepts an org id as an argument from the caller's
// request body — the whole point is that organization membership is
// always resolved server-side from the authenticated user, never trusted
// from client input.

import type { SupabaseClient } from "@supabase/supabase-js";

export type ResolvedOrg = { userId: string; orgId: string };

export async function resolveOrgFromBearerToken(
  supabaseAdmin: SupabaseClient,
  authHeader: string | undefined,
): Promise<ResolvedOrg | null> {
  const token = authHeader?.slice(7);
  if (!token) return null;

  const { data: { user } } = await supabaseAdmin.auth.getUser(token);
  if (!user) return null;

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("organization_id")
    .eq("id", user.id)
    .maybeSingle();
  let orgId: string | null = profile?.organization_id ?? null;

  if (!orgId) {
    const { data: membership } = await supabaseAdmin
      .from("org_memberships")
      .select("org_id")
      .eq("member_id", user.id)
      .maybeSingle();
    orgId = membership?.org_id ?? null;
  }

  if (!orgId) return null;
  return { userId: user.id, orgId };
}
