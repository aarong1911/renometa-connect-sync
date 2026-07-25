-- Organization-scoped encrypted secret storage — first user: the Gmail
-- SMTP App Password, currently stored PLAINTEXT in
-- organizations.integration_settings.gmail.appPassword.
--
-- This table is deliberately generic (org_id, provider, secret_type) so any
-- future per-integration secret (not just Gmail SMTP) can reuse it instead
-- of growing more plaintext fields inside integration_settings.
--
-- Security model: this table is SERVICE-ROLE ONLY. There is no legitimate
-- reason for a browser (anon or authenticated) client to ever read or
-- write an encrypted secret value directly — every read/write goes
-- through a dedicated Netlify function (smtp-config-save.ts,
-- smtp-config-status.ts, smtp-disconnect.ts, and send-inbox-message.ts's
-- own read), all using the service-role key, which bypasses RLS entirely.
-- No policies are added for anon/authenticated at all, matching the same
-- fully-locked-down precedent already used for oauth_states
-- (20260725_gmail_oauth_rls.sql) — a table with no legitimate direct
-- client access gets no policies, not permissive ones.

create table if not exists public.organization_integration_secrets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null,
  secret_type text not null,
  -- Same AES-256-GCM + bytea wire format already used by
  -- integrations.access_token_encrypted (see
  -- netlify/functions/lib/gmail-token-crypto.ts) — reused as-is, not
  -- reinvented: "\x" + hex(base64(iv(12) || authTag(16) || ciphertext)),
  -- key = SHA-256(ENCRYPTION_KEY).
  encrypted_value bytea not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider, secret_type)
);

create index if not exists organization_integration_secrets_org_idx
  on public.organization_integration_secrets (organization_id, provider, secret_type);

alter table public.organization_integration_secrets enable row level security;

revoke all on public.organization_integration_secrets from public, anon, authenticated;
-- service_role bypasses RLS entirely and needs no explicit grant here.
