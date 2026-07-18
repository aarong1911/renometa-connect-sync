/// <reference types="node" />
// netlify/functions/portal-data.ts
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

export const handler: Handler = async (event) => {
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  if (event.httpMethod !== "GET") return { statusCode: 405, headers, body: "Method Not Allowed" };

  const token = event.queryStringParameters?.token;
  if (!token) return { statusCode: 400, headers, body: JSON.stringify({ error: "Token required" }) };

  // Validate token → invitation
  const { data: inv, error: invErr } = await supabaseAdmin
    .from("invitations")
    .select("*")
    .eq("token", token)
    .in("status", ["pending", "roster_only", "accepted"])
    .maybeSingle();

  if (invErr || !inv) return { statusCode: 404, headers, body: JSON.stringify({ error: "Invalid or expired token" }) };
  if (inv.role !== "viewer") return { statusCode: 403, headers, body: JSON.stringify({ error: "Access denied" }) };

  const orgId = inv.organization_id;
  const clientEmail = inv.email;

  // Get org info
  const { data: org } = await supabaseAdmin
    .from("organizations")
    .select("name, public_name, phone, logo_url, primary_color, secondary_color")
    .eq("id", orgId)
    .maybeSingle();

  // Find contact by email
  const { data: contact } = await supabaseAdmin
    .from("contacts")
    .select("id, full_name, email, phone")
    .eq("org_id", orgId)
    .eq("email", clientEmail)
    .maybeSingle();

  // Find projects linked to this contact (or via invitation.project_id)
  let projects: any[] = [];
  if (inv.project_id) {
    const { data: p } = await supabaseAdmin
      .from("projects")
      .select("id, name, status, address, start_date, end_date, budget_total, completion_percentage, description")
      .eq("id", inv.project_id)
      .maybeSingle();
    if (p) projects = [p];
  } else if (contact?.id) {
    const { data: ps } = await supabaseAdmin
      .from("projects")
      .select("id, name, status, address, start_date, end_date, budget_total, completion_percentage, description")
      .eq("org_id", orgId)
      .eq("client_id", contact.id)
      .order("created_at", { ascending: false });
    projects = ps ?? [];
  }

  // For each project get estimates, invoices, notes, files
  const projectIds = projects.map((p: any) => p.id);

  const [{ data: estimates }, { data: invoices }, { data: notes }, { data: files }] =
    await Promise.all([
      projectIds.length
        ? supabaseAdmin.from("estimates")
            .select("id, number, title, total, client_total, status, esign_status, created_at, valid_until, pdf_url")
            .in("project_id", projectIds)
            .order("created_at", { ascending: false })
        : { data: [] },
      projectIds.length
        ? supabaseAdmin.from("invoices")
            .select("id, invoice_number, total_amount, amount_paid, status, due_date, issue_date")
            .in("project_id", projectIds)
            .order("due_date", { ascending: true })
        : { data: [] },
      projectIds.length
        ? supabaseAdmin.from("project_notes")
            .select("id, project_id, body, author, is_client_message, client_email, created_at")
            .in("project_id", projectIds)
            .order("created_at", { ascending: true })
        : { data: [] },
      projectIds.length
        ? supabaseAdmin.from("project_files")
            .select("id, project_id, file_name, file_type, mime_type, file_path, description, created_at")
            .in("project_id", projectIds)
            .order("created_at", { ascending: false })
            .limit(20)
        : { data: [] },
    ]);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      client: {
        name: inv.first_name ? `${inv.first_name} ${inv.last_name || ""}`.trim() : contact?.full_name || clientEmail,
        email: clientEmail,
      },
      org: {
        name: org?.public_name || org?.name || "Your Contractor",
        phone: org?.phone || null,
        logo: org?.logo_url || null,
        primaryColor: org?.primary_color || "#3B82F6",
      },
      projects: projects ?? [],
      estimates: estimates ?? [],
      invoices: invoices ?? [],
      notes: notes ?? [],
      files: files ?? [],
    }),
  };
};