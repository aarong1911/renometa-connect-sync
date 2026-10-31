/// <reference types="node" />
// netlify/functions/invite-member.ts
//
// Owner invites a team member (email invitation) or adds a roster-only member (placeholder account + profile + membership, no
// email). Service-role writes, so before anything is written:
//   - the caller must be the owner of their organization (lib/member-authorization.ts, fail-closed); the organization is never
//     taken from the request;
//   - the role must be a supported role and never 'owner'; email and worker type are validated;
//   - roster-only: an existing account with that email is removed ONLY if it is provably this organization's own disposable roster
//     placeholder; any other existing account stops the request (409) untouched.
// Roster-only writes that fail return an error and remove what this request created (invitation, placeholder, profile,
// membership) — never a success. User-controlled values are HTML-escaped in the email.
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";
import { errorCode, escapeHtml, isOrgRosterPlaceholder, removeRosterPlaceholder, requireOrgOwner, respond } from "./lib/member-authorization";
import { isSupportedMemberRole } from "./lib/member-roles";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const FIELD_APP_URL  = "https://field.renometa.com";
const PORTAL_APP_URL = "https://portal.renometa.com";
const CONNECT_URL    = "https://connect.renometa.com";

function getInviteUrl(role: string, isOffline: boolean, token: string): string {
  if (role === "field_worker" && isOffline) return `${FIELD_APP_URL}/welcome?token=${token}`;
  if (role === "viewer")                    return `${PORTAL_APP_URL}/portal?token=${token}`;
  return `${CONNECT_URL}/auth/callback?token=${token}`;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const caller = await requireOrgOwner(supabaseAdmin, event.headers.authorization);
  if (!caller.ok) return respond(caller.statusCode, { error: caller.error });
  const { orgId, userId: callerId } = caller;

  let body: {
    email: string; role: string; name?: string; phone?: string;
    workerType?: string; isOffline?: boolean; rosterOnly?: boolean;
    addressLine1?: string; addressLine2?: string; city?: string;
    state?: string; postalCode?: string;
    ssn?: string; ein?: string; companyName?: string;
  };
  try { body = JSON.parse(event.body ?? "{}"); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const {
    email, role, name, phone,
    workerType  = "employee",
    isOffline   = false,
    rosterOnly  = false,
    addressLine1, addressLine2, city, state, postalCode,
    ssn, ein, companyName,
  } = body;

  if (!email || !role) return { statusCode: 400, body: JSON.stringify({ error: "email and role required" }) };
  for (const [key, value] of Object.entries({ email, role, name, phone, workerType, addressLine1, addressLine2, city, state, postalCode, ssn, ein, companyName }))
    if (value !== undefined && value !== null && typeof value !== "string") return respond(400, { error: `${key} must be text` });
  if (typeof isOffline !== "boolean" || typeof rosterOnly !== "boolean") return respond(400, { error: "isOffline and rosterOnly must be true or false" });
  if (email.length > 254 || !/^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[^\s@<>()",;:\\]+$/.test(email)) return respond(422, { error: "Invalid email address" });
  if (!isSupportedMemberRole(role)) return respond(422, { error: "Unsupported role" });
  if (role === "owner") return respond(403, { error: "Owner invitations can't be created here." });
  if (workerType !== "employee" && workerType !== "subcontractor") return respond(422, { error: "Unsupported worker type" });

  // Roster-only: an account with this email may already exist. Only this organization's own disposable placeholder (a previous
  // roster entry) may be replaced; anything else is left untouched and the request stops before writing anything.
  if (rosterOnly) {
    const { data: rows, error: lookupErr } = await supabaseAdmin.rpc("get_user_id_by_email", { user_email: email });
    if (lookupErr) return respond(500, { error: "Could not check for an existing account." });
    const existingId: string | undefined = rows?.[0]?.id;
    if (existingId) {
      if (!(await isOrgRosterPlaceholder(supabaseAdmin, orgId, existingId, email)))
        return respond(409, { error: "An account with this email already exists." });
      const failed = await removeRosterPlaceholder(supabaseAdmin, orgId, existingId);
      if (failed.length) {
        console.error(`[invite-member] previous roster placeholder ${existingId} could not be removed: ${failed.join(", ")}`);
        return respond(500, { error: "Could not replace the existing roster entry. Please try again." });
      }
      console.log("[invite-member] replaced this organization's previous roster placeholder");
    }
  }

  const { data: org } = await supabaseAdmin
    .from("organizations").select("name, phone").eq("id", orgId).maybeSingle();
  const orgName  = org?.name  || "your team";
  const orgPhone = org?.phone || "";

  const trimmedName = (name ?? "").trim();
  const nameParts   = trimmedName ? trimmedName.split(" ") : [];
  const firstName   = nameParts[0]                 || null;
  const lastName    = nameParts.slice(1).join(" ") || null;
  const fullName    = trimmedName                  || null;
  const invToken    = crypto.randomUUID();

  // ── Save invitation ────────────────────────────────────────────────────────
  const { data: invitation, error: invErr } = await supabaseAdmin
    .from("invitations")
    .insert({
      organization_id: orgId,
      email,
      role,
      status:        rosterOnly ? "roster_only" : "pending",
      invited_by:    callerId,
      token:         invToken,
      expires_at:    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      first_name:    firstName,
      last_name:     lastName,
      primary_phone: phone        || null,
      worker_type:   workerType,
      address_line1: addressLine1 || null,
      address_line2: addressLine2 || null,
      city:          city         || null,
      state:         state        || null,
      postal_code:   postalCode   || null,
      ssn:           ssn          || null,
      ein:           ein          || null,
      company_name:  companyName  || null,
    })
    .select("id")
    .single();

  if (invErr || !invitation) {
    console.error(`[invite-member] invitation insert failed (${errorCode(invErr)})`);
    return { statusCode: 500, body: JSON.stringify({ error: "Failed to create invitation" }) };
  }

  // ── Roster-only: placeholder auth user + profile + org_memberships ────────
  if (rosterOnly) {
    console.log(`[invite-member] roster-only invitation ${invitation.id}`);

    // Any failure removes everything this request created and returns an error. The removals are scoped to the new invitation
    // id and the placeholder id created here, so nothing else can be touched.
    const fail = async (reason: string, rosterId: string | null) => {
      const failed: string[] = [];
      if (rosterId) failed.push(...await removeRosterPlaceholder(supabaseAdmin, orgId, rosterId));
      try {
        const { error } = await supabaseAdmin.from("invitations").delete().eq("id", invitation.id).eq("organization_id", orgId);
        if (error) failed.push("invitations");
      } catch { failed.push("invitations"); }
      if (failed.length) {
        console.error(`[invite-member] ${reason}; CLEANUP INCOMPLETE — invitation ${invitation.id}, placeholder ${rosterId ?? "none"}: ${failed.join(", ")}`);
        return respond(500, { error: "Couldn't add this roster member, and a partial entry may remain. Please contact support before retrying." });
      }
      console.error(`[invite-member] ${reason}; nothing kept`);
      return respond(500, { error: "Couldn't add this roster member. Please try again." });
    };

    // email_confirm: false avoids the UPDATE trigger that fires on confirmed users
    let ghostUser: { user: { id: string } | null } | null = null;
    let ghostErr: unknown = null;
    try {
      ({ data: ghostUser, error: ghostErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      email_confirm: false,
      user_metadata: {
        first_name:  firstName,
        last_name:   lastName,
        full_name:   fullName,
        phone:       phone || null,
        org_id:      orgId,
        role,
        roster_only: true,
      },
      }));
    } catch (e) { ghostErr = e; }
    const rosterId = ghostUser?.user?.id;
    if (ghostErr || !rosterId) return await fail(`placeholder user failed (${errorCode(ghostErr)})`, null);
    console.log(`[invite-member] placeholder user created: ${rosterId}`);

    const { error: pe } = await supabaseAdmin.from("profiles").upsert({
      id:              rosterId,
      email,
      first_name:      firstName,
      last_name:       lastName,
      phone:           phone         || null,
      organization_id: orgId,
      address_line1:   addressLine1  || null,
      address_line2:   addressLine2  || null,
      city:            city          || null,
      state:           state         || null,
      postal_code:     postalCode    || null,
      worker_type:     workerType,
      ssn:             ssn           || null,
      ein:             ein           || null,
      company_name:    companyName   || null,
    }, { onConflict: "id" });
    if (pe) return await fail(`profile upsert failed (${errorCode(pe)})`, rosterId);
    console.log("[invite-member] profile created");

    const { error: me } = await supabaseAdmin.from("org_memberships").insert({
      member_id:   rosterId,
      org_id:      orgId,
      role,
      worker_type: workerType,
      name:        fullName,
    });
    if (me) return await fail(`org_memberships insert failed (${errorCode(me)})`, rosterId);
    console.log("[invite-member] added to org_memberships");

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: true, invitationId: invitation.id, rosterOnly: true }),
    };
  }

  // ── Standard invite: send email ────────────────────────────────────────────
  const inviteUrl = getInviteUrl(role, isOffline, invToken);
  // Every value below that a user or administrator typed is HTML-escaped; the subject is plain text without line breaks.
  const htmlOrg    = escapeHtml(orgName);
  const htmlPhone  = escapeHtml(orgPhone);
  const subjectOrg = orgName.replace(/[\r\n]+/g, " ");
  const greeting   = fullName ? ` ${escapeHtml(fullName)}` : "";

  let emailHtml: string;
  let subject: string;

  if (role === "field_worker" && isOffline) {
    subject   = `You've been added to the ${subjectOrg} team`;
    emailHtml = `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
<h2 style="color:#111">You've been added to the ${htmlOrg} team!</h2>
<p>Hi${greeting},</p>
<p>You have been added to the <strong>${htmlOrg}</strong> roster as <strong>Field Crew / Technician</strong>.</p>
<p style="margin:28px 0"><a href="${inviteUrl}" style="background:#F59E0B;color:white;padding:13px 28px;border-radius:7px;text-decoration:none;display:inline-block;font-weight:600;font-size:15px;">View Your Team Profile</a></p>
${orgPhone ? `<p><a href="tel:${htmlPhone}" style="color:#3b82f6">Call the office: ${htmlPhone}</a></p>` : ""}
<p style="color:#6b7280;font-size:13px;">No account or password needed.</p>
</div>`;
  } else if (role === "viewer") {
    subject   = `Your project portal from ${subjectOrg}`;
    emailHtml = `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
<h2 style="color:#111">Your project portal is ready</h2>
<p>Hi${greeting},</p>
<p><strong>${htmlOrg}</strong> has set up a project portal for you.</p>
<p style="margin:28px 0"><a href="${inviteUrl}" style="background:#3b82f6;color:white;padding:13px 28px;border-radius:7px;text-decoration:none;display:inline-block;font-weight:600;font-size:15px;">View Your Project Portal</a></p>
<p style="color:#6b7280;font-size:13px;">No account or password needed.</p>
</div>`;
  } else {
    subject   = `You've been invited to join ${subjectOrg} on RenoMeta Connect`;
    emailHtml = `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
<h2 style="color:#111">You've been invited!</h2>
<p>Hi${greeting},</p>
<p>You've been invited to join <strong>${htmlOrg}</strong> as <strong>${escapeHtml(role.replace(/_/g, " "))}</strong> on RenoMeta Connect.</p>
<p style="margin:28px 0"><a href="${inviteUrl}" style="background:#3b82f6;color:white;padding:13px 28px;border-radius:7px;text-decoration:none;display:inline-block;font-weight:600;font-size:15px;">Accept Invitation &amp; Set Password</a></p>
<p style="color:#6b7280;font-size:13px;">This link expires in 7 days.</p>
</div>`;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    });
    await transporter.sendMail({
      from: `"RenoMeta Connect" <${process.env.SMTP_USER}>`,
      to: email,
      subject,
      html: emailHtml,
    });
    console.log(`[invite-member] email sent to ${email} (${role}, offline=${isOffline})`);
  } catch (mailErr) {
    console.error("[invite-member] email failed:", mailErr);
    return {
      statusCode: 207,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: false,
        invitationId: invitation.id,
        error: `Invitation saved but email failed: ${(mailErr as Error).message}`,
      }),
    };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ success: true, invitationId: invitation.id }),
  };
};