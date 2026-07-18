// netlify/functions/run-agent.ts
/// <reference types="node" />
/**
 * run-agent.ts
 * Netlify Function — executes an autonomous AI agent for an org.
 *
 * POST { agentDefinitionId, orgId, triggerData? }
 */

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { execFile } from "node:child_process";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: HEADERS, body: "" };
  if (event.httpMethod !== "POST")
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: "Method Not Allowed" }) };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: "ANTHROPIC_API_KEY is not configured" }) };
  }

  let body: { agentDefinitionId: string; orgId: string; triggerData?: Record<string, unknown> };
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { agentDefinitionId, orgId, triggerData = {} } = body;
  if (!agentDefinitionId || !orgId)
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "agentDefinitionId and orgId required" }) };

  // 1. Load definition
  const { data: definition } = await supabase
    .from("agent_definitions")
    .select("*")
    .eq("id", agentDefinitionId)
    .maybeSingle();

  if (!definition)
    return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: "Agent definition not found" }) };

  // 2. Get or create instance
  const instance = await getOrCreateInstance(orgId, agentDefinitionId);
  if (!instance)
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: "Failed to get agent instance" }) };

  // 3. Skip if disabled (unless manually triggered)
  if (!instance.is_enabled && triggerData.manual !== true)
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ skipped: true, reason: "Agent is disabled" }) };

  // 4. Create run record
  const { data: run } = await supabase
    .from("agent_runs")
    .insert({ agent_instance_id: instance.id, org_id: orgId, status: "running", trigger_data: triggerData })
    .select()
    .single();

  if (!run)
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: "Failed to create run record" }) };

  try {
    // 5. Fetch org info
    const { data: org } = await supabase
      .from("organizations")
      .select("name, phone, address")
      .eq("id", orgId)
      .maybeSingle();
    const orgName = (org as any)?.name ?? "your company";
    const orgPhone = (org as any)?.phone ?? "";

    // 6. Fetch real data
    const realData = await fetchAgentData(definition, orgId, triggerData);

    // 7. Build user prompt
    const userPrompt = buildPrompt(definition, realData, orgName, triggerData);

    // 8. Call Claude via child process — same workaround as run-tool.mjs.
    //    lambda-local intercepts fetch/https to api.anthropic.com on Node 24.
    const claudeResp = await callClaudeChild({
      model: definition.model ?? "claude-haiku-4-5",
      max_tokens: 2048,
      system: definition.system_prompt ?? "You are a helpful AI assistant.",
      messages: [{ role: "user", content: userPrompt }],
    }, apiKey);

    if (claudeResp.status >= 400) {
      throw new Error(claudeResp.body?.error?.message ?? `Claude API error ${claudeResp.status}`);
    }

    const claudeText: string = claudeResp.body?.content?.[0]?.text ?? "";
    const tokensUsed = (claudeResp.body?.usage?.input_tokens ?? 0) + (claudeResp.body?.usage?.output_tokens ?? 0);

    // 9. Execute actions
    const actionsTaken = await executeActions(definition, claudeText, realData, orgId, orgName, orgPhone);

    // 10. Cost estimate
    const costUsd = (tokensUsed / 1_000_000) * 0.25; // haiku rate

    // 11. Update run record
    await supabase.from("agent_runs").update({
      status: "completed",
      result_summary: claudeText.slice(0, 500),
      actions_taken: actionsTaken,
      tokens_used: tokensUsed,
      cost_usd: costUsd,
      completed_at: new Date().toISOString(),
    }).eq("id", run.id);

    // 12. Update instance stats
    const newRunsThisWeek = (instance.runs_this_week ?? 0) + 1;
    const prevRuns = instance.runs_this_week ?? 0;
    const prevSuccess = instance.success_rate ?? 0;
    const newSuccessRate = prevRuns === 0 ? 100 : Math.round((prevSuccess * prevRuns + 100) / newRunsThisWeek);
    await supabase.from("agent_instances").update({
      runs_this_week: newRunsThisWeek,
      success_rate: Math.min(100, newSuccessRate),
      last_run_at: new Date().toISOString(),
    }).eq("id", instance.id);

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ success: true, runId: run.id, actionsTaken, summary: claudeText.slice(0, 200) }),
    };
  } catch (err: any) {
    await supabase.from("agent_runs").update({
      status: "failed",
      result_summary: err.message ?? "Unknown error",
      completed_at: new Date().toISOString(),
    }).eq("id", run.id);

    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: err.message ?? "Agent execution failed" }),
    };
  }
};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getOrCreateInstance(orgId: string, agentDefinitionId: string) {
  const { data: existing } = await supabase
    .from("agent_instances")
    .select("*")
    .eq("org_id", orgId)
    .eq("agent_definition_id", agentDefinitionId)
    .maybeSingle();
  if (existing) return existing;

  const { data: created } = await supabase
    .from("agent_instances")
    .insert({ org_id: orgId, agent_definition_id: agentDefinitionId, is_enabled: false })
    .select()
    .single();
  return created;
}

async function fetchAgentData(
  definition: any,
  orgId: string,
  triggerData: Record<string, unknown>,
): Promise<Record<string, any>> {
  const result: Record<string, any> = {};

  for (const source of definition.data_sources ?? []) {
    switch (source.type) {
      case "lead": {
        const leadId = triggerData.lead_id as string | undefined;
        if (leadId) {
          const { data } = await supabase.from("leads").select("*").eq("id", leadId).maybeSingle();
          result.lead = data;
        }
        break;
      }
      case "leads": {
        if (source.filter === "needs_followup") {
          const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
          const { data } = await supabase
            .from("leads")
            .select("id, name, phone, source, status, job_type, last_contacted_at, notes")
            .eq("org_id", orgId)
            .or(`status.eq.cold,last_contacted_at.lt.${sevenDaysAgo},last_contacted_at.is.null`)
            .limit(20);
          result.leads = data ?? [];
        }
        break;
      }
      case "invoices": {
        if (source.filter === "overdue") {
          const { data } = await supabase
            .from("invoices")
            .select("id, invoice_number, total_amount, amount_paid, due_date, status, contacts(full_name, phone, email)")
            .eq("org_id", orgId)
            .eq("status", "overdue")
            .order("due_date");
          result.invoices = (data ?? []).map((inv: any) => ({
            ...inv,
            days_overdue: Math.floor((Date.now() - new Date(inv.due_date).getTime()) / 86400000),
          }));
        }
        break;
      }
      case "projects": {
        if (source.filter === "active") {
          const { data } = await supabase
            .from("projects")
            .select("id, name, status, completion_percentage, contacts(full_name, phone, email)")
            .eq("org_id", orgId)
            .in("status", ["active", "contracted", "pre-construction", "punch-list"]);
          result.projects = data ?? [];
        }
        break;
      }
      case "tasks": {
        if (source.filter === "done_this_week") {
          const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
          const { data } = await supabase
            .from("tasks")
            .select("id, title, project_id, updated_at")
            .eq("org_id", orgId)
            .eq("status", "done")
            .gte("updated_at", sevenDaysAgo);
          result.done_tasks = data ?? [];
        }
        break;
      }
      case "estimates": {
        if (source.filter === "recent_similar") {
          const jobType = (triggerData.job_type as string | undefined) ?? null;
          let q = supabase
            .from("estimates")
            .select("id, job_type, total_amount, estimate_items(*)")
            .eq("org_id", orgId)
            .order("created_at", { ascending: false })
            .limit(source.limit ?? 5);
          if (jobType) q = q.eq("job_type", jobType);
          const { data } = await q;
          result.past_estimates = data ?? [];
        } else if (source.filter === "similar") {
          const jobType = result.estimate?.job_type ?? null;
          let q = supabase
            .from("estimates")
            .select("id, job_type, total_amount, estimate_items(*)")
            .eq("org_id", orgId)
            .order("created_at", { ascending: false })
            .limit(source.limit ?? 3);
          if (jobType) q = q.eq("job_type", jobType);
          const { data } = await q;
          result.similar_estimates = data ?? [];
        }
        break;
      }
      case "estimate": {
        const estimateId = triggerData.estimate_id as string | undefined;
        if (estimateId) {
          const { data } = await supabase
            .from("estimates")
            .select("*, estimate_items(*)")
            .eq("id", estimateId)
            .maybeSingle();
          result.estimate = data;
        }
        break;
      }
      case "project": {
        const projectId = triggerData.project_id as string | undefined;
        if (projectId) {
          const { data } = await supabase
            .from("projects")
            .select("id, name, status, completion_percentage, contacts(full_name, phone, email)")
            .eq("id", projectId)
            .maybeSingle();
          result.project = data;
        }
        break;
      }
      case "voice_call": {
        const callId = triggerData.call_id as string | undefined;
        if (callId) {
          const { data } = await supabase
            .from("voice_calls")
            .select("id, caller_phone, duration, transcript, started_at")
            .eq("id", callId)
            .maybeSingle();
          result.call = data;
        } else {
          result.call = {
            caller_phone: triggerData.caller_phone,
            transcript: triggerData.transcript,
            duration: triggerData.duration,
          };
        }
        break;
      }
      case "messages": {
        const { data } = await supabase
          .from("project_notes")
          .select("id, body, author, client_email, is_client_message, created_at, project_id")
          .eq("is_client_message", true)
          .order("created_at", { ascending: false })
          .limit(source.limit ?? 20);
        result.messages = data ?? [];
        break;
      }
    }
  }

  return result;
}

function buildPrompt(
  definition: any,
  realData: Record<string, any>,
  orgName: string,
  triggerData: Record<string, unknown>,
): string {
  const parts = [`You are acting on behalf of ${orgName}, a home improvement contractor.`];

  if (realData.lead) parts.push(`Lead info:\n${JSON.stringify(realData.lead, null, 2)}`);
  if (realData.leads?.length)
    parts.push(`Leads to process (${realData.leads.length}):\n${JSON.stringify(realData.leads, null, 2)}`);
  if (realData.invoices?.length)
    parts.push(`Overdue invoices (${realData.invoices.length}):\n${JSON.stringify(realData.invoices, null, 2)}`);
  if (realData.projects?.length)
    parts.push(`Active projects (${realData.projects.length}):\n${JSON.stringify(realData.projects, null, 2)}`);
  if (realData.done_tasks?.length)
    parts.push(`Tasks completed this week:\n${JSON.stringify(realData.done_tasks, null, 2)}`);
  if (realData.past_estimates?.length)
    parts.push(`Historical estimates for reference:\n${JSON.stringify(realData.past_estimates, null, 2)}`);
  if (realData.estimate)
    parts.push(`Estimate to review:\n${JSON.stringify(realData.estimate, null, 2)}`);
  if (realData.similar_estimates?.length)
    parts.push(`Similar historical estimates:\n${JSON.stringify(realData.similar_estimates, null, 2)}`);
  if (realData.call)
    parts.push(`Call record:\n${JSON.stringify(realData.call, null, 2)}`);
  if (realData.messages?.length)
    parts.push(`Recent client messages (${realData.messages.length}):\n${JSON.stringify(realData.messages, null, 2)}`);
  if (realData.project)
    parts.push(`Project:\n${JSON.stringify(realData.project, null, 2)}`);
  if (triggerData.job_notes)
    parts.push(`Job notes from user:\n${triggerData.job_notes}`);

  return parts.join("\n\n");
}

async function executeActions(
  definition: any,
  claudeText: string,
  realData: Record<string, any>,
  orgId: string,
  orgName: string,
  _orgPhone: string,
): Promise<any[]> {
  const taken: any[] = [];
  const allowedActions: any[] = definition.actions ?? [];
  const has = (type: string) => allowedActions.some((a: any) => a.type === type);

  let parsed: any = null;
  try {
    const jsonMatch = claudeText.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : claudeText);
  } catch {
    parsed = null;
  }

  // ── send_sms ───────────────────────────────────────────────────────────────
  if (has("send_sms")) {
    const messages: any[] = [];

    if (Array.isArray(parsed)) {
      messages.push(...parsed);
    } else if (parsed?.messages) {
      messages.push(...parsed.messages);
    } else if (parsed?.callback_message) {
      const phone = realData.call?.caller_phone ?? realData.lead?.phone;
      if (phone) messages.push({ phone, message: parsed.callback_message });
    } else if (typeof claudeText === "string" && claudeText.length <= 200 && !claudeText.trim().startsWith("{")) {
      const phone = realData.lead?.phone ?? realData.project?.contacts?.phone;
      if (phone) messages.push({ phone, message: claudeText.trim() });
    }

    for (const msg of messages) {
      const phone: string | undefined = msg.phone ?? msg.contact_phone;
      const text: string | undefined = msg.message ?? msg.sms_text;
      if (phone && text) {
        await sendSms(phone, text.replace("{ORG_NAME}", orgName)).catch(() => {});
        taken.push({ type: "sms_sent", to: phone, preview: text.slice(0, 100) });
      }
    }
  }

  // ── update_lead_score ──────────────────────────────────────────────────────
  if (has("update_lead_score") && parsed && realData.lead?.id) {
    const score = parsed.score ?? null;
    const aiQuality = parsed.quality ?? null;
    if (score !== null) {
      await supabase
        .from("leads")
        .update({ score, ai_quality: aiQuality, ai_notes: parsed.qualification_summary ?? null })
        .eq("id", realData.lead.id);
      taken.push({ type: "lead_score_updated", score, quality: aiQuality });
    }
  }

  // ── update_lead_contacted ──────────────────────────────────────────────────
  if (has("update_lead_contacted") && realData.leads?.length) {
    const now = new Date().toISOString();
    const processedIds: string[] = Array.isArray(parsed)
      ? parsed.map((m: any) => m.lead_id).filter(Boolean)
      : (realData.leads as any[]).map((l) => l.id);
    for (const id of processedIds) {
      await supabase.from("leads").update({ last_contacted_at: now }).eq("id", id);
    }
    taken.push({ type: "leads_contacted_updated", count: processedIds.length });
  }

  // ── insert_note ────────────────────────────────────────────────────────────
  if (has("insert_note")) {
    if (parsed && realData.estimate?.project_id) {
      await supabase.from("project_notes").insert({
        project_id: realData.estimate.project_id,
        body: `AI Estimate Review:\n${JSON.stringify(parsed, null, 2)}`,
        author: `AI - ${definition.name}`,
      });
      taken.push({ type: "note_inserted", preview: `Score: ${parsed.overall_score ?? "—"}` });
    }

    if (parsed?.triaged && Array.isArray(parsed.triaged)) {
      for (const t of parsed.triaged) {
        if (t.urgency === "urgent" && t.message_id) {
          const msg = (realData.messages as any[])?.find((m: any) => m.id === t.message_id);
          if (msg?.project_id) {
            await supabase.from("project_notes").insert({
              project_id: msg.project_id,
              body: `[AI Triage] ${t.summary ?? ""}${t.suggested_reply ? `\n\nSuggested reply: ${t.suggested_reply}` : ""}`,
              author: "AI - Inbox Triage",
            });
            taken.push({ type: "note_inserted", preview: (t.summary ?? "").slice(0, 80) });
          }
        }
      }
    }
  }

  // ── create_task ────────────────────────────────────────────────────────────
  if (has("create_task") && realData.invoices?.length) {
    for (const inv of realData.invoices as any[]) {
      if (inv.days_overdue > 30) {
        const contactName = inv.contacts?.full_name ?? "Client";
        await supabase.from("tasks").insert({
          org_id: orgId,
          title: `Escalate collections for ${contactName} (#${inv.invoice_number ?? inv.id.slice(0, 8)})`,
          priority: "high",
          status: "todo",
        });
        taken.push({ type: "task_created", title: `Escalate collections for ${contactName}` });
      }
    }
  }

  // ── create_lead ────────────────────────────────────────────────────────────
  if (has("create_lead") && parsed?.is_new_lead) {
    const callerPhone: string | undefined = realData.call?.caller_phone;
    if (callerPhone) {
      const { data: existing } = await supabase
        .from("contacts")
        .select("id")
        .eq("phone", callerPhone)
        .eq("org_id", orgId)
        .maybeSingle();
      if (!existing) {
        await supabase.from("leads").insert({
          org_id: orgId,
          phone: callerPhone,
          source: "missed_call",
          job_type: parsed.lead_job_type ?? "Unknown",
          status: "new",
          name: "Unknown Caller",
        });
        taken.push({ type: "lead_created", phone: callerPhone });
      }
    }
  }

  // ── create_estimate ────────────────────────────────────────────────────────
  if (has("create_estimate") && parsed?.line_items?.length) {
    const { data: est } = await supabase
      .from("estimates")
      .insert({
        org_id: orgId,
        job_type: (realData as any).job_type ?? "Unknown",
        total_amount: parsed.subtotal ?? 0,
        status: "draft",
        notes: parsed.notes ?? null,
      })
      .select()
      .single();
    if (est) {
      const items = (parsed.line_items as any[]).map((li: any) => ({
        estimate_id: est.id,
        description: li.description,
        quantity: li.quantity ?? 1,
        unit: li.unit ?? "ls",
        unit_price: li.unit_price ?? 0,
        total: li.total ?? 0,
      }));
      await supabase.from("estimate_items").insert(items);
      taken.push({ type: "estimate_created", estimate_id: est.id, line_item_count: items.length });
    }
  }

  return taken;
}

async function sendSms(to: string, body: string) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !auth || !from) return;

  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${auth}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ From: from, To: to, Body: body.slice(0, 160) }).toString(),
  });
}

// ── Child-process Claude call ─────────────────────────────────────────────────
// lambda-local intercepts fetch/https to api.anthropic.com on Node 24 + Windows.
// A child node process is outside that context and reaches the API normally.

function callClaudeChild(
  requestBody: Record<string, unknown>,
  apiKey: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const b64 = Buffer.from(JSON.stringify(requestBody)).toString("base64");
    const script = `
const body = Buffer.from(process.env.__B64, "base64").toString();
const r = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-api-key": process.env.__KEY, "anthropic-version": "2023-06-01" },
  body,
});
process.stdout.write(JSON.stringify({ status: r.status, body: await r.json() }));
`.trim();

    execFile(
      process.execPath,
      ["--input-type=module", "-e", script],
      { env: { ...process.env, __B64: b64, __KEY: apiKey }, timeout: 55_000, maxBuffer: 10 * 1024 * 1024, encoding: "utf8" },
      (err, stdout) => {
        if (err) { reject(new Error(err.message ?? "Claude child process failed")); return; }
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error("Bad Claude response: " + stdout.slice(0, 200))); }
      },
    );
  });
}
