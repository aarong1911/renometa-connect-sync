-- 20260904_fix_project_files_workspace_linkage.sql
--
-- S5C.1 (Files) — schema history for two corrections ALREADY APPLIED
-- MANUALLY to production in equivalent form. This migration is tracked
-- for repository/schema history only — DO NOT APPLY, it would be a no-op
-- against the live database (or fail on the DROP NOT NULL if already
-- dropped), and is provided so the tracked migration history matches the
-- confirmed live model.
--
-- BACKGROUND: the general Files page (files-store.ts) needs to persist
-- "Workspace" files — documents with no linked Project — but
-- project_files.project_id was NOT NULL and its BEFORE INSERT/UPDATE
-- trigger (validate_project_files_linkage, added by
-- 20260813_project_execution_daily_logs_photos.sql for the Project Photos
-- feature) unconditionally required project_id to resolve to an existing
-- Project. Production already has 3 rows with a valid project_id (Project
-- Photos), so this is an additive, non-destructive relaxation — no
-- existing row's project_id changes, and every existing validation still
-- applies whenever project_id IS NOT NULL.
--
-- A. Allow project_id to be NULL (Workspace files).
alter table public.project_files
  alter column project_id drop not null;

-- B. validate_project_files_linkage(): only require project_id to resolve
-- to an existing Project (and to match project_files.org_id) when
-- project_id IS NOT NULL. Every other check — uploaded_by org membership,
-- and phase_id/milestone_id/daily_log_id/task_id each belonging to the
-- linked Project — is preserved verbatim. search_path is preserved
-- verbatim. The trigger itself (project_files_validate_linkage) already
-- references this function by name and is NOT modified/recreated here.
create or replace function public.validate_project_files_linkage()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  project_org_id uuid;
begin
  -- NULL project_id = Workspace file — allowed, and has no Project to
  -- validate org membership against. Every row still requires a real
  -- org_id (project_files.org_id itself remains NOT NULL, unchanged).
  if new.project_id is not null then
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

-- NOTE: project_files.storage_bucket (text NOT NULL DEFAULT
-- 'project-photos') is INTENTIONALLY left unchanged here. Project Photos
-- continues to rely on the existing default/explicit-write behavior for
-- its own bucket ("project-media"/legacy "project-photos"). General Files
-- uploads (files-store.ts addFile()) instead explicitly write
-- storage_bucket = 'project-files' on every insert — the metadata row
-- must identify the SAME bucket the object was actually uploaded to,
-- which the table-wide default does not.
