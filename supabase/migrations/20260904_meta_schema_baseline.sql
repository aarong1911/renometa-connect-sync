-- 20260904_meta_schema_baseline.sql
--
-- Meta Ads Foundation Hardening — Part B (rewrite).
--
-- Backfills tracked migration history for THREE tables/columns that
-- already exist live but have no corresponding CREATE TABLE anywhere in
-- supabase/migrations/ (confirmed: no file matching *meta* under this
-- directory, and no CREATE TABLE meta_connections / sms_meta_messages
-- found by grepping every migration in this repo):
--
--   1. meta_connections                        (Meta OAuth connections)
--   2. sms_meta_messages                        (inbound/outbound message log)
--   3. contacts.messenger_psid / instagram_igsid (Meta-specific contact identifiers)
--
-- SCHEMA SOURCE: this version was rewritten against a direct live
-- production schema inspection (information_schema + pg_catalog: columns,
-- constraints, indexes, RLS policies, triggers) — NOT from prior
-- documentation. The previous version of this file (authored from
-- .claude/skills/meta-integrations/SKILL.md without live DB access) had
-- several mismatches against production and must not be applied; this
-- rewrite replaces it in place under the same filename/timestamp since it
-- was never applied and never committed.
--
-- PURPOSE AND LIMITS OF THIS BASELINE — read before extending it:
--   - On an EMPTY database, the `create table if not exists` blocks below
--     create these tables in the exact live shape.
--   - On the CURRENT live database (already matching the shape below),
--     every statement is a no-op: `create table if not exists`, catalog
--     existence checks before creating a constraint/policy/trigger, and
--     `create index if not exists` all skip cleanly.
--   - This migration is NOT a general-purpose repair tool. Per Postgres
--     semantics, `create table if not exists` does not reconcile the
--     columns/constraints of an already-existing table with a different
--     shape, and this file makes no attempt to do so — if a target
--     database has a `meta_connections`/`sms_meta_messages` table that
--     exists but differs from what's documented here, this migration will
--     silently no-op on `create table` and only add whatever new indexes/
--     policies/trigger are missing; it will not fix mismatched columns.
--     Verify with the queries in the "Verification" section before relying
--     on this file for any database whose shape you haven't confirmed.
--
-- Two intentional real-world properties, preserved exactly rather than
-- redesigned here:
--   - meta_connections.access_token is `text`, NOT NULL. New writes are
--     "enc:" + base64(iv||authTag||ciphertext) (AES-256-GCM, see
--     meta-oauth-callback.ts); rows written before that scheme shipped may
--     still hold a bare plaintext value with no prefix. This migration
--     never touches existing token values.
--   - meta_connections is one row per (org_id, product) — a `product`
--     column plus a unique constraint on (org_id, product), not a single
--     row per org.
--
-- Both tables carry PII (access tokens, message bodies, phone/email-shaped
-- sender identifiers). Live production has RLS ENABLED on both tables WITH
-- real client-facing SELECT (and, for meta_connections, ALL) policies
-- scoped to the caller's own org — this is NOT a zero-policy/service-role-
-- only design, and this migration reproduces those exact policies rather
-- than assuming otherwise. Do not broaden, rename, or drop any policy
-- below without a deliberate, reviewed reason.

-- ── meta_connections ─────────────────────────────────────────────────────
create table if not exists meta_connections (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references organizations(id) on delete cascade,
  user_id                uuid not null references auth.users(id) on delete cascade,
  meta_user_id           text not null,
  meta_user_name         text,
  access_token           text not null,
  token_type             text default 'bearer'::text,
  expires_at             timestamptz,
  granted_scopes         text[],
  ad_account_id          text,
  ad_account_name        text,
  page_id                text,
  page_name              text,
  ig_actor_id            text,
  is_active              boolean not null default true,
  connected_at           timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  waba_id                text,
  waba_phone_number_id   text,
  waba_display_phone     text,
  ig_username            text,
  meta_user_picture_url  text,
  business_id            text,
  business_name          text,
  product                text not null
);

comment on table meta_connections is
  'Meta (Facebook/Instagram/WhatsApp) OAuth connections, one row per (org_id, product). access_token is text NOT NULL — "enc:"-prefixed base64 AES-256-GCM for new writes (see meta-oauth-callback.ts); pre-existing rows may be bare plaintext with no prefix, so reader code must check for the prefix before decrypting. RLS-enabled with real org-scoped client policies (see meta_connections_org / meta_connections_select_own_org below) — not service-role-only.';

-- Unique on (org_id, product) — live constraint name reused exactly.
-- Postgres has no `add constraint if not exists`, so this is guarded by a
-- pg_constraint existence check rather than exception-swallowing.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.meta_connections'::regclass
      and conname = 'meta_connections_org_id_product_key'
  ) then
    alter table public.meta_connections
      add constraint meta_connections_org_id_product_key unique (org_id, product);
  end if;
end $$;

-- Live explicit indexes only — no page_id index exists in production, so
-- none is added here.
create index if not exists idx_meta_conn_org           on meta_connections(org_id);
create index if not exists idx_meta_connections_org_product on meta_connections(org_id, product);
create index if not exists idx_meta_connections_waba_id     on meta_connections(waba_id) where waba_id is not null;

-- handle_updated_at() is live production's existing SHARED trigger
-- function — it is not defined by any tracked migration in this repo (it
-- predates tracked history, same as the tables themselves), and it is very
-- likely used as the updated_at trigger for other tables beyond
-- meta_connections. This baseline must never overwrite an existing copy of
-- a shared function — even a definition that looks behaviorally identical
-- could differ in ways not visible from this file (search_path, owner,
-- security properties, or a body this migration's author didn't
-- anticipate) and CREATE OR REPLACE would silently apply whatever this
-- file says regardless. The guard below only ever CREATEs the function,
-- and only when to_regprocedure proves no function with this exact
-- signature exists yet — against current live production this is a true
-- no-op (the function already exists, so nothing inside the IF ever
-- runs); it only creates a working copy on a database where the function
-- is genuinely absent (e.g. a fresh/empty database exercising this
-- migration for the first time).
do $$
begin
  if to_regprocedure('public.handle_updated_at()') is null then
    execute $fn$
      create function public.handle_updated_at()
      returns trigger
      language plpgsql
      set search_path = public, pg_temp
      as $body$
      begin
        new.updated_at = now();
        return new;
      end;
      $body$
    $fn$;
  end if;
end $$;

-- Live trigger name/definition reused exactly. Guarded by a pg_trigger
-- existence check — deliberately NOT `drop trigger if exists` followed by
-- `create trigger`, since this baseline must leave an already-correct live
-- trigger completely untouched rather than drop-and-recreate it.
do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.meta_connections'::regclass
      and tgname = 'meta_connections_updated_at'
  ) then
    create trigger meta_connections_updated_at
      before update on public.meta_connections
      for each row execute function public.handle_updated_at();
  end if;
end $$;

alter table meta_connections enable row level security;

-- Live policies reused exactly (name, command, roles, USING clause).
-- CREATE POLICY has no IF NOT EXISTS, so each is guarded by a pg_policies
-- existence check — never DROP POLICY IF EXISTS, so an already-correct
-- live policy is left completely untouched.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'meta_connections' and policyname = 'meta_connections_org'
  ) then
    create policy meta_connections_org
      on public.meta_connections
      for all
      to public
      using (
        exists (
          select 1 from org_memberships m
          where m.org_id = meta_connections.org_id
            and m.member_id = auth.uid()
        )
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'meta_connections' and policyname = 'meta_connections_select_own_org'
  ) then
    create policy meta_connections_select_own_org
      on public.meta_connections
      for select
      to public
      using (
        org_id in (
          select profiles.organization_id
          from profiles
          where profiles.id = auth.uid()
        )
      );
  end if;
end $$;

-- ── sms_meta_messages ────────────────────────────────────────────────────
create table if not exists sms_meta_messages (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references organizations(id) on delete cascade,
  contact_id           uuid references contacts(id) on delete set null,
  channel              text not null check (channel = any (array['sms'::text, 'whatsapp'::text, 'messenger'::text, 'instagram'::text])),
  direction            text not null check (direction = any (array['in'::text, 'out'::text])),
  body                 text not null,
  from_address         text,
  provider_message_id  text,
  is_read              boolean not null default false,
  meta                 jsonb,
  created_at           timestamptz not null default now()
);

comment on table sms_meta_messages is
  'Shared inbound/outbound message log for WhatsApp, Messenger, Instagram Direct, and SMS. NOT to be confused with Gmail/email tables (emails, email_threads, inbox_emails, gmail_messages) or voice tables (voice_calls, call_logs), which are separate. RLS-enabled with a real org-scoped SELECT policy (see sms_meta_messages_select_own_org below) — not service-role-only; there is no client-facing write policy, so inserts remain service-role-only from Netlify functions.';

-- Live explicit indexes only — no (org_id, contact_id) index exists in
-- production, so none is added here.
create index if not exists idx_sms_meta_messages_contact_created on sms_meta_messages(contact_id, created_at) where contact_id is not null;
create index if not exists idx_sms_meta_messages_org_channel     on sms_meta_messages(org_id, channel);
create index if not exists idx_sms_meta_messages_org_created     on sms_meta_messages(org_id, created_at desc);

alter table sms_meta_messages enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sms_meta_messages' and policyname = 'sms_meta_messages_select_own_org'
  ) then
    create policy sms_meta_messages_select_own_org
      on public.sms_meta_messages
      for select
      to public
      using (
        org_id in (
          select profiles.organization_id
          from profiles
          where profiles.id = auth.uid()
        )
      );
  end if;
end $$;

-- ── contacts: Meta-specific identifier columns ──────────────────────────
-- messenger_psid / instagram_igsid are platform-scoped sender ids (PSID /
-- IGSID), NOT phone numbers or emails — kept distinct from the `phone`
-- column, which carries its own (org_id, phone) uniqueness semantics
-- documented in CLAUDE.md. Nullable: most contacts have neither. contacts
-- uses org_id (not organization_id) for its org-scope column, same as
-- meta_connections/sms_meta_messages above.
alter table contacts add column if not exists messenger_psid  text;
alter table contacts add column if not exists instagram_igsid text;

-- Live indexes are ORG-SCOPED UNIQUE partial indexes, not global
-- single-column indexes — a given PSID/IGSID is only guaranteed unique
-- within one org's contacts, not across all orgs.
create unique index if not exists idx_contacts_org_messenger_psid  on public.contacts(org_id, messenger_psid)  where messenger_psid is not null;
create unique index if not exists idx_contacts_org_instagram_igsid on public.contacts(org_id, instagram_igsid) where instagram_igsid is not null;

-- ── Verification (run manually — read-only) ─────────────────────────────
--
-- A. Columns / nullability / defaults — diff against the CREATE TABLE
--    statements above BEFORE applying, and again after:
--
-- select table_name, column_name, data_type, udt_name, is_nullable, column_default
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name in ('meta_connections', 'sms_meta_messages', 'contacts')
-- order by table_name, ordinal_position;
--
-- B. Constraints (PK / FK / UNIQUE / CHECK):
--
-- select conname, contype, pg_get_constraintdef(oid) as definition
-- from pg_constraint
-- where conrelid in ('public.meta_connections'::regclass, 'public.sms_meta_messages'::regclass)
-- order by conrelid, conname;
--
-- Expect on meta_connections: meta_connections_pkey (p),
-- meta_connections_org_id_fkey (f, -> organizations), meta_connections_user_id_fkey
-- (f, -> auth.users), meta_connections_org_id_product_key (u, on (org_id, product)).
-- Expect on sms_meta_messages: sms_meta_messages_pkey (p),
-- sms_meta_messages_org_id_fkey (f, -> organizations), sms_meta_messages_contact_id_fkey
-- (f, -> contacts), sms_meta_messages_channel_check (c), sms_meta_messages_direction_check (c).
--
-- C. Indexes:
--
-- select indexname, indexdef from pg_indexes
-- where schemaname = 'public'
--   and tablename in ('meta_connections', 'sms_meta_messages', 'contacts')
--   and (indexname like 'idx_meta%' or indexname like 'idx_sms_meta%' or indexname like 'idx_contacts_org_%psid' or indexname like 'idx_contacts_org_%igsid')
-- order by tablename, indexname;
--
-- Expect exactly: idx_meta_conn_org, idx_meta_connections_org_product,
-- idx_meta_connections_waba_id, idx_sms_meta_messages_contact_created,
-- idx_sms_meta_messages_org_channel, idx_sms_meta_messages_org_created,
-- idx_contacts_org_messenger_psid, idx_contacts_org_instagram_igsid.
--
-- D. RLS enabled (expect 2 rows, both relrowsecurity = true):
--
-- select c.relname, c.relrowsecurity
-- from pg_class c
-- join pg_namespace n on n.oid = c.relnamespace
-- where n.nspname = 'public'
--   and c.relname in ('meta_connections', 'sms_meta_messages');
--
-- E. Policies (expect exactly these 3 rows):
--    meta_connections / meta_connections_org
--    meta_connections / meta_connections_select_own_org
--    sms_meta_messages / sms_meta_messages_select_own_org
--
-- select tablename, policyname, cmd, roles, qual, with_check
-- from pg_policies
-- where schemaname = 'public'
--   and tablename in ('meta_connections', 'sms_meta_messages')
-- order by tablename, policyname;
--
-- F. Trigger (expect 1 row: meta_connections_updated_at):
--
-- select tgname from pg_trigger
-- where tgrelid = 'public.meta_connections'::regclass
--   and not tgisinternal;
--
-- G. Contact Meta indexes (covered by C above; confirm uniqueness explicitly):
--
-- select indexname, indexdef from pg_indexes
-- where schemaname = 'public' and tablename = 'contacts'
--   and indexname in ('idx_contacts_org_messenger_psid', 'idx_contacts_org_instagram_igsid');
