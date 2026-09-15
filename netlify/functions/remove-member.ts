/// <reference types="node" />
// netlify/functions/remove-member.ts
//
// Authorization cleanup pass. This endpoint used to resolve only the
// CALLER's own org (via profiles.organization_id) and never checked the
// caller's own role at all — any authenticated org member could remove
// another member or cancel an invitation, the only protection being that
// the TARGET could not be the owner. Team management
// (team-members-manager.tsx, reached via settings.team.tsx) is only
// reachable at all by the `owner` role — src/lib/permissions.ts's
// ROLE_ALLOWED_ROUTES has no "/settings" prefix for any role but `owner`,
// and canAccessSettings() is `role === "owner"` only. Admin never sees
// this page today, so this endpoint now matches that real, already-shipped
// intent: owner-only, not "owner or admin".
//
// A second, independent bug is fixed here too: when `memberId` did not
// belong to the caller's org, the org_memberships lookup below correctly
// returned null, but the OLD code still fell through and ran
// `profiles.update({ organization_id: null })` and
// `auth.admin.deleteUser(memberId)` with NO org filter on either —
// letting a caller delete an arbitrary user's auth account cross-tenant
// just by supplying their id. This now returns 404 before touching
// anything if the target isn't a member of the caller's own org.
//
// Uses the canonical resolveOrgAndAuthority() from lib/resolve-org.ts for
// org/role resolution — never a client-supplied org id or role.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgAndAuthority } from "./lib/resolve-org";

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };

  const token = event.headers.authorization?.slice(7);
  if (!token) return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };

  const { data: { user: caller } } = await admin.auth.getUser(token);
  if (!caller) return { statusCode: 401, body: JSON.stringify({ error: "Invalid token" }) };

  const { orgId, role } = await resolveOrgAndAuthority(admin, caller.id);
  if (!orgId) return { statusCode: 403, body: JSON.stringify({ error: "No organization was found for this user." }) };
  if (role !== "owner") {
    return { statusCode: 403, body: JSON.stringify({ error: "Only an organization owner may remove members or cancel invitations." }) };
  }

  let reqBody: { memberId?: unknown; invitationId?: unknown };
  try {
    reqBody = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body." }) };
  }
  const memberId = typeof reqBody.memberId === "string" ? reqBody.memberId : undefined;
  const invitationId = typeof reqBody.invitationId === "string" ? reqBody.invitationId : undefined;

  // ── Remove a pending invitation ───────────────────────────────────────────
  if (invitationId) {
    const { data: inv } = await admin
      .from("invitations").select("*")
      .eq("id", invitationId).eq("organization_id", orgId).maybeSingle();

    // Scoped to the caller's own org — an invitation belonging to another
    // org is reported identically to one that doesn't exist at all, never
    // distinguished (no cross-tenant existence leak).
    if (!inv) return { statusCode: 404, body: JSON.stringify({ error: "Invitation not found." }) };

    const { error: deleteInvErr } = await admin.from("invitations").delete().eq("id", invitationId);
    if (deleteInvErr) {
      console.error("[remove-member] invitation delete failed:", deleteInvErr);
      return { statusCode: 500, body: JSON.stringify({ error: "Could not cancel invitation." }) };
    }

    // Best-effort cleanup of a pre-created (not-yet-accepted) auth user for
    // this specific invitation's email — never fails the request if this
    // step doesn't find or can't delete one.
    if (inv.email) {
      const { data: rows } = await admin.rpc("get_user_id_by_email", { user_email: inv.email });
      const userId = rows?.[0]?.id;
      if (userId) {
        const { error: delErr } = await admin.auth.admin.deleteUser(userId);
        if (delErr) console.error("[remove-member] auth delete failed for invitation cleanup:", delErr);
      }
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  // ── Remove an active member ───────────────────────────────────────────────
  if (memberId) {
    const { data: membership } = await admin
      .from("org_memberships").select("role")
      .eq("member_id", memberId).eq("org_id", orgId).maybeSingle();

    // Target must actually belong to the caller's own org — this is the
    // fix for the cross-tenant deletion bug described above. Reported the
    // same way as any other missing member, no cross-tenant existence leak.
    if (!membership) return { statusCode: 404, body: JSON.stringify({ error: "Member not found in this organization." }) };

    if (membership.role === "owner") {
      return { statusCode: 403, body: JSON.stringify({ error: "Cannot remove the owner." }) };
    }

    const { error: deleteMembershipErr } = await admin
      .from("org_memberships").delete().eq("member_id", memberId).eq("org_id", orgId);
    if (deleteMembershipErr) {
      console.error("[remove-member] membership delete failed:", deleteMembershipErr);
      return { statusCode: 500, body: JSON.stringify({ error: "Could not remove member." }) };
    }

    const { error: profileErr } = await admin
      .from("profiles").update({ organization_id: null }).eq("id", memberId);
    if (profileErr) console.error("[remove-member] profile detach failed:", profileErr);

    // They no longer have an org — delete their auth account. Only ever
    // reached after the org-scoped membership row was confirmed to exist
    // and was successfully removed above.
    const { error: delErr } = await admin.auth.admin.deleteUser(memberId);
    if (delErr) console.error("[remove-member] auth delete failed for removed member:", delErr);

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 400, body: JSON.stringify({ error: "memberId or invitationId required." }) };
};
