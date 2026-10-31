/// <reference types="node" />
// netlify/functions/accept-invite.ts
//
// Turns a pending invitation into an account: auth user, profile, org_memberships row, then marks the invitation accepted. These are
// separate requests (not one transaction), so the order matters:
//   - the invitation's role is checked BEFORE any account exists;
//   - a failed profile or membership write is an error, never a silent success, and removes what this request created (membership,
//     profile, auth user) so the invitation stays pending and can be retried;
//   - the profile and membership are read back and must match the invitation's organization and role;
//   - the invitation is marked accepted only after all three exist, and only while it is still pending. If that update fails, the
//     account is removed the same way;
//   - user metadata (names, org_id, role) is written only AFTER all of that. createUser({ email_confirm: true }) inserts the user and
//     then UPDATEs email_confirmed_at, which is exactly when the on_invited_user_confirmed trigger (handle_invited_user) acts on any
//     org_id/role metadata. createUser therefore carries NO metadata; a later metadata update can't re-fire it (already confirmed).
// Concurrent attempts for one invitation create at most one account: the invitation's email is unique in auth, so a second createUser
// fails ("email exists") before that request writes anything. If a removal step itself fails, the response says so generically and the
// server log names the steps and the user id to repair (no token, password, tax numbers or raw database error is logged or returned).
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveAcceptedTaxFields } from "./lib/invitation-lookup";
import { isSupportedMemberRole } from "./lib/member-roles";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const SETUP_FAILED = "We couldn't finish creating your account. Please try again, or contact your administrator.";
const SETUP_FAILED_CONTACT_ADMIN = "We couldn't finish creating your account. Please contact your administrator before trying again.";

const respond = (statusCode: number, payload: Record<string, unknown>) => ({
  statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
});

// Logs only an error code, never the message/details (they can echo row values).
const errorCode = (e: unknown): string =>
  e && typeof e === "object" && "code" in e && (e as { code?: unknown }).code ? String((e as { code: unknown }).code) : "unknown";

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  let body: {
    token: string; password: string;
    firstName: string; lastName: string; phone?: string;
    addressLine1?: string; addressLine2?: string; city?: string; state?: string; postalCode?: string;
    ssn?: string; ein?: string; companyName?: string;
  };
  try { body = JSON.parse(event.body ?? "{}"); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { token, password, firstName, lastName, phone,
    addressLine1, addressLine2, city, state, postalCode,
    ssn, ein, companyName } = body;

  if (!token || !password) return { statusCode: 400, body: JSON.stringify({ error: "token and password required" }) };

  const { data: invitation, error: invErr } = await supabaseAdmin
    .from("invitations").select("*").eq("token", token).eq("status", "pending").maybeSingle();

  if (invErr || !invitation) {
    if (invErr) console.error("[accept-invite] token lookup failed:", errorCode(invErr));
    return { statusCode: 404, body: JSON.stringify({ error: "Invalid or expired invitation" }) };
  }
  if (new Date(invitation.expires_at) < new Date())
    return { statusCode: 410, body: JSON.stringify({ error: "Invitation has expired" }) };

  const { email, organization_id: orgId, role, worker_type: workerType } = invitation;

  // The membership row can only hold a supported role — reject before anything is created.
  if (!isSupportedMemberRole(role)) {
    console.error(`[accept-invite] invitation ${invitation.id} has an unsupported role; nothing created`);
    return respond(422, { error: "This invitation can't be accepted. Please ask your administrator to send a new one." });
  }
  console.log(`[accept-invite] processing: ${email} → org ${orgId} as ${role} (${workerType})`);

  // Create auth user — deliberately WITHOUT user_metadata (see the header: confirmation must not see org_id/role)
  const { data: newUser, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (createErr || !newUser?.user?.id) {
    const code = errorCode(createErr);
    console.error("[accept-invite] createUser failed:", code);
    if (code === "email_exists" || code === "user_already_exists")
      return respond(409, { error: "An account with this email already exists. Please sign in, or contact your administrator." });
    return respond(500, { error: SETUP_FAILED });
  }
  const userId = newUser.user.id;
  console.log(`[accept-invite] created auth user: ${userId}`);

  // Removes what this request created, in reverse order. Every step runs even if an earlier one fails; returns the steps that failed.
  // Each delete is scoped to the user id created above, so it can only touch this request's own rows (a write whose response was lost
  // is removed too).
  const removePartialAccount = async (): Promise<string[]> => {
    const failed: string[] = [];
    const step = async (name: string, run: () => PromiseLike<{ error: unknown }>) => {
      try { const { error } = await run(); if (error) failed.push(name); }
      catch { failed.push(name); }
    };
    await step("org_memberships", () => supabaseAdmin.from("org_memberships").delete().eq("member_id", userId).eq("org_id", orgId));
    await step("profiles", () => supabaseAdmin.from("profiles").delete().eq("id", userId));
    await step("auth_user", () => supabaseAdmin.auth.admin.deleteUser(userId));
    return failed;
  };

  const abort = async (reason: string, statusCode = 500, message = SETUP_FAILED) => {
    const failedSteps = await removePartialAccount();
    if (failedSteps.length) {
      console.error(`[accept-invite] ${reason}; CLEANUP INCOMPLETE — manual repair needed for user ${userId} (invitation ${invitation.id}): ${failedSteps.join(", ")}`);
      return respond(500, { error: SETUP_FAILED_CONTACT_ADMIN });
    }
    console.error(`[accept-invite] ${reason}; partial account removed, invitation ${invitation.id} left pending`);
    return respond(statusCode, { error: message });
  };

  try {
    // The invitee page no longer receives the administrator's full ssn/ein: a blank field keeps what the administrator entered.
    const taxFields = resolveAcceptedTaxFields({ ssn, ein, companyName }, invitation);

    // Upsert full profile
    const { error: profileErr } = await supabaseAdmin.from("profiles").upsert({
      id: userId, email,
      first_name:    firstName,
      last_name:     lastName,
      phone:         phone         || null,
      organization_id: orgId,
      address_line1: addressLine1  || null,
      address_line2: addressLine2  || null,
      city:          city          || null,
      state:         state         || null,
      postal_code:   postalCode    || null,
      worker_type:   workerType    || "employee",
      ssn:           taxFields.ssn,
      ein:           taxFields.ein,
      company_name:  taxFields.company_name,
    }, { onConflict: "id" });
    if (profileErr) return await abort(`profiles upsert failed (${errorCode(profileErr)})`);
    console.log("[accept-invite] profile upserted");

    // Add to org_memberships
    const { error: memberErr } = await supabaseAdmin.from("org_memberships").insert({
      member_id:   userId,
      org_id:      orgId,
      role,
      worker_type: workerType || "employee",
    });
    if (memberErr) return await abort(`org_memberships insert failed (${errorCode(memberErr)})`);
    console.log("[accept-invite] added to org_memberships");

    // Read both back: exactly one membership in the invitation's org with the invitation's role, and a profile in that org
    const { data: memberRows, error: memberReadErr } = await supabaseAdmin.from("org_memberships")
      .select("role").eq("member_id", userId).eq("org_id", orgId);
    if (memberReadErr) return await abort(`org_memberships read-back failed (${errorCode(memberReadErr)})`);
    if (memberRows?.length !== 1 || memberRows[0].role !== role)
      return await abort(`org_memberships read-back mismatch (${memberRows?.length ?? 0} rows)`);
    const { data: profileRow, error: profileReadErr } = await supabaseAdmin.from("profiles")
      .select("organization_id").eq("id", userId).maybeSingle();
    if (profileReadErr) return await abort(`profiles read-back failed (${errorCode(profileReadErr)})`);
    if (profileRow?.organization_id !== orgId) return await abort("profiles read-back mismatch");

    // Mark invitation accepted — only if it is still pending (not revoked or accepted meanwhile)
    const { data: acceptedRows, error: acceptErr } = await supabaseAdmin.from("invitations")
      .update({ status: "accepted", accepted_at: new Date().toISOString() })
      .eq("id", invitation.id)
      .eq("status", "pending")
      .select("id");
    if (acceptErr) return await abort(`invitation status update failed (${errorCode(acceptErr)})`);
    if (acceptedRows?.length !== 1)
      return await abort("invitation was no longer pending", 409, "This invitation is no longer valid. Please contact your administrator.");
  } catch (e) {
    return await abort(`unexpected error (${errorCode(e)})`);
  }

  // Onboarding is complete and committed. Metadata and the E.164 phone are written now, after confirmation, so they can't fire the
  // confirmation trigger. They only feed display (names) and are not used for authorization — the role and organization live in
  // org_memberships/profiles, written above. So a failure here does NOT undo a working account: it is retried once, then logged with
  // the user id for follow-up, and the response still succeeds. Phone is separate so a phone conflict can't block the names.
  const updateAfterOnboarding = async (label: string, attributes: Record<string, unknown>) => {
    let code: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, attributes);
        code = error ? errorCode(error) : null;
      } catch (e) { code = errorCode(e); }
      if (code === null) return;
    }
    console.error(`[accept-invite] account complete, but the ${label} update failed (${code}) for user ${userId}; re-run it for this user`);
  };

  await updateAfterOnboarding("metadata", {
    user_metadata: {
      first_name: firstName, last_name: lastName,
      full_name: `${firstName} ${lastName}`.trim(),
      phone: phone || null, org_id: orgId, role,
      invitation_id: invitation.id,
    },
  });

  // Set phone E.164
  if (phone) {
    const d = phone.replace(/\D/g, "");
    const e164 = d.length === 10 ? `+1${d}` : d.length === 11 && d.startsWith("1") ? `+${d}` : null;
    if (e164) await updateAfterOnboarding("phone", { phone: e164 });
  }

  console.log(`[accept-invite] ✓ complete — ${email} joined org ${orgId} as ${role}`);
  return { statusCode: 200, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ success: true, email }) };
};
