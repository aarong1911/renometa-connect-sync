-- workflows table
create table if not exists workflows (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete cascade,
  name             text not null,
  description      text not null default '',
  status           text not null default 'draft'
                     check (status in ('active', 'paused', 'draft')),
  trigger          text not null default '',
  category         text not null default 'Operations'
                     check (category in ('Sales', 'Operations', 'Finance', 'Marketing', 'Client Care')),
  folder           text not null default 'General',
  owner_name       text not null default '',
  owner_initials   text not null default '',
  nodes            jsonb not null default '[]'::jsonb,
  runs_count       integer not null default 0,
  success_rate     integer not null default 0,
  last_run_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- workflow_runs table
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

-- RLS
alter table workflows enable row level security;

create policy "org_workflows_all" on workflows for all
  using (
    org_id = (select organization_id from profiles where id = auth.uid())
  );

alter table workflow_runs enable row level security;

create policy "org_workflow_runs_all" on workflow_runs for all
  using (
    org_id = (select organization_id from profiles where id = auth.uid())
  );

-- Index for fast per-org queries
create index if not exists workflows_org_id_idx on workflows (org_id);
create index if not exists workflow_runs_workflow_id_idx on workflow_runs (workflow_id);
create index if not exists workflow_runs_org_id_idx on workflow_runs (org_id);
