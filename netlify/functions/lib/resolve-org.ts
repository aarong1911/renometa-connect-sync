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

// Re-confirms a user still belongs to a SPECIFIC org, server-side — for
// callbacks that received userId/orgId from a verified-but-earlier-issued
// source (e.g. a signed OAuth state minted up to 10 minutes ago), where
// org membership could have been revoked in between. Same precedence as
// resolveOrgFromBearerToken (profiles.organization_id first,
// org_memberships fallback), but checks equality against a given orgId
// instead of deriving one. Does not verify the user still exists —
// callers that need that should check separately via
// supabaseAdmin.auth.admin.getUserById first.
export async function userBelongsToOrg(
  supabaseAdmin: SupabaseClient,
  userId: string,
  orgId: string,
): Promise<boolean> {
  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("organization_id")
    .eq("id", userId)
    .maybeSingle();
  if (profile?.organization_id === orgId) return true;

  const { data: membership } = await supabaseAdmin
    .from("org_memberships")
    .select("org_id")
    .eq("member_id", userId)
    .eq("org_id", orgId)
    .maybeSingle();
  return !!membership;
}
