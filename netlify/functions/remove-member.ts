/// <reference types="node" />
// netlify/functions/remove-member.ts
//
// Owner removes a member, or cancels a team invitation, in their own organization. Service-role writes, so:
//   - the caller must be the owner of their organization (lib/member-authorization.ts, fail-closed);
//   - the invitation / membership must belong to that organization (otherwise 404, the same as "doesn't exist");
//   - an owner is never removed here;
//   - an Auth account (and profile) is deleted only when it belongs to nobody else: for a member, only when this organization
//     was their only membership; for a cancelled roster invitation, only this organization's own disposable roster placeholder.
//     It is never looked up by email and deleted blindly (an accepted invitee or another organization's user keeps their account);
//   - every database error returns an error, never { ok: true }.
// Reviewed against f1632db (never merged): keeps its owner check and org-scoped lookups, drops its delete-by-email cleanup and its
// unconditional auth-account deletion.
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { errorCode, isOrgRosterPlaceholder, membershipsOf, removeRosterPlaceholder, requireOrgOwner, respond } from "./lib/member-authorization";

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return respond(405, { error: "Method Not Allowed" });

  const caller = await requireOrgOwner(admin, event.headers.authorization);
  if (!caller.ok) return respond(caller.statusCode, { error: caller.error });
  const { orgId } = caller;

  let reqBody: { memberId?: unknown; invitationId?: unknown };
  try { reqBody = JSON.parse(event.body ?? "{}") ?? {}; }
  catch { return respond(400, { error: "Invalid JSON" }); }
  const memberId = typeof reqBody.memberId === "string" && reqBody.memberId ? reqBody.memberId : undefined;
  const invitationId = typeof reqBody.invitationId === "string" && reqBody.invitationId ? reqBody.invitationId : undefined;

  // ── Cancel an invitation ──────────────────────────────────────────────────
  if (invitationId) {
    const { data: inv, error: invErr } = await admin
      .from("invitations").select("id, email, status")
      .eq("id", invitationId).eq("organization_id", orgId).maybeSingle();
    if (invErr) return respond(500, { error: "Could not load the invitation." });
    if (!inv) return respond(404, { error: "Invitation not found." });

    // A roster-only invitation has a placeholder account; find it BEFORE deleting anything, and only if it is provably this
    // organization's own disposable placeholder.
    let placeholderId: string | null = null;
    if (inv.status === "roster_only" && inv.email) {
      const { data: rows, error: lookupErr } = await admin.rpc("get_user_id_by_email", { user_email: inv.email });
      if (lookupErr) return respond(500, { error: "Could not cancel the invitation." });
      const userId: string | undefined = rows?.[0]?.id;
      if (userId && await isOrgRosterPlaceholder(admin, orgId, userId, inv.email)) placeholderId = userId;
      else if (userId) console.warn(`[remove-member] invitation ${inv.id}: account ${userId} is not this organization's roster placeholder; left untouched`);
    }

    const { error: deleteInvErr } = await admin.from("invitations").delete().eq("id", inv.id).eq("organization_id", orgId);
    if (deleteInvErr) {
      console.error(`[remove-member] invitation delete failed (${errorCode(deleteInvErr)})`);
      return respond(500, { error: "Could not cancel the invitation." });
    }

    if (placeholderId) {
      const failed = await removeRosterPlaceholder(admin, orgId, placeholderId);
      if (failed.length) {
        console.error(`[remove-member] invitation ${inv.id} cancelled; CLEANUP INCOMPLETE for placeholder ${placeholderId}: ${failed.join(", ")}`);
        return respond(500, { error: "The invitation was cancelled, but its roster entry could not be fully removed. Please try again or contact support." });
      }
    }
    return respond(200, { ok: true });
  }

  // ── Remove an active member ───────────────────────────────────────────────
  if (memberId) {
    const memberships = await membershipsOf(admin, memberId);
    if (!memberships) return respond(500, { error: "Could not load this member." });
    const membership = memberships.find((m) => m.org_id === orgId);
    if (!membership) return respond(404, { error: "Member not found in this organization." });
    if (membership.role === "owner") return respond(403, { error: "Cannot remove the owner." });
    const belongsElsewhere = memberships.some((m) => m.org_id !== orgId);

    const { data: profile, error: profileErr } = await admin.from("profiles").select("organization_id").eq("id", memberId).maybeSingle();
    if (profileErr) return respond(500, { error: "Could not load this member." });
    const profileInOtherOrg = !!profile?.organization_id && profile.organization_id !== orgId;

    const { data: removed, error: deleteErr } = await admin
      .from("org_memberships").delete().eq("member_id", memberId).eq("org_id", orgId).select("member_id");
    if (deleteErr || removed?.length !== 1) {
      console.error(`[remove-member] membership delete failed (${deleteErr ? errorCode(deleteErr) : `${removed?.length ?? 0} rows`}) for ${memberId}`);
      return respond(500, { error: "Could not remove this member." });
    }

    // Detach the profile only from THIS organization.
    if (profile?.organization_id === orgId) {
      const { error: detachErr } = await admin.from("profiles").update({ organization_id: null })
        .eq("id", memberId).eq("organization_id", orgId);
      if (detachErr) {
        console.error(`[remove-member] member ${memberId} removed from org ${orgId}; profile detach failed (${errorCode(detachErr)})`);
        return respond(500, { error: "The member was removed, but their profile could not be updated. Please contact support." });
      }
    }

    // Delete the login only when this organization was their only one.
    if (belongsElsewhere || profileInOtherOrg) {
      console.log(`[remove-member] ${memberId} removed from org ${orgId}; account kept (belongs to another organization)`);
      return respond(200, { ok: true });
    }
    let code: string | null;
    try { const { error } = await admin.auth.admin.deleteUser(memberId); code = error ? errorCode(error) : null; }
    catch (e) { code = errorCode(e); }
    if (code !== null) {
      console.error(`[remove-member] member ${memberId} removed from org ${orgId}; auth delete failed (${code})`);
      return respond(500, { error: "The member was removed, but their login could not be deleted. Please contact support." });
    }
    return respond(200, { ok: true });
  }

  return respond(400, { error: "memberId or invitationId required" });
};
