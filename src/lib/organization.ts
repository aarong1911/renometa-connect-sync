// src/lib/organization.ts
//
// Platform State Sync Phase S5D — Organization / Team / Permissions.
//
// BEFORE: a module-level `org` object + `team` array + two listener Sets +
// `emitOrg()`/`emitTeam()` + `useSyncExternalStore`, hydrated by a
// top-level `loadOrgFromSupabase()` call at import time, plus its OWN
// three realtime channels (`org_${orgId}`, `members_${orgId}`,
// `invitations_${orgId}`) — the exact "duplicate subscription per module"
// anti-pattern the central RealtimeBridge exists to eliminate.
//
// AFTER: two TanStack Query keys per org — `queryKeys.organization(orgId)`
// (the organizations row) and `queryKeys.teamMembers(orgId)` (active
// org_memberships, profile-joined) — plus a third,
// `queryKeys.organizationInvitations(orgId)`, for the invitations table
// that `useTeam()` merges in client-side (same merge rule the old
// `reloadTeam()` used: active members first, then invited/roster members
// whose email isn't already an active member). `useOrganization()` and
// `useTeam()` keep their EXACT public shapes (`Organization` /
// `TeamMember[]`) so none of this file's ~32 importers need to change.
// The central RealtimeBridge now invalidates these on `organizations` /
// `org_memberships` / `profiles` / `invitations` changes — see
// realtime-bridge.tsx. No module-level realtime channels remain here.
//
// Org id resolution now uses the shared `useOrgId()` (src/lib/org-id.ts) —
// the same hook every other Query-backed domain (S1–S5C) already uses —
// instead of this file's own bespoke profiles→org_memberships lookup with
// explicit SIGNED_IN/SIGNED_OUT/TOKEN_REFRESHED handling. `useOrgId()`'s
// per-user memoization already invalidates correctly when a different
// user signs in (keyed by auth user id), matching every already-migrated
// domain's accepted session model. The one behavior worth preserving
// explicitly: on SIGNED_OUT, the old code cleared the localStorage logo/
// company-name cache so a different identity on the same machine never
// sees a stale prior org's branding pre-fetch — kept below as a single
// small, one-time auth listener (not a data cache, not a realtime
// channel) that also drops this domain's Query cache entries.
//
// S5D.1 correction: `addMember`/`removeMember` are NOT local-only mocks —
// a real, already-built trusted persistence path exists for both
// (src/lib/team.ts's `inviteMember`/`removeMemberFromOrg`, calling
// netlify/functions/invite-member.ts / remove-member.ts) and was already
// wired into team-members-manager.tsx before S5D. The actual defect
// (fixed in S5D.1) was ORDERING: the UI called these two functions to
// patch local state BEFORE awaiting the real server call, so a failed
// invite/remove still looked like it succeeded, and a successful one
// never told the Query cache to reconcile with the authoritative row.
// team-members-manager.tsx now calls the real endpoint FIRST and only
// calls addMember()/removeMember() after confirmed success; these two
// functions still don't touch Supabase themselves — they patch the Query
// cache as an instant-feel placeholder and invalidate the correct real
// key(s) so the next refetch replaces it with server truth.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "./supabase";
import { getQueryClient } from "@/lib/query-client";
import { getOrgId, useOrgId } from "@/lib/org-id";
import { queryKeys } from "@/lib/query-keys";

export type Role =
  | "owner" | "admin" | "office_manager" | "estimator" | "sales"
  | "project_manager" | "field_worker" | "accountant" | "viewer";

export const ALL_ROLES: Role[] = [
  "owner","admin","office_manager",
  "estimator","sales",
  "project_manager","field_worker",
  "accountant","viewer",
];

export const ROLE_LABELS: Record<Role, string> = {
  owner:           "Account Owner",
  admin:           "Company Administrator",
  office_manager:  "Office Manager / Operations",
  estimator:       "Pre-Construction / Estimator",
  sales:           "Sales Representative",
  project_manager: "Project Manager",
  field_worker:    "Field Crew / Technician",
  accountant:      "External Bookkeeper / CPA",
  viewer:          "Read-Only Stakeholder",
};

export const ROLE_GROUPS = [
  { label: "🏢 Corporate & Management", roles: ["owner","admin","office_manager"] as Role[] },
  { label: "📈 Growth & Revenue",        roles: ["estimator","sales"] as Role[] },
  { label: "🛠️ Field Operations",        roles: ["project_manager","field_worker"] as Role[] },
  { label: "🔒 External & Restricted",   roles: ["accountant","viewer"] as Role[] },
];

export const OFFLINE_CAPABLE_ROLES: Role[] = ["field_worker", "viewer"];

export const INDUSTRIES = [
  "General Contractor / Remodeler","HVAC","Plumbing","Electrical","Roofing",
  "Painting","Landscaping","Flooring","Windows & Doors","Handyman",
] as const;

export const TIMEZONE_OPTIONS = [
  "America/New_York","America/Chicago","America/Denver","America/Los_Angeles",
  "America/Anchorage","Pacific/Honolulu","America/Phoenix","America/Toronto",
  "America/Vancouver","Europe/London","Europe/Paris","Europe/Berlin",
  "Asia/Tokyo","Asia/Shanghai","Australia/Sydney",
] as const;

const STATE_TZ: Record<string, string> = {
  AL:"America/Chicago",AK:"America/Anchorage",AZ:"America/Phoenix",
  AR:"America/Chicago",CA:"America/Los_Angeles",CO:"America/Denver",
  CT:"America/New_York",DE:"America/New_York",FL:"America/New_York",
  GA:"America/New_York",HI:"Pacific/Honolulu",ID:"America/Boise",
  IL:"America/Chicago",IN:"America/Indiana/Indianapolis",IA:"America/Chicago",
  KS:"America/Chicago",KY:"America/New_York",LA:"America/Chicago",
  ME:"America/New_York",MD:"America/New_York",MA:"America/New_York",
  MI:"America/Detroit",MN:"America/Chicago",MS:"America/Chicago",
  MO:"America/Chicago",MT:"America/Denver",NE:"America/Chicago",
  NV:"America/Los_Angeles",NH:"America/New_York",NJ:"America/New_York",
  NM:"America/Denver",NY:"America/New_York",NC:"America/New_York",
  ND:"America/Chicago",OH:"America/New_York",OK:"America/Chicago",
  OR:"America/Los_Angeles",PA:"America/New_York",RI:"America/New_York",
  SC:"America/New_York",SD:"America/Chicago",TN:"America/Chicago",
  TX:"America/Chicago",UT:"America/Denver",VT:"America/New_York",
  VA:"America/New_York",WA:"America/Los_Angeles",WV:"America/New_York",
  WI:"America/Chicago",WY:"America/Denver",DC:"America/New_York",
};

export function guessTimezoneFromAddress(address: string): string | null {
  const m = address.match(/\b([A-Z]{2})\s*\d{0,5}\s*$/);
  if (m) return STATE_TZ[m[1]] ?? null;
  const m2 = address.match(/,\s*([A-Z]{2})\b/);
  if (m2) return STATE_TZ[m2[1]] ?? null;
  return null;
}

export const CRM_GOALS = [
  "Manage Leads","Track Sales","Schedule Jobs","Invoice Customers",
  "Automations","Email/SMS Marketing","Reporting",
] as const;

export type WorkerType = "employee" | "subcontractor";

export type Organization = {
  companyName: string; primaryPhone: string; website: string;
  industry?: string; address: string; logoUrl: string | null;
  crmGoals: string[]; timezone: string;
};

export type TeamMember = {
  id: string; name: string; email: string; phone?: string;
  role: Role; workerType: WorkerType;
  status: "active" | "invited" | "roster";
  invitedAt?: string;
};

const LOGO_KEY    = "rm_org_logo";
const COMPANY_KEY = "rm_org_name";

function readLogoCache(): string | null {
  try { const v = localStorage.getItem(LOGO_KEY); return v && !v.startsWith("blob:") ? v : null; }
  catch { return null; }
}
function writeLogoCache(url: string | null) {
  try { url && !url.startsWith("blob:") ? localStorage.setItem(LOGO_KEY, url) : localStorage.removeItem(LOGO_KEY); }
  catch {}
}
function readCompanyCache(): string {
  try { return localStorage.getItem(COMPANY_KEY) ?? ""; } catch { return ""; }
}
function writeCompanyCache(name: string) {
  try { name ? localStorage.setItem(COMPANY_KEY, name) : localStorage.removeItem(COMPANY_KEY); } catch {}
}

const DEFAULT_ORG: Organization = {
  companyName: "", primaryPhone: "", website: "", industry: undefined,
  address: "", logoUrl: null, crmGoals: [], timezone: "America/Los_Angeles",
};

const qc = () => getQueryClient();

// ── One-time sign-out cleanup (NOT a data cache/realtime channel — see
// file header) ─────────────────────────────────────────────────────────
// Registered lazily on first hook use (never at import time). Preserves
// the one behavior worth keeping from the old SIGNED_OUT handler: a
// different identity on the same machine must never see a stale prior
// org's cached branding before its own first fetch resolves.
let signOutCleanupAttached = false;
function ensureSignOutCleanup() {
  if (signOutCleanupAttached) return;
  signOutCleanupAttached = true;
  supabase.auth.onAuthStateChange((event) => {
    if (event !== "SIGNED_OUT") return;
    writeLogoCache(null);
    writeCompanyCache("");
    qc().removeQueries({ queryKey: ["organization"] });
    qc().removeQueries({ queryKey: ["teamMembers"] });
    qc().removeQueries({ queryKey: ["organizationInvitations"] });
    qc().removeQueries({ queryKey: ["memberPermissions"] });
  });
}

// ── Organization profile ─────────────────────────────────────────────────

async function fetchOrganizationForOrg(orgId: string): Promise<Organization> {
  const { data: orgData, error } = await supabase.from("organizations").select("*").eq("id", orgId).maybeSingle();
  if (error) {
    console.error("[org] fetchOrganizationForOrg failed:", error);
    throw error;
  }
  if (!orgData) return { ...DEFAULT_ORG, logoUrl: readLogoCache(), companyName: readCompanyCache() };

  const rawLogo = orgData.logo_url || null;
  const logoUrl = rawLogo?.startsWith("blob:") ? null : rawLogo;
  const resolved: Organization = {
    companyName:  orgData.name  || orgData.public_name || "",
    primaryPhone: orgData.phone || "",
    website:      orgData.website || "",
    industry:     orgData.industry || undefined,
    address:      orgData.address  || orgData.business_address || "",
    logoUrl:      logoUrl || readLogoCache(),
    crmGoals:     orgData.crm_goals || [],
    timezone:     orgData.timezone  || "America/Los_Angeles",
  };
  if (logoUrl) writeLogoCache(logoUrl);
  writeCompanyCache(resolved.companyName);
  return resolved;
}

function useOrganizationQuery() {
  ensureSignOutCleanup();
  const orgId = useOrgId();
  return useQuery({
    queryKey: orgId ? queryKeys.organization(orgId) : ["organization", "_pending"],
    queryFn: () => fetchOrganizationForOrg(orgId as string),
    enabled: !!orgId,
    // Org profile changes rarely (name/logo/branding) — mutation
    // invalidation + realtime + focus-refetch are the primary freshness
    // path, this just caps redundant refetches.
    staleTime: 90_000,
    // Anti-flash (Part 23): seeds from the exact same localStorage cache
    // the pre-S5D module default used, so the app shell/settings never
    // show a blank name/logo before the first fetch resolves.
    initialData: () => ({ ...DEFAULT_ORG, logoUrl: readLogoCache(), companyName: readCompanyCache() }),
  });
}

export function useOrganization(): Organization {
  return useOrganizationQuery().data ?? DEFAULT_ORG;
}

/** One-off cache reader for non-hook contexts (e.g. a draft-form's "Reset" button). */
export function getOrganization(): Organization {
  for (const [, data] of qc().getQueriesData<Organization>({ queryKey: ["organization"] })) {
    if (data) return data;
  }
  return { ...DEFAULT_ORG, logoUrl: readLogoCache(), companyName: readCompanyCache() };
}

/**
 * Optimistic-first (preserved exactly — this was already the one domain
 * in the app with an instant-feel update-before-persist contract, unlike
 * the persist-first pattern every other S-phase store uses). Switching it
 * to persist-first would add perceived latency to renaming the org or
 * changing the logo that never existed before S5D.
 */
export function updateOrganization(patch: Partial<Organization>) {
  qc().setQueriesData<Organization>({ queryKey: ["organization"] }, (old) => ({ ...(old ?? DEFAULT_ORG), ...patch }));
  if (patch.logoUrl     !== undefined) writeLogoCache(patch.logoUrl);
  if (patch.companyName !== undefined) writeCompanyCache(patch.companyName);

  (async () => {
    try {
      const orgId = await getOrgId();
      if (!orgId) return;
      const u: Record<string, any> = {};
      if (patch.companyName  !== undefined) { u.name = patch.companyName; u.public_name = patch.companyName; }
      if (patch.primaryPhone !== undefined) u.phone     = patch.primaryPhone;
      if (patch.website      !== undefined) u.website   = patch.website;
      if (patch.industry     !== undefined) u.industry  = patch.industry;
      if (patch.address      !== undefined) u.address   = patch.address;
      if (patch.logoUrl      !== undefined) u.logo_url  = patch.logoUrl;
      if (patch.crmGoals     !== undefined) u.crm_goals = patch.crmGoals;
      if (patch.timezone     !== undefined) u.timezone  = patch.timezone;
      if (Object.keys(u).length > 0) {
        const { error } = await supabase.from("organizations").update(u).eq("id", orgId);
        if (error) console.error("[org] updateOrganization failed:", error);
        else void qc().invalidateQueries({ queryKey: ["organization"] });
      }
    } catch (err) { console.error("[org] updateOrganization sync failed:", err); }
  })();
}

// ── Team roster + invitations ────────────────────────────────────────────
//
// Two separate Query keys (teamMembers = active org_memberships, profile-
// joined; organizationInvitations = pending/roster-only team invites) so
// inviting someone only ever invalidates the invitations key, never the
// whole roster, and vice versa — see the S5D report's invalidation
// matrix. `useTeam()` merges them client-side with the EXACT same rule
// `reloadTeam()` always used (active members first, then any invited/
// roster row whose email isn't already an active member), so its public
// shape — one `TeamMember[]` — never changed for its ~15 callers.

type OrgInvitationRow = TeamMember;

async function fetchTeamMembersForOrg(orgId: string): Promise<TeamMember[]> {
  const { data: members, error } = await supabase.from("org_memberships").select(`
    member_id, role, name,
    profiles!org_memberships_member_id_fkey(id, first_name, last_name, email, phone)
  `).eq("org_id", orgId);
  if (error) {
    console.error("[org] fetchTeamMembersForOrg failed:", error);
    throw error;
  }
  return (members ?? []).map((m: any) => {
    const profileName = `${m.profiles?.first_name || ""} ${m.profiles?.last_name || ""}`.trim();
    return {
      id:         m.member_id,
      name:       profileName || m.name || m.profiles?.email || "",
      email:      m.profiles?.email  || "",
      phone:      m.profiles?.phone  || undefined,
      role:       (m.role || "viewer") as Role,
      workerType: "employee" as WorkerType,
      status:     "active" as const,
    };
  });
}

async function fetchOrganizationInvitationsForOrg(orgId: string): Promise<OrgInvitationRow[]> {
  const { data: invites, error } = await supabase.from("invitations").select("*")
    .eq("organization_id", orgId)
    .in("status", ["pending", "roster_only"])
    .is("project_id", null);
  if (error) {
    console.error("[org] fetchOrganizationInvitationsForOrg failed:", error);
    throw error;
  }
  return (invites ?? []).map((inv: any) => ({
    id:        `inv-${inv.id}`,
    name:      `${inv.first_name || ""} ${inv.last_name || ""}`.trim() || inv.email || "",
    email:     inv.email || "",
    phone:     inv.primary_phone || undefined,
    role:      (inv.role || "viewer") as Role,
    workerType: (inv.worker_type || "employee") as WorkerType,
    status:    inv.status === "roster_only" ? "roster" as const : "invited" as const,
    invitedAt: inv.created_at,
  }));
}

function mergeTeam(active: TeamMember[], invited: OrgInvitationRow[]): TeamMember[] {
  const activeEmails = new Set(active.map((m) => m.email));
  const filteredInvited = invited.filter((m) => !activeEmails.has(m.email));
  return [...active, ...filteredInvited];
}

function useTeamMembersQuery() {
  ensureSignOutCleanup();
  const orgId = useOrgId();
  return useQuery({
    queryKey: orgId ? queryKeys.teamMembers(orgId) : ["teamMembers", "_pending"],
    queryFn: () => fetchTeamMembersForOrg(orgId as string),
    enabled: !!orgId,
    staleTime: 60_000,
  });
}

function useOrganizationInvitationsQuery() {
  const orgId = useOrgId();
  return useQuery({
    queryKey: orgId ? queryKeys.organizationInvitations(orgId) : ["organizationInvitations", "_pending"],
    queryFn: () => fetchOrganizationInvitationsForOrg(orgId as string),
    enabled: !!orgId,
    staleTime: 60_000,
  });
}

export function useTeam(): TeamMember[] {
  const active = useTeamMembersQuery().data ?? [];
  const invited = useOrganizationInvitationsQuery().data ?? [];
  // Stable reference unless either underlying Query actually changed —
  // useCurrentUserRole() (permissions.ts) and every role-gated control
  // reads this on every render; a fresh array every render would still be
  // correct but would defeat memoized consumers downstream for no reason.
  return useMemo(() => mergeTeam(active, invited), [active, invited]);
}

/** One-off cache reader for non-hook contexts (e.g. tasks-store.ts's assignee display resolution). */
export function getTeam(): TeamMember[] {
  let active: TeamMember[] = [];
  let invited: OrgInvitationRow[] = [];
  for (const [, data] of qc().getQueriesData<TeamMember[]>({ queryKey: ["teamMembers"] })) {
    if (Array.isArray(data)) { active = data; break; }
  }
  for (const [, data] of qc().getQueriesData<OrgInvitationRow[]>({ queryKey: ["organizationInvitations"] })) {
    if (Array.isArray(data)) { invited = data; break; }
  }
  return mergeTeam(active, invited);
}

/**
 * S5D.1 correction — addMember() is now ONLY ever called by
 * team-members-manager.tsx AFTER a real `inviteMember()` (src/lib/team.ts
 * -> netlify/functions/invite-member.ts) call has confirmed persistence
 * (invitation row insert + email send, or for a roster-only add, an
 * immediate ghost profile + org_membership too). This function itself
 * still does no Supabase call — its only job is the instant-feel local
 * placeholder — but it now patches and invalidates the CORRECT real Query
 * key(s) so the placeholder is reconciled with the authoritative server
 * row within moments, instead of being the only representation of
 * "success" indefinitely (the pre-S5D.1 defect).
 *
 * The one remaining local-only case: `status === "active"` happens when
 * the caller explicitly turns off "Send invite now" without choosing
 * roster-only — there is no existing backend endpoint for "add an
 * already-active member with no invitation," so this one path stays a
 * local-only placeholder exactly as before (see the S5D.1 report's
 * "remaining gaps").
 */
export function addMember(member: Omit<TeamMember, "id">): TeamMember {
  const next: TeamMember = { ...member, id: `u${Date.now()}` };

  if (member.status === "active") {
    qc().setQueriesData<TeamMember[]>({ queryKey: ["teamMembers"] }, (old) => (Array.isArray(old) ? [...old, next] : old));
    return next;
  }

  // "invited" or "roster" — a real invitation row (and, for roster, an
  // immediate org_membership too) now exists server-side.
  qc().setQueriesData<OrgInvitationRow[]>({ queryKey: ["organizationInvitations"] }, (old) => (Array.isArray(old) ? [...old, next] : old));
  void qc().invalidateQueries({ queryKey: ["organizationInvitations"] });
  if (member.status === "roster") void qc().invalidateQueries({ queryKey: ["teamMembers"] });
  return next;
}

export function updateMember(id: string, patch: Partial<TeamMember>) {
  qc().setQueriesData<TeamMember[]>({ queryKey: ["teamMembers"] }, (old) =>
    Array.isArray(old) ? old.map((m) => (m.id === id ? { ...m, ...patch } : m)) : old);
  qc().setQueriesData<OrgInvitationRow[]>({ queryKey: ["organizationInvitations"] }, (old) =>
    Array.isArray(old) ? old.map((m) => (m.id === id ? { ...m, ...patch } : m)) : old);

  // Invitation rows are edited directly by the caller (team-members-
  // manager.tsx's MemberInfoModal writes to `invitations` itself before
  // calling this) — no real member profile to patch via the secure
  // Netlify boundary below, matching the pre-S5D early return exactly.
  if (id.startsWith("inv-")) return;

  (async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const member = getTeam().find((m) => m.id === id);
      const parts  = (patch.name ?? member?.name ?? "").trim().split(" ");
      // Privileged write stays server-side, unchanged (Part 22) — never
      // moved to a direct client-side profiles/org_memberships write.
      const res = await fetch("/.netlify/functions/update-user-by-id", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          targetUserId: id,
          ...(patch.name       !== undefined ? { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") ?? "" } : {}),
          ...(patch.phone      !== undefined ? { phone: patch.phone || "" } : {}),
          ...(patch.role       !== undefined ? { role: patch.role } : {}),
          ...(patch.workerType !== undefined ? { workerType: patch.workerType } : {}),
        }),
      });
      if (!res.ok) console.error("[org] update-user-by-id failed:", await res.text());
      // Same 500ms settle window the old reloadTeam() call waited out —
      // the Netlify function's write needs a moment before reading it back.
      await new Promise((r) => setTimeout(r, 500));
      void qc().invalidateQueries({ queryKey: ["teamMembers"] });
      // A role change can change this member's EFFECTIVE permissions
      // (role defaults, see permission-features.ts) — nudge their
      // permissions query too, in case their Permissions page is open.
      // Prefix invalidation (no orgId in scope here) — cheap, matches the
      // convention every other store in this codebase uses for this kind
      // of "just in case it's open" nudge.
      if (patch.role !== undefined) void qc().invalidateQueries({ queryKey: ["memberPermissions"] });
    } catch (err) {
      console.error("[org] updateMember failed:", err);
    }
  })();
}

/**
 * S5D.1 correction — removeMember() is now ONLY ever called by
 * team-members-manager.tsx AFTER a real `removeMemberFromOrg()`
 * (src/lib/team.ts -> netlify/functions/remove-member.ts) call has
 * confirmed persistence (org_membership delete + profiles.organization_id
 * cleared + auth user deleted for an active member; invitation row delete
 * + best-effort auth cleanup for a pending/roster row — see the S5D.1
 * report for why the auth-account delete is intentional here, not a
 * bug). Filters the placeholder out of both team caches immediately, then
 * invalidates both plus this member's permission overrides (now moot)
 * so a refetch confirms the removal against server truth.
 */
export function removeMember(id: string) {
  qc().setQueriesData<TeamMember[]>({ queryKey: ["teamMembers"] }, (old) => (Array.isArray(old) ? old.filter((m) => m.id !== id) : old));
  qc().setQueriesData<OrgInvitationRow[]>({ queryKey: ["organizationInvitations"] }, (old) => (Array.isArray(old) ? old.filter((m) => m.id !== id) : old));
  void qc().invalidateQueries({ queryKey: ["teamMembers"] });
  void qc().invalidateQueries({ queryKey: ["organizationInvitations"] });
  void qc().invalidateQueries({ queryKey: ["memberPermissions"] });
}

// ── Member permission overrides ──────────────────────────────────────────
//
// Scoped per (org, member) — the Permissions settings page only ever
// needs the currently-selected member's override rows, never every
// member's at once (Part 8). Role DEFAULTS live in permission-features.ts
// (getRoleDefaultPermission) — unchanged, not duplicated here; this only
// covers the persisted per-member override rows themselves.

export type MemberPermissionOverride = { feature: string; action: string; granted: boolean };

async function fetchMemberPermissions(orgId: string, memberId: string): Promise<MemberPermissionOverride[]> {
  const { data, error } = await supabase.from("member_permissions")
    .select("feature, action, granted")
    .eq("org_id", orgId)
    .eq("member_id", memberId);
  if (error) {
    console.error("[org] fetchMemberPermissions failed:", error);
    throw error;
  }
  return (data ?? []) as MemberPermissionOverride[];
}

export function useMemberPermissions(orgId: string | null | undefined, memberId: string | null | undefined) {
  const enabled = !!orgId && !!memberId;
  return useQuery({
    queryKey: enabled ? queryKeys.memberPermissions(orgId as string, memberId as string) : ["memberPermissions", "_pending"],
    queryFn: () => fetchMemberPermissions(orgId as string, memberId as string),
    enabled,
    staleTime: 30_000,
  });
}

export type SetMemberPermissionResult = { ok: true } | { ok: false; error: string };

export async function setMemberPermissionOverride(
  orgId: string, memberId: string, feature: string, action: string, granted: boolean,
): Promise<SetMemberPermissionResult> {
  const { error } = await supabase.from("member_permissions").upsert(
    { org_id: orgId, member_id: memberId, feature, action, granted, updated_at: new Date().toISOString() },
    { onConflict: "org_id,member_id,feature,action" },
  );
  if (error) { console.error("[org] setMemberPermissionOverride failed:", error); return { ok: false, error: error.message }; }
  void qc().invalidateQueries({ queryKey: queryKeys.memberPermissions(orgId, memberId) });
  return { ok: true };
}

/** Clears a single override, reverting that one feature/action back to the role default. */
export async function clearMemberPermissionOverride(
  orgId: string, memberId: string, feature: string, action: string,
): Promise<SetMemberPermissionResult> {
  const { error } = await supabase.from("member_permissions").delete()
    .eq("org_id", orgId).eq("member_id", memberId).eq("feature", feature).eq("action", action);
  if (error) { console.error("[org] clearMemberPermissionOverride failed:", error); return { ok: false, error: error.message }; }
  void qc().invalidateQueries({ queryKey: queryKeys.memberPermissions(orgId, memberId) });
  return { ok: true };
}

/** Clears every override for a member, reverting them entirely to their role's default permissions. */
export async function resetMemberPermissions(orgId: string, memberId: string): Promise<SetMemberPermissionResult> {
  const { error } = await supabase.from("member_permissions").delete()
    .eq("org_id", orgId).eq("member_id", memberId);
  if (error) { console.error("[org] resetMemberPermissions failed:", error); return { ok: false, error: error.message }; }
  void qc().invalidateQueries({ queryKey: queryKeys.memberPermissions(orgId, memberId) });
  return { ok: true };
}

export function memberInitials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2)
    .map(p => p[0]?.toUpperCase() ?? "").join("") || "?";
}