-- Phase 6, Item 7 — pipeline_stages INSERT policy fix
--
-- pipeline_stages' INSERT policy currently only permits the organization's
-- creator (organizations.created_by), unlike pipelines' own INSERT policy,
-- which already permits EITHER the org's creator OR any org_memberships
-- member. This blocks any non-creator team member from adding a stage to
-- a pipeline they can otherwise fully manage.
--
-- This migration does not assume the exact name of the existing INSERT
-- policy — direct pg_catalog/pg_policies access was not available from the
-- application session that authored this migration, only the live
-- pipelines/pipeline_stages table schemas (verified via the Supabase REST
-- API) and the behavioral description of the existing policies. The DO
-- block below finds and drops whatever INSERT policy(ies) currently exist
-- on pipeline_stages, by command type, rather than a guessed name — SELECT,
-- UPDATE, and DELETE policies on pipeline_stages are untouched.
--
-- Mirrors the same org_memberships-or-creator UNION pattern already used by
-- pipelines' own INSERT policy and by deals' RLS policies
-- (20260606_deals_rls_and_wtq.sql), scoped through pipeline_stages.pipeline_id
-- -> pipelines.id -> pipelines.org_id since pipeline_stages has no org_id
-- column of its own.

do $$
declare
  pol record;
begin
  for pol in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'pipeline_stages'
      and cmd = 'INSERT'
  loop
    execute format('drop policy %I on public.pipeline_stages', pol.policyname);
  end loop;
end $$;

create policy "org members or creator can insert pipeline stages"
on public.pipeline_stages
for insert
to authenticated
with check (
  exists (
    select 1
    from public.pipelines p
    where p.id = pipeline_stages.pipeline_id
      and (
        exists (
          select 1 from public.org_memberships om
          where om.member_id = auth.uid() and om.org_id = p.org_id
        )
        or exists (
          select 1 from public.organizations o
          where o.id = p.org_id and o.created_by = auth.uid()
        )
      )
  )
);
