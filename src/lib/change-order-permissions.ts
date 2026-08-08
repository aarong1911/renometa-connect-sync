// src/lib/change-order-permissions.ts
//
// Security audit (post-13.3B), Part 9 — Change Orders now participates in
// the existing role + member_permissions override architecture
// (src/lib/permission-features.ts / member_permissions table) instead of
// being gated only by ordinary Project route access. One resolver
// implementation is shared by the browser (UI gating: hide/disable
// Send/Cancel/Apply-schedule-impact) and by Netlify functions (server-side
// enforcement before ever calling a privileged RPC) — both call
// resolveChangeOrderPermission with whichever Supabase client is
// appropriate for that context, so the access logic itself never drifts
// between the two call sites.
//
// This is intentionally an application-layer check, not a database-layer
// one: no table's RLS/trigger in this codebase currently consults
// member_permissions (org membership is the DB-level boundary everywhere,
// including project_change_orders — see the migration), and introducing a
// novel enforcement layer just for this one feature would create exactly
// the kind of drift this module exists to avoid. Org isolation itself
// remains enforced in the database regardless of what this resolves to.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Role } from "./organization";
import { type PermissionAction, getRoleDefaultPermission } from "./permission-features";

const CHANGE_ORDERS_FEATURE_ID = "change_orders";

/** Minimal shape both the browser `supabase` client and a Netlify function's service-role client satisfy. */
type QueryableClient = Pick<SupabaseClient, "from">;

async function resolveOrgId(client: QueryableClient, userId: string): Promise<string | null> {
  const { data: profile } = await client.from("profiles").select("organization_id").eq("id", userId).maybeSingle();
  if (profile?.organization_id) return profile.organization_id as string;
  const { data: membership } = await client.from("org_memberships").select("org_id").eq("member_id", userId).maybeSingle();
  return (membership?.org_id as string | undefined) ?? null;
}

async function resolveRole(client: QueryableClient, userId: string, orgId: string): Promise<Role | null> {
  const { data } = await client.from("org_memberships").select("role").eq("member_id", userId).eq("org_id", orgId).maybeSingle();
  return (data?.role as Role | undefined) ?? null;
}

/**
 * Core resolver: role default, overridden by a member_permissions row when
 * one exists for (org, member, "change_orders", action) — identical
 * precedence to the Permissions settings page (member_permissions wins,
 * else the role default from permission-features.ts).
 */
export async function resolveChangeOrderPermission(
  client: QueryableClient,
  userId: string,
  orgId: string,
  action: PermissionAction,
): Promise<boolean> {
  const role = await resolveRole(client, userId, orgId);
  if (!role) return false;

  const roleDefault = getRoleDefaultPermission(role, CHANGE_ORDERS_FEATURE_ID, action);

  const { data: override } = await client
    .from("member_permissions")
    .select("granted")
    .eq("org_id", orgId)
    .eq("member_id", userId)
    .eq("feature", CHANGE_ORDERS_FEATURE_ID)
    .eq("action", action)
    .maybeSingle();

  if (override && typeof override.granted === "boolean") return override.granted;
  return roleDefault;
}

/** Semantic action names used by the Change Orders feature, mapped onto the generic view/create/edit/delete vocabulary. */
export const CHANGE_ORDER_PERMISSION_ACTIONS = {
  view: "view",
  create: "create",
  send: "edit",
  cancel: "edit",
  applyScheduleImpact: "edit",
  delete: "delete",
} as const satisfies Record<string, PermissionAction>;

export type ChangeOrderPermissionName = keyof typeof CHANGE_ORDER_PERMISSION_ACTIONS;

/** Convenience wrapper for Netlify functions: resolves org from userId first (never trusts a client-supplied orgId for anything beyond an initial read), then checks permission within it. */
export async function resolveChangeOrderPermissionServer(
  client: QueryableClient,
  userId: string,
  orgId: string,
  action: ChangeOrderPermissionName,
): Promise<boolean> {
  const resolvedOrgId = await resolveOrgId(client, userId);
  if (!resolvedOrgId || resolvedOrgId !== orgId) return false;
  return resolveChangeOrderPermission(client, userId, orgId, CHANGE_ORDER_PERMISSION_ACTIONS[action]);
}

/** Browser-side convenience wrapper for UI gating (hide/disable actions before the server even gets a chance to reject them). Not a React hook despite the naming temptation — plain async helper, call it from an effect. */
export async function checkChangeOrderPermission(
  client: QueryableClient,
  userId: string | null,
  orgId: string | null,
  action: ChangeOrderPermissionName,
): Promise<boolean> {
  if (!userId || !orgId) return false;
  return resolveChangeOrderPermission(client, userId, orgId, CHANGE_ORDER_PERMISSION_ACTIONS[action]);
}
