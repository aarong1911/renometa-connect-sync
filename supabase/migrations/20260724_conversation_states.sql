-- Phase 7, Item 4 — persisted conversation archive state
--
-- The Inbox has no `conversations` table (conversations are composed
-- client-side from sms_meta_messages/voice_calls/gmail_messages, grouped by
-- (contact_id, channel)) so there is nowhere to persist "this conversation
-- is archived" on an existing row. This migration adds the smallest table
-- that can hold that state, keyed by the same (org_id, contact_id, channel)
-- identity every other read path in the Inbox already uses.
--
-- Scope for this migration: ARCHIVE ONLY. is_starred is included in the
-- shape (per the requested design) for forward compatibility, but nothing
-- in this pass reads or writes it — Starred stays exactly as it is today.
-- No assignment/mention columns are added — explicitly deferred.
--
-- Ownership model: ORGANIZATION-WIDE, not per-user. There is no per-user
-- inbox partitioning anywhere else in this app today — contact tags
-- (contacts.labels), deal visibility, and conversation history are all
-- shared across the org's team, consistent with a single shared "Unified
-- Inbox" rather than individual private inboxes. A user_id-scoped archive
-- would mean two team members looking at the same conversation see
-- different archived states, which contradicts that framing. No user_id
-- column is included — an unused nullable column with no read/write path
-- would just invite confusion later.

create table if not exists public.conversation_states (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  channel text not null check (channel in ('sms', 'email', 'whatsapp', 'messenger', 'instagram', 'voice')),
  is_archived boolean not null default false,
  archived_at timestamptz,
  is_starred boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, contact_id, channel)
);

create index if not exists conversation_states_org_archived_idx
  on public.conversation_states (org_id, is_archived);

create index if not exists conversation_states_contact_channel_idx
  on public.conversation_states (contact_id, channel);

alter table public.conversation_states enable row level security;

-- Same org_memberships-or-creator UNION pattern already used by pipelines/
-- deals (20260606_deals_rls_and_wtq.sql) and pipeline_stages
-- (20260723_pipeline_stages_insert_policy.sql).

create policy "org members or creator can select conversation states"
on public.conversation_states
for select
to authenticated
using (
  exists (
    select 1 from public.org_memberships om
    where om.member_id = auth.uid() and om.org_id = conversation_states.org_id
  )
  or exists (
    select 1 from public.organizations o
    where o.id = conversation_states.org_id and o.created_by = auth.uid()
  )
);

create policy "org members or creator can insert conversation states"
on public.conversation_states
for insert
to authenticated
with check (
  exists (
    select 1 from public.org_memberships om
    where om.member_id = auth.uid() and om.org_id = conversation_states.org_id
  )
  or exists (
    select 1 from public.organizations o
    where o.id = conversation_states.org_id and o.created_by = auth.uid()
  )
);

create policy "org members or creator can update conversation states"
on public.conversation_states
for update
to authenticated
using (
  exists (
    select 1 from public.org_memberships om
    where om.member_id = auth.uid() and om.org_id = conversation_states.org_id
  )
  or exists (
    select 1 from public.organizations o
    where o.id = conversation_states.org_id and o.created_by = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.org_memberships om
    where om.member_id = auth.uid() and om.org_id = conversation_states.org_id
  )
  or exists (
    select 1 from public.organizations o
    where o.id = conversation_states.org_id and o.created_by = auth.uid()
  )
);

revoke all on public.conversation_states from public, anon;
grant select, insert, update on public.conversation_states to authenticated;
