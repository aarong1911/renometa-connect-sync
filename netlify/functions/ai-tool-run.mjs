// netlify/functions/ai-tool-run.mjs
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ── Auth / org resolution ────────────────────────────────────────────────
// Same pattern as run-tool.mjs's resolveOrgFromBearerToken (and
// lib/resolve-org.ts's resolveOrgFromBearerToken): profiles.organization_id
// first, org_memberships fallback. Reimplemented via plain REST here rather
// than importing either, to match this file's existing zero-npm-import,
// pure-fetch style. Never accepts orgId/userId/tenantId from the request —
// the only trust input is the bearer token itself.
async function resolveOrgFromBearerToken(authHeader) {
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return null;

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  if (!user?.id) return null;

  const sbHeaders = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
  };

  const profileRes = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=organization_id`,
    { headers: sbHeaders }
  );
  const profiles = profileRes.ok ? await profileRes.json() : [];
  let orgId = profiles[0]?.organization_id ?? null;

  if (!orgId) {
    const memberRes = await fetch(
      `${SUPABASE_URL}/rest/v1/org_memberships?member_id=eq.${user.id}&select=org_id`,
      { headers: sbHeaders }
    );
    const memberships = memberRes.ok ? await memberRes.json() : [];
    orgId = memberships[0]?.org_id ?? null;
  }

  if (!orgId) return null;
  return { userId: user.id, orgId };
}

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("", { status: 204 });
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  if (!ANTHROPIC_API_KEY) {
    return Response.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return Response.json({ error: "Server configuration error" }, { status: 500 });
  }

  // Every AI Tools call must be tied to a valid authenticated RenoMeta org —
  // missing header and invalid/expired token both return the same 401 shape.
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const resolved = await resolveOrgFromBearerToken(authHeader);
  if (!resolved) return Response.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { toolId, inputs } = await req.json();

    if (!toolId || !inputs) {
      return Response.json({ error: "Missing toolId or inputs" }, { status: 400 });
    }

    const prompt = buildPrompt(toolId, inputs);
    if (!prompt) {
      return Response.json({ error: `Unknown tool: ${toolId}` }, { status: 400 });
    }

    // claude-sonnet-4-20250514 was deprecated (retiring 2026-06-15, per
    // Vapi's own deprecation warning for the same id) and that date has
    // passed — claude-sonnet-4-6 is the confirmed current replacement
    // already used elsewhere in this codebase (see
    // netlify/functions/lib/vapi-assistant-body.ts / voice-agent-tab.tsx).
    const MODEL = "claude-sonnet-4-6";
    const PROVIDER = "anthropic";

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      // Sanitized diagnostics only — never log prompt/transcript/summary
      // content (which includes customer name/phone/notes) or the API key.
      let providerType, providerMessage;
      try {
        const errJson = await response.json();
        providerType = errJson?.error?.type;
        providerMessage = errJson?.error?.message;
      } catch {
        // non-JSON error body — nothing further to extract safely
      }
      console.error("[ai-tool-run] upstream provider error", {
        toolId,
        provider: PROVIDER,
        model: MODEL,
        status: response.status,
        providerType,
        providerMessage,
      });
      return Response.json({ error: "AI service error" }, { status: 502 });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "";

    const sections = {};
    const sectionRegex = /## (.+?)\n([\s\S]*?)(?=\n## |\n*$)/g;
    let match;
    while ((match = sectionRegex.exec(text)) !== null) {
      sections[match[1].trim()] = match[2].trim();
    }

    if (Object.keys(sections).length === 0) {
      sections["Output"] = text;
    }

    return Response.json({ sections });
  } catch (err) {
    console.error("Function error:", err);
    return Response.json({ error: err.message || "Internal error" }, { status: 500 });
  }
};

function buildPrompt(toolId, inputs) {
  const i = inputs;
  const prompts = {
    "proposal-writer": `You are a professional proposal writer for home service and renovation businesses.

Write a compelling project proposal with these details:
- Client: ${i.clientName}
- Company: ${i.companyName}
- Project Type: ${i.projectType}
- Address: ${i.address}
- Description: ${i.projectDescription}
- Estimated Value: $${i.estimatedValue}
- Timeline: ${i.timeline}

Return your response in exactly this format with these 5 sections. Use "## Section Name" as headers:

## Executive Summary
(2-3 compelling paragraphs introducing the project, the company, and why you're the right fit)

## Scope of Work
(Detailed bullet-point breakdown of everything included in the project)

## Approach and Timeline
(Phase-by-phase breakdown with estimated duration for each phase)

## Investment Breakdown
(Line-item cost breakdown with subtotals. End with the total investment amount.)

## Call to Action
(Warm, professional closing with clear next steps for the client to approve and get started)

Make it professional, specific to the project type, and persuasive.`,

    "pipeline-coach": `You are an expert sales coach for home service and renovation businesses.

Analyze this stuck deal and provide actionable coaching:
- Deal: ${i.dealName}
- Stage: ${i.pipelineStage}
- Days in Stage: ${i.daysInStage}
- Deal Value: $${i.dealValue}
- Last Interaction: ${i.lastInteraction}
- Known Objections: ${i.knownObjections}

Return your response in exactly this format with these 5 sections. Use "## Section Name" as headers:

## Risk Level
(One of: 🔴 HIGH, 🟡 MEDIUM, or 🟢 LOW — with a one-line explanation)

## Win Probability
(Percentage with brief justification)

## Recommended Next Actions
(3-5 specific, actionable steps)

## Talk Scripts
(2-3 ready-to-use scripts for phone/text/email)

## Objection Handling Responses
(Direct responses to each known objection)`,

    "crm-update": `You are a CRM data extraction specialist for home service businesses.

Extract structured CRM data from this raw content:
- Contact: ${i.contactName}
- Source: ${i.sourceType}
- Date: ${i.date}
- Content:
${i.rawContent}

Return your response in exactly this format with these 5 sections. Use "## Section Name" as headers:

## Extracted Contact Updates
(Any contact info found. Format as key: value pairs.)

## Project Fields
(Project type, scope, budget, timeline. Format as key: value pairs.)

## Action Items with Owners
(Format as a table: Action Item | Owner | Priority | Due Date)

## Recommended Pipeline Stage Change
(What stage should this deal be in? Why?)

## Sentiment Indicator
(One of: 😊 Positive, 😐 Neutral, 😟 Concerned, 😡 Negative — with explanation)`,

    "conversation-summary": `You are an expert at summarizing business conversations for home service companies.

Summarize this conversation:
- Participants: ${i.participants}
- Type: ${i.conversationType}
- Date: ${i.date}
- Duration: ${i.duration} minutes
- Transcript:
${i.transcript}
${i.appointmentFacts ? `
REAL SYSTEM STATE (authoritative — reproduce these facts exactly, do not add, invent, or infer any additional status, owner, or deadline beyond what is listed here):
${i.appointmentFacts}
` : ""}
Return your response in exactly this format. Use "## Section Name" as headers for every section except the first:

## Summary
(2-3 plain sentences capturing the essential outcome — no bullet points, no markdown table)

## Key Points
(3-6 short bullet points, plain text — no markdown table)

## Suggested Next Steps
(2-4 short bullet points of recommended follow-up actions, phrased as suggestions, e.g. "Consider..." / "May want to...". These are NOT confirmed, scheduled, or completed actions — never state a status, owner, or deadline for anything in this section, since you have no way to know if it has actually happened.)
${i.appointmentFacts ? `
## Appointment
(Reproduce the REAL SYSTEM STATE facts given above, formatted as short bullet points. Do not add any detail not present in those facts.)
` : ""}
Do not use markdown tables (pipe "|" syntax) anywhere in your response — use short plain-text bullet points instead.`,

    "task-extractor": `You are a task extraction specialist for home service businesses.

Extract all tasks from this content:
- Source: ${i.contentSource}
- Default Assignee: ${i.defaultAssignee}
- Content:
${i.rawContent}

Return your response in exactly this format. Use "## Section Name" as header:

## Extracted Task List
(Table: Task Description | Priority (🔴 High / 🟡 Medium / 🟢 Low) | Assigned To | Suggested Due Date | Category

Assign unowned tasks to ${i.defaultAssignee}.)`,

    "ai-insights": `You are a business analytics expert for home service companies.

Analyze this business data:
- Period: ${i.analysisPeriod}
- Revenue: $${i.revenue}
- Total Leads: ${i.totalLeads}
- Conversion Rate: ${i.conversionRate}%
- Active Pipeline Value: $${i.activePipelineValue}
- Top Job Types: ${i.topJobTypes}
- Team Size: ${i.teamSize}

Return your response in exactly this format with these 5 sections. Use "## Section Name" as headers:

## Top 3 Business Insights
(Three high-impact insights with specific numbers and emojis)

## KPI Health Dashboard
(Rate each KPI as 🟢 Healthy, 🟡 Needs Attention, or 🔴 Critical)

## Growth Opportunities
(3-4 specific opportunities with estimated revenue impact)

## Revenue Forecast
(Best-case, likely, worst-case scenarios with dollar amounts)

## Recommended Actions
(5 prioritized actions)`,

    "revenue-intelligence": `You are a revenue forecasting specialist for home service businesses.

Analyze this pipeline data:
- Closed Revenue: $${i.closedRevenue}
- Revenue Target: $${i.revenueTarget}
- Active Pipeline: $${i.activePipelineTotal}
- Avg Deal Size: $${i.averageDealSize}
- Close Rate: ${i.averageCloseRate}%
- Season: ${i.currentSeason}

Return your response in exactly this format with these 5 sections. Use "## Section Name" as headers:

## Revenue Forecast with Confidence Range
(Low/mid/high range with math)

## Pipeline Health Score
(Score out of 100 with breakdown)

## Gap to Target
(Exact dollar gap and deals needed)

## Velocity Metrics
(Days per stage, deals per month, trends)

## Top 3 Recommended Actions
(Three actions with expected revenue impact)`,
  };

  return prompts[toolId] || null;
}
