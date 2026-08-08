-- Phase 13.3B -- Project -> Estimate -> Contract workflow.
--
-- Product decision: no separate Contract entity. An APPROVED estimate
-- linked to a Project becomes that Project's Original Contract document.
-- This migration adds exactly one guarded, additive trigger that performs
-- that linking in a trusted database path -- never trusted to the
-- browser -- when an estimate's status transitions to 'approved'.
--
-- Does not modify any prior migration (including 20260815_project_change_
-- orders.sql or any earlier file). Not applied automatically -- run
-- manually in the Supabase SQL Editor. Idempotent: every statement is
-- guarded so re-running this file is a no-op.

begin;

-- ── trusted contract-linking trigger ──────────────────────────────────────
-- Fires only on an actual transition INTO 'approved' (old.status is
-- distinct from 'approved' AND new.status = 'approved' -- an estimate
-- that is re-saved while already approved, or any other status change,
-- never re-triggers this). Requirements enforced directly in the WHERE
-- clause of the UPDATE, per Part 13 of the spec:
--   - "Estimate belongs to same org"       -> org_id = new.org_id
--   - "Estimate is linked to same Project" -> new.project_id is not null,
--                                              id = new.project_id
--   - "status is becoming approved"        -> the trigger condition itself
--   - "Project.estimate_id is null before
--      auto-setting"                       -> estimate_id is null
--   - "do not overwrite an existing
--      Project contract estimate silently" -> same WHERE clause: an
--                                              already-linked Project
--                                              (estimate_id IS NOT NULL)
--                                              matches zero rows, so the
--                                              UPDATE is a no-op and the
--                                              existing contract is left
--                                              exactly as it was.
--
-- SECURITY DEFINER so this behaves identically regardless of which path
-- recorded the approval: the public customer-facing proposal-action.ts
-- (service-role client, already bypasses RLS) and an authenticated staff
-- member manually marking an estimate approved from estimates.tsx (subject
-- to ordinary `projects` RLS, which already permits an org member to
-- update their own org's Project) both go through this exact same trigger
-- -- there is no second copy of this logic living in either Netlify
-- function or client code.
create or replace function public.link_approved_estimate_to_project()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved' and new.project_id is not null then
    update public.projects
      set estimate_id = new.id
      where id = new.project_id
        and org_id = new.org_id
        and estimate_id is null;
  end if;
  return new;
end;
$$;

comment on function public.link_approved_estimate_to_project() is
  'Phase 13.3B -- trusted server-side link from an approved, Project-linked Estimate to that Project''s contract document (projects.estimate_id). Only the FIRST approved estimate for a Project is ever auto-linked (WHERE estimate_id IS NULL) -- a Project that already has a contract estimate is never silently replaced by a later approval. This is the sole writer of projects.estimate_id from the approval path; no Netlify function or client code duplicates this logic.';

drop trigger if exists estimates_link_approved_contract on public.estimates;
create trigger estimates_link_approved_contract
  after update of status on public.estimates
  for each row
  execute function public.link_approved_estimate_to_project();

commit;

-- ============================================================================
-- POST-DEPLOYMENT VERIFICATION (run manually, not part of this migration)
-- ============================================================================
-- select proname from pg_proc where proname = 'link_approved_estimate_to_project';
-- select tgname from pg_trigger where tgname = 'estimates_link_approved_contract';
--
-- -- Confirm a Project's contract only ever gets set once:
-- -- select id, estimate_id from public.projects where id = '<project id>';
-- -- (approve a second estimate linked to the same project_id, then re-run
-- -- the query above -- estimate_id must be unchanged.)
