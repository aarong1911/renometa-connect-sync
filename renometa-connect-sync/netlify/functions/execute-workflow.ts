/// <reference types="node" />
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ── Handler ───────────────────────────────────────────────────────────────────

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: HEADERS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: HEADERS, body: "Method Not Allowed" };

  let reqBody: {
    triggerType?: string;
    triggerData?: Record<string, any>;
    contactId?: string;
    orgId?: string;     // for internal (server-side) calls
    workflowId?: string; // run a specific workflow
  };

  try { reqBody = JSON.parse(event.body ?? "{}"); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  // ── Auth: accept Bearer token (client) or service-key header (internal) ──
  let orgId: string | null = reqBody.orgId ?? null;

  if (!orgId) {
    const authToken = event.headers.authorization?.slice(7);
    if (!authToken) return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: "Unauthorized" }) };

    const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authToken);
    if (authErr || !user) return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: "Invalid token" }) };

    const { data: profile } = await supabaseAdmin.from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
    orgId = profile?.organization_id ?? null;
    if (!orgId) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "No org found" }) };
  }

  const { triggerType, triggerData = {}, contactId, workflowId } = reqBody;

  // ── Load matching active workflows ────────────────────────────────────────
  let query = supabaseAdmin
    .from("workflows")
    .select("id, name, nodes, edges")
    .eq("org_id", orgId)
    .eq("status", "active");

  if (workflowId) {
    query = query.eq("id", workflowId);
  } else if (triggerType) {
    // Match trigger_event OR trigger_type column
    query = query.or(`trigger_event.eq.${triggerType},trigger_type.eq.${triggerType}`);
  } else {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "triggerType or workflowId required" }) };
  }

  const { data: wfRows, error: wfErr } = await query;
  if (wfErr) return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: wfErr.message }) };

  if (!wfRows || wfRows.length === 0) {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ message: "No active workflows matched", triggered: 0 }) };
  }

  // ── Load org data (for {org.name} token interpolation) ───────────────────
  const { data: orgRow } = await supabaseAdmin
    .from("organizations").select("id, name, phone, website").eq("id", orgId).maybeSingle();

  // ── Load contact data if contactId provided ───────────────────────────────
  let contactData: Record<string, any> = {};
  if (contactId) {
    const { data: contact } = await supabaseAdmin.from("contacts").select("*").eq("id", contactId).maybeSingle();
    if (contact) contactData = contact;
  }

  // ── Execute each matching workflow ────────────────────────────────────────
  const results: any[] = [];
  for (const wfRow of wfRows) {
    const runId = await startRun(wfRow.id, orgId, contactData);
    try {
      const r = await executeWorkflow(wfRow, triggerData, contactData, orgId, orgRow);
      await finishRun(runId, r.failedNodeId ?? null, r.failedNodeId ? "failed" : "success", r.durationMs);
      results.push({ workflowId: wfRow.id, name: wfRow.name, status: r.failedNodeId ? "failed" : "success" });
    } catch (err: any) {
      await finishRun(runId, null, "failed", 0);
      console.error(`[execute-workflow] wf=${wfRow.id} error:`, err?.message ?? err);
      results.push({ workflowId: wfRow.id, name: wfRow.name, status: "failed", error: err?.message });
    }
  }

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ triggered: results.length, results }) };
};

// ── Graph executor ────────────────────────────────────────────────────────────

interface GraphNode { id: string; type: string; data: { nodeType: string; config: Record<string, any>; category: string }; position: { x: number; y: number } }
interface GraphEdge { id: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }

async function executeWorkflow(
  wfRow: { id: string; name: string; nodes: any; edges: any },
  triggerData: Record<string, any>,
  contactData: Record<string, any>,
  orgId: string,
  orgRow: Record<string, any> | null,
): Promise<{ failedNodeId?: string; durationMs: number; context: Record<string, any> }> {
  const start = Date.now();
  const nodes: GraphNode[] = Array.isArray(wfRow.nodes) ? wfRow.nodes : [];
  const edges: GraphEdge[] = Array.isArray(wfRow.edges) ? wfRow.edges : [];

  if (nodes.length === 0) return { durationMs: 0, context: {} };

  // Build adjacency map
  const outEdges: Record<string, GraphEdge[]> = {};
  const inDegree: Record<string, number> = {};
  for (const n of nodes) { outEdges[n.id] = []; inDegree[n.id] = 0; }
  for (const e of edges) {
    outEdges[e.source]?.push(e);
    inDegree[e.target] = (inDegree[e.target] ?? 0) + 1;
  }

  // Trigger node = node with no incoming edges or category === "trigger"
  const triggerNode = nodes.find((n) => inDegree[n.id] === 0 || n.data?.category === "trigger");
  if (!triggerNode) return { durationMs: Date.now() - start, context: {} };

  // Shared execution context — org.name etc. available for token interpolation
  const ctx: Record<string, any> = {
    ...triggerData,
    contact: contactData,
    org: { name: orgRow?.name ?? "", phone: orgRow?.phone ?? "", website: orgRow?.website ?? "" },
  };
  const visited = new Set<string>();

  async function walk(nodeId: string): Promise<string | null> {
    if (visited.has(nodeId) || visited.size > 50) return null;
    visited.add(nodeId);

    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return null;

    // Skip the trigger node (it just fires, no action)
    if (node.data?.category !== "trigger") {
      try {
        const result = await executeNode(node, ctx, orgId);
        if (result.ctxPatch) Object.assign(ctx, result.ctxPatch);
        if (result.failed) return nodeId; // stop walk, return failed nodeId

        // For if_else: branch on conditionMet
        if (node.data?.nodeType === "if_else") {
          const handle = result.conditionMet ? "yes" : "no";
          const next = outEdges[nodeId]?.find((e) => e.sourceHandle === handle);
          if (next) return walk(next.target);
          return null;
        }
      } catch (err) {
        console.error(`[execute-workflow] node=${nodeId} type=${node.data?.nodeType}:`, err);
        return nodeId; // treat as failed
      }
    }

    // Follow all outgoing edges (usually one)
    const nexts = outEdges[nodeId] ?? [];
    for (const edge of nexts) {
      const failedAt = await walk(edge.target);
      if (failedAt) return failedAt;
    }
    return null;
  }

  const failedNodeId = (await walk(triggerNode.id)) ?? undefined;
  return { failedNodeId, durationMs: Date.now() - start, context: ctx };
}

// ── Node executor ─────────────────────────────────────────────────────────────

async function executeNode(
  node: GraphNode,
  ctx: Record<string, any>,
  orgId: string,
): Promise<{ failed?: boolean; conditionMet?: boolean; ctxPatch?: Record<string, any> }> {
  const { nodeType, config } = node.data;

  switch (nodeType) {

    case "send_sms": {
      const phone = config.to === "custom"
        ? config.custom_phone
        : (ctx.contact?.phone ?? ctx.contact?.caller_number ?? null);
      if (!phone) { console.warn("[execute-workflow] send_sms: no phone"); break; }
      const body = interpolate(config.message ?? "", ctx);
      await sendTwilioSms(phone, body);
      break;
    }

    case "send_email": {
      const email = config.to === "custom"
        ? config.custom_email
        : (ctx.contact?.email ?? null);
      if (!email) { console.warn("[execute-workflow] send_email: no email"); break; }
      await sendSmtpEmail(email, interpolate(config.subject ?? "", ctx), interpolate(config.body ?? "", ctx));
      break;
    }

    case "create_task": {
      const unitMs: Record<string, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000, weeks: 604_800_000 };
      const dueMs = ((config.due_in ?? 1) as number) * (unitMs[config.due_unit ?? "days"] ?? 86_400_000);
      await supabaseAdmin.from("tasks").insert({
        org_id: orgId,
        title: interpolate(config.title ?? "Workflow task", ctx),
        status: "todo",
        priority: config.priority ?? "medium",
        due: new Date(Date.now() + dueMs).toISOString(),
        assignee: config.assignee === "specific" ? (config.member_id || null) : null,
      });
      break;
    }

    case "assign_member": {
      const memberId = config.strategy === "specific" ? (config.member_id || null) : null;
      if (!memberId) break; // round_robin not yet implemented server-side
      const leadId   = ctx.lead?.id   ?? ctx.triggerData?.lead_id   ?? null;
      const projectId = ctx.project?.id ?? ctx.triggerData?.project_id ?? null;
      if (leadId)    await supabaseAdmin.from("leads").update({ assigned_to: memberId }).eq("id", leadId).eq("org_id", orgId);
      if (projectId) await supabaseAdmin.from("projects").update({ assigned_to: memberId }).eq("id", projectId).eq("org_id", orgId);
      break;
    }

    case "send_portal_invite": {
      const email = config.send_to === "custom"
        ? (config.custom_email ?? null)
        : (ctx.contact?.email ?? null);
      if (!email) { console.warn("[execute-workflow] send_portal_invite: no email"); break; }

      const firstName = ctx.contact?.first_name ?? "";
      const lastName  = ctx.contact?.last_name  ?? "";
      const slug = `${(firstName || "client").toLowerCase().replace(/\s+/g, "-")}-${Math.random().toString(36).slice(2, 6)}`;
      const projectId = ctx.project?.id ?? ctx.triggerData?.project_id ?? null;

      await supabaseAdmin.from("invitations").insert({
        organization_id: orgId,
        email,
        first_name: firstName,
        last_name:  lastName,
        role:       "viewer",
        status:     "pending",
        project_id: projectId,
        portal_slug: slug,
      });

      const orgName   = ctx.org?.name ?? "Your contractor";
      const note      = config.note ? `<p>${interpolate(config.note, ctx)}</p>` : "";
      const portalUrl = `https://portal.renometa.com/p/${slug}`;
      const html = `<p>Hi ${firstName || "there"},</p>${note}<p>${orgName} has invited you to your project portal where you can track progress, approve estimates, and pay invoices.</p><p><a href="${portalUrl}" style="background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:8px;">View your portal</a></p>`;
      await sendSmtpEmail(email, `${orgName} invited you to your project portal`, html);
      break;
    }

    case "add_note": {
      const content = interpolate(config.content ?? "", ctx);
      if (config.target === "project" && ctx.project?.id) {
        await supabaseAdmin.from("project_notes").insert({
          project_id: ctx.project.id,
          content,
          is_client_message: false,
        });
      }
      // For lead/contact notes, just log (no dedicated notes table for those yet)
      break;
    }

    case "update_status": {
      const table = config.entity === "project" ? "projects" : config.entity === "deal" ? "deals" : "leads";
      const id = ctx[config.entity]?.id ?? ctx.contact?.id;
      if (id) {
        await supabaseAdmin
          .from(table)
          .update({ [config.field ?? "status"]: config.value })
          .eq("id", id)
          .eq("org_id", orgId);
      }
      break;
    }

    case "filter":
    case "if_else": {
      const conditionMet = evaluateCondition(config, ctx);
      if (nodeType === "filter" && !conditionMet) return { failed: false }; // stop (not a failure)
      return { conditionMet };
    }

    case "wait": {
      // Serverless functions can't sleep — log and continue
      console.info(`[execute-workflow] wait node: ${config.amount} ${config.unit} (skipped in serverless)`);
      break;
    }

    case "ai_step": {
      try {
        const result = await runAiStep(
          interpolate(config.system_prompt ?? "", ctx),
          interpolate(config.user_prompt ?? "", ctx),
        );
        return { ctxPatch: { [config.output_variable ?? "ai_output"]: result } };
      } catch (err) {
        console.warn("[execute-workflow] ai_step failed:", err);
      }
      break;
    }

    case "webhook": {
      const body = config.method === "GET" ? undefined : interpolate(config.body ?? "{}", ctx);
      const headersObj: Record<string, string> = {
        "Content-Type": "application/json",
        ...Object.fromEntries((config.headers ?? []).map((h: { key: string; value: string }) => [h.key, h.value])),
      };
      await fetch(config.url, { method: config.method ?? "POST", headers: headersObj, body });
      break;
    }

    default:
      console.warn("[execute-workflow] unknown nodeType:", nodeType);
  }

  return {};
}

// ── Condition evaluator ───────────────────────────────────────────────────────

function evaluateCondition(config: Record<string, any>, ctx: Record<string, any>): boolean {
  const fieldParts = (config.field ?? "").split(".");
  let actual: any = ctx;
  for (const part of fieldParts) actual = actual?.[part];

  const expected = config.value ?? "";
  const op: string = config.operator ?? "equals";

  switch (op) {
    case "equals":       return String(actual ?? "") === String(expected);
    case "not_equals":   return String(actual ?? "") !== String(expected);
    case "contains":     return String(actual ?? "").includes(String(expected));
    case "not_contains": return !String(actual ?? "").includes(String(expected));
    case "greater_than": return Number(actual) > Number(expected);
    case "less_than":    return Number(actual) < Number(expected);
    case "is_empty":     return actual == null || actual === "";
    case "is_not_empty": return actual != null && actual !== "";
    default: return false;
  }
}

// ── Template interpolation ────────────────────────────────────────────────────

function interpolate(template: string, ctx: Record<string, any>): string {
  return template.replace(/\{([^}]+)\}/g, (_, key) => {
    const parts = (key as string).trim().split(".");
    let value: any = ctx;
    for (const part of parts) value = value?.[part];
    return value != null ? String(value) : `{${key}}`;
  });
}

// ── Run record helpers ────────────────────────────────────────────────────────

async function startRun(workflowId: string, orgId: string, contactData: Record<string, any>): Promise<string> {
  const contactName = [contactData?.first_name, contactData?.last_name].filter(Boolean).join(" ")
    || contactData?.full_name
    || contactData?.name
    || "";
  const { data } = await supabaseAdmin.from("workflow_runs").insert({
    workflow_id: workflowId,
    org_id: orgId,
    contact_name: contactName,
    status: "running",
  }).select("id").single();
  return data?.id ?? "";
}

async function finishRun(runId: string, failedAtNodeId: string | null, status: string, durationMs: number) {
  if (!runId) return;
  await supabaseAdmin.from("workflow_runs").update({
    status,
    ended_at: new Date().toISOString(),
    duration_ms: durationMs,
    failed_at_node_id: failedAtNodeId,
  }).eq("id", runId);
}

// ── Integrations ──────────────────────────────────────────────────────────────

async function sendTwilioSms(to: string, body: string) {
  const sid  = process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !auth || !from) { console.warn("[execute-workflow] Twilio env vars not set"); return; }

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${auth}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ From: from, To: to, Body: body }).toString(),
  });
  if (!res.ok) console.warn("[execute-workflow] Twilio error:", await res.text());
}

async function sendSmtpEmail(to: string, subject: string, html: string) {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  if (!user || !pass) { console.warn("[execute-workflow] SMTP env vars not set"); return; }

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com", port: 587, secure: false,
    auth: { user, pass },
  });
  await transporter.sendMail({ from: `"RenoMeta" <${user}>`, to, subject, html });
}

async function runAiStep(systemPrompt: string, userPrompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API error: ${await res.text()}`);
  const data = await res.json();
  return data.content?.[0]?.text ?? "";
}
