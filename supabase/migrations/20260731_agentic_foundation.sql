-- Phase 9.6 — Agentic Architecture Readiness.
--
-- Audit findings that shaped this migration (see Phase 9.6 report for full
-- detail):
--   - agent_definitions/agent_instances/agent_runs already exist
--     (20260531_ai_center.sql) and are NOT recreated here. agent_instances
--     is extended (autonomy_level, policy) rather than duplicated.
--   - agent_instances.runs_this_week/success_rate/hours_saved are confirmed
--     live to be misleading (lifetime-not-weekly, fabricated, never-
--     computed respectively) — those semantics are deliberately NOT carried
--     into the new tables below.
--   - workflow_trigger_queue was found to have `using (true)`/
--     `with check (true)` RLS (a real cross-org read/write vulnerability)
--     and is unconsumed dead infrastructure. Nothing here reuses it; new
--     tables use the same org-scoped RLS template already established by
--     crm_import_jobs/crm_import_rows (20260730_crm_import_history.sql).
--   - No new job-queue table is created. agent_executions itself doubles as
--     the queue row when status='queued' (claimed_by/claimed_at/
--     next_attempt_at/attempt_count columns below) — the smallest
--     architecture that still satisfies "queued/claimed/retry/timeout"
--     without standing up parallel infrastructure before it's needed.
--
-- All new tables are additive only. No existing table is dropped or
-- destructively altered.

-- ── Extend agent_instances (Priority 4/6/11) ────────────────────────────
-- autonomy_level and policy are additive, default-safe columns. Real per-
-- instance enforcement is wired up when the first production agent
-- (post-Phase 10) actually reads them; the Phase 9.6 proof-of-concept
-- (agent_key-based, no seeded agent_instance row) does not depend on this
-- ALTER, but the column is added now so it doesn't require a second
-- migration later.
alter table agent_instances add column if not exists autonomy_level int not null default 1;
alter table agent_instances add column if not exists policy jsonb not null default '{}'::jsonb;
alter table agent_instances add constraint agent_instances_autonomy_level_check
  check (autonomy_level between 1 and 4);

comment on column agent_instances.autonomy_level is 'Phase 9.6: 1=Recommend, 2=Prepare, 3=Limited execution, 4=Managed autonomy. Server-side policy only — never accept an autonomy override from a client request.';
comment on column agent_instances.policy is 'Phase 9.6: org-defined operating policy for this instance (hours, action/message limits, allowed channels, cost limits, escalation). See src/lib/agentic/policies.ts.';
comment on column agent_instances.runs_this_week is 'KNOWN ISSUE (Phase 9.6 audit): despite the name this is lifetime-cumulative, never reset weekly. Do not build new features on this column — see agent_executions for the corrected model.';
comment on column agent_instances.success_rate is 'KNOWN ISSUE (Phase 9.6 audit): only updated on the success path in run-agent.ts, biased toward 100. Do not build new features on this column.';
comment on column agent_instances.hours_saved is 'KNOWN ISSUE (Phase 9.6 audit): never computed/written anywhere; always 0. Do not build new features on this column.';

-- ── agent_executions (Priority 6/7/8/9) ─────────────────────────────────
-- One overall agent run. Also doubles as the "job queue row" while
-- status = 'queued' (claimed_by/claimed_at/next_attempt_at/attempt_count),
-- so no separate queue table is introduced in this pass.
create table if not exists agent_executions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  -- Nullable on purpose: the Phase 9.6 proof-of-concept has no seeded
  -- agent_instances row (creating one would make a fake card appear in the
  -- real AI Center UI, which this phase must not do). agent_key is the
  -- stable identifier for what ran; agent_instance_id is populated once a
  -- real per-org configurable instance exists for that capability.
  agent_instance_id uuid references agent_instances(id) on delete set null,
  agent_key text not null,
  actor_type text not null check (actor_type in ('user','agent','workflow','integration','system')),
  actor_id text,
  source text,
  trigger_event text,
  status text not null default 'queued' check (status in (
    'queued','running','awaiting_approval','succeeded','partially_succeeded',
    'failed','cancelled','paused','expired'
  )),
  autonomy_level int not null default 1 check (autonomy_level between 1 and 4),
  target_entity_type text,
  target_entity_id uuid,
  input_summary jsonb not null default '{}'::jsonb,
  output_summary jsonb not null default '{}'::jsonb,
  error text,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cost_usd_estimated numeric(10,4) not null default 0,
  idempotency_key text,
  -- Queue-row columns (Priority 9) — unused by the synchronous Phase 9.6
  -- proof-of-concept, present so a future background worker doesn't need
  -- another migration to add claim/retry/timeout support.
  claimed_by text,
  claimed_at timestamptz,
  attempt_count int not null default 0,
  max_attempts int not null default 1,
  next_attempt_at timestamptz,
  timeout_seconds int not null default 120,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, idempotency_key)
);

comment on table agent_executions is 'Phase 9.6: one agent run. status=queued rows are unclaimed jobs (see claimed_by/claimed_at/next_attempt_at) — no separate job-queue table exists; this table is deliberately dual-purpose.';

create index if not exists idx_agent_executions_org_id on agent_executions(org_id);
create index if not exists idx_agent_executions_status on agent_executions(status);
create index if not exists idx_agent_executions_agent_instance_id on agent_executions(agent_instance_id);
create index if not exists idx_agent_executions_target on agent_executions(target_entity_type, target_entity_id);
create index if not exists idx_agent_executions_created_at on agent_executions(created_at desc);

-- ── agent_execution_steps (Priority 6/7) ────────────────────────────────
create table if not exists agent_execution_steps (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null references agent_executions(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  sequence int not null,
  step_type text not null check (step_type in ('read','propose','approval','write','notify')),
  action_key text not null,
  status text not null default 'pending' check (status in (
    'pending','running','awaiting_approval','succeeded','failed','skipped','cancelled'
  )),
  input_snapshot jsonb not null default '{}'::jsonb,
  output_snapshot jsonb not null default '{}'::jsonb,
  approval_request_id uuid,
  error text,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cost_usd_estimated numeric(10,4) not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (execution_id, sequence)
);

comment on table agent_execution_steps is 'Phase 9.6: ordered steps within one agent_executions row (read/propose/approval/write/notify).';

create index if not exists idx_agent_execution_steps_execution_id on agent_execution_steps(execution_id);
create index if not exists idx_agent_execution_steps_org_id on agent_execution_steps(org_id);

-- ── agent_approval_requests (Priority 5) ────────────────────────────────
create table if not exists agent_approval_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  agent_instance_id uuid references agent_instances(id) on delete set null,
  execution_id uuid not null references agent_executions(id) on delete cascade,
  execution_step_id uuid references agent_execution_steps(id) on delete cascade,
  action_key text not null,
  target_entity_type text,
  target_entity_id uuid,
  proposed_input jsonb not null,
  -- Snapshot hash of proposed_input at request time — the approval
  -- executor recomputes this at approve-time and refuses to execute if it
  -- no longer matches, so approved input can never be silently changed
  -- after the fact (Priority 5 requirement).
  proposed_input_hash text not null,
  summary text not null,
  risk_level text not null check (risk_level in ('read','low','medium','high','prohibited')),
  status text not null default 'pending' check (status in (
    'pending','approved','rejected','expired','cancelled','executed','failed'
  )),
  requested_by_actor_type text not null check (requested_by_actor_type in ('user','agent','workflow','integration','system')),
  requested_by_actor_id text,
  reviewed_by uuid references profiles(id),
  requested_at timestamptz not null default now(),
  reviewed_at timestamptz,
  expires_at timestamptz,
  rejection_reason text,
  metadata jsonb not null default '{}'::jsonb,
  unique (execution_step_id)
);

comment on table agent_approval_requests is 'Phase 9.6: human approval gate for medium/high-risk proposed actions. proposed_input_hash prevents silent input tampering between request and approval.';

create index if not exists idx_agent_approval_requests_org_id on agent_approval_requests(org_id);
create index if not exists idx_agent_approval_requests_status on agent_approval_requests(status);
create index if not exists idx_agent_approval_requests_execution_id on agent_approval_requests(execution_id);

-- ── agent_usage_events (Priority 14) ─────────────────────────────────────
create table if not exists agent_usage_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  agent_instance_id uuid references agent_instances(id) on delete set null,
  execution_id uuid references agent_executions(id) on delete cascade,
  execution_step_id uuid references agent_execution_steps(id) on delete cascade,
  provider text not null,
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cached_tokens int not null default 0,
  tool_call_count int not null default 0,
  latency_ms int,
  estimated_cost_usd numeric(10,6) not null default 0,
  -- Always true today (Priority 14) — no provider gives exact invoiced
  -- cost via API response; UI must label this "estimated", never
  -- "invoiced".
  is_estimated boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table agent_usage_events is 'Phase 9.6: provider-neutral usage/cost ledger. estimated_cost_usd is always an ESTIMATE (is_estimated=true) — never presented as invoiced billing.';

create index if not exists idx_agent_usage_events_org_id on agent_usage_events(org_id);
create index if not exists idx_agent_usage_events_execution_id on agent_usage_events(execution_id);

-- ── agent_events (Priority 10) ───────────────────────────────────────────
create table if not exists agent_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  event_type text not null,
  schema_version int not null default 1,
  entity_type text,
  entity_id uuid,
  actor_type text not null default 'system' check (actor_type in ('user','agent','workflow','integration','system')),
  actor_id text,
  payload jsonb not null default '{}'::jsonb,
  idempotency_key text,
  occurred_at timestamptz not null default now(),
  processed boolean not null default false,
  processed_at timestamptz,
  unique (org_id, idempotency_key)
);

comment on table agent_events is 'Phase 9.6: normalized event contract for future agent triggers. Only manual.run_requested is produced in this phase — see src/lib/agentic/events.ts. Not yet wired to every table trigger.';

create index if not exists idx_agent_events_org_id on agent_events(org_id);
create index if not exists idx_agent_events_type on agent_events(event_type);
create index if not exists idx_agent_events_processed on agent_events(processed) where not processed;

-- ── agent_action_idempotency (Priority 8) ───────────────────────────────
-- Generic duplicate-action guard: a write action claims a slot with
-- `insert ... on conflict (org_id, action_key, idempotency_key) do nothing
-- returning *` before performing its real mutation. If no row is returned,
-- the action has already run and must not repeat.
create table if not exists agent_action_idempotency (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  action_key text not null,
  idempotency_key text not null,
  execution_id uuid references agent_executions(id) on delete cascade,
  result_snapshot jsonb,
  created_at timestamptz not null default now(),
  unique (org_id, action_key, idempotency_key)
);

comment on table agent_action_idempotency is 'Phase 9.6: generic duplicate-write guard. Server-only — no client access (see RLS below).';

create index if not exists idx_agent_action_idempotency_org_id on agent_action_idempotency(org_id);

-- ── RLS ──────────────────────────────────────────────────────────────────
-- Same org-scoped template as crm_import_jobs/crm_import_rows
-- (20260730_crm_import_history.sql): org_id in (profiles ∪
-- org_memberships), no USING(true)/WITH CHECK(true). All of these tables
-- are written by Netlify functions using the service-role client (which
-- bypasses RLS) — authenticated browser clients get SELECT only, so an
-- agent job or approval can never be forged or hijacked directly from the
-- browser. agent_action_idempotency has RLS enabled with NO policies at
-- all (default-deny for anon/authenticated; service role still works).

alter table agent_executions enable row level security;
alter table agent_execution_steps enable row level security;
alter table agent_approval_requests enable row level security;
alter table agent_usage_events enable row level security;
alter table agent_events enable row level security;
alter table agent_action_idempotency enable row level security;

drop policy if exists "org members read own org agent executions" on agent_executions;
create policy "org members read own org agent executions" on agent_executions
  for select
  using (
    org_id in (
      select organization_id from profiles where id = auth.uid()
      union
      select org_id from org_memberships where member_id = auth.uid()
    )
  );

drop policy if exists "org members read own org execution steps" on agent_execution_steps;
create policy "org members read own org execution steps" on agent_execution_steps
  for select
  using (
    org_id in (
      select organization_id from profiles where id = auth.uid()
      union
      select org_id from org_memberships where member_id = auth.uid()
    )
  );

drop policy if exists "org members read own org approval requests" on agent_approval_requests;
create policy "org members read own org approval requests" on agent_approval_requests
  for select
  using (
    org_id in (
      select organization_id from profiles where id = auth.uid()
      union
      select org_id from org_memberships where member_id = auth.uid()
    )
  );

-- Approve/reject (UPDATE) is further restricted to org owners/admins
-- (Priority 12 — "who can approve high-risk actions"). profiles.
-- organization_id matching directly identifies the org's own
-- owner/creator account (per this codebase's existing org-resolution
-- fallback pattern); org_memberships.role='admin' covers invited admins.
-- Everyone else in the org can still SELECT (see policy above) so an
-- "Awaiting Approval" count is visible to all members, but only
-- owner/admin can actually change a request's status.
drop policy if exists "org owners and admins approve or reject" on agent_approval_requests;
create policy "org owners and admins approve or reject" on agent_approval_requests
  for update
  using (
    org_id in (
      select organization_id from profiles where id = auth.uid()
      union
      select org_id from org_memberships where member_id = auth.uid()
    )
  )
  with check (
    org_id in (
      select organization_id from profiles where id = auth.uid() and organization_id is not null
      union
      select org_id from org_memberships where member_id = auth.uid() and role in ('owner', 'admin')
    )
  );

drop policy if exists "org members read own org usage events" on agent_usage_events;
create policy "org members read own org usage events" on agent_usage_events
  for select
  using (
    org_id in (
      select organization_id from profiles where id = auth.uid()
      union
      select org_id from org_memberships where member_id = auth.uid()
    )
  );

drop policy if exists "org members read own org agent events" on agent_events;
create policy "org members read own org agent events" on agent_events
  for select
  using (
    org_id in (
      select organization_id from profiles where id = auth.uid()
      union
      select org_id from org_memberships where member_id = auth.uid()
    )
  );

-- agent_action_idempotency: RLS enabled, intentionally zero policies for
-- anon/authenticated (default deny) — this table is a server-only
-- internal guard; only the service-role client (which bypasses RLS
-- entirely) ever touches it.
