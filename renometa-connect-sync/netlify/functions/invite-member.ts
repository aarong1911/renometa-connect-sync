/// <reference types="node" />
// netlify/functions/invite-member.ts
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";

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

  const authToken = event.headers.authorization?.slice(7);
  if (!authToken) return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };

  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authToken);
  if (authErr || !user) return { statusCode: 401, body: JSON.stringify({ error: "Invalid token" }) };

  const { data: callerProfile } = await supabaseAdmin
    .from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
  const orgId = callerProfile?.organization_id;
  if (!orgId) return { statusCode: 400, body: JSON.stringify({ error: "No organization found" }) };

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
      invited_by:    user.id,
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

  if (invErr) {
    console.error("[invite-member] invitation insert failed:", invErr);
    return { statusCode: 500, body: JSON.stringify({ error: "Failed to create invitation" }) };
  }

  // ── Roster-only: ghost auth user + profile + org_memberships ──────────────
  if (rosterOnly) {
    console.log(`[invite-member] roster-only: ${email}`);

    // Clean up any existing unconfirmed user with this email
    try {
      const { data: rows } = await supabaseAdmin.rpc("get_user_id_by_email", { user_email: email });
      const existingId = rows?.[0]?.id;
      if (existingId) {
        const { data: eu } = await supabaseAdmin.auth.admin.getUserById(existingId);
        if (eu?.user && !eu.user.email_confirmed_at) {
          await supabaseAdmin.auth.admin.deleteUser(existingId);
          console.log("[invite-member] cleaned up existing unconfirmed user");
        }
      }
    } catch (e) { console.warn("[invite-member] cleanup check failed:", e); }

    // email_confirm: false avoids the UPDATE trigger that fires on confirmed users
    const { data: ghostUser, error: ghostErr } = await supabaseAdmin.auth.admin.createUser({
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
    });

    if (ghostErr) {
      console.error("[invite-member] ghost user failed:", ghostErr.message);
      // Non-fatal — member still shows via invitations table
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ success: true, invitationId: invitation.id, rosterOnly: true }),
      };
    }

    const rosterId = ghostUser.user.id;
    console.log(`[invite-member] ghost user created: ${rosterId}`);

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
    if (pe) console.error("[invite-member] profile failed:", pe.message);
    else    console.log("[invite-member] profile created");

    const { error: me } = await supabaseAdmin.from("org_memberships").insert({
      member_id:   rosterId,
      org_id:      orgId,
      role,
      worker_type: workerType,
      name:        fullName,
    });
    if (me) console.error("[invite-member] org_memberships failed:", me.message);
    else    console.log("[invite-member] added to org_memberships");

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: true, invitationId: invitation.id, rosterOnly: true }),
    };
  }

  // ── Standard invite: send email ────────────────────────────────────────────
  const inviteUrl = getInviteUrl(role, isOffline, invToken);
  const greeting  = fullName ? ` ${fullName}` : "";

  let emailHtml: string;
  let subject: string;

  if (role === "field_worker" && isOffline) {
    subject   = `You've been added to the ${orgName} team`;
    emailHtml = `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
<h2 style="color:#111">You've been added to the ${orgName} team!</h2>
<p>Hi${greeting},</p>
<p>You have been added to the <strong>${orgName}</strong> roster as <strong>Field Crew / Technician</strong>.</p>
<p style="margin:28px 0"><a href="${inviteUrl}" style="background:#F59E0B;color:white;padding:13px 28px;border-radius:7px;text-decoration:none;display:inline-block;font-weight:600;font-size:15px;">View Your Team Profile</a></p>
${orgPhone ? `<p><a href="tel:${orgPhone}" style="color:#3b82f6">Call the office: ${orgPhone}</a></p>` : ""}
<p style="color:#6b7280;font-size:13px;">No account or password needed.</p>
</div>`;
  } else if (role === "viewer") {
    subject   = `Your project portal from ${orgName}`;
    emailHtml = `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
<h2 style="color:#111">Your project portal is ready</h2>
<p>Hi${greeting},</p>
<p><strong>${orgName}</strong> has set up a project portal for you.</p>
<p style="margin:28px 0"><a href="${inviteUrl}" style="background:#3b82f6;color:white;padding:13px 28px;border-radius:7px;text-decoration:none;display:inline-block;font-weight:600;font-size:15px;">View Your Project Portal</a></p>
<p style="color:#6b7280;font-size:13px;">No account or password needed.</p>
</div>`;
  } else {
    subject   = `You've been invited to join ${orgName} on RenoMeta Connect`;
    emailHtml = `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
<h2 style="color:#111">You've been invited!</h2>
<p>Hi${greeting},</p>
<p>You've been invited to join <strong>${orgName}</strong> as <strong>${role.replace(/_/g, " ")}</strong> on RenoMeta Connect.</p>
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