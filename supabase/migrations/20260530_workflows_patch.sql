-- Safe patch: adds any columns that the original CREATE TABLE IF NOT EXISTS may have skipped.
-- Run this if you already have a "workflows" table that's missing columns.

alter table workflows
  add column if not exists description      text not null default '',
  add column if not exists trigger          text not null default '',
  add column if not exists category         text not null default 'Operations',
  add column if not exists folder           text not null default 'General',
  add column if not exists owner_name       text not null default '',
  add column if not exists owner_initials   text not null default '',
  add column if not exists nodes            jsonb not null default '[]'::jsonb,
  add column if not exists runs_count       integer not null default 0,
  add column if not exists success_rate     integer not null default 0,
  add column if not exists last_run_at      timestamptz,
  add column if not exists updated_at       timestamptz not null default now();

-- Also add the workflow_runs table if it was skipped
create table if not exists workflow_runs (
  id                  uuid primary key default gen_random_uuid(),
  workflow_id         uuid not null references workflows(id) on delete cascade,
  org_id              uuid not null references organizations(id) on delete cascade,
  contact_name        text not null default '',
  started_at          timestamptz not null default now(),
  ended_at            timestamptz,
  duration_ms         integer,
  status              text not null default 'running'
                        check (status in ('success', 'failed', 'running')),
  failed_at_node_id   text,
  created_at          timestamptz not null default now()
);

-- Ensure RLS is on both tables
alter table workflows enable row level security;
alter table workflow_runs enable row level security;

-- Drop and recreate policies to avoid "already exists" errors
drop policy if exists "org_workflows_all" on workflows;
create policy "org_workflows_all" on workflows for all
  using (org_id = (select organization_id from profiles where id = auth.uid()));

drop policy if exists "org_workflow_runs_all" on workflow_runs;
create policy "org_workflow_runs_all" on workflow_runs for all
  using (org_id = (select organization_id from profiles where id = auth.uid()));

-- Indexes
create index if not exists workflows_org_id_idx on workflows (org_id);
create index if not exists workflow_runs_workflow_id_idx on workflow_runs (workflow_id);
create index if not exists workflow_runs_org_id_idx on workflow_runs (org_id);
