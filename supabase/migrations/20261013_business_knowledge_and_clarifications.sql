-- AI Center — Business Knowledge + Owner Clarification workflow.
--
-- NOT YET APPLIED. Proposed migration only — review before running. Per the
-- database-migrations skill this file is never applied automatically; the
-- owner applies it manually through the Supabase SQL Editor.
--
-- AUDIT PERFORMED BEFORE WRITING THIS:
--   - grep of supabase/migrations/ and src/ for business_knowledge /
--     ai_clarification / knowledge / faq tables: nothing exists. Both tables
--     below are NEW (confirmed absent from the repo; the live DB must still
--     be checked with the verification queries at the bottom BEFORE running
--     — `create table if not exists` below is only safe because absence is
--     being asserted, not assumed: if either table already exists live with
--     a different shape this file's later statements would be wrong, so run
--     verification query 0 first).
--   - agent_approval_requests (20260731_agentic_foundation.sql) models a
--     proposed ACTION for human approval: action_key, proposed_input +
--     hash, risk_level, execution_step_id (unique), approve/reject/execute
--     status vocabulary. A knowledge clarification has none of those
--     concepts (no action, no risk level, no hash, a free-text owner answer
--     and a save-to-knowledge flag instead), so reusing it would have
--     overloaded every one of those columns and its status vocabulary with
--     misleading meaning — hence a dedicated table.
--   - RLS pattern mirrors that file's "org members read own org ..."
--     SELECT policies (profiles.organization_id UNION org_memberships).
--   - organizations.ai_center_settings (20260913) was considered and
--     rejected for knowledge storage: an unbounded, per-entry, enable/
--     disable-able, individually-keyed list of free text does not belong in
--     a single jsonb settings blob (no per-row constraints, no per-entry
--     updated_at/created_by, no unique key).
--
-- WHAT THIS DOES: creates
--   1. business_knowledge_entries — trusted, owner-authored facts about the
--      business, one row per (org_id, key).
--   2. ai_clarification_requests — "the AI was asked a company-specific
--      question it has no trusted answer for; the owner answers once".
--
-- WHAT THIS DOES NOT DO: no change to any existing table, policy, function,
-- or grant. No backfill, no seeded rows (system_seeded is a permitted
-- `source` value for future use only). No realtime publication change.
--
-- WRITE MODEL (important): NEITHER table has an INSERT/UPDATE/DELETE policy
-- for `authenticated`. RLS is enabled, so browser clients are read-only
-- (SELECT, tenant-scoped) and every write goes through a service-role
-- Netlify function that independently verifies owner/admin authority
-- (business-knowledge.ts, ai-clarification-resolve.ts) — the model can
-- never write either table, and no client-supplied org_id is ever trusted.

-- ── 1. business_knowledge_entries ───────────────────────────────────────

create table if not exists public.business_knowledge_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  -- Canonical key: a catalog key (e.g. 'permit_handling') or 'custom_<slug>'.
  -- Unique per org so "save to Business Knowledge" is a deterministic upsert,
  -- never a pile of near-duplicate rows.
  key text not null check (char_length(key) between 1 and 80),
  -- A catalog key (same as `key`) or the literal 'custom'.
  category text not null check (char_length(category) between 1 and 80),
  question text not null check (char_length(question) between 1 and 300),
  answer text not null check (char_length(btrim(answer)) between 1 and 1000),
  source text not null default 'owner_configured'
    check (source in ('owner_configured', 'owner_clarification', 'system_seeded')),
  status text not null default 'active' check (status in ('active', 'inactive')),
  -- Typed extras, e.g. { "optionId": "handle_all" } for a multiple-choice answer.
  metadata jsonb not null default '{}'::jsonb,
  -- ORIGINAL author — set on insert, IMMUTABLE afterwards (enforced by the
  -- preserve-creator trigger below, not just by application code).
  created_by uuid references public.profiles(id) on delete set null,
  -- Most recent human editor (equals created_by until the first edit).
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, key)
);

comment on table public.business_knowledge_entries is
  'Trusted, owner-authored facts about THIS business, injected into AI agent context (netlify/functions/lib/ai/context-builder.ts). Written only by service-role functions after an owner/admin check — never by a model.';

-- Database-level backstop for created_by semantics: an UPSERT's conflict
-- path is an UPDATE, so without this a re-save would silently turn
-- created_by into "last writer". The application also avoids sending
-- created_by on update; this guarantees it even if some future writer does.
create or replace function public.business_knowledge_entries_preserve_creator()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.org_id := old.org_id;
  new.key := old.key;
  return new;
end;
$$;

drop trigger if exists business_knowledge_entries_preserve_creator on public.business_knowledge_entries;
create trigger business_knowledge_entries_preserve_creator
  before update on public.business_knowledge_entries
  for each row execute function public.business_knowledge_entries_preserve_creator();

create index if not exists idx_business_knowledge_entries_org_status
  on public.business_knowledge_entries (org_id, status);

alter table public.business_knowledge_entries enable row level security;

drop policy if exists "org members read own org business knowledge" on public.business_knowledge_entries;
create policy "org members read own org business knowledge" on public.business_knowledge_entries
  for select
  using (
    org_id in (
      select organization_id from public.profiles where id = auth.uid() and organization_id is not null
      union
      select org_id from public.org_memberships where member_id = auth.uid()
    )
  );

-- ── 2. ai_clarification_requests ───────────────────────────────────────

create table if not exists public.ai_clarification_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  -- The run that discovered the gap. Traceability only.
  execution_id uuid not null references public.agent_executions(id) on delete cascade,
  -- Required: the answer is sent back to this contact. A question with no
  -- contact to answer is never turned into a clarification request.
  contact_id uuid not null references public.contacts(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null,
  -- Original inbound message row (sms_meta_messages.id), when known. Not an
  -- FK: that table's rows are retention-managed independently.
  inbound_message_id uuid,
  channel text not null check (channel in ('sms', 'whatsapp')),
  -- Neutral restatement of what the customer asked.
  question text not null check (char_length(question) between 1 and 300),
  -- Canonical Business Knowledge key this would answer (catalog key or
  -- custom_<slug>) — also the duplicate-coalescing key.
  knowledge_key text not null check (char_length(knowledge_key) between 1 and 80),
  category text not null check (char_length(category) between 1 and 80),
  -- [{ id, label, answer }] — empty for custom/free-text-only questions.
  suggested_options jsonb not null default '[]'::jsonb,
  -- Status model:
  --   pending     awaiting the owner
  --   sending     owner submitted; an answer is being delivered (atomic claim)
  --   send_failed owner answered but delivery failed — retryable, answer kept
  --   resolved    answer delivered to the customer
  --   dismissed   owner chose not to answer; nothing was sent
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'send_failed', 'resolved', 'dismissed')),
  answer text check (answer is null or char_length(btrim(answer)) between 1 and 1000),
  option_id text,
  save_to_knowledge boolean not null default false,
  -- Set only when the knowledge upsert actually succeeded / failed.
  knowledge_saved_at timestamptz,
  knowledge_save_error text,
  send_error text,
  provider_message_id text,
  resolved_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

comment on table public.ai_clarification_requests is
  'Owner Clarification workflow: a customer asked a company-specific question with no trusted Business Knowledge answer. The owner answers once; the answer is sent to the customer and optionally saved as Business Knowledge. Written only by service-role functions.';

-- Duplicate coalescing: at most ONE unresolved clarification per
-- (org, contact, knowledge_key). Resolved/dismissed rows are history and
-- never block a new question.
create unique index if not exists uq_ai_clarification_open_per_contact_key
  on public.ai_clarification_requests (org_id, contact_id, knowledge_key)
  where status in ('pending', 'sending', 'send_failed');

create index if not exists idx_ai_clarification_org_status_created
  on public.ai_clarification_requests (org_id, status, created_at desc);
create index if not exists idx_ai_clarification_execution
  on public.ai_clarification_requests (execution_id);

-- Same-org validation for every cross-table reference (database-migrations
-- skill: "same-org validation triggers on every FK a table carries").
create or replace function public.ai_clarification_requests_validate_same_org()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from public.agent_executions e where e.id = new.execution_id and e.org_id = new.org_id) then
    raise exception 'ai_clarification_requests: execution does not belong to this organization';
  end if;
  if not exists (select 1 from public.contacts c where c.id = new.contact_id and c.org_id = new.org_id) then
    raise exception 'ai_clarification_requests: contact does not belong to this organization';
  end if;
  if new.lead_id is not null
     and not exists (select 1 from public.leads l where l.id = new.lead_id and l.org_id = new.org_id) then
    raise exception 'ai_clarification_requests: lead does not belong to this organization';
  end if;
  return new;
end;
$$;

drop trigger if exists ai_clarification_requests_same_org on public.ai_clarification_requests;
create trigger ai_clarification_requests_same_org
  before insert or update of org_id, execution_id, contact_id, lead_id on public.ai_clarification_requests
  for each row execute function public.ai_clarification_requests_validate_same_org();

alter table public.ai_clarification_requests enable row level security;

drop policy if exists "org members read own org clarification requests" on public.ai_clarification_requests;
create policy "org members read own org clarification requests" on public.ai_clarification_requests
  for select
  using (
    org_id in (
      select organization_id from public.profiles where id = auth.uid() and organization_id is not null
      union
      select org_id from public.org_memberships where member_id = auth.uid()
    )
  );

-- ── Verification (run BEFORE and AFTER applying) ────────────────────────
-- 0. BEFORE applying — both tables must be absent:
-- select table_name from information_schema.tables
--   where table_schema = 'public' and table_name in ('business_knowledge_entries', 'ai_clarification_requests');
-- Expect: 0 rows.
--
-- 1. AFTER — columns:
-- select table_name, column_name, data_type, is_nullable from information_schema.columns
--   where table_schema = 'public' and table_name in ('business_knowledge_entries', 'ai_clarification_requests')
--   order by table_name, ordinal_position;
--
-- 2. AFTER — RLS enabled, exactly ONE (select) policy per table, no write policies:
-- select tablename, policyname, cmd from pg_policies
--   where schemaname = 'public' and tablename in ('business_knowledge_entries', 'ai_clarification_requests');
-- select relname, relrowsecurity from pg_class
--   where relname in ('business_knowledge_entries', 'ai_clarification_requests');
-- Expect: 2 policies (both cmd = SELECT); relrowsecurity = true for both.
--
-- 3. AFTER — indexes / constraints:
-- select indexname, indexdef from pg_indexes
--   where schemaname = 'public' and tablename in ('business_knowledge_entries', 'ai_clarification_requests');
-- Expect: unique (org_id, key); uq_ai_clarification_open_per_contact_key (partial).
--
-- 4. AFTER — tenant-isolation smoke check (as an authenticated user of org A, NOT service role):
-- select count(*) from public.business_knowledge_entries where org_id <> '<org A id>';
-- Expect: 0.
