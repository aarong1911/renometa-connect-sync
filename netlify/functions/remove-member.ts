/// <reference types="node" />
// netlify/functions/remove-member.ts
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "" };

  const token = event.headers.authorization?.slice(7);
  if (!token) return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };

  const { data: { user: caller } } = await admin.auth.getUser(token);
  if (!caller) return { statusCode: 401, body: JSON.stringify({ error: "Invalid token" }) };

  const { data: callerProfile } = await admin
    .from("profiles").select("organization_id").eq("id", caller.id).maybeSingle();
  const orgId = callerProfile?.organization_id;
  if (!orgId) return { statusCode: 403, body: JSON.stringify({ error: "No org found" }) };

  const { memberId, invitationId } = JSON.parse(event.body ?? "{}");

  // ── Remove a pending invitation ───────────────────────────────────────────
  if (invitationId) {
    const { data: inv } = await admin
      .from("invitations").select("*")
      .eq("id", invitationId).eq("organization_id", orgId).maybeSingle();

    if (!inv) return { statusCode: 404, body: JSON.stringify({ error: "Invitation not found" }) };

    // Delete invitation row first
    await admin.from("invitations").delete().eq("id", invitationId);

    // Find auth user by email using auth.users table directly
    if (inv.email) {
      // Query auth.users directly — more reliable than listUsers pagination
      const { data: authUser } = await admin
        .from("auth.users")
        .select("id")
        .eq("email", inv.email)
        .maybeSingle();

      // auth schema not accessible via .from() — use rpc instead
      const { data: rows } = await admin.rpc("get_user_id_by_email", { user_email: inv.email });
      const userId = rows?.[0]?.id;

      if (userId) {
        const { error: delErr } = await admin.auth.admin.deleteUser(userId);
        if (delErr) console.error(`[remove-member] auth delete failed:`, delErr);
        else console.log(`[remove-member] deleted auth user ${userId} (${inv.email})`);
      } else {
        console.log(`[remove-member] no auth user found for ${inv.email}`);
      }
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  // ── Remove an active member ───────────────────────────────────────────────
  if (memberId) {
    const { data: membership } = await admin
      .from("org_memberships").select("role")
      .eq("member_id", memberId).eq("org_id", orgId).maybeSingle();

    if (membership?.role === "owner") {
      return { statusCode: 403, body: JSON.stringify({ error: "Cannot remove the owner" }) };
    }

    // Remove from org
    await admin.from("org_memberships").delete().eq("member_id", memberId).eq("org_id", orgId);
    await admin.from("profiles").update({ organization_id: null }).eq("id", memberId);

    // Delete from Auth — they no longer have an org
    const { error: delErr } = await admin.auth.admin.deleteUser(memberId);
    if (delErr) console.error(`[remove-member] auth delete failed for ${memberId}:`, delErr);
    else console.log(`[remove-member] deleted auth user ${memberId}`);

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 400, body: JSON.stringify({ error: "memberId or invitationId required" }) };
};