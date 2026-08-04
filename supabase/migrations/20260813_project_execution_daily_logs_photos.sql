-- supabase/migrations/20260813_project_execution_daily_logs_photos.sql
--
-- Phase 13.3A — Project Execution Foundation
-- Daily Logs + enhanced Project Photos on the existing project_files table.
--
-- DEPLOYMENT
-- - Run manually in Supabase SQL Editor.
-- - Do NOT run `supabase db push`.
-- - This migration is additive, guarded, and non-destructive.
--
-- ARCHITECTURE
-- - RenoMeta Connect remains the canonical Project system.
-- - RenoMeta Field and RenoMeta Portal will later consume restricted
--   projections of these same records.
-- - `source` is provenance metadata only and must never be used as authorization.
-- - Project photos continue to use the existing public.project_files table.
-- - The existing `project-photos` Storage bucket is still public in this phase.
--   Therefore is_customer_visible/is_field_visible do NOT secure the underlying
--   image bytes. Before RenoMeta Field or RenoMeta Portal exposes photos, move
--   photo delivery to a private bucket with organization-aware policies and
--   short-lived signed URLs.

begin;

-- ============================================================================
-- 1. PROJECT DAILY LOGS
-- ============================================================================

create table if not exists public.project_daily_logs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  log_date date not null,
  title text null,
  summary text not null,
  work_completed text null,
  work_planned_next text null,
  delays_issues text null,
  safety_notes text null,
  visitor_notes text null,
  weather_summary text null,
  temperature_low numeric null,
  temperature_high numeric null,
  crew_count integer null,
  status text not null default 'draft',
  is_customer_visible boolean not null default false,
  is_field_visible boolean not null default true,
  source text not null default 'connect',
  created_by uuid null references public.profiles(id) on delete set null,
  published_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

comment on table public.project_daily_logs is
  'Dated Project site/progress reports. Multiple logs per Project per day are allowed. RenoMeta Connect remains canonical; source records provenance only and is never used for authorization.';

comment on column public.project_daily_logs.is_customer_visible is
  'Portal-readiness metadata. A future Portal projection must expose only intentionally safe fields and must exclude internal safety, visitor, delay, metadata, and internal identity fields.';

comment on column public.project_daily_logs.is_field_visible is
  'Field-readiness metadata. Defaults true because Daily Logs are operational records.';

comment on column public.project_daily_logs.source is
  'Allowed values: connect, field, portal, automation, import. Provenance metadata only; never authorization.';

comment on column public.project_daily_logs.crew_count is
  'Headcount only. Individual crew participation and time tracking are intentionally deferred.';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.project_daily_logs'::regclass
      and conname = 'project_daily_logs_summary_check'
  ) then
    alter table public.project_daily_logs
      add constraint project_daily_logs_summary_check
      check (char_length(btrim(summary)) > 0);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.project_daily_logs'::regclass
      and conname = 'project_daily_logs_status_check'
  ) then
    alter table public.project_daily_logs
      add constraint project_daily_logs_status_check
      check (status in ('draft', 'published', 'archived'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.project_daily_logs'::regclass
      and conname = 'project_daily_logs_source_check'
  ) then
    alter table public.project_daily_logs
      add constraint project_daily_logs_source_check
      check (source in ('connect', 'field', 'portal', 'automation', 'import'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.project_daily_logs'::regclass
      and conname = 'project_daily_logs_crew_count_check'
  ) then
    alter table public.project_daily_logs
      add constraint project_daily_logs_crew_count_check
      check (crew_count is null or crew_count >= 0);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.project_daily_logs'::regclass
      and conname = 'project_daily_logs_temperature_check'
  ) then
    alter table public.project_daily_logs
      add constraint project_daily_logs_temperature_check
      check (
        (temperature_low is null or (temperature_low > -80 and temperature_low < 150))
        and
        (temperature_high is null or (temperature_high > -80 and temperature_high < 150))
        and
        (
          temperature_low is null
          or temperature_high is null
          or temperature_low <= temperature_high
        )
      );
  end if;
end $$;

-- Relational integrity only:
-- - Project must belong to the supplied organization.
-- - created_by, when present, must belong to the same organization.
-- Authentication/authorization is enforced separately by RLS.
create or replace function public.validate_project_daily_log_org()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
    from public.projects p
    where p.id = new.project_id
      and p.org_id = new.org_id
  ) then
    raise exception
      'Daily Log project_id must belong to the same organization as org_id';
  end if;

  if new.created_by is not null and not exists (
    select 1
    from public.profiles pr
    where pr.id = new.created_by
      and pr.organization_id = new.org_id
  ) then
    raise exception
      'Daily Log created_by must belong to the same organization as org_id';
  end if;

  return new;
end;
$$;

drop trigger if exists project_daily_logs_validate_org
  on public.project_daily_logs;

create trigger project_daily_logs_validate_org
  before insert or update of project_id, org_id, created_by
  on public.project_daily_logs
  for each row
  execute function public.validate_project_daily_log_org();

create index if not exists idx_project_daily_logs_project_date
  on public.project_daily_logs (project_id, log_date desc);

create index if not exists idx_project_daily_logs_org
  on public.project_daily_logs (org_id);

create index if not exists idx_project_daily_logs_status
  on public.project_daily_logs (status);

create index if not exists idx_project_daily_logs_created_by
  on public.project_daily_logs (created_by);

create index if not exists idx_project_daily_logs_customer_visible
  on public.project_daily_logs (project_id, log_date desc)
  where is_customer_visible = true;

create index if not exists idx_project_daily_logs_field_visible
  on public.project_daily_logs (project_id, log_date desc)
  where is_field_visible = true;

create or replace function public.set_project_daily_logs_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists project_daily_logs_set_updated_at
  on public.project_daily_logs;

create trigger project_daily_logs_set_updated_at
  before update
  on public.project_daily_logs
  for each row
  execute function public.set_project_daily_logs_updated_at();

alter table public.project_daily_logs enable row level security;

drop policy if exists project_daily_logs_select
  on public.project_daily_logs;

create policy project_daily_logs_select
  on public.project_daily_logs
  for select
  to authenticated
  using (
    org_id in (
      select p.organization_id
      from public.profiles p
      where p.id = auth.uid()
    )
    or org_id in (
      select om.org_id
      from public.org_memberships om
      where om.member_id = auth.uid()
    )
  );

drop policy if exists project_daily_logs_insert
  on public.project_daily_logs;

create policy project_daily_logs_insert
  on public.project_daily_logs
  for insert
  to authenticated
  with check (
    org_id in (
      select p.organization_id
      from public.profiles p
      where p.id = auth.uid()
    )
    or org_id in (
      select om.org_id
      from public.org_memberships om
      where om.member_id = auth.uid()
    )
  );

drop policy if exists project_daily_logs_update
  on public.project_daily_logs;

create policy project_daily_logs_update
  on public.project_daily_logs
  for update
  to authenticated
  using (
    org_id in (
      select p.organization_id
      from public.profiles p
      where p.id = auth.uid()
    )
    or org_id in (
      select om.org_id
      from public.org_memberships om
      where om.member_id = auth.uid()
    )
  )
  with check (
    org_id in (
      select p.organization_id
      from public.profiles p
      where p.id = auth.uid()
    )
    or org_id in (
      select om.org_id
      from public.org_memberships om
      where om.member_id = auth.uid()
    )
  );

drop policy if exists project_daily_logs_delete
  on public.project_daily_logs;

create policy project_daily_logs_delete
  on public.project_daily_logs
  for delete
  to authenticated
  using (
    org_id in (
      select p.organization_id
      from public.profiles p
      where p.id = auth.uid()
    )
    or org_id in (
      select om.org_id
      from public.org_memberships om
      where om.member_id = auth.uid()
    )
  );

-- ============================================================================
-- 2. EXTEND EXISTING PROJECT_FILES FOR PROJECT PHOTOS
-- ============================================================================

alter table public.project_files
  add column if not exists category text not null default 'other';

alter table public.project_files
  add column if not exists caption text null;

alter table public.project_files
  add column if not exists phase_id uuid null
  references public.project_phases(id) on delete set null;

alter table public.project_files
  add column if not exists daily_log_id uuid null
  references public.project_daily_logs(id) on delete set null;

alter table public.project_files
  add column if not exists task_id uuid null
  references public.tasks(id) on delete set null;

alter table public.project_files
  add column if not exists milestone_id uuid null
  references public.project_milestones(id) on delete set null;

alter table public.project_files
  add column if not exists width integer null;

alter table public.project_files
  add column if not exists height integer null;

alter table public.project_files
  add column if not exists "position" integer not null default 0;

alter table public.project_files
  add column if not exists is_cover boolean not null default false;

alter table public.project_files
  add column if not exists is_customer_visible boolean not null default false;

alter table public.project_files
  add column if not exists is_field_visible boolean not null default true;

alter table public.project_files
  add column if not exists source text not null default 'connect';

alter table public.project_files
  add column if not exists taken_at timestamptz null;

alter table public.project_files
  add column if not exists updated_at timestamptz not null default now();

comment on column public.project_files.category is
  'Photo category: before, progress, issue, delivery, inspection, completion, after, document, or other.';

comment on column public.project_files.is_cover is
  'At most one cover file per Project, enforced by a partial unique index.';

comment on column public.project_files.is_customer_visible is
  'Portal-readiness metadata. Defaults false. Does not secure the underlying object while the project-photos bucket is public.';

comment on column public.project_files.is_field_visible is
  'Field-readiness metadata. Defaults true. Does not secure the underlying object while the project-photos bucket is public.';

comment on column public.project_files.source is
  'Allowed values: connect, field, portal, automation, import. Provenance only; never authorization.';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.project_files'::regclass
      and conname = 'project_files_category_check'
  ) then
    alter table public.project_files
      add constraint project_files_category_check
      check (
        category in (
          'before',
          'progress',
          'issue',
          'delivery',
          'inspection',
          'completion',
          'after',
          'document',
          'other'
        )
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.project_files'::regclass
      and conname = 'project_files_source_check'
  ) then
    alter table public.project_files
      add constraint project_files_source_check
      check (source in ('connect', 'field', 'portal', 'automation', 'import'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.project_files'::regclass
      and conname = 'project_files_dimensions_check'
  ) then
    alter table public.project_files
      add constraint project_files_dimensions_check
      check (
        (width is null or width >= 0)
        and
        (height is null or height >= 0)
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.project_files'::regclass
      and conname = 'project_files_position_check'
  ) then
    alter table public.project_files
      add constraint project_files_position_check
      check ("position" >= 0);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.project_files'::regclass
      and conname = 'project_files_path_check'
  ) then
    alter table public.project_files
      add constraint project_files_path_check
      check (char_length(btrim(file_path)) > 0);
  end if;
end $$;

-- Existing rows receive is_cover=false, so this index is safe on first deploy.
create unique index if not exists idx_project_files_one_cover_per_project
  on public.project_files (project_id)
  where is_cover = true;

-- Validates:
-- - project_id exists
-- - project_files.org_id matches projects.org_id
-- - uploaded_by, when present, belongs to the same organization
-- - linked phase/task/milestone/daily-log belongs to the same Project
create or replace function public.validate_project_files_linkage()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  project_org_id uuid;
begin
  select p.org_id
  into project_org_id
  from public.projects p
  where p.id = new.project_id;

  if project_org_id is null then
    raise exception
      'project_files.project_id must reference an existing Project';
  end if;

  if new.org_id <> project_org_id then
    raise exception
      'project_files.org_id must match the Project organization';
  end if;

  if new.uploaded_by is not null and not exists (
    select 1
    from public.profiles pr
    where pr.id = new.uploaded_by
      and pr.organization_id = new.org_id
  ) then
    raise exception
      'project_files.uploaded_by must belong to the same organization as org_id';
  end if;

  if new.phase_id is not null and not exists (
    select 1
    from public.project_phases pp
    where pp.id = new.phase_id
      and pp.project_id = new.project_id
  ) then
    raise exception
      'project_files.phase_id must belong to the same Project';
  end if;

  if new.milestone_id is not null and not exists (
    select 1
    from public.project_milestones pm
    where pm.id = new.milestone_id
      and pm.project_id = new.project_id
  ) then
    raise exception
      'project_files.milestone_id must belong to the same Project';
  end if;

  if new.daily_log_id is not null and not exists (
    select 1
    from public.project_daily_logs pdl
    where pdl.id = new.daily_log_id
      and pdl.project_id = new.project_id
  ) then
    raise exception
      'project_files.daily_log_id must belong to the same Project';
  end if;

  if new.task_id is not null and not exists (
    select 1
    from public.tasks t
    where t.id = new.task_id
      and t.project_id = new.project_id
  ) then
    raise exception
      'project_files.task_id must belong to the same Project';
  end if;

  return new;
end;
$$;

drop trigger if exists project_files_validate_linkage
  on public.project_files;

create trigger project_files_validate_linkage
  before insert or update of
    org_id,
    project_id,
    uploaded_by,
    phase_id,
    milestone_id,
    daily_log_id,
    task_id
  on public.project_files
  for each row
  execute function public.validate_project_files_linkage();

create or replace function public.set_project_files_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists project_files_set_updated_at
  on public.project_files;

create trigger project_files_set_updated_at
  before update
  on public.project_files
  for each row
  execute function public.set_project_files_updated_at();

create index if not exists idx_project_files_project_created
  on public.project_files (project_id, created_at desc);

create index if not exists idx_project_files_project_category
  on public.project_files (project_id, category);

create index if not exists idx_project_files_phase
  on public.project_files (phase_id);

create index if not exists idx_project_files_daily_log
  on public.project_files (daily_log_id);

create index if not exists idx_project_files_task
  on public.project_files (task_id);

create index if not exists idx_project_files_milestone
  on public.project_files (milestone_id);

create index if not exists idx_project_files_customer_visible
  on public.project_files (project_id, created_at desc)
  where is_customer_visible = true;

create index if not exists idx_project_files_field_visible
  on public.project_files (project_id, created_at desc)
  where is_field_visible = true;

-- project_files already has RLS enabled with SELECT, INSERT, and DELETE policies.
-- Add the missing UPDATE policy required for caption/category/visibility/linkage/
-- cover-photo metadata changes.
drop policy if exists "Users can update project files in their org"
  on public.project_files;

create policy "Users can update project files in their org"
  on public.project_files
  for update
  to authenticated
  using (
    org_id in (
      select om.org_id
      from public.org_memberships om
      where om.member_id = auth.uid()
    )
  )
  with check (
    org_id in (
      select om.org_id
      from public.org_memberships om
      where om.member_id = auth.uid()
    )
  );

-- ============================================================================
-- 3. PROJECT-PHOTOS STORAGE WRITE POLICIES
-- ============================================================================

-- Current path convention:
--   {projectId}/{timestamp}-{random}.{extension}
--
-- The first path segment is therefore the Project UUID.
-- Public SELECT remains temporarily because the current frontend uses public
-- URLs. Remove public read only after converting the frontend to signed URLs.

drop policy if exists "Authenticated upload project photos"
  on storage.objects;

drop policy if exists "Org members can upload project photos"
  on storage.objects;

create policy "Org members can upload project photos"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'project-photos'
    and (storage.foldername(name))[1] in (
      select p.id::text
      from public.projects p
      where p.org_id in (
        select om.org_id
        from public.org_memberships om
        where om.member_id = auth.uid()
      )
    )
  );

drop policy if exists "Org members can update project photos"
  on storage.objects;

create policy "Org members can update project photos"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'project-photos'
    and (storage.foldername(name))[1] in (
      select p.id::text
      from public.projects p
      where p.org_id in (
        select om.org_id
        from public.org_memberships om
        where om.member_id = auth.uid()
      )
    )
  )
  with check (
    bucket_id = 'project-photos'
    and (storage.foldername(name))[1] in (
      select p.id::text
      from public.projects p
      where p.org_id in (
        select om.org_id
        from public.org_memberships om
        where om.member_id = auth.uid()
      )
    )
  );

drop policy if exists "Org members can delete project photos"
  on storage.objects;

create policy "Org members can delete project photos"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'project-photos'
    and (storage.foldername(name))[1] in (
      select p.id::text
      from public.projects p
      where p.org_id in (
        select om.org_id
        from public.org_memberships om
        where om.member_id = auth.uid()
      )
    )
  );

commit;

-- ============================================================================
-- POST-DEPLOYMENT VERIFICATION
-- Run these separately after the migration succeeds.
-- ============================================================================

-- 1. RLS status
-- select
--   c.relname,
--   c.relrowsecurity
-- from pg_class c
-- join pg_namespace n on n.oid = c.relnamespace
-- where n.nspname = 'public'
--   and c.relname in ('project_daily_logs', 'project_files')
-- order by c.relname;

-- 2. project_files policies: expect SELECT, INSERT, UPDATE, DELETE
-- select policyname, cmd, roles, qual, with_check
-- from pg_policies
-- where schemaname = 'public'
--   and tablename = 'project_files'
-- order by policyname;

-- 3. project-photos policies: expect public SELECT temporarily plus
--    organization-scoped INSERT, UPDATE, and DELETE
-- select policyname, cmd, roles, qual, with_check
-- from pg_policies
-- where schemaname = 'storage'
--   and tablename = 'objects'
--   and (
--     coalesce(qual, '') ilike '%project-photos%'
--     or coalesce(with_check, '') ilike '%project-photos%'
--   )
-- order by policyname;

-- 4. Added project_files columns
-- select column_name, data_type, is_nullable, column_default
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name = 'project_files'
--   and column_name in (
--     'category',
--     'caption',
--     'phase_id',
--     'daily_log_id',
--     'task_id',
--     'milestone_id',
--     'width',
--     'height',
--     'position',
--     'is_cover',
--     'is_customer_visible',
--     'is_field_visible',
--     'source',
--     'taken_at',
--     'updated_at'
--   )
-- order by column_name;
