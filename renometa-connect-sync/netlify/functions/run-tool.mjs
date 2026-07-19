/**
 * run-tool.mjs  —  Netlify Functions v2 (export default, zero npm imports)
 *
 * POST { toolDefinitionId, orgId, userId?, input }
 * Returns { output, sections }
 *
 * Uses node:https for Claude API (bypasses bootstrap fetch polyfill that hangs
 * on api.anthropic.com inside lambda-local on Node 24 + Windows netlify dev).
 * Uses global fetch for Supabase REST (works fine).
 */

import { execFile } from "node:child_process";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ── Supabase REST helpers ─────────────────────────────────────────────────────

function sbHeaders() {
  return {
    "apikey": SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    "Prefer": "return=representation",
  };
}

async function sbSelect(table, filters = {}, select = "*") {
  const params = new URLSearchParams({ select });
  for (const [col, val] of Object.entries(filters)) {
    if (val !== undefined && val !== null) params.set(col, `eq.${val}`);
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    headers: sbHeaders(),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`[sb] SELECT ${table} error:`, err);
    return [];
  }
  return res.json();
}

async function sbInsert(table, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: sbHeaders(),
    body: JSON.stringify(row),
  });
  if (!res.ok) console.error(`[sb] INSERT ${table} error:`, await res.text());
  return res.ok;
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);

  if (!ANTHROPIC_KEY) return json({ error: "ANTHROPIC_API_KEY is not configured" }, 500);
  if (!SUPABASE_URL || !SUPABASE_KEY) return json({ error: "Supabase env vars missing" }, 500);

  let body;
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const { toolDefinitionId, orgId, userId, input = {} } = body;
  if (!toolDefinitionId || !orgId) return json({ error: "toolDefinitionId and orgId required" }, 400);

  // 1. Load tool definition
  const tools = await sbSelect("tool_definitions", { id: toolDefinitionId });
  const tool = tools[0];
  if (!tool) return json({ error: "Tool definition not found" }, 404);

  try {
    // 2. Fetch context data
    const ctx = await fetchContext(tool, orgId, input);

    // 3. Build prompt
    const userPrompt = buildPrompt(tool, input, ctx);

    // 4. Call Claude via child process — lambda-local's bootstrap intercepts
    //    fetch/https on api.anthropic.com; a child Node process bypasses this.
    const model = resolveModel(tool.model);
    const claudeData = await callClaudeInChildProcess({
      model,
      max_tokens: 4096,
      system: tool.system_prompt ?? "You are a helpful AI assistant.",
      messages: [{ role: "user", content: userPrompt }],
    }, ANTHROPIC_KEY);

    if (claudeData.status >= 400) {
      const msg = claudeData.body?.error?.message ?? `Claude API error ${claudeData.status}`;
      console.error("[run-tool] Claude error:", claudeData.status, msg);
      return json({ error: msg }, 502);
    }

    const rawOutput = claudeData.body?.content?.[0]?.text ?? "";
    const inputTokens = claudeData.body?.usage?.input_tokens ?? 0;
    const outputTokens = claudeData.body?.usage?.output_tokens ?? 0;
    const tokensUsed = inputTokens + outputTokens;
    const costUsd = tool.model?.includes("sonnet")
      ? (inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15
      : (tokensUsed / 1_000_000) * 0.25;

    // 5. Format output
    const { output, sections } = formatOutput(tool, rawOutput);

    // 6. Record the run (fire and forget)
    sbInsert("tool_runs", {
      org_id: orgId,
      tool_definition_id: toolDefinitionId,
      user_id: userId ?? null,
      input,
      output: rawOutput,
      tokens_used: tokensUsed,
      cost_usd: costUsd,
    });

    return json({ output, sections });
  } catch (err) {
    console.error("[run-tool] error:", err?.message ?? err);
    return json({ error: err?.message ?? "Tool execution failed" }, 500);
  }
};

// ── Model resolution ──────────────────────────────────────────────────────────

function resolveModel(model) {
  if (!model) return "claude-haiku-4-5-20251001";
  if (model === "claude-haiku-4-5") return "claude-haiku-4-5-20251001";
  if (model === "claude-sonnet-4-5") return "claude-sonnet-4-5";
  return model;
}

// ── Context fetching ─────────────────────────────────────────────────────────

async function fetchContext(tool, orgId, input) {
  const ctx = {};

  if (tool.name === "Proposal Writer") {
    const orgs = await sbSelect("organizations", { id: orgId }, "name,phone,address,website");
    if (orgs[0]) ctx.org = orgs[0];
  }

  if (tool.name === "AI Insights") {
    const days = parseInt(input.date_range ?? "30", 10);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const [leads, projects, invoices] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/leads?org_id=eq.${orgId}&created_at=gte.${since}&select=id,status,source,score`, { headers: sbHeaders() }).then(r => r.json()).catch(() => []),
      fetch(`${SUPABASE_URL}/rest/v1/projects?org_id=eq.${orgId}&created_at=gte.${since}&select=id,status,completion_percentage,budget_total`, { headers: sbHeaders() }).then(r => r.json()).catch(() => []),
      fetch(`${SUPABASE_URL}/rest/v1/invoices?org_id=eq.${orgId}&created_at=gte.${since}&select=id,status,total_amount,amount_paid`, { headers: sbHeaders() }).then(r => r.json()).catch(() => []),
    ]);

    const totalLeads = leads.length;
    const converted = leads.filter(l => l.status === "won").length;

    const sourceCounts = {};
    leads.forEach(l => { if (l.source) sourceCounts[l.source] = (sourceCounts[l.source] ?? 0) + 1; });
    const topSources = Object.entries(sourceCounts).sort(([, a], [, b]) => b - a).slice(0, 3).map(([source, count]) => ({ source, count }));

    const totalInvoiced = invoices.reduce((s, i) => s + (Number(i.total_amount) || 0), 0);
    const totalCollected = invoices.reduce((s, i) => s + (Number(i.amount_paid) || 0), 0);

    const projectsByStatus = {};
    projects.forEach(p => { if (p.status) projectsByStatus[p.status] = (projectsByStatus[p.status] ?? 0) + 1; });

    ctx.businessData = {
      period_days: days,
      leads: { total: totalLeads, converted, conversion_rate_pct: totalLeads > 0 ? Math.round((converted / totalLeads) * 100) : 0, top_sources: topSources },
      projects: {
        total: projects.length,
        by_status: projectsByStatus,
        avg_completion_pct: projects.length > 0 ? Math.round(projects.reduce((s, p) => s + (Number(p.completion_percentage) || 0), 0) / projects.length) : 0,
        total_budget: projects.reduce((s, p) => s + (Number(p.budget_total) || 0), 0),
      },
      invoices: {
        total_invoiced: totalInvoiced,
        total_collected: totalCollected,
        outstanding: totalInvoiced - totalCollected,
        overdue_count: invoices.filter(i => i.status === "overdue").length,
        collection_rate_pct: totalInvoiced > 0 ? Math.round((totalCollected / totalInvoiced) * 100) : 0,
      },
    };
  }

  return ctx;
}

// ── Prompt building ───────────────────────────────────────────────────────────

function buildPrompt(tool, input, ctx) {
  const parts = [];

  if (ctx.org) {
    const o = ctx.org;
    parts.push(`Company: ${o.name ?? ""}\nPhone: ${o.phone ?? ""}\nAddress: ${o.address ?? ""}`);
  }

  if (ctx.businessData) {
    parts.push(`Business data for last ${ctx.businessData.period_days} days:\n${JSON.stringify(ctx.businessData, null, 2)}`);
  }

  const inputLines = Object.entries(input).filter(([, v]) => v?.trim()).map(([k, v]) => `${k}: ${v}`);
  if (inputLines.length) parts.push(inputLines.join("\n"));

  let prompt = parts.join("\n\n");

  if (ctx.org && tool.name === "Proposal Writer") {
    const o = ctx.org;
    prompt = prompt
      .replace(/{ORG_NAME}/g, o.name ?? "")
      .replace(/{ORG_PHONE}/g, o.phone ?? "")
      .replace(/{ORG_ADDRESS}/g, o.address ?? "");
  }

  return prompt;
}

// ── Output formatting ─────────────────────────────────────────────────────────

function formatOutput(tool, rawText) {
  if (tool.name === "Proposal Writer") {
    const sections = {};
    const headingRegex = /^#+\s+(.+)$|^\d+\.\s+(.+)$/gm;
    const parts = rawText.split(headingRegex).filter(Boolean);
    if (parts.length > 1) {
      for (let i = 0; i < parts.length - 1; i += 2) {
        const heading = parts[i]?.trim();
        const content = parts[i + 1]?.trim() ?? "";
        if (heading) sections[heading] = content;
      }
    }
    if (!Object.keys(sections).length) sections["Proposal"] = rawText.trim();
    return { output: rawText, sections };
  }

  try {
    const match = rawText.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    const parsed = JSON.parse(match ? match[0] : rawText);
    const sections = {};

    if (Array.isArray(parsed)) {
      sections["Extracted Tasks"] = parsed.map((t, i) =>
        `${i + 1}. [${(t.priority ?? "MEDIUM").toUpperCase()}] ${t.title}${t.assignee_hint ? ` → ${t.assignee_hint}` : ""}${t.due_date_hint ? ` (${t.due_date_hint})` : ""}${t.context ? `\n   ${t.context}` : ""}`
      ).join("\n");
    } else {
      for (const [key, value] of Object.entries(parsed)) {
        const label = key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
        if (Array.isArray(value)) {
          if (!value.length) continue;
          sections[label] = typeof value[0] === "string"
            ? value.map(s => `• ${s}`).join("\n")
            : value.map(item => {
                if (item.title && item.description) return `**${item.title}**\n${item.description}`;
                if (item.task) return `• ${item.task}${item.owner ? ` (${item.owner})` : ""}${item.due ? ` — ${item.due}` : ""}`;
                if (item.action) return `• [${(item.priority ?? "MED").toUpperCase()}] ${item.action} — ${item.estimated_impact ?? ""}`;
                if (item.source) return `• ${item.source}: ${item.count}`;
                return `• ${JSON.stringify(item)}`;
              }).join("\n");
        } else if (typeof value === "object" && value !== null) {
          sections[label] = Object.entries(value).map(([k, v]) => `${k}: ${v}`).join("\n");
        } else {
          sections[label] = String(value);
        }
      }
    }

    if (!Object.keys(sections).length) sections["Output"] = rawText.trim();
    return { output: rawText, sections };
  } catch {
    return { output: rawText, sections: { Output: rawText.trim() } };
  }
}

// ── Child-process Claude call ─────────────────────────────────────────────────
// lambda-local intercepts fetch AND https.request on api.anthropic.com.
// A child Node.js process is completely outside that context — same as running
// test-claude.mjs directly, which we proved works fine.

function callClaudeInChildProcess(requestBody, apiKey) {
  return new Promise((resolve, reject) => {
    // Pass request body as base64 env var to avoid any shell-escaping issues
    const b64 = Buffer.from(JSON.stringify(requestBody)).toString("base64");

    const script = `
const body = Buffer.from(process.env.__B64, "base64").toString();
const r = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": process.env.__KEY,
    "anthropic-version": "2023-06-01",
  },
  body,
});
process.stdout.write(JSON.stringify({ status: r.status, body: await r.json() }));
`.trim();

    execFile(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        env: { ...process.env, __B64: b64, __KEY: apiKey },
        timeout: 55_000,
        maxBuffer: 10 * 1024 * 1024,
        encoding: "utf8",
      },
      (err, stdout) => {
        if (err) { reject(new Error(err.message ?? "Claude child process failed")); return; }
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error("Bad Claude response: " + stdout.slice(0, 300))); }
      },
    );
  });
}
