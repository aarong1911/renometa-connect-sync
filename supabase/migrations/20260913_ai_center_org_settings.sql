-- AI-1L (correction pass) — dedicated organization-level AI Center
-- operational/safety settings.
--
-- NOT YET APPLIED. Proposed migration only — review before running. Must
-- be applied BEFORE deploying the corresponding code change in
-- src/lib/agentic/policy-resolver.ts (see that file's own header for the
-- exact fail-closed behavior if deployment order is reversed).
--
-- Background: AI Center's centralized safety enforcement
-- (src/lib/agentic/action-executor.ts's emergencyPaused/enforceOptOut
-- checks) initially persisted `emergencyPaused` as an interim, uncommitted
-- stopgap inside `organizations.integration_settings.aiCenter` — a column
-- whose name and existing purpose (third-party integration credentials —
-- Twilio, Stripe, etc.) is semantically wrong for an operational safety
-- flag. A read-only live check (this pass) confirmed ZERO organizations
-- have ever had that interim key set (0 of 17 orgs scanned had an
-- `aiCenter` key under `integration_settings` at all) — the stopgap was
-- never actually used in production, so this migration and the paired
-- code change remove it cleanly rather than supporting two competing
-- policy locations.
--
-- Storage choice: a single jsonb settings column, not flat typed columns
-- (contrast with 20260908_appointment_sms_reminder_settings.sql's flat-
-- column choice for a two-field, permanently-fixed-shape setting) —
-- AI Center's own operational settings are expected to grow (this is
-- explicitly the FIRST supported key, not the only one ever planned) and
-- a jsonb blob avoids a new migration for every future addition, matching
-- how `integration_settings` itself was already used for exactly this
-- kind of open-ended settings shape elsewhere on this same table.
--
-- Explicitly NOT `integration_settings` reused, and NOT a new table:
-- this is one org-wide switch today, not per-agent policy (per-agent
-- granularity, if ever needed, belongs in a small dedicated table keyed
-- by (org_id, agent_key) — deliberately not built here, per this task's
-- own scope).

alter table public.organizations
  add column if not exists ai_center_settings jsonb not null default '{}'::jsonb;

comment on column public.organizations.ai_center_settings is
  'Organization-wide RenoMeta AI Center operational/safety configuration — NOT CRM data and NOT third-party integration credentials (see integration_settings for those). Currently supports: { "emergencyPaused": boolean } — read by src/lib/agentic/policy-resolver.ts''s resolveExecutionPolicy() to centrally gate mutating/outbound AI-executed actions (src/lib/agentic/action-executor.ts). Missing/absent key means emergencyPaused=false (not paused) for an org that has never configured this. No UI writes this yet as of this migration; it is currently settable only via a direct, service-role-authenticated database update.';

-- ── Verification (run after applying) ──────────────────────────────────
-- 1. Column exists with the expected type/default:
-- select column_name, data_type, column_default, is_nullable
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'organizations' and column_name = 'ai_center_settings';
-- Expect: data_type = 'jsonb', column_default = '''{}''::jsonb', is_nullable = 'NO'.
--
-- 2. Every existing organization defaulted to an empty, unpaused settings object:
-- select count(*) from public.organizations where ai_center_settings <> '{}'::jsonb;
-- Expect: 0 (no organization should have a non-default value immediately after applying).
--
-- 3. No RLS policy changes were made by this migration — confirm existing
--    organizations policies are unchanged:
-- select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'organizations' order by policyname;
