-- ============================================================================
-- Phase 14.1 — Campaign Pause/Resume
--
-- Adds a `paused` campaign status so a scheduled/queued/sending campaign
-- can be safely halted and later resumed, without losing its content or
-- recipient snapshot. Does NOT touch 20260829_marketing_campaigns_foundation
-- (applied, historical) or 20260830_google_ads_oauth_foundation (unrelated,
-- separately applied/unapplied) — this is a pure additive evolution of the
-- `campaigns` table and its existing status-lifecycle guard.
--
-- Design (documented before implementing, per the pre-apply review):
--   - paused_at timestamptz: when the pause happened. Cleared on resume.
--   - paused_from_status text, one of 'scheduled' | 'queued' | 'sending':
--     Resume needs to know where to return a campaign to. A campaign
--     paused while 'sending' must NEVER resume back into a persistent
--     'sending' state — 'sending' is meant to be a durable "attempt in
--     flight" marker for a single claimed batch (see
--     marketing-campaign-process-queue.ts's ambiguous-provider-window
--     analysis), not a state a campaign should sit in indefinitely.
--     Resuming a paused-while-sending campaign therefore goes to 'queued'
--     so only its remaining not-yet-claimed recipients continue — this is
--     implemented in marketing-campaign-resume.ts, not in the database
--     (the resume decision also depends on scheduled_at, which is a
--     runtime "has this passed yet" comparison, not something a CHECK
--     constraint should encode).
--
-- Paused campaigns keep their existing content/recipients/counters
-- untouched — pausing is a pure status/timestamp change, nothing here
-- ever mutates campaign_recipients rows or campaigns.content/subject.
-- ============================================================================

begin;

alter table public.campaigns
  add column if not exists paused_at timestamptz,
  add column if not exists paused_from_status text;

alter table public.campaigns drop constraint if exists campaigns_paused_from_status_check;
alter table public.campaigns
  add constraint campaigns_paused_from_status_check
  check (paused_from_status is null or paused_from_status in ('scheduled', 'queued', 'sending'));

-- Consistency: paused_at/paused_from_status are only meaningful while the
-- campaign is actually 'paused' — never left stale on a resumed/canceled/
-- completed row.
alter table public.campaigns drop constraint if exists campaigns_paused_fields_require_paused_status;
alter table public.campaigns
  add constraint campaigns_paused_fields_require_paused_status
  check (
    (status = 'paused' and paused_at is not null and paused_from_status is not null)
    or (status <> 'paused' and paused_at is null and paused_from_status is null)
  );

-- Widen the canonical lifecycle status constraint to include 'paused' —
-- every previously-valid status is preserved as-is.
alter table public.campaigns drop constraint if exists campaigns_status_check;
alter table public.campaigns
  add constraint campaigns_status_check
  check (status in ('draft', 'scheduled', 'queued', 'sending', 'paused', 'completed', 'canceled', 'failed'));

-- ── Write guard: extend the existing trusted-caller pinning to the two new
-- backend-owned fields. This is defense-in-depth, not the primary
-- boundary — enforce_campaigns_write_guard() already rejects ANY
-- untrusted-caller status transition away from 'draft' outright (an
-- untrusted UPDATE requires old.status = new.status = 'draft'), so an
-- authenticated client can never reach 'paused' at all today. Pinning
-- paused_at/paused_from_status here just keeps those two columns
-- consistent with every other backend-owned lifecycle field in case this
-- guard's shape changes later.
create or replace function public.enforce_campaigns_write_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_is_trusted_caller boolean := current_user not in ('authenticated', 'anon');
  v_uid uuid := auth.uid();
begin
  if TG_OP = 'INSERT' then
    if not v_is_trusted_caller then
      new.status := 'draft';
      new.scheduled_at := null;
      new.started_at := null;
      new.completed_at := null;
      new.paused_at := null;
      new.paused_from_status := null;
      new.total_recipients := 0;
      new.recipients_sent := 0;
      new.recipients_delivered := 0;
      new.recipients_failed := 0;
      new.recipients_excluded := 0;
      new.successful_deliveries := 0;
      new.opens := 0;
      new.clicks := 0;
      new.conversions := 0;
      new.actual_cost := 0;

      if new.created_by is null then
        new.created_by := v_uid;
      elsif new.created_by is distinct from v_uid then
        raise exception 'created_by must match the authenticated user';
      end if;
    end if;
  elsif TG_OP = 'UPDATE' then
    if not v_is_trusted_caller then
      if old.status <> 'draft' then
        raise exception 'Only draft campaigns can be edited directly — use the pause/resume/schedule/send/cancel action for %', old.status;
      end if;
      if new.status <> 'draft' then
        raise exception 'Campaign status can only be changed by the trusted pause/resume/schedule/send/cancel backend';
      end if;

      new.scheduled_at := old.scheduled_at;
      new.started_at := old.started_at;
      new.completed_at := old.completed_at;
      new.paused_at := old.paused_at;
      new.paused_from_status := old.paused_from_status;
      new.total_recipients := old.total_recipients;
      new.recipients_sent := old.recipients_sent;
      new.recipients_delivered := old.recipients_delivered;
      new.recipients_failed := old.recipients_failed;
      new.recipients_excluded := old.recipients_excluded;
      new.successful_deliveries := old.successful_deliveries;
      new.opens := old.opens;
      new.clicks := old.clicks;
      new.conversions := old.conversions;
      new.actual_cost := old.actual_cost;
      new.created_by := old.created_by;
      new.org_id := old.org_id;
    end if;
  end if;

  -- Unchanged from 20260829 — still applies to every caller, still
  -- excludes draft/canceled/failed/paused. A paused campaign was already
  -- validated when it first transitioned into scheduled/queued/sending
  -- (this same check ran then), and pausing never touches
  -- subject/content, so re-requiring non-blank content while paused would
  -- be redundant, not protective.
  if new.status in ('scheduled', 'queued', 'sending', 'completed') then
    if new.campaign_type = 'email' and (new.subject is null or btrim(new.subject) = '') then
      raise exception 'Email campaigns require a non-blank subject before scheduling/sending';
    end if;
    if new.content is null or btrim(new.content) = '' then
      raise exception 'Campaign message content cannot be empty before scheduling/sending';
    end if;
  end if;

  return new;
end;
$$;

commit;

-- ============================================================================
-- VERIFICATION — run after applying, before trusting this migration:
-- ============================================================================
--
-- -- 1. paused status accepted:
-- select pg_get_constraintdef(oid) from pg_constraint where conname = 'campaigns_status_check';
-- -- expect status list to include 'paused' alongside all 7 prior values.
--
-- -- 2. New columns exist:
-- select column_name, data_type from information_schema.columns
-- where table_schema = 'public' and table_name = 'campaigns'
--   and column_name in ('paused_at', 'paused_from_status');
-- -- expect 2 rows.
--
-- -- 3. paused_from_status is constrained to the 3 valid values (or null):
-- select pg_get_constraintdef(oid) from pg_constraint where conname = 'campaigns_paused_from_status_check';
--
-- -- 4. paused fields can never be set without status = 'paused' and vice versa:
-- select pg_get_constraintdef(oid) from pg_constraint where conname = 'campaigns_paused_fields_require_paused_status';
--
-- -- 5. Write guard still blocks authenticated lifecycle tampering — as an
-- --    authenticated user (NOT service_role), attempt:
-- --    update campaigns set status = 'paused' where id = '<any non-draft campaign>';
-- --    expect: rejected with "Only draft campaigns can be edited directly...".
-- --    update campaigns set status = 'paused' where id = '<a draft campaign>';
-- --    expect: rejected with "Campaign status can only be changed by the trusted...".
--
-- -- 6. Existing historical rows unchanged (both preserved 20260829 rows,
-- --    plus the live test campaign, still have paused_at/paused_from_status
-- --    both null and their pre-migration status untouched):
-- select id, name, status, paused_at, paused_from_status from public.campaigns order by created_at;
--
-- -- 7. No campaign data deleted:
-- select count(*) from public.campaigns;
-- -- expect the same row count as immediately before applying this migration.
--
-- -- 8. No recipient data changed — this migration contains zero statements
-- --    referencing campaign_recipients:
-- select count(*) from public.campaign_recipients;
-- -- expect unchanged from immediately before applying (includes the live
-- -- test campaign's 18 rows — 1 sent, 17 excluded).
-- ============================================================================
