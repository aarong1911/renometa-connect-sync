-- Scheduling foundation (Phase 2) — persisted offered-slot state.
--
-- NOT YET APPLIED. Proposed migration only — review before running.
--
-- AUDIT PERFORMED BEFORE WRITING THIS (per database-migrations skill —
-- "local migration history is not the live schema"):
--   - Read 20260724_conversation_states.sql (original table) and
--     20260726_conversation_states_external_key.sql (the one later
--     migration that touches this table) in full, from THIS repo's
--     supabase/migrations/ — no other file references conversation_states
--     (confirmed via grep across supabase/migrations/*.sql).
--   - Current real shape, as of those two files: id, org_id, contact_id
--     (nullable), channel (check: sms|email|whatsapp|messenger|instagram|
--     voice), is_archived, archived_at, is_starred, external_conversation_key
--     (nullable), created_at, updated_at. Identity: EITHER contact_id OR
--     external_conversation_key (conversation_states_identity_chk). Two
--     partial unique indexes: (org_id, contact_id, channel) WHERE
--     contact_id IS NOT NULL AND channel <> 'email', and (org_id,
--     external_conversation_key, channel) WHERE external_conversation_key
--     IS NOT NULL.
--   - RLS: SELECT/INSERT/UPDATE for `authenticated`, scoped to
--     org_memberships-or-org-creator, referencing only org_id (confirmed by
--     20260726's own comment: "every existing policy only references
--     org_id, never contact_id"). A service-role Netlify function (the only
--     writer for scheduling offer state — see below) bypasses RLS
--     entirely, same as every other service-role write in this app.
--
-- WHAT THIS DOES: adds two nullable columns so an SMS/WhatsApp conversation
-- (contact_id + channel — the existing, live-used identity path; this
-- scheduling feature does not touch the email/external_conversation_key
-- path at all) can carry a deterministic, persisted record of which
-- appointment slots were most recently offered to that contact in that
-- channel. This lets a later inbound message ("11 works") be resolved
-- against a REAL, structured prior offer instead of relying on model
-- memory — see netlify/functions/lib/scheduling-availability.ts's own
-- header for the full reasoning and the hard rule that an offer is NEVER
-- itself proof of availability (always re-validated immediately before any
-- booking write).
--
-- WHAT THIS DOES NOT DO: no `scheduling_claimed_at`/reservation column —
-- not needed for Phases 1-3 (booking idempotency is handled entirely by
-- the EXISTING agent_executions/agent_approval_requests mechanism — see
-- that work's own migration/report — not by anything in this table). No
-- RLS/policy change (every existing policy only ever referenced org_id,
-- which is unaffected). No change to the existing unique indexes, the
-- identity CHECK constraint, or any email/external_conversation_key
-- behavior. No backfill — every existing row simply gets NULL in both new
-- columns, which is the correct "no offer has ever been made" state.
--
-- SHAPE OF scheduling_offered_slots: a jsonb ARRAY of objects, each with
-- {start, end, timeZone, assignedTo?, appointmentType?} (see
-- scheduling-availability.ts's SlotCandidate type — kept in sync by
-- convention, not a DB constraint; see below for why no CHECK is added).
-- Deliberately NOT human-readable-label-only — every field needed to
-- re-validate the exact slot (start/end/timezone/assignee) is persisted
-- structurally, per this phase's explicit requirement.
--
-- No jsonb-shape CHECK constraint is added: validating an array-of-objects
-- shape in a Postgres CHECK is awkward (would need a plpgsql function) and
-- this column is written exclusively by one trusted, server-side,
-- service-role code path (never client-writable — RLS's `authenticated`
-- grant is for is_archived/is_starred, and the TS write path validates the
-- shape before every write) — the same trust model already governing
-- sms_meta_messages.meta elsewhere in this app, which also carries
-- unvalidated-by-Postgres jsonb for the same reason.

alter table public.conversation_states
  add column if not exists scheduling_offered_slots jsonb null,
  add column if not exists scheduling_offered_at timestamptz null;

comment on column public.conversation_states.scheduling_offered_slots is
  'Scheduling foundation (Phase 2). jsonb array of the most recently offered appointment slots for this (org_id, contact_id, channel) conversation — each {start, end, timeZone, assignedTo?, appointmentType?}. NEVER proof the slot is still available; always re-validated via scheduling-availability.ts immediately before any booking write. Null = no offer currently outstanding.';
comment on column public.conversation_states.scheduling_offered_at is
  'Scheduling foundation (Phase 2). When scheduling_offered_slots was last written. Paired with scheduling_offered_slots — both are set/cleared together by application code, never independently.';

-- ── Verification (run after applying) ───────────────────────────────────
-- 1. Columns exist, nullable, correct type:
-- select column_name, data_type, is_nullable from information_schema.columns
--   where table_schema = 'public' and table_name = 'conversation_states'
--   and column_name in ('scheduling_offered_slots', 'scheduling_offered_at');
--
-- 2. Every existing row is unaffected (both new columns null for every
--    pre-existing row — should return 0):
-- select count(*) from public.conversation_states
--   where scheduling_offered_slots is not null or scheduling_offered_at is not null;
--
-- 3. Existing constraints/indexes untouched (spot-check row counts match
--    what they were before applying):
-- select conname from pg_constraint where conrelid = 'public.conversation_states'::regclass;
-- select indexname from pg_indexes where tablename = 'conversation_states';
