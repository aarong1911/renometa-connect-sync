---
name: ai-center
description: >
  Full context for the RenoMeta Connect AI Center feature — Autonomous Agents
  and AI Tools. Covers agent definitions, tool definitions, data sources,
  Anthropic API patterns, execution architecture, DB schema, and all
  contractor-specific prompting conventions. Use at the start of any session
  involving AI Center, autonomous agents, AI tools, agent runs, or anything
  in /automation/agents. Also triggers on: Lead Qualifier, Speed-to-Lead,
  Follow-Up Agent, Estimate Drafter, Collections Agent, Review Agent,
  Inbox Triage, Voicemail Agent, Estimate Reviewer, Proposal Writer,
  CRM Update, Conversation Summary, Task Extractor, AI Insights.
---

# RenoMeta Connect — AI Center Skill

## Architecture Overview

AI Center has two tabs:
1. **Autonomous Agents** — run on a schedule or trigger, operate independently
2. **AI Tools** — run on demand by the user, take input and return output

Both use Claude API (`claude-haiku-4-5` for speed/cost, `claude-sonnet-4-5` for complex reasoning).

## Anthropic API Call Pattern

```typescript
const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": process.env.ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model: "claude-haiku-4-5",   // haiku for agents, sonnet for tools
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  }),
});
const data = await response.json();
const text = data.content[0].text;
```

Always request JSON output for structured data:
```
Respond ONLY with valid JSON. No markdown, no explanation, no backticks.
```

## DB Schema

```sql
-- Agent definitions (seeded, not user-created)
agent_definitions (
  id, name, description, category, icon,
  trigger_type,     -- scheduled | event | manual
  trigger_config,   -- { cron, event_type, etc. }
  system_prompt,    -- the Claude system prompt
  data_sources,     -- jsonb array of what data it reads
  actions,          -- jsonb array of what it can do
  model,            -- claude-haiku-4-5 | claude-sonnet-4-5
  is_active default false
)

-- Per-org agent instances
agent_instances (
  id, org_id, agent_definition_id,
  is_enabled,       -- owner toggles on/off
  config_overrides, -- org-specific customizations
  runs_this_week, success_rate, hours_saved,
  last_run_at, created_at
)

-- Agent run history
agent_runs (
  id, agent_instance_id, org_id,
  status,           -- running | completed | failed
  trigger_data,     -- what triggered this run
  actions_taken,    -- jsonb array of what it did
  result_summary,   -- human-readable summary
  tokens_used, cost_usd,
  started_at, completed_at
)

-- Tool definitions (seeded)
tool_definitions (
  id, name, description, category, icon,
  input_schema,     -- jsonb: what fields the user fills in
  system_prompt,
  model
)

-- Tool run history
tool_runs (
  id, org_id, tool_definition_id, user_id,
  input, output,
  tokens_used, cost_usd,
  created_at
)
```

## Autonomous Agents — 10 Agents

### Category: Sales & Lead Response

**Lead Qualifier**
- Trigger: `new_lead` event
- Data: lead record (name, source, phone, notes, job type)
- Actions: update lead score, add qualification note, assign to sales rep
- Model: haiku

**Speed-to-Lead Responder**
- Trigger: `new_lead` event (within 60s)
- Data: lead record, org name, phone
- Actions: send SMS reply via Twilio
- Model: haiku

**Follow-Up Agent**
- Trigger: scheduled (daily cron)
- Data: leads with status=cold or last_contacted > 7 days
- Actions: send SMS, update lead status, add note
- Model: haiku

### Category: Estimating & Project Ops

**Estimate Drafter**
- Trigger: manual (user provides job notes)
- Data: org's past estimates for similar job types, material catalog
- Actions: create draft estimate with line items
- Model: sonnet

**Client Update Agent**
- Trigger: scheduled (weekly, Monday 8am)
- Data: active projects (status, completion %, recent notes, tasks done this week)
- Actions: send SMS or email progress update to client
- Model: haiku

### Category: Financials

**Collections Agent**
- Trigger: scheduled (daily)
- Data: invoices with status=overdue, days_overdue, amount
- Actions: send SMS reminder, add collection note, escalate task if >30 days
- Model: haiku

### Category: Reputation & Marketing

**Review Agent**
- Trigger: `project_status_changed` to completed
- Data: project record, client contact info
- Actions: send SMS review request (after 1 day delay)
- Model: haiku

### Category: Internal / Horizontal

**Inbox Triage Agent**
- Trigger: scheduled (every 2 hours)
- Data: unread inbox conversations (last 20)
- Actions: add AI summary label, draft reply suggestion, flag urgent items
- Model: haiku

**Voicemail Agent**
- Trigger: `missed_call` event (from Vapi webhook)
- Data: call record, transcript if available, caller phone
- Actions: classify intent, send SMS callback, create lead if new number
- Model: haiku

**Estimate Reviewer** (custom addition)
- Trigger: manual (user runs on a draft estimate)
- Data: estimate line items, job type, org's historical estimates for same type
- Actions: add review comments, flag missing items, suggest pricing adjustments
- Model: sonnet

## AI Tools — 5 Tools

**Proposal Writer** (Sales)
- Input: client name, job type, scope notes, budget range
- Output: full professional proposal text ready to send
- Model: sonnet

**CRM Update** (CRM Intelligence)
- Input: raw conversation text (call notes, email, SMS)
- Output: structured JSON with contact info, project details, action items, sentiment
- Actions: optionally updates contact/lead record directly
- Model: haiku

**Conversation Summary** (CRM Intelligence)
- Input: conversation thread or call transcript
- Output: summary with key points, action items, follow-up draft
- Model: haiku

**Task Extractor** (CRM Intelligence)
- Input: notes, conversation, or meeting transcript
- Output: structured task list with priorities, owners, due dates
- Model: haiku

**AI Insights** (Operations & Insights)
- Input: date range (last 30/60/90 days)
- Data: leads, projects, invoices, pipeline value from DB
- Output: top 3 insights, opportunities, recommended actions
- Model: sonnet

## Real Data Fetching Pattern

Each agent/tool fetches live data from Supabase before calling Claude:

```typescript
// Example: Collections Agent
const { data: overdueInvoices } = await supabaseAdmin
  .from("invoices")
  .select("id, invoice_number, total_amount, amount_paid, due_date, client_id, contacts(full_name, phone, email)")
  .eq("org_id", orgId)
  .eq("status", "overdue")
  .order("due_date");

const prompt = `You are the collections agent for ${orgName}.
Review these overdue invoices and decide the appropriate action for each.
Invoices: ${JSON.stringify(overdueInvoices)}
...`;
```

## Execution Architecture

- **Netlify function**: `run-agent.ts` — called by cron or event trigger
- **Netlify function**: `run-tool.ts` — called on demand from UI
- Both write to `agent_runs` / `tool_runs` tables
- UI polls run status or uses Supabase realtime subscription
- Agent toggles (on/off) stored in `agent_instances.is_enabled`

## Env Vars Required

```
ANTHROPIC_API_KEY   # Claude API
TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER  # SMS actions
SMTP_USER, SMTP_PASSWORD  # Email actions
```

## Prompting Conventions

- Always include org name, contractor type in system prompt
- Use contractor-appropriate tone: professional but direct
- SMS messages: max 160 chars, always include company name
- Always request JSON for structured output, plain text for messages
- Include real data counts in prompts ("You have 3 overdue invoices...")
- Never hallucinate client names — only use data passed in context