-- Stage 9.5, Priority 7 — Import history for the Leads/Contacts/Companies
-- CSV importers. Confirmed live (via direct PostgREST checks against
-- crm_import_jobs / crm_import_rows / import_jobs / import_history, all
-- returning 404 PGRST205) that no such table exists yet in this database.
--
-- Org-scoped, RLS enabled, no USING(true)/WITH CHECK(true). Members can
-- only read/write their own org's rows. created_by always trusts
-- auth.uid(), never a client-supplied value.

create table if not exists crm_import_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  entity_type text not null check (entity_type in ('lead', 'contact', 'company')),
  original_filename text,
  status text not null default 'in_progress' check (status in ('in_progress', 'completed', 'failed', 'rolled_back', 'partially_rolled_back')),
  total_rows integer not null default 0,
  created_rows integer not null default 0,
  skipped_rows integer not null default 0,
  failed_rows integer not null default 0,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists crm_import_rows (
  id uuid primary key default gen_random_uuid(),
  import_job_id uuid not null references crm_import_jobs(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  source_row_number integer not null,
  entity_id uuid,
  action text not null check (action in ('created', 'skipped_duplicate', 'skipped_invalid', 'failed', 'rolled_back')),
  status text not null default 'ok' check (status in ('ok', 'error')),
  error_message text,
  source_data jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_crm_import_jobs_org_id on crm_import_jobs(org_id);
create index if not exists idx_crm_import_jobs_created_at on crm_import_jobs(created_at desc);
create index if not exists idx_crm_import_rows_import_job_id on crm_import_rows(import_job_id);
create index if not exists idx_crm_import_rows_org_id on crm_import_rows(org_id);

alter table crm_import_jobs enable row level security;
alter table crm_import_rows enable row level security;

drop policy if exists "org members read own org import jobs" on crm_import_jobs;
create policy "org members read own org import jobs" on crm_import_jobs
  for select
  using (
    org_id in (
      select organization_id from profiles where id = auth.uid()
      union
      select org_id from org_memberships where member_id = auth.uid()
    )
  );

drop policy if exists "org members insert own org import jobs" on crm_import_jobs;
create policy "org members insert own org import jobs" on crm_import_jobs
  for insert
  with check (
    org_id in (
      select organization_id from profiles where id = auth.uid()
      union
      select org_id from org_memberships where member_id = auth.uid()
    )
  );

drop policy if exists "org members update own org import jobs" on crm_import_jobs;
create policy "org members update own org import jobs" on crm_import_jobs
  for update
  using (
    org_id in (
      select organization_id from profiles where id = auth.uid()
      union
      select org_id from org_memberships where member_id = auth.uid()
    )
  );

drop policy if exists "org members read own org import rows" on crm_import_rows;
create policy "org members read own org import rows" on crm_import_rows
  for select
  using (
    org_id in (
      select organization_id from profiles where id = auth.uid()
      union
      select org_id from org_memberships where member_id = auth.uid()
    )
  );

drop policy if exists "org members insert own org import rows" on crm_import_rows;
create policy "org members insert own org import rows" on crm_import_rows
  for insert
  with check (
    org_id in (
      select organization_id from profiles where id = auth.uid()
      union
      select org_id from org_memberships where member_id = auth.uid()
    )
  );

drop policy if exists "org members update own org import rows" on crm_import_rows;
create policy "org members update own org import rows" on crm_import_rows
  for update
  using (
    org_id in (
      select organization_id from profiles where id = auth.uid()
      union
      select org_id from org_memberships where member_id = auth.uid()
    )
  );
