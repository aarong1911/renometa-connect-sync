// netlify/functions/lib/member-authorization.ts
//
// Fail-closed authorization for the team-management endpoints (invite-member, update-user-by-id, remove-member). These use the
// service-role key, so this check IS the tenant boundary. Stricter than resolveOrgAndAuthority() on purpose:
//   - every database error denies (it never reads a failed lookup as "no row");
//   - authority comes ONLY from org_memberships.role === 'owner' in the caller's organization — no profiles.role fallback;
//   - the organization is profiles.organization_id, or the caller's single membership when that is empty; anything else
//     (no membership, several memberships and no profile organization) is ambiguous and denied.
// Owner-only matches the app: Team settings are reachable only by the owner (permissions.ts canAccessSettings).

import type { SupabaseClient } from "@supabase/supabase-js";

export type Denied = { ok: false; statusCode: number; error: string };
export type OwnerCaller = { ok: true; userId: string; orgId: string };

export const respond = (statusCode: number, payload: Record<string, unknown>) => ({
  statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
});

// Logs only an error code, never the message/details (they can echo row values).
export const errorCode = (e: unknown): string =>
  e && typeof e === "object" && "code" in e && (e as { code?: unknown }).code ? String((e as { code: unknown }).code) : "unknown";

const deny = (statusCode: number, error: string): Denied => ({ ok: false, statusCode, error });

export async function requireOrgOwner(admin: SupabaseClient, authHeader: string | undefined): Promise<OwnerCaller | Denied> {
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return deny(401, "Unauthorized");
  let userId: string | undefined;
  try {
    const { data, error } = await admin.auth.getUser(token);
    userId = error ? undefined : data?.user?.id;
  } catch { userId = undefined; }
  if (!userId) return deny(401, "Invalid token");

  const { data: profile, error: profileErr } = await admin.from("profiles").select("organization_id").eq("id", userId).maybeSingle();
  if (profileErr) return deny(500, "Could not verify your organization.");
  const { data: memberships, error: membershipErr } = await admin.from("org_memberships").select("org_id, role").eq("member_id", userId);
  if (membershipErr || !Array.isArray(memberships)) return deny(500, "Could not verify your organization.");

  let orgId: string | null = profile?.organization_id ?? null;
  if (!orgId) orgId = memberships.length === 1 ? memberships[0].org_id : null;
  if (!orgId) return deny(403, "No organization was found for this user.");

  const inOrg = memberships.filter((m) => m.org_id === orgId);
  if (inOrg.length !== 1 || inOrg[0].role !== "owner")
    return deny(403, "Only the organization owner can manage team members.");
  return { ok: true, userId, orgId };
}

// Every membership the user has, or null on a database error (callers treat null as "deny").
export async function membershipsOf(admin: SupabaseClient, userId: string): Promise<{ org_id: string; role: string }[] | null> {
  const { data, error } = await admin.from("org_memberships").select("org_id, role").eq("member_id", userId);
  return error || !Array.isArray(data) ? null : data;
}

// True only for this organization's own disposable roster placeholder (invite-member's roster-only "ghost" user): never
// confirmed, never signed in, created for exactly this email and organization as roster_only, with no membership or profile
// in any other organization. Any lookup error, or anything else about the account, means it is NOT a placeholder.
export async function isOrgRosterPlaceholder(admin: SupabaseClient, orgId: string, userId: string, email: string): Promise<boolean> {
  try {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    const user = data?.user;
    if (error || !user) return false;
    const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
    if (user.email_confirmed_at || user.last_sign_in_at) return false;
    if ((user.email ?? "").toLowerCase() !== email.toLowerCase()) return false;
    if (meta.roster_only !== true || meta.org_id !== orgId) return false;

    const memberships = await membershipsOf(admin, userId);
    if (!memberships || memberships.some((m) => m.org_id !== orgId)) return false;
    const { data: profile, error: profileErr } = await admin.from("profiles").select("organization_id").eq("id", userId).maybeSingle();
    if (profileErr) return false;
    return !profile?.organization_id || profile.organization_id === orgId;
  } catch {
    return false;
  }
}

// Removes a placeholder confirmed by isOrgRosterPlaceholder: its membership in this organization, its profile, its auth user.
// Every step runs; returns the steps that failed.
export async function removeRosterPlaceholder(admin: SupabaseClient, orgId: string, userId: string): Promise<string[]> {
  const failed: string[] = [];
  const step = async (name: string, run: () => PromiseLike<{ error: unknown }>) => {
    try { const { error } = await run(); if (error) failed.push(name); }
    catch { failed.push(name); }
  };
  await step("org_memberships", () => admin.from("org_memberships").delete().eq("member_id", userId).eq("org_id", orgId));
  await step("profiles", () => admin.from("profiles").delete().eq("id", userId));
  await step("auth_user", () => admin.auth.admin.deleteUser(userId));
  return failed;
}

export const escapeHtml = (value: unknown): string =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
