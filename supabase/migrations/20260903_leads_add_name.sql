-- 20260903_leads_add_name.sql
--
-- Phase 3 — CRM Schema Improvement: adds a canonical, lead-owned display
-- name column to public.leads.
--
-- ── Audit summary (see the Phase 3 "Add Canonical name Column" report for
-- the full writeup) ─────────────────────────────────────────────────────
-- public.leads predates supabase/migrations/ (no CREATE TABLE for it
-- anywhere in this folder — same situation as companies/contacts/vendors,
-- see the database-migrations skill). Confirmed live shape via
-- src/lib/leads-store.ts (the canonical store) and every other file that
-- inserts into leads: id, org_id, contact_id, source, status,
-- estimated_value, notes, assigned_to, custom_fields (jsonb),
-- converted_to_deal_id, created_at, updated_at. No `name` column exists
-- today.
--
-- Before this migration, the visible "Lead name" shown throughout the UI
-- (src/lib/leads-store.ts mapRow()) was ALWAYS derived at read time, never
-- stored on leads itself:
--   contact?.full_name ?? custom_fields.name ?? "Unknown"
-- i.e. the linked public.contacts row's full_name column (contacts has no
-- separate first_name/last_name — full_name is its own canonical display
-- field), falling back to a legacy custom_fields.name value that in
-- practice is only ever written by updateLead() (never by lead creation),
-- falling back to the literal display string "Unknown" (never stored in
-- the database — a render-time fallback only).
--
-- This migration is purely additive: one new nullable column, backfilled
-- from that exact same precedence, then a NOT NULL check is deliberately
-- NOT applied (see the nullability note below). Does NOT touch any other
-- historical migration.
--
-- No changes to Contact/Lead separation semantics: one contact can still
-- have multiple leads, each lead keeps its own independent `name` snapshot
-- copied at creation/edit time, and Google Ads repeat-submission
-- attribution (google_ads_lead_submissions.lead_id) is untouched.

-- ── Column ────────────────────────────────────────────────────────────
alter table public.leads add column if not exists name text;

comment on column public.leads.name is
  'Canonical, lead-owned display name — a snapshot at creation/edit time, independent of the linked contact (Phase 3, CRM Schema Improvement). Nullable: RenoMeta allows leads with no resolvable name (e.g. a missed-call lead with only a phone number — see netlify/functions/run-agent.ts''s create_lead action). Prefer this column for display/reporting/attribution queries; the legacy contacts.full_name / custom_fields.name derivation remains available as a fallback for any pre-existing row this backfill could not resolve.';

-- ── Backfill existing rows ───────────────────────────────────────────
-- Precedence exactly matches the pre-existing read-time derivation in
-- leads-store.ts's mapRow(), applied once here instead of at every read:
--   1. the linked contact's contacts.full_name (the strongest, most
--      current canonical source — contacts has no other name field)
--   2. leads.custom_fields->>'name' (legacy per-row text, only ever
--      written by updateLead() edits, never by any creation path)
--   3. otherwise left NULL — never fabricated (no "Unknown Lead" or
--      similar placeholder is written by this migration; "Unknown" is a
--      render-time UI fallback only, not a stored value convention).
update public.leads l
set name = c.full_name
from public.contacts c
where l.contact_id = c.id
  and l.name is null
  and c.full_name is not null
  and btrim(c.full_name) <> '';

update public.leads l
set name = l.custom_fields->>'name'
where l.name is null
  and l.custom_fields ? 'name'
  and l.custom_fields->>'name' is not null
  and btrim(l.custom_fields->>'name') <> '';

-- ── Nullability decision ─────────────────────────────────────────────
-- Deliberately NOT set NOT NULL. Confirmed creation paths include at
-- least one that legitimately has no name to give at insert time
-- (netlify/functions/run-agent.ts's create_lead agent action, for a
-- missed-call lead identified only by phone number before any name is
-- known — though note that path currently also references leads.phone/
-- leads.job_type, columns that do NOT exist on this table; see the Phase
-- 3 report). RenoMeta's product model already treats an
-- incomplete/anonymous lead as valid (a lead with no linked contact, or a
-- contact with no full_name, is not rejected anywhere in this codebase),
-- so forcing NOT NULL would require inventing placeholder names — exactly
-- what this migration's backfill step was instructed not to do.

-- ── Verification (run after applying) ────────────────────────────────
-- 1. column exists
-- select column_name from information_schema.columns
--   where table_schema = 'public' and table_name = 'leads' and column_name = 'name';
--
-- 2. column type
-- select data_type, character_maximum_length from information_schema.columns
--   where table_schema = 'public' and table_name = 'leads' and column_name = 'name';
--   -- expect data_type = 'text'
--
-- 3. nullability
-- select is_nullable from information_schema.columns
--   where table_schema = 'public' and table_name = 'leads' and column_name = 'name';
--   -- expect is_nullable = 'YES'
--
-- 4. count of leads with NULL name after backfill
-- select count(*) as leads_with_null_name from public.leads where name is null;
--
-- 5. sample lead/contact comparison (spot-check the backfill matches the
--    pre-existing read-time derivation)
-- select l.id as lead_id, l.name as lead_name, c.full_name as contact_full_name,
--        l.custom_fields->>'name' as custom_fields_name
-- from public.leads l
-- left join public.contacts c on c.id = l.contact_id
-- order by l.created_at desc
-- limit 20;
