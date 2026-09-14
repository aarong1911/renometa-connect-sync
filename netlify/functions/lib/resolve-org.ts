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

export type ResolvedOrgAndAuthority = { orgId: string | null; isOwnerOrAdmin: boolean };

// Server-side owner/admin resolution for AI Center's Emergency Pause
// endpoint (ai-emergency-pause.ts). Deliberately does NOT reuse the
// "profile carries organization_id => always owner/admin" shortcut
// duplicated inline in agent-approve-action.ts and voice-call-delete.ts —
// a live check while building this (2026-09-14, org
// d7963ad6-4bfe-4cc2-b9c2-949a02a3fa72) proved that shortcut unsafe:
// EVERY member of that org (the real owner, a 'viewer', and a
// 'project_manager') has profiles.organization_id populated, not just the
// account owner/creator. That shortcut would grant owner/admin authority
// to any org member for whatever it gates — flagged as a pre-existing
// concern in those two files, out of scope to fix here.
//
// The canonical, fine-grained per-org role (owner / admin / office_manager
// / estimator / sales / project_manager / field_worker / accountant /
// viewer — the same set src/lib/permissions.ts's Role type and
// src/lib/organization.ts's team roster use) lives on
// org_memberships.role, scoped to (member_id, org_id) — this is the same
// table/column src/lib/organization.ts's fetchTeamMembersForOrg() reads to
// build the roster that useCurrentUserRole() derives the frontend's role
// from. That is the source of truth used here.
//
// org id resolution keeps the same precedence as resolveOrgFromBearerToken
// (profiles.organization_id first, org_memberships fallback) — org
// lookup, not authority, is what that precedence is for. Once orgId is
// known, authority ALWAYS comes from a fresh org_memberships.role lookup
// scoped to that exact org, never inferred from profile presence alone.
// Only if no org_memberships row exists at all (legacy/edge case) does
// this fall back to profiles.role's own coarse owner/member flag — and
// only the literal 'owner' value there is treated as authorized; anything
// else (including missing) fails closed to not-authorized.
//
// Never trusts a role/orgId supplied by the caller; both are derived from
// the authenticated userId against server-side tables.
export async function resolveOrgAndAuthority(
  supabaseAdmin: SupabaseClient,
  userId: string,
): Promise<ResolvedOrgAndAuthority> {
  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("organization_id, role")
    .eq("id", userId)
    .maybeSingle();
  let orgId: string | null = profile?.organization_id ?? null;

  if (!orgId) {
    const { data: membership } = await supabaseAdmin
      .from("org_memberships")
      .select("org_id")
      .eq("member_id", userId)
      .maybeSingle();
    orgId = membership?.org_id ?? null;
  }
  if (!orgId) return { orgId: null, isOwnerOrAdmin: false };

  const { data: membershipRole } = await supabaseAdmin
    .from("org_memberships")
    .select("role")
    .eq("member_id", userId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (membershipRole?.role) {
    return { orgId, isOwnerOrAdmin: membershipRole.role === "owner" || membershipRole.role === "admin" };
  }

  // No org_memberships row for this org — fall back to profiles.role's
  // coarse flag, fail-closed (only an exact 'owner' match authorizes).
  return { orgId, isOwnerOrAdmin: profile?.role === "owner" };
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
