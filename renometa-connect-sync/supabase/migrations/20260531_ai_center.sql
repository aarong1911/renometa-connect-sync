-- AI Center tables + seed data.
-- Run this in Supabase SQL editor. Safe to run multiple times (idempotent).

-- ── Tables ──────────────────────────────────────────────────────────────────

create table if not exists agent_definitions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  category text not null,
  icon text,
  trigger_type text not null,
  trigger_config jsonb default '{}',
  system_prompt text,
  data_sources jsonb default '[]',
  actions jsonb default '[]',
  model text default 'claude-haiku-4-5',
  created_at timestamptz default now()
);

create table if not exists agent_instances (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id) on delete cascade,
  agent_definition_id uuid references agent_definitions(id),
  is_enabled boolean default false,
  config_overrides jsonb default '{}',
  runs_this_week int default 0,
  success_rate float default 0,
  hours_saved float default 0,
  last_run_at timestamptz,
  created_at timestamptz default now(),
  unique(org_id, agent_definition_id)
);

create table if not exists agent_runs (
  id uuid primary key default gen_random_uuid(),
  agent_instance_id uuid references agent_instances(id),
  org_id uuid references organizations(id),
  status text default 'running',
  trigger_data jsonb,
  actions_taken jsonb default '[]',
  result_summary text,
  tokens_used int,
  cost_usd float,
  started_at timestamptz default now(),
  completed_at timestamptz
);

create table if not exists tool_definitions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  category text not null,
  icon text,
  input_schema jsonb default '[]',
  system_prompt text,
  model text default 'claude-haiku-4-5',
  created_at timestamptz default now()
);

create table if not exists tool_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id),
  tool_definition_id uuid references tool_definitions(id),
  user_id uuid references profiles(id),
  input jsonb,
  output text,
  tokens_used int,
  cost_usd float,
  created_at timestamptz default now()
);

-- Safely extend leads table for AI fields
alter table leads add column if not exists score int;
alter table leads add column if not exists ai_quality text;
alter table leads add column if not exists last_contacted_at timestamptz;
alter table leads add column if not exists ai_notes text;

-- ── Seed agent_definitions (skip if already seeded) ─────────────────────────

do $$
begin
  if (select count(*) from agent_definitions) = 0 then

    insert into agent_definitions (name, description, category, icon, trigger_type, trigger_config, data_sources, actions, model, system_prompt) values

    ('Lead Qualifier',
     'Scores inbound leads on budget, timeline, project type, and source. Routes hot leads and adds a qualification summary note.',
     'sales', 'filter', 'event',
     '{"event_type":"new_lead"}',
     '[{"type":"lead","from":"trigger"}]',
     '[{"type":"update_lead_score"},{"type":"insert_note"}]',
     'claude-haiku-4-5',
     'You are an expert lead qualification AI for a home improvement contractor. Analyze the lead data and score the quality.

Return ONLY valid JSON — no markdown, no explanation:
{"quality":"hot|warm|cold","score":0-100,"reason":"one concise sentence","qualification_summary":"2-3 sentence summary covering budget fit, timeline, job type alignment, and source quality"}

Scoring guide:
- Hot (80-100): Clear budget ≥$10k, defined timeline, job matches services, warm referral or direct inquiry
- Warm (50-79): Some budget clarity, vague timeline, job type fits
- Cold (0-49): No budget stated, unclear scope, cold channel, or out-of-area'),

    ('Speed-to-Lead Responder',
     'Replies to new leads within 60 seconds via SMS. Friendly, under 160 characters, always includes the company name.',
     'sales', 'zap', 'event',
     '{"event_type":"new_lead"}',
     '[{"type":"lead","from":"trigger"},{"type":"org"}]',
     '[{"type":"send_sms"}]',
     'claude-haiku-4-5',
     'You are a fast-response SMS agent for a home improvement contractor.

Write a single friendly SMS reply to a new lead. Rules:
- Maximum 160 characters total
- Must include the company name
- Warm and human — never robotic
- Ask one simple question to keep the conversation going

Return ONLY the SMS message text — nothing else.'),

    ('Follow-Up Agent',
     'Daily sweep of cold and stalled leads. Sends personalized follow-up SMS to each, updates last_contacted_at, and adds a note.',
     'sales', 'clock', 'scheduled',
     '{"cron":"0 9 * * *","label":"Daily 9:00 AM"}',
     '[{"type":"leads","filter":"needs_followup"}]',
     '[{"type":"send_sms"},{"type":"update_lead_contacted"},{"type":"insert_note"}]',
     'claude-haiku-4-5',
     'You are a follow-up specialist for a home improvement contractor.

For each lead provided, write a personalized follow-up SMS. Rules per message:
- Under 160 characters
- Reference their specific job type (kitchen, bathroom, roof, etc.)
- Feel genuine — not a mass-blast
- Include company name once

Return ONLY valid JSON — no markdown:
[{"lead_id":"uuid","phone":"10-digit","message":"sms text"}]

If there are no leads to follow up with, return an empty array: []'),

    ('Estimate Drafter',
     'Turns job notes into a detailed line-item estimate using historical pricing. Creates a draft estimate record.',
     'ops', 'clipboard-list', 'manual',
     '{"input_field":"job_notes","label":"Job notes / site visit summary"}',
     '[{"type":"estimates","filter":"recent_similar","limit":5},{"type":"org"}]',
     '[{"type":"create_estimate"}]',
     'claude-sonnet-4-5',
     'You are a senior construction estimator for a home improvement contractor.

Using the job notes and historical estimates as reference, create a realistic line-item estimate.

Return ONLY valid JSON — no markdown:
{"line_items":[{"description":"text","quantity":1,"unit":"ea|lf|sf|ls|hr","unit_price":0,"total":0}],"subtotal":0,"suggested_margin_percent":0,"notes":"any caveats or assumptions"}

Guidelines:
- Base pricing on the historical estimates provided
- Include all trades (demo, rough-in, finish, cleanup)
- Realistic market rates for residential remodeling'),

    ('Client Update Agent',
     'Every Monday sends a brief friendly progress SMS to clients on all active projects, based on real task and note activity.',
     'ops', 'message-square', 'scheduled',
     '{"cron":"0 8 * * 1","label":"Monday 8:00 AM"}',
     '[{"type":"projects","filter":"active"},{"type":"tasks","filter":"done_this_week"}]',
     '[{"type":"send_sms"}]',
     'claude-haiku-4-5',
     'You are a client communications specialist for a home improvement contractor.

For each active project, write a brief friendly progress SMS for the homeowner.
Rules:
- Under 160 characters per message
- Mention one concrete milestone or task completed this week
- Warm, professional tone
- Include company name

Return ONLY valid JSON — no markdown:
[{"project_id":"uuid","phone":"10-digit","message":"sms text"}]

If a project has no recent activity, skip it (omit from array).'),

    ('Collections Agent',
     'Daily sweep of overdue invoices. Sends polite SMS reminders, adds collection notes, and creates escalation tasks for invoices overdue 30+ days.',
     'financials', 'receipt', 'scheduled',
     '{"cron":"0 10 * * *","label":"Daily 10:00 AM"}',
     '[{"type":"invoices","filter":"overdue"}]',
     '[{"type":"send_sms"},{"type":"insert_note"},{"type":"create_task"}]',
     'claude-haiku-4-5',
     'You are a collections specialist for a home improvement contractor.

For each overdue invoice, generate an appropriate reminder SMS calibrated to days overdue.

Days 1-14: Friendly reminder
Days 15-29: Polite but firm — mention the specific amount
Days 30+: Serious, set escalate=true

Return ONLY valid JSON — no markdown:
[{"invoice_id":"uuid","contact_phone":"10-digit","message":"sms text under 160 chars","note":"internal note text","escalate":false,"days_overdue":0}]'),

    ('Review Agent',
     'Fires when a project is marked complete. Sends a warm, personalized review request SMS to the client.',
     'marketing', 'star', 'event',
     '{"event_type":"project_status_changed","to_status":"completed"}',
     '[{"type":"project","from":"trigger"}]',
     '[{"type":"send_sms"}]',
     'claude-haiku-4-5',
     'You are a reputation manager for a home improvement contractor.

Write a warm, personal review request SMS to a client whose project just completed.

Rules:
- Under 160 characters
- Reference the specific project name
- Never feel spammy or automated
- Include a Google review link placeholder: {REVIEW_LINK}

Return ONLY the SMS message text — nothing else.'),

    ('Inbox Triage Agent',
     'Every 2 hours reviews unread client messages. Classifies urgency, adds AI summaries, and drafts suggested replies for urgent items.',
     'internal', 'inbox', 'scheduled',
     '{"cron":"0 */2 * * *","label":"Every 2 hours"}',
     '[{"type":"messages","filter":"unread","limit":20}]',
     '[{"type":"insert_note"},{"type":"update_priority"}]',
     'claude-haiku-4-5',
     'You are an inbox triage assistant for a home improvement contractor.

Urgency guide:
- urgent: Client complaint, payment issue, project blocker, safety concern
- normal: Status question, scheduling request, general inquiry
- low: Thank-you note, FYI, no action required

Return ONLY valid JSON — no markdown:
{"triaged":[{"message_id":"uuid","urgency":"urgent|normal|low","summary":"one sentence summary","suggested_reply":"draft reply text or null if not urgent"}]}'),

    ('Voicemail Agent',
     'Fires on missed calls. Classifies caller intent, sends an SMS callback, and creates a lead if the caller is not in contacts.',
     'internal', 'voicemail', 'event',
     '{"event_type":"missed_call"}',
     '[{"type":"voice_call","from":"trigger"}]',
     '[{"type":"send_sms"},{"type":"create_lead"}]',
     'claude-haiku-4-5',
     'You are a voicemail analysis assistant for a home improvement contractor.

Analyze the call transcript or caller info to determine intent and draft an appropriate callback SMS.

Return ONLY valid JSON — no markdown:
{"intent":"new_lead|existing_client|vendor|wrong_number|other","callback_message":"sms text under 160 chars","is_new_lead":true,"lead_job_type":"kitchen|bathroom|roof|addition|other or null"}'),

    ('Estimate Reviewer',
     'Reviews a draft estimate against historical pricing. Flags missing line items, pricing outliers, and returns a scored review as a project note.',
     'internal', 'eye', 'manual',
     '{"input_field":"estimate_id","label":"Select an estimate to review"}',
     '[{"type":"estimate","from":"trigger"},{"type":"estimates","filter":"similar","limit":3}]',
     '[{"type":"insert_note"}]',
     'claude-sonnet-4-5',
     'You are a senior estimating consultant reviewing a draft estimate for a home improvement contractor.

Return ONLY valid JSON — no markdown:
{"missing_items":["description of missing line item"],"pricing_flags":[{"item":"line item description","issue":"explanation"}],"suggestions":["actionable suggestion"],"overall_score":0,"score_rationale":"one sentence"}

Score guide: 90-100 = ready to send, 70-89 = minor tweaks, below 70 = significant gaps');

  end if;
end $$;

-- ── Seed tool_definitions (skip if already seeded) ───────────────────────────

do $$
begin
  if (select count(*) from tool_definitions) = 0 then

    insert into tool_definitions (name, description, category, icon, model, input_schema, system_prompt) values

    ('Proposal Writer',
     'Writes a professional project proposal tailored to the client and job type, ready to send or customize.',
     'sales', 'file-text', 'claude-sonnet-4-5',
     '[{"key":"client_name","label":"Client Name","type":"text","placeholder":"e.g. Sarah Johnson"},{"key":"job_type","label":"Job Type","type":"select","options":["Kitchen Remodel","Bathroom Remodel","Addition","Full Renovation","Roofing","Siding","Windows & Doors","Flooring","Painting","Deck / Outdoor","Other"]},{"key":"scope_notes","label":"Scope Notes","type":"textarea","placeholder":"Describe the project scope, special requirements, client preferences..."},{"key":"budget_range","label":"Budget Range","type":"text","placeholder":"e.g. $50,000 – $80,000"},{"key":"timeline","label":"Timeline","type":"select","options":["1-2 weeks","2-4 weeks","1-2 months","2-4 months","4-6 months","6+ months"]}]',
     'You are a professional proposal writer for a home improvement contracting company.

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

Write flowing prose under each heading — not bullet points. Make the client feel excited and confident.
Include the org name where you see {ORG_NAME}, phone as {ORG_PHONE}, address as {ORG_ADDRESS}.'),

    ('CRM Update',
     'Extracts structured CRM data from raw call notes, emails, or SMS threads — contact info, project details, action items, and sentiment.',
     'crm', 'brain', 'claude-haiku-4-5',
     '[{"key":"raw_text","label":"Raw Conversation Text","type":"textarea","placeholder":"Paste call notes, email thread, or SMS conversation here..."}]',
     'You are a CRM data extraction specialist for a home improvement contractor.

Extract all structured data from the raw conversation text provided.

Return ONLY valid JSON — no markdown, no explanation:
{"contact":{"name":"full name or null","phone":"10-digit or null","email":"email or null","address":"property address or null"},"project":{"type":"job type or null","scope":"brief scope description or null","budget":"budget mentioned or null","timeline":"timeline mentioned or null"},"action_items":[{"task":"task description","owner":"who should do it","due":"due date or null"}],"sentiment":"positive|neutral|negative","follow_up_date":"YYYY-MM-DD or null","pipeline_stage":"new_lead|discovery|estimate_sent|negotiation|won|lost or null"}'),

    ('Conversation Summary',
     'Transforms long conversations and call transcripts into concise summaries with key points, action items, and a follow-up draft.',
     'crm', 'message-square', 'claude-haiku-4-5',
     '[{"key":"conversation_text","label":"Conversation / Transcript","type":"textarea","placeholder":"Paste the full conversation, call transcript, or email thread here..."}]',
     'You are a conversation analysis specialist for a home improvement contractor.

Analyze the conversation and return a structured summary.

Return ONLY valid JSON — no markdown:
{"summary":"2-3 sentence TL;DR","key_points":["key point 1","key point 2"],"action_items":[{"task":"task description","owner":"who","due":"due date or ASAP or null"}],"follow_up_draft":"a ready-to-send follow-up email or SMS draft","sentiment":"positive|neutral|negative","next_pipeline_stage":"recommended next stage or null"}'),

    ('Task Extractor',
     'Scans meeting notes, transcripts, or project notes and extracts a clean task list with priorities, owners, and due dates.',
     'crm', 'list-checks', 'claude-haiku-4-5',
     '[{"key":"notes_text","label":"Notes / Transcript","type":"textarea","placeholder":"Paste meeting notes, call transcript, or project notes here..."}]',
     'You are a task extraction specialist for a home improvement contractor.

Extract every actionable task from the text provided.

Return ONLY valid JSON — no markdown:
[{"title":"short action-oriented task title","priority":"high|medium|low","assignee_hint":"who should do it or null","due_date_hint":"due date or timeframe mentioned or null","context":"one sentence of context"}]

If no tasks found, return an empty array: []'),

    ('AI Insights',
     'Analyzes your business data for the selected period and surfaces high-impact insights, opportunities, and recommended actions.',
     'operations', 'bar-chart-3', 'claude-sonnet-4-5',
     '[{"key":"date_range","label":"Analysis Period","type":"select","options":["30","60","90"],"placeholder":"Select period"}]',
     'You are a business intelligence analyst for a home improvement contracting company.

Analyze the business data provided and generate actionable insights. Be specific — reference actual numbers.

Return ONLY valid JSON — no markdown:
{"insights":[{"title":"short insight title","description":"2-3 sentence insight with specific data references","impact":"high|medium|low"}],"opportunities":[{"title":"opportunity title","description":"specific, actionable opportunity based on the data"}],"recommended_actions":[{"action":"specific action to take","priority":"high|medium|low","estimated_impact":"what outcome to expect"}]}

Generate 3-5 insights, 2-3 opportunities, and 3 recommended actions. Be concrete, not generic.');

  end if;
end $$;

-- ── RLS policies ─────────────────────────────────────────────────────────────
-- agent_definitions and tool_definitions are global read-only data.
-- agent_instances, agent_runs, tool_runs are org-scoped.

alter table agent_definitions enable row level security;
drop policy if exists "ai_agent_definitions_read" on agent_definitions;
create policy "ai_agent_definitions_read" on agent_definitions
  for select to authenticated using (true);

alter table tool_definitions enable row level security;
drop policy if exists "ai_tool_definitions_read" on tool_definitions;
create policy "ai_tool_definitions_read" on tool_definitions
  for select to authenticated using (true);

alter table agent_instances enable row level security;
drop policy if exists "ai_agent_instances_all" on agent_instances;
create policy "ai_agent_instances_all" on agent_instances
  for all to authenticated using (
    org_id in (
      select org_id from org_memberships where member_id = auth.uid()
      union
      select organization_id from profiles where id = auth.uid()
    )
  );

alter table agent_runs enable row level security;
drop policy if exists "ai_agent_runs_read" on agent_runs;
create policy "ai_agent_runs_read" on agent_runs
  for select to authenticated using (
    org_id in (
      select org_id from org_memberships where member_id = auth.uid()
      union
      select organization_id from profiles where id = auth.uid()
    )
  );

alter table tool_runs enable row level security;
drop policy if exists "ai_tool_runs_all" on tool_runs;
create policy "ai_tool_runs_all" on tool_runs
  for all to authenticated using (
    org_id in (
      select org_id from org_memberships where member_id = auth.uid()
      union
      select organization_id from profiles where id = auth.uid()
    )
  );
