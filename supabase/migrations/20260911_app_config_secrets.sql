-- App-wide (not per-organization), per-deployment-environment encrypted
-- config/secret storage — moves platform-wide integration credentials
-- (Stripe, Vapi, Twilio, Google Ads, Meta app secret, AWS SES, SMTP,
-- JWT/signing secrets, etc.) out of Netlify environment variables and
-- into the DB, fetched at runtime instead.
--
-- Why: Netlify bundles every configured env var into every function's
-- Lambda environment, and AWS Lambda caps a function's total environment
-- payload at 4KB. This project is at ~88 vars / ~6.4KB, already over that
-- ceiling. Vars that bootstrap the runtime itself (SUPABASE_URL,
-- SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY) must stay real env vars —
-- you can't fetch the decryption key for this table out of this table.
--
-- Distinct from organization_integration_secrets
-- (20260727_organization_integration_secrets.sql): that table holds one
-- row per tenant's own OAuth token. This one holds platform-wide values
-- shared by the whole app, but — UNLIKE org secrets — the same key can
-- legitimately hold a different value per deployment context (production
-- vs. deploy-preview vs. branch-deploy vs. local dev), e.g. distinct
-- Stripe webhook endpoints per environment. Hence the composite
-- (environment, key) primary key instead of a bare key.
--
-- Security model: SERVICE-ROLE ONLY, same precedent as
-- organization_integration_secrets and oauth_states. No anon/authenticated
-- policies at all — every read/write goes through a Netlify function using
-- the service-role key, which bypasses RLS entirely.
--
-- New table — confirmed absent from supabase/migrations/ (no prior
-- CREATE TABLE for it anywhere in this repo's migration history) and from
-- this repo's only prior attempt at it, which lived under _to_delete/ and
-- was never wired into supabase/migrations/ or any live code path, so it
-- was never applied. No direct information_schema query was available in
-- this environment to confirm against the live database directly — run
-- the verification query at the bottom BEFORE applying to confirm the
-- table truly doesn't already exist with a different shape.

create table if not exists public.app_config_secrets (
  environment text not null,
  key text not null,
  -- Same AES-256-GCM + bytea wire format as organization_integration_secrets
  -- and integrations.access_token_encrypted (see
  -- netlify/functions/lib/gmail-token-crypto.ts) — reused as-is:
  -- "\x" + hex(base64(iv(12) || authTag(16) || ciphertext)),
  -- key = SHA-256(ENCRYPTION_KEY). Never a second encryption scheme.
  encrypted_value bytea not null,
  updated_at timestamptz not null default now(),
  primary key (environment, key)
);

alter table public.app_config_secrets enable row level security;

revoke all on public.app_config_secrets from public, anon, authenticated;
-- service_role bypasses RLS entirely and needs no explicit grant here.

-- ---------------------------------------------------------------------------
-- Verification — run AFTER applying, before trusting this change:
-- ---------------------------------------------------------------------------
--
-- 1. Confirm the table exists with exactly this shape:
--   select column_name, data_type, is_nullable
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'app_config_secrets'
--   order by ordinal_position;
--   -- expect: environment(text,NO), key(text,NO), encrypted_value(bytea,NO),
--   -- updated_at(timestamptz,NO)
--
-- 2. Confirm the primary key is the composite (environment, key):
--   select kcu.column_name
--   from information_schema.table_constraints tc
--   join information_schema.key_column_usage kcu
--     on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
--   where tc.table_schema = 'public' and tc.table_name = 'app_config_secrets'
--     and tc.constraint_type = 'PRIMARY KEY'
--   order by kcu.ordinal_position;
--   -- expect: environment, key (in that order)
--
-- 3. Confirm RLS is enabled and there are NO anon/authenticated policies:
--   select relrowsecurity from pg_class where relname = 'app_config_secrets';
--   -- expect: true
--   select policyname, roles from pg_policies where tablename = 'app_config_secrets';
--   -- expect: zero rows
--
-- 4. Confirm anon/authenticated have no table privileges at all:
--   select grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'app_config_secrets'
--     and grantee in ('anon', 'authenticated');
--   -- expect: zero rows
