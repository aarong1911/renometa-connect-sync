// netlify/functions/ai-tool-run.mjs
export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("", { status: 204 });
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  if (!ANTHROPIC_API_KEY) {
    return Response.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
  }

  try {
    const { toolId, inputs } = await req.json();

    if (!toolId || !inputs) {
      return Response.json({ error: "Missing toolId or inputs" }, { status: 400 });
    }

    const prompt = buildPrompt(toolId, inputs);
    if (!prompt) {
      return Response.json({ error: `Unknown tool: ${toolId}` }, { status: 400 });
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error("Anthropic API error:", response.status, errBody);
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

Return your response in exactly this format with these 5 sections. Use "## Section Name" as headers:

## TL;DR Summary
(2-3 sentences capturing the essential outcome)

## Key Points
(5-8 bullet points)

## Action Items with Owners & Deadlines
(Table: Action Item | Owner | Deadline | Status)

## Sentiment Analysis
(😊 Positive, 😐 Neutral, 😟 Concerned, or 😡 Negative — with evidence)

## Draft Follow-Up Message
(Ready-to-send follow-up email/text)`,

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
