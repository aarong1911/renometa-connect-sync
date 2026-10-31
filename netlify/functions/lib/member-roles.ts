// netlify/functions/lib/member-roles.ts
//
// The nine member roles the app supports — the same set as src/lib/organization.ts's Role / ALL_ROLES (kept separate because Netlify
// functions don't import browser modules) and as org_memberships_role_check, set by
// supabase/migrations/20261031_org_memberships_role_office_manager.sql (applied 2026-10-31). A test keeps all three lists identical.

export const SUPPORTED_MEMBER_ROLES = [
  "owner", "admin", "office_manager",
  "estimator", "sales",
  "project_manager", "field_worker",
  "accountant", "viewer",
] as const;

export type MemberRole = (typeof SUPPORTED_MEMBER_ROLES)[number];

export function isSupportedMemberRole(role: unknown): role is MemberRole {
  return typeof role === "string" && (SUPPORTED_MEMBER_ROLES as readonly string[]).includes(role);
}
