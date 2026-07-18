/**
 * seed-ai-center.ts
 * Seeds agent_definitions and tool_definitions tables.
 * Run with: npx tsx supabase/seed-ai-center.ts
 * Or triggered automatically from run-agent / run-tool when tables are empty.
 */

import { createClient } from "@supabase/supabase-js";

// Env vars are injected by Netlify at runtime.
// For local standalone runs: set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in your shell,
// or use: dotenv -e .env npx tsx supabase/seed-ai-center.ts

const supabase = createClient(
  process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// ── Agent Definitions ────────────────────────────────────────────────────────

const AGENT_DEFINITIONS = [
  // ── Sales & Lead Response ────────────────────────────────────────────────
  {
    name: "Lead Qualifier",
    description:
      "Scores inbound leads on budget, timeline, project type, and source. Routes hot leads and adds a qualification summary note.",
    category: "sales",
    icon: "filter",
    trigger_type: "event",
    trigger_config: { event_type: "new_lead" },
    data_sources: [{ type: "lead", from: "trigger" }],
    actions: [{ type: "update_lead_score" }, { type: "insert_note" }],
    model: "claude-haiku-4-5",
    system_prompt: `You are an expert lead qualification AI for a home improvement contractor. Analyze the lead data and score the quality.

Return ONLY valid JSON — no markdown, no explanation:
{
  "quality": "hot|warm|cold",
  "score": 0-100,
  "reason": "one concise sentence explaining the score",
  "qualification_summary": "2-3 sentence summary covering budget fit, timeline, job type alignment, and source quality"
}

Scoring guide:
- Hot (80-100): Clear budget ≥$10k, defined timeline, job matches services, warm referral or direct inquiry
- Warm (50-79): Some budget clarity, vague timeline, job type fits
- Cold (0-49): No budget stated, unclear scope, cold channel (Angi/generic), or out-of-area`,
  },
  {
    name: "Speed-to-Lead Responder",
    description:
      "Replies to new leads within 60 seconds via SMS. Friendly, under 160 characters, always includes the company name.",
    category: "sales",
    icon: "zap",
    trigger_type: "event",
    trigger_config: { event_type: "new_lead" },
    data_sources: [{ type: "lead", from: "trigger" }, { type: "org" }],
    actions: [{ type: "send_sms" }],
    model: "claude-haiku-4-5",
    system_prompt: `You are a fast-response SMS agent for a home improvement contractor.

Write a single friendly SMS reply to a new lead. Rules:
- Maximum 160 characters total
- Must include the company name
- Warm and human — never robotic
- Ask one simple question to keep the conversation going
- No emojis unless the brand uses them

Return ONLY the SMS message text — nothing else.`,
  },
  {
    name: "Follow-Up Agent",
    description:
      "Daily sweep of cold and stalled leads. Sends personalized follow-up SMS to each, updates last_contacted_at, and adds a note.",
    category: "sales",
    icon: "clock",
    trigger_type: "scheduled",
    trigger_config: { cron: "0 9 * * *", label: "Daily 9:00 AM" },
    data_sources: [{ type: "leads", filter: "needs_followup" }],
    actions: [
      { type: "send_sms" },
      { type: "update_lead_contacted" },
      { type: "insert_note" },
    ],
    model: "claude-haiku-4-5",
    system_prompt: `You are a follow-up specialist for a home improvement contractor.

For each lead provided, write a personalized follow-up SMS. Rules per message:
- Under 160 characters
- Reference their specific job type (kitchen, bathroom, roof, etc.)
- Feel genuine — not a mass-blast
- Soft call to action (schedule a visit, answer a question)
- Include company name once

Return ONLY valid JSON — no markdown:
[
  { "lead_id": "uuid", "phone": "10-digit", "message": "sms text" }
]

If there are no leads to follow up with, return an empty array: []`,
  },

  // ── Estimating & Project Ops ─────────────────────────────────────────────
  {
    name: "Estimate Drafter",
    description:
      "Turns job notes into a detailed line-item estimate using historical pricing. Creates a draft estimate record.",
    category: "ops",
    icon: "clipboard-list",
    trigger_type: "manual",
    trigger_config: { input_field: "job_notes", label: "Job notes / site visit summary" },
    data_sources: [
      { type: "estimates", filter: "recent_similar", limit: 5 },
      { type: "org" },
    ],
    actions: [{ type: "create_estimate" }],
    model: "claude-sonnet-4-5",
    system_prompt: `You are a senior construction estimator for a home improvement contractor.

Using the job notes and historical estimates as reference, create a realistic line-item estimate.

Return ONLY valid JSON — no markdown:
{
  "line_items": [
    { "description": "text", "quantity": number, "unit": "ea|lf|sf|ls|hr", "unit_price": number, "total": number }
  ],
  "subtotal": number,
  "suggested_margin_percent": number,
  "notes": "any caveats or assumptions"
}

Guidelines:
- Base pricing on the historical estimates provided
- Include all trades (demo, rough-in, finish, cleanup)
- Flag anything missing from the notes with a note
- Realistic market rates for residential remodeling`,
  },
  {
    name: "Client Update Agent",
    description:
      "Every Monday sends a brief friendly progress SMS to clients on all active projects, based on real task and note activity.",
    category: "ops",
    icon: "message-square",
    trigger_type: "scheduled",
    trigger_config: { cron: "0 8 * * 1", label: "Monday 8:00 AM" },
    data_sources: [
      { type: "projects", filter: "active" },
      { type: "tasks", filter: "done_this_week" },
    ],
    actions: [{ type: "send_sms" }],
    model: "claude-haiku-4-5",
    system_prompt: `You are a client communications specialist for a home improvement contractor.

For each active project, write a brief friendly progress SMS for the homeowner.
Rules:
- Under 160 characters per message
- Mention one concrete milestone or task completed this week
- Warm, professional tone — they're paying a lot of money
- Include company name

Return ONLY valid JSON — no markdown:
[
  { "project_id": "uuid", "phone": "10-digit", "message": "sms text" }
]

If a project has no recent activity, skip it (omit from array).`,
  },

  // ── Financials ───────────────────────────────────────────────────────────
  {
    name: "Collections Agent",
    description:
      "Daily sweep of overdue invoices. Sends polite SMS reminders, adds collection notes, and creates escalation tasks for invoices overdue 30+ days.",
    category: "financials",
    icon: "receipt",
    trigger_type: "scheduled",
    trigger_config: { cron: "0 10 * * *", label: "Daily 10:00 AM" },
    data_sources: [{ type: "invoices", filter: "overdue" }],
    actions: [
      { type: "send_sms" },
      { type: "insert_note" },
      { type: "create_task" },
    ],
    model: "claude-haiku-4-5",
    system_prompt: `You are a collections specialist for a home improvement contractor.

For each overdue invoice, generate an appropriate reminder message calibrated to days overdue.

Days 1-14: Friendly reminder
Days 15-29: Polite but firm — mention the specific amount
Days 30+: Serious, set escalate=true

Return ONLY valid JSON — no markdown:
[
  {
    "invoice_id": "uuid",
    "contact_phone": "10-digit",
    "message": "sms text under 160 chars",
    "note": "internal note text",
    "escalate": false,
    "days_overdue": number
  }
]`,
  },

  // ── Reputation & Marketing ───────────────────────────────────────────────
  {
    name: "Review Agent",
    description:
      "Fires when a project is marked complete. Waits 24 hours then sends a warm, personalized review request SMS to the client.",
    category: "marketing",
    icon: "star",
    trigger_type: "event",
    trigger_config: {
      event_type: "project_status_changed",
      to_status: "completed",
    },
    data_sources: [{ type: "project", from: "trigger" }],
    actions: [{ type: "send_sms" }],
    model: "claude-haiku-4-5",
    system_prompt: `You are a reputation manager for a home improvement contractor.

Write a warm, personal review request SMS to a client whose project just completed.

Rules:
- Under 160 characters
- Reference the specific project name
- Never feel spammy or automated
- Include a Google Maps or Google review link placeholder: {REVIEW_LINK}
- Warm closing

Return ONLY the SMS message text — nothing else.`,
  },

  // ── Internal / Horizontal ────────────────────────────────────────────────
  {
    name: "Inbox Triage Agent",
    description:
      "Every 2 hours reviews unread client messages. Classifies urgency, adds AI summaries, and drafts suggested replies for urgent items.",
    category: "internal",
    icon: "inbox",
    trigger_type: "scheduled",
    trigger_config: { cron: "0 */2 * * *", label: "Every 2 hours" },
    data_sources: [{ type: "messages", filter: "unread", limit: 20 }],
    actions: [{ type: "insert_note" }, { type: "update_priority" }],
    model: "claude-haiku-4-5",
    system_prompt: `You are an inbox triage assistant for a home improvement contractor.

Analyze each message and classify urgency. For urgent messages, draft a suggested reply.

Urgency guide:
- urgent: Client complaint, payment issue, project blocker, safety concern
- normal: Status question, scheduling request, general inquiry
- low: Thank-you note, FYI, no action required

Return ONLY valid JSON — no markdown:
{
  "triaged": [
    {
      "message_id": "uuid",
      "urgency": "urgent|normal|low",
      "summary": "one sentence summary",
      "suggested_reply": "draft reply text or null if not urgent"
    }
  ]
}`,
  },
  {
    name: "Voicemail Agent",
    description:
      "Fires on missed calls. Transcribes, classifies caller intent, sends an SMS callback, and creates a lead if the caller is not in contacts.",
    category: "internal",
    icon: "voicemail",
    trigger_type: "event",
    trigger_config: { event_type: "missed_call" },
    data_sources: [{ type: "voice_call", from: "trigger" }],
    actions: [{ type: "send_sms" }, { type: "create_lead" }],
    model: "claude-haiku-4-5",
    system_prompt: `You are a voicemail analysis assistant for a home improvement contractor.

Analyze the call transcript or caller info to determine intent and draft an appropriate callback SMS.

Return ONLY valid JSON — no markdown:
{
  "intent": "new_lead|existing_client|vendor|wrong_number|other",
  "callback_message": "sms text under 160 chars — warm, personalized, from the company",
  "is_new_lead": true/false,
  "lead_job_type": "kitchen|bathroom|roof|addition|other or null"
}`,
  },
  {
    name: "Estimate Reviewer",
    description:
      "Reviews a draft estimate against historical pricing. Flags missing line items, pricing outliers, and returns a scored review as a project note.",
    category: "internal",
    icon: "eye",
    trigger_type: "manual",
    trigger_config: {
      input_field: "estimate_id",
      label: "Select an estimate to review",
    },
    data_sources: [
      { type: "estimate", from: "trigger" },
      { type: "estimates", filter: "similar", limit: 3 },
    ],
    actions: [{ type: "insert_note" }],
    model: "claude-sonnet-4-5",
    system_prompt: `You are a senior estimating consultant reviewing a draft estimate for a home improvement contractor.

Compare the estimate against historical examples and identify issues.

Return ONLY valid JSON — no markdown:
{
  "missing_items": ["description of missing line item"],
  "pricing_flags": [
    { "item": "line item description", "issue": "explanation of pricing concern" }
  ],
  "suggestions": ["actionable suggestion text"],
  "overall_score": 0-100,
  "score_rationale": "one sentence explanation of the score"
}

Score guide: 90-100 = ready to send, 70-89 = minor tweaks needed, below 70 = significant gaps`,
  },
];

// ── Tool Definitions ─────────────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    name: "Proposal Writer",
    description:
      "Writes a professional project proposal tailored to the client and job type, ready to send or customize.",
    category: "sales",
    icon: "file-text",
    model: "claude-sonnet-4-5",
    input_schema: [
      { key: "client_name", label: "Client Name", type: "text", placeholder: "e.g. Sarah Johnson" },
      {
        key: "job_type",
        label: "Job Type",
        type: "select",
        options: [
          "Kitchen Remodel",
          "Bathroom Remodel",
          "Addition",
          "Full Renovation",
          "Roofing",
          "Siding",
          "Windows & Doors",
          "Flooring",
          "Painting",
          "Deck / Outdoor",
          "Other",
        ],
      },
      {
        key: "scope_notes",
        label: "Scope Notes",
        type: "textarea",
        placeholder: "Describe the project scope, special requirements, client preferences...",
      },
      { key: "budget_range", label: "Budget Range", type: "text", placeholder: "e.g. $50,000 – $80,000" },
      {
        key: "timeline",
        label: "Timeline",
        type: "select",
        options: ["1-2 weeks", "2-4 weeks", "1-2 months", "2-4 months", "4-6 months", "6+ months"],
      },
    ],
    system_prompt: `You are a professional proposal writer for a home improvement contracting company.

Write a comprehensive, polished project proposal. Use warm but professional contractor language.
Make it specific to the client name, job type, scope, and budget provided.

Structure the proposal with these clearly labeled sections:
1. Introduction & Thank You
2. Project Overview
3. Scope of Work
4. Timeline & Milestones
5. Investment
6. Our Commitment
7. Next Steps

Write it as flowing prose under each heading — not bullet points. Make the client feel excited and confident.
Include the org name where you see {ORG_NAME}, phone as {ORG_PHONE}, address as {ORG_ADDRESS}.`,
  },
  {
    name: "CRM Update",
    description:
      "Extracts structured CRM data from raw call notes, emails, or SMS threads — contact info, project details, action items, and sentiment.",
    category: "crm",
    icon: "brain",
    model: "claude-haiku-4-5",
    input_schema: [
      {
        key: "raw_text",
        label: "Raw Conversation Text",
        type: "textarea",
        placeholder: "Paste call notes, email thread, or SMS conversation here...",
      },
    ],
    system_prompt: `You are a CRM data extraction specialist for a home improvement contractor.

Extract all structured data from the raw conversation text provided.

Return ONLY valid JSON — no markdown, no explanation:
{
  "contact": {
    "name": "full name or null",
    "phone": "10-digit or null",
    "email": "email or null",
    "address": "property address or null"
  },
  "project": {
    "type": "job type or null",
    "scope": "brief scope description or null",
    "budget": "budget mentioned or null",
    "timeline": "timeline mentioned or null"
  },
  "action_items": [
    { "task": "task description", "owner": "who should do it", "due": "due date or null" }
  ],
  "sentiment": "positive|neutral|negative",
  "follow_up_date": "YYYY-MM-DD or null",
  "pipeline_stage": "new_lead|discovery|estimate_sent|negotiation|won|lost or null"
}`,
  },
  {
    name: "Conversation Summary",
    description:
      "Transforms long conversations and call transcripts into concise summaries with key points, action items, and a follow-up draft.",
    category: "crm",
    icon: "message-square",
    model: "claude-haiku-4-5",
    input_schema: [
      {
        key: "conversation_text",
        label: "Conversation / Transcript",
        type: "textarea",
        placeholder: "Paste the full conversation, call transcript, or email thread here...",
      },
    ],
    system_prompt: `You are a conversation analysis specialist for a home improvement contractor.

Analyze the conversation and return a structured summary.

Return ONLY valid JSON — no markdown:
{
  "summary": "2-3 sentence TL;DR",
  "key_points": ["key point 1", "key point 2"],
  "action_items": [
    { "task": "task description", "owner": "who", "due": "due date or ASAP or null" }
  ],
  "follow_up_draft": "a ready-to-send follow-up email or SMS draft",
  "sentiment": "positive|neutral|negative",
  "next_pipeline_stage": "recommended next stage or null"
}`,
  },
  {
    name: "Task Extractor",
    description:
      "Scans meeting notes, transcripts, or project notes and extracts a clean task list with priorities, owners, and due dates.",
    category: "crm",
    icon: "list-checks",
    model: "claude-haiku-4-5",
    input_schema: [
      {
        key: "notes_text",
        label: "Notes / Transcript",
        type: "textarea",
        placeholder: "Paste meeting notes, call transcript, or project notes here...",
      },
    ],
    system_prompt: `You are a task extraction specialist for a home improvement contractor.

Extract every actionable task from the text provided. Be thorough — include anything that implies work needs to be done.

Return ONLY valid JSON — no markdown:
[
  {
    "title": "short action-oriented task title",
    "priority": "high|medium|low",
    "assignee_hint": "who should do it (role or name) or null",
    "due_date_hint": "due date or timeframe mentioned or null",
    "context": "one sentence of context for why this task matters"
  }
]

If no tasks found, return an empty array: []`,
  },
  {
    name: "AI Insights",
    description:
      "Analyzes your business data for the selected period and surfaces high-impact insights, opportunities, and recommended actions.",
    category: "operations",
    icon: "bar-chart-3",
    model: "claude-sonnet-4-5",
    input_schema: [
      {
        key: "date_range",
        label: "Analysis Period",
        type: "select",
        options: ["30", "60", "90"],
        placeholder: "Select period",
      },
    ],
    system_prompt: `You are a business intelligence analyst for a home improvement contracting company.

Analyze the business data provided and generate actionable insights. Be specific — reference actual numbers from the data.

Return ONLY valid JSON — no markdown:
{
  "insights": [
    {
      "title": "short insight title",
      "description": "2-3 sentence insight with specific data references",
      "impact": "high|medium|low"
    }
  ],
  "opportunities": [
    {
      "title": "opportunity title",
      "description": "specific, actionable opportunity based on the data"
    }
  ],
  "recommended_actions": [
    {
      "action": "specific action to take",
      "priority": "high|medium|low",
      "estimated_impact": "what outcome to expect"
    }
  ]
}

Generate 3-5 insights, 2-3 opportunities, and 3 recommended actions. Be concrete, not generic.`,
  },
  {
    name: "Create Ad Campaign",
    description:
      "Creates a real campaign, ad set, and ad in your connected Meta Ads account via the Marketing API — always created PAUSED, so it's safe to try and never spends money. Activate it yourself in Meta Ads Manager when you're ready to launch.",
    category: "sales",
    icon: "trending-up",
    model: "n/a — calls the Meta Marketing API directly, not Claude",
    input_schema: [
      {
        key: "name",
        label: "Campaign Name",
        type: "text",
        placeholder: "e.g. Spring Kitchen Remodel Promo",
      },
      {
        key: "daily_budget",
        label: "Daily Budget",
        type: "number",
        prefix: "$",
        placeholder: "25",
      },
      {
        key: "objective",
        label: "Objective",
        type: "select",
        options: ["OUTCOME_LEADS", "OUTCOME_TRAFFIC", "OUTCOME_AWARENESS", "OUTCOME_ENGAGEMENT", "OUTCOME_SALES"],
        placeholder: "Select objective",
      },
      {
        key: "image",
        label: "Ad Image",
        type: "image",
      },
      {
        key: "headline",
        label: "Headline",
        type: "text",
        placeholder: "e.g. Transform Your Kitchen This Spring",
      },
      {
        key: "primary_text",
        label: "Primary Text",
        type: "textarea",
        placeholder: "The main ad copy shown above the image — what's the offer or message?",
      },
      {
        key: "description",
        label: "Description",
        type: "text",
        placeholder: "Shorter supporting text shown below the headline",
      },
      {
        key: "cta",
        label: "Call to Action",
        type: "select",
        options: ["LEARN_MORE", "GET_QUOTE", "CONTACT_US", "BOOK_TRAVEL", "SIGN_UP", "CALL_NOW", "MESSAGE_PAGE"],
        placeholder: "Select a call-to-action button",
      },
      {
        key: "destination_url",
        label: "Destination URL",
        type: "text",
        placeholder: "https://connect.renometa.com or a specific project/landing page",
      },
    ],
    // No system_prompt — this tool bypasses run-tool.mjs's Claude pipeline
    // entirely. See ai-tools-tab.tsx ToolDrawerContent.handleRun, which
    // special-cases tool.name === "Create Ad Campaign" to call
    // meta-create-ad-campaign.ts instead of /.netlify/functions/run-tool.
    system_prompt: "",
  },
];

// ── Seed runner ───────────────────────────────────────────────────────────────

export async function seedAiCenter() {
  console.log("[seed] Checking agent_definitions...");
  const { count: agentCount } = await supabase
    .from("agent_definitions")
    .select("*", { count: "exact", head: true });

  if ((agentCount ?? 0) === 0) {
    console.log("[seed] Inserting agent definitions...");
    const { error } = await supabase.from("agent_definitions").insert(AGENT_DEFINITIONS);
    if (error) {
      console.error("[seed] Failed to insert agent definitions:", error.message);
    } else {
      console.log(`[seed] Inserted ${AGENT_DEFINITIONS.length} agent definitions.`);
    }
  } else {
    console.log(`[seed] agent_definitions already has ${agentCount} rows — skipping.`);
  }

  console.log("[seed] Checking tool_definitions...");
  const { count: toolCount } = await supabase
    .from("tool_definitions")
    .select("*", { count: "exact", head: true });

  if ((toolCount ?? 0) === 0) {
    console.log("[seed] Inserting tool definitions...");
    const { error } = await supabase.from("tool_definitions").insert(TOOL_DEFINITIONS);
    if (error) {
      console.error("[seed] Failed to insert tool definitions:", error.message);
    } else {
      console.log(`[seed] Inserted ${TOOL_DEFINITIONS.length} tool definitions.`);
    }
  } else {
    console.log(`[seed] tool_definitions already has ${toolCount} rows — skipping.`);
  }

  console.log("[seed] Done.");
}

// Run directly if this is the main module
const isMain = process.argv[1]?.endsWith("seed-ai-center.ts") || process.argv[1]?.endsWith("seed-ai-center.js");
if (isMain) {
  seedAiCenter()
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
}