-- 20260917_meta_whatsapp_pending_selections.sql
--
-- WhatsApp OAuth connection-quality fix — removes blind index-0 WABA/
-- phone-number selection in meta-oauth-callback.ts. When Meta returns
-- MORE THAN ONE candidate (business + WABA + phone-number) for a
-- WhatsApp connect attempt, the callback can no longer silently persist
-- meta_connections — it must let the owner/admin explicitly choose. This
-- table is the short-lived, server-side holding place for that choice,
-- mirroring meta_oauth_nonces' (supabase/migrations/20260905_meta_oauth_
-- nonces.sql) proven reserve-then-consume, single-use, race-safe pattern
-- — reused deliberately rather than inventing a new shape, per this
-- pass's own instruction to prefer an existing selection-state pattern.
--
-- NOT APPLIED. Create only — the user applies this manually via the
-- Supabase SQL Editor after review, same as every other migration in
-- this engagement.
--
-- ── Why NOT the Google Ads account-selection pattern ─────────────────────
-- Google Ads (google_ads_connections + google-ads-accounts.ts /
-- google-ads-select-account.ts) persists its connection (refresh token)
-- FIRST, then lets the operator pick an account afterward, re-deriving
-- the account list on demand each time from the already-stored refresh
-- token. That shape was considered and deliberately NOT used here:
-- this task's own instruction is explicit that RenoMeta must not persist
-- ANY meta_connections row — not even a partial one with a real token and
-- null waba fields — until a final candidate is actually selected ("Only
-- after a final candidate is selected should RenoMeta persist/update the
-- WhatsApp meta_connections row"). A reserve-then-consume temporary table
-- (this one) is what makes that possible without losing the discovered
-- candidate list between the OAuth popup closing and the operator's
-- selection.
--
-- ── What this table holds ────────────────────────────────────────────────
-- Everything meta-whatsapp-select-number.ts needs to finish the SAME
-- final meta_connections upsert meta-oauth-callback.ts already performs
-- for the single-candidate case — the long-lived Meta access token
-- (encrypted, same "enc:" + AES-256-GCM scheme as meta_connections.
-- access_token), token metadata, the connected Meta user's profile
-- fields, and the FULL list of discovered candidates (server-side only —
-- the browser only ever receives a safe display-only subset of this via
-- postMessage, never the token; see meta-oauth-callback.ts and
-- integration-config-drawer.tsx).
--
-- ── Why the full candidate list is stored, not just the chosen one ──────
-- meta-whatsapp-select-number.ts must verify the phoneNumberId the
-- browser submits is actually one Meta discovered during THIS OAuth
-- transaction, never trusting a client-supplied id at face value ("Do
-- NOT allow: arbitrary wabaId, arbitrary phoneNumberId. The selected
-- candidate must be one of the candidates discovered for that exact
-- OAuth transaction. Fail closed if candidate/state mismatches.").
--
-- Only a SHA-256 hash of the selection token is stored — never the raw
-- value — same discipline as meta_oauth_nonces.nonce_hash.

create table if not exists meta_whatsapp_pending_selections (
  selection_token_hash  text primary key,
  org_id                uuid not null references organizations(id) on delete cascade,
  user_id               uuid not null references auth.users(id) on delete cascade,
  product               text not null default 'whatsapp',
  encrypted_access_token text not null,
  token_type            text not null,
  token_expires_at      timestamptz,
  granted_scopes        text[] not null default '{}',
  meta_user_id          text not null,
  meta_user_name        text,
  meta_user_picture_url text,
  -- Discovered generically for every product (not WhatsApp-specific) by
  -- meta-oauth-callback.ts's existing page-discovery block, BEFORE the
  -- WhatsApp candidate branch runs — carried through here so the eventual
  -- meta_connections upsert in meta-whatsapp-select-number.ts can set it
  -- the same way the single-candidate path already does, instead of
  -- silently nulling it out on a multi-candidate reconnect.
  page_id               text,
  page_name             text,
  -- Array of full candidate objects: {businessId, businessName, wabaId,
  -- wabaName, phoneNumberId, displayPhoneNumber, verifiedName,
  -- qualityRating} — only fields Meta's Graph API actually returns for
  -- these node types, nothing invented.
  candidates             jsonb not null,
  expires_at             timestamptz not null,
  consumed_at            timestamptz,
  created_at             timestamptz not null default now()
);

comment on table meta_whatsapp_pending_selections is
  'Short-lived, single-use holding record for a WhatsApp OAuth connect attempt that discovered more than one business/WABA/phone-number candidate. Reserved at meta-oauth-callback.ts, consumed via a conditional UPDATE at meta-whatsapp-select-number.ts once the owner/admin picks one. Server-only — no client access. See meta-oauth-callback.ts header for the full design.';

create index if not exists idx_meta_whatsapp_pending_selections_expires_at on meta_whatsapp_pending_selections(expires_at);
create index if not exists idx_meta_whatsapp_pending_selections_org_user on meta_whatsapp_pending_selections(org_id, user_id);

alter table meta_whatsapp_pending_selections enable row level security;
-- Intentionally zero policies — default-denies anon/authenticated
-- entirely, same reasoning as meta_oauth_nonces: the service-role client
-- (meta-oauth-callback.ts / meta-whatsapp-select-number.ts, the only
-- things that ever touch this table) bypasses RLS as usual. This table
-- holds an encrypted access token — there is no legitimate client-facing
-- read/write use case for it, ever.

-- ── Atomicity fix (added before this migration was ever applied — see
-- this pass's own report) ────────────────────────────────────────────────
--
-- meta-whatsapp-select-number.ts originally consumed the pending
-- selection and wrote meta_connections as TWO SEPARATE Supabase REST
-- calls. If the consume succeeded but the meta_connections write then
-- failed (a transient DB error, a network blip), the selection token was
-- permanently burned (single-use held — no double-connect risk) but the
-- chosen WhatsApp number was never actually saved, forcing the operator
-- through a full OAuth reconnect for no real reason. Not a security bug —
-- a real correctness/UX one. This function moves BOTH steps into ONE
-- Postgres transaction (a plpgsql function body is implicitly one
-- transaction) so a failure at any point rolls back everything: consumed_
-- at stays null, meta_connections is untouched, and the SAME
-- selectionToken can be retried.
--
-- SERVER-ONLY. Never exposed to anon/authenticated — see the REVOKE/GRANT
-- below. The browser may only ever submit an opaque selectionToken +
-- phoneNumberId (see meta-whatsapp-select-number.ts); this function
-- receives the already-hashed token and the already-resolved, already-
-- authorized org_id/user_id from that endpoint (bearer auth +
-- resolveOrgAndAuthority() + owner/admin check all still happen in
-- TypeScript, BEFORE this is ever called — authorization is not moved
-- into SQL, only the already-trusted final write is).
--
-- SECURITY DEFINER so this function's own grants are the sole gate
-- (defense-in-depth) regardless of what RLS policies exist on either
-- table today or in the future — meta_connections carries REAL org-scoped
-- client policies (see supabase/migrations/20260904_meta_schema_
-- baseline.sql), unlike this table's zero-policy design, so this function
-- deliberately does not rely on the caller's own RLS standing. `search_
-- path` is pinned and every table reference is schema-qualified so this
-- can never be tricked by a caller-controlled search_path. Takes no
-- connection/token JSON from its caller — the access token, scopes, and
-- Meta user/page metadata all come from the pending-selection row itself,
-- never from a parameter.
--
-- Candidate validation happens INSIDE this function against the row's own
-- stored `candidates` jsonb — a phoneNumberId that doesn't match anything
-- in it is rejected (status 'invalid_candidate') WITHOUT marking the
-- selection consumed and WITHOUT writing meta_connections, so an invalid
-- guess never burns the token.
--
-- `for update` on the initial lookup is what makes concurrent finalize
-- attempts for the SAME row safe: a second concurrent call blocks on the
-- row lock until the first transaction commits, then re-evaluates its own
-- `consumed_at is null` condition against the now-committed state and
-- correctly finds nothing (status 'not_found_or_expired') — same
-- race-safety property the old conditional UPDATE had, now covering the
-- meta_connections write too.
create or replace function public.finalize_meta_whatsapp_selection(
  p_selection_token_hash text,
  p_org_id uuid,
  p_user_id uuid,
  p_phone_number_id text
)
returns table (
  status text,
  business_name text,
  waba_display_phone text,
  verified_name text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.meta_whatsapp_pending_selections%rowtype;
  v_candidate jsonb;
  v_now timestamptz := now();
begin
  -- Lock the row FIRST (before any other statement) so a concurrent call
  -- for the same token blocks here rather than racing past this check.
  select * into v_row
  from public.meta_whatsapp_pending_selections
  where selection_token_hash = p_selection_token_hash
    and org_id = p_org_id
    and user_id = p_user_id
    and product = 'whatsapp'
    and consumed_at is null
    and expires_at > v_now
  for update;

  if not found then
    return query select 'not_found_or_expired'::text, null::text, null::text, null::text;
    return;
  end if;

  -- Candidate must be literally present in THIS row's own discovered list
  -- — never trust p_phone_number_id beyond matching it against trusted
  -- server data already stored at OAuth-callback time.
  select c into v_candidate
  from jsonb_array_elements(v_row.candidates) as c
  where c ->> 'phoneNumberId' = p_phone_number_id
  limit 1;

  if v_candidate is null then
    return query select 'invalid_candidate'::text, null::text, null::text, null::text;
    return;
  end if;

  -- Same final write meta-oauth-callback.ts performs for the single-
  -- candidate case — ONE ROW PER (org_id, product), never touches
  -- Messenger/Instagram/Ads/Lead Ads rows (separate rows under the
  -- per-product schema). The pending row's own encrypted_access_token is
  -- copied AS-IS — no decrypt/re-encrypt round trip needed (or possible
  -- in plain SQL; AES-256-GCM stays entirely in Node/TypeScript), it was
  -- already stored in the exact "enc:" format meta_connections.
  -- access_token expects.
  insert into public.meta_connections (
    org_id, product, user_id, meta_user_id, meta_user_name, meta_user_picture_url,
    business_id, business_name, page_id, page_name,
    waba_id, waba_phone_number_id, waba_display_phone,
    access_token, token_type, expires_at, granted_scopes, is_active, updated_at
  ) values (
    p_org_id, 'whatsapp', p_user_id, v_row.meta_user_id, v_row.meta_user_name, v_row.meta_user_picture_url,
    v_candidate ->> 'businessId', v_candidate ->> 'businessName', v_row.page_id, v_row.page_name,
    v_candidate ->> 'wabaId', v_candidate ->> 'phoneNumberId', v_candidate ->> 'displayPhoneNumber',
    v_row.encrypted_access_token, v_row.token_type, v_row.token_expires_at, v_row.granted_scopes, true, v_now
  )
  on conflict on constraint meta_connections_org_id_product_key do update set
    user_id = excluded.user_id,
    meta_user_id = excluded.meta_user_id,
    meta_user_name = excluded.meta_user_name,
    meta_user_picture_url = excluded.meta_user_picture_url,
    business_id = excluded.business_id,
    business_name = excluded.business_name,
    -- Never null out a field this write has no fresh value for — same
    -- fallback reasoning meta-oauth-callback.ts's own existingRow fetch
    -- already used before this function existed.
    page_id = coalesce(excluded.page_id, meta_connections.page_id),
    page_name = coalesce(excluded.page_name, meta_connections.page_name),
    waba_id = excluded.waba_id,
    waba_phone_number_id = excluded.waba_phone_number_id,
    waba_display_phone = excluded.waba_display_phone,
    access_token = excluded.access_token,
    token_type = excluded.token_type,
    expires_at = excluded.expires_at,
    granted_scopes = excluded.granted_scopes,
    is_active = true,
    updated_at = excluded.updated_at;

  update public.meta_whatsapp_pending_selections
  set consumed_at = v_now
  where selection_token_hash = p_selection_token_hash;

  return query select
    'ok'::text,
    (v_candidate ->> 'businessName')::text,
    (v_candidate ->> 'displayPhoneNumber')::text,
    (v_candidate ->> 'verifiedName')::text;
end;
$$;

comment on function public.finalize_meta_whatsapp_selection(text, uuid, uuid, text) is
  'Atomically consumes a meta_whatsapp_pending_selections row and writes the matching meta_connections row in ONE transaction. Server-only (SECURITY DEFINER, EXECUTE revoked from anon/authenticated). Called only from meta-whatsapp-select-number.ts, AFTER bearer auth + resolveOrgAndAuthority() + owner/admin authorization already happened in TypeScript. See this migration file''s own comment above for the full design/incident history.';

revoke all on function public.finalize_meta_whatsapp_selection(text, uuid, uuid, text) from public;
revoke all on function public.finalize_meta_whatsapp_selection(text, uuid, uuid, text) from anon;
revoke all on function public.finalize_meta_whatsapp_selection(text, uuid, uuid, text) from authenticated;
grant execute on function public.finalize_meta_whatsapp_selection(text, uuid, uuid, text) to service_role;

-- ── Verification (run manually — read-only) ─────────────────────────────
--
-- A. Table + columns:
--
-- select column_name, data_type, udt_name, is_nullable, column_default
-- from information_schema.columns
-- where table_schema = 'public' and table_name = 'meta_whatsapp_pending_selections'
-- order by ordinal_position;
--
-- B. PK (expect meta_whatsapp_pending_selections_pkey, PRIMARY KEY on selection_token_hash):
--
-- select conname, contype, pg_get_constraintdef(oid) as definition
-- from pg_constraint
-- where conrelid = 'public.meta_whatsapp_pending_selections'::regclass
-- order by conname;
--
-- C. RLS enabled (expect 1 row, relrowsecurity = true):
--
-- select c.relname, c.relrowsecurity
-- from pg_class c
-- join pg_namespace n on n.oid = c.relnamespace
-- where n.nspname = 'public' and c.relname = 'meta_whatsapp_pending_selections';
--
-- D. Policies (expect 0 rows — service-role-only by design):
--
-- select policyname from pg_policies
-- where schemaname = 'public' and tablename = 'meta_whatsapp_pending_selections';
--
-- E. Indexes:
--
-- select indexname, indexdef from pg_indexes
-- where schemaname = 'public' and tablename = 'meta_whatsapp_pending_selections';
--
-- F. RPC function exists, is SECURITY DEFINER, has a pinned search_path:
--
-- select proname, prosecdef, proconfig
-- from pg_proc
-- where pronamespace = 'public'::regnamespace and proname = 'finalize_meta_whatsapp_selection';
-- -- expect prosecdef = true, proconfig containing 'search_path=public, pg_temp'
--
-- G. RPC grants (expect exactly one row: service_role / EXECUTE):
--
-- select grantee, privilege_type
-- from information_schema.routine_privileges
-- where routine_schema = 'public' and routine_name = 'finalize_meta_whatsapp_selection';
