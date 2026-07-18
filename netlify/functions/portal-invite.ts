/// <reference types="node" />
// netlify/functions/portal-invite.ts
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const PORTAL_URL = "https://portal.renometa.com";

function makeSlug(name: string): string {
  const base = name.trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 30);
  const rand = Math.random().toString(36).slice(2, 6);
  return base ? `${base}-${rand}` : `client-${rand}`;
}

export const handler: Handler = async (event) => {
  const headers = { "Content-Type": "application/json" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: "Method Not Allowed" };

  const authToken = event.headers.authorization?.slice(7);
  if (!authToken) return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };

  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authToken);
  if (authErr || !user) return { statusCode: 401, headers, body: JSON.stringify({ error: "Invalid token" }) };

  const { data: callerProfile } = await supabaseAdmin
    .from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
  const orgId = callerProfile?.organization_id;
  if (!orgId) return { statusCode: 400, headers, body: JSON.stringify({ error: "No organization found" }) };

  let body: { email: string; name?: string; projectId: string; message?: string };
  try { body = JSON.parse(event.body ?? "{}"); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { email, name, projectId, message } = body;
  if (!email || !projectId) return { statusCode: 400, headers, body: JSON.stringify({ error: "email and projectId required" }) };

  const { data: project } = await supabaseAdmin
    .from("projects").select("id, name, address, status").eq("id", projectId).eq("org_id", orgId).maybeSingle();
  if (!project) return { statusCode: 404, headers, body: JSON.stringify({ error: "Project not found" }) };

  const { data: org } = await supabaseAdmin
    .from("organizations").select("name, phone").eq("id", orgId).maybeSingle();
  const orgName  = org?.name || "your contractor";
  const orgPhone = org?.phone || "";

  const trimmedName = (name ?? "").trim();
  const nameParts   = trimmedName ? trimmedName.split(" ") : [];
  const firstName   = nameParts[0] || null;
  const lastName    = nameParts.slice(1).join(" ") || null;
  const invToken    = crypto.randomUUID();
  const slug        = makeSlug(trimmedName || email.split("@")[0]);

  // Cancel any existing portal invites for this project+email
  await supabaseAdmin.from("invitations")
    .update({ status: "canceled", canceled_at: new Date().toISOString(), canceled_by: user.id })
    .eq("organization_id", orgId).eq("email", email).eq("role", "viewer")
    .eq("project_id", projectId).in("status", ["pending"]);

  const { data: invitation, error: invErr } = await supabaseAdmin
    .from("invitations")
    .insert({
      organization_id: orgId, email, role: "viewer",
      status: "pending", invited_by: user.id,
      token: invToken, portal_slug: slug,
      first_name: firstName, last_name: lastName,
      project_id: projectId,
      expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .select("id").single();

  if (invErr) {
    console.error("[portal-invite] insert failed:", invErr);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Failed to create invitation" }) };
  }

  const portalUrl  = `${PORTAL_URL}/p/${slug}`;
  const greeting   = trimmedName || "there";
  const customNote = message?.trim()
    ? `<p style="background:#f0f4ff;border-left:3px solid #3b82f6;padding:12px 16px;border-radius:0 8px 8px 0;font-style:italic;color:#374151;">${message.trim()}</p>`
    : "";

  const emailHtml = `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#111">
<div style="background:#3b82f6;padding:24px 32px;border-radius:12px 12px 0 0">
  <h1 style="color:white;margin:0;font-size:22px;font-weight:700">${orgName}</h1>
  <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;font-size:14px">Client Project Portal</p>
</div>
<div style="border:1px solid #e5e7eb;border-top:none;padding:32px;border-radius:0 0 12px 12px">
  <h2 style="margin:0 0 8px;font-size:18px">Hi ${greeting},</h2>
  <p style="color:#6b7280;margin:0 0 20px;">Your project portal is ready. Track progress, review estimates, check invoices, and message us directly.</p>
  ${customNote}
  <div style="background:#f8f9fa;border-radius:8px;padding:16px;margin:20px 0">
    <p style="margin:0 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#9ca3af;font-weight:600">Project</p>
    <p style="margin:0;font-size:16px;font-weight:700;color:#111">${project.name}</p>
    ${project.address ? `<p style="margin:4px 0 0;font-size:13px;color:#6b7280">${project.address}</p>` : ""}
  </div>
  <p style="margin:24px 0">
    <a href="${portalUrl}" style="display:inline-block;background:#3b82f6;color:white;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;">
      View Your Project Portal
    </a>
  </p>
  <p style="font-size:13px;color:#9ca3af;margin:0">No account or password needed. Bookmark this link for easy access.</p>
  ${orgPhone ? `<p style="font-size:13px;color:#9ca3af;margin:8px 0 0">Questions? Call us: <a href="tel:${orgPhone}" style="color:#3b82f6">${orgPhone}</a></p>` : ""}
  <p style="font-size:11px;color:#d1d5db;margin:16px 0 0">Your portal link: ${portalUrl}</p>
</div>
</div>`;

  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com", port: 587, secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    });
    await transporter.sendMail({
      from: `"${orgName}" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `Your project portal — ${project.name}`,
      html: emailHtml,
    });
    console.log(`[portal-invite] sent to ${email}, slug: ${slug}`);
  } catch (mailErr) {
    console.error("[portal-invite] email failed:", mailErr);
    return {
      statusCode: 207, headers,
      body: JSON.stringify({
        success: false, invitationId: invitation.id,
        error: `Invitation saved but email failed: ${(mailErr as Error).message}`,
      }),
    };
  }

  return {
    statusCode: 200, headers,
    body: JSON.stringify({ success: true, invitationId: invitation.id, portalUrl, slug }),
  };
};
