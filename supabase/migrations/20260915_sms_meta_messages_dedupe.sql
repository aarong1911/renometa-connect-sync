-- AI-2A — Twilio SMS inbound integration into AI Center.
--
-- NOT YET APPLIED. Proposed migration only — review before running.
--
-- Background: sms_meta_messages (supabase/migrations/20260904_meta_schema_
-- baseline.sql) has a `provider_message_id` column but NO uniqueness
-- constraint on it. AI-2A's inbound Twilio webhook
-- (netlify/functions/ai-twilio-sms-inbound.ts) needs an atomic dedupe
-- guard: Twilio may retry a webhook delivery (the same MessageSid) if it
-- doesn't get a fast-enough 200 response, and the AI runtime must never
-- produce a second AI run/reply for a retried delivery of the same
-- inbound message.
--
-- This adds a unique index on (org_id, provider_message_id) — scoped by
-- org, not global, since provider_message_id (a Twilio MessageSid) is only
-- guaranteed unique within Twilio, and different orgs could in principle
-- use different Twilio (sub)accounts. The webhook inserts the inbound row
-- with provider_message_id = the inbound MessageSid BEFORE doing anything
-- else (dispatching AI orchestration, etc.); a unique-violation on that
-- insert (Postgres error 23505) is treated as "already processed this
-- exact delivery" and the webhook returns success immediately without
-- re-dispatching.
--
-- Partial (`where provider_message_id is not null`): existing/future rows
-- with no provider_message_id (e.g. a channel or path that doesn't have
-- one) are never constrained by this index — only rows that do carry one
-- must be unique per org.
--
-- Does not touch any other constraint, column, or RLS policy on this
-- table — see 20260904_meta_schema_baseline.sql for the table's existing
-- shape, untouched here.

create unique index if not exists uq_sms_meta_messages_org_provider_message_id
  on public.sms_meta_messages (org_id, provider_message_id)
  where provider_message_id is not null;

comment on index public.uq_sms_meta_messages_org_provider_message_id is
  'AI-2A dedupe guard: prevents a retried Twilio webhook delivery (same MessageSid) from producing a second inbound message row / AI run. Partial — only applies to rows with a non-null provider_message_id.';

-- ── Verification (run after applying) ──────────────────────────────────
-- 1. Index exists:
-- select indexname, indexdef from pg_indexes
--   where schemaname = 'public' and tablename = 'sms_meta_messages' and indexname = 'uq_sms_meta_messages_org_provider_message_id';
--
-- 2. No existing rows already violate it (should be empty — if this
--    returns rows, investigate before relying on the index for dedupe):
-- select org_id, provider_message_id, count(*) from public.sms_meta_messages
--   where provider_message_id is not null
--   group by org_id, provider_message_id having count(*) > 1;
