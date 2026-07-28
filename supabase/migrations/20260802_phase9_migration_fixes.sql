-- Phase 9.6 closure pass — small corrective fixes discovered while
-- reviewing two ALREADY-APPLIED migrations:
--   20260730_crm_import_history.sql
--   20260731_agentic_foundation.sql
--
-- IMPORTANT: a live check (direct PostgREST calls with the service-role
-- key) during this review confirmed BOTH of the above migrations are
-- already applied to the live database — contrary to their own header
-- comments, which (accurately, at the time they were written) said
-- "not yet verified applied." Because they are now live, this review's
-- findings are shipped as a NEW migration rather than by editing the
-- original files in place, since editing an already-applied migration's
-- source has no effect on the schema that actually exists — see the
-- Phase 9.6 closure report for the full verification trail.
--
-- Every statement below is additive/corrective only. Nothing here alters
-- application data, and every DDL change is guarded to be safe even if
-- this file is ever run twice.

-- ── Fix 1: crm_import_rows could reference another org's import job ────
-- crm_import_rows.org_id and crm_import_rows.import_job_id were both
-- present, but nothing enforced that a row's org_id actually matches the
-- org_id of the crm_import_jobs row it points at. Both writer paths
-- (src/lib/import-jobs-store.ts) always write a consistent pair today,
-- but the schema itself did not guarantee it — a client with a valid
-- session could otherwise INSERT a row with its own org_id but a
-- foreign import_job_id belonging to a different organization's job.
-- A composite unique key on the parent + a composite FK on the child
-- closes this at the database level, not just in application code.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'crm_import_jobs_id_org_id_uq'
  ) then
    alter table crm_import_jobs
      add constraint crm_import_jobs_id_org_id_uq unique (id, org_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'crm_import_rows_job_org_fk'
  ) then
    alter table crm_import_rows
      add constraint crm_import_rows_job_org_fk
      foreign key (import_job_id, org_id)
      references crm_import_jobs (id, org_id)
      on delete cascade;
  end if;
end $$;

comment on constraint crm_import_rows_job_org_fk on crm_import_rows is 'Phase 9.6 closure fix: a row''s org_id must match its parent crm_import_jobs row''s org_id — prevents attaching an import-row record to another organization''s job.';

-- ── Fix 2: agent_instances autonomy check constraint idempotency ───────
-- The original migration's `alter table ... add constraint ... check (...)`
-- has no `IF NOT EXISTS` equivalent in Postgres. It already succeeded once
-- live, so this is a no-op guard — added only so this migration file (and
-- any future replay of the original) stays safe to run more than once,
-- matching this project's "safe to run multiple times" convention.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'agent_instances_autonomy_level_check'
  ) then
    alter table agent_instances add constraint agent_instances_autonomy_level_check
      check (autonomy_level between 1 and 4);
  end if;
end $$;

-- ── Fix 3: agent_approval_requests.reviewed_by had no ON DELETE behavior ─
-- Defaulted to NO ACTION, which would block deleting a profile that had
-- ever reviewed an approval. Recreated as ON DELETE SET NULL (the review
-- history's action/decision/timestamp remain; only the reviewer
-- attribution clears). The original FK's name is looked up dynamically
-- rather than assumed, since Postgres auto-generates it.
do $$
declare
  fk_name text;
begin
  select con.conname into fk_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  where rel.relname = 'agent_approval_requests'
    and con.contype = 'f'
    and pg_get_constraintdef(con.oid) ilike '%reviewed_by%references profiles%';

  if fk_name is not null then
    execute format('alter table agent_approval_requests drop constraint %I', fk_name);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'agent_approval_requests_reviewed_by_fkey'
  ) then
    alter table agent_approval_requests
      add constraint agent_approval_requests_reviewed_by_fkey
      foreign key (reviewed_by) references profiles(id) on delete set null;
  end if;
end $$;

-- ── Fix 4: composite indexes for the two most common lookup patterns ───
-- "This org's queued jobs" and "this org's pending approvals" each
-- previously required combining two separate single-column indexes;
-- these composites cover both in one index scan.
create index if not exists idx_agent_executions_org_status on agent_executions(org_id, status);
create index if not exists idx_agent_approval_requests_org_status on agent_approval_requests(org_id, status);
