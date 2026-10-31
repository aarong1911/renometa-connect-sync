-- DEPLOYMENT COPY — PRODUCTION, fingerprint 40f7d0682459c01da59e6410662d7bd2
--
-- STATUS: APPLIED to production manually on 2026-10-31. Kept as the record of exactly what ran. Do not apply it again
-- (a re-run is a no-op: it returns at the s1:no-metadata-authority check) and do not edit it; further changes go in a
-- new migration.
--
-- Generated from supabase/migrations/20261031_handle_invited_user_no_metadata_authority.sql with the confirmed
-- production def_md5 filled in. Not in supabase/migrations/ on purpose: apply this file ONCE, by hand, as `postgres`:
--   psql "<production url>" -v ON_ERROR_STOP=1 -f supabase/deploy/20261031_handle_invited_user_no_metadata_authority.production.sql
-- It refuses to run if public.handle_invited_user() no longer has exactly this definition (re-run the preflight first:
-- supabase/verification/handle_invited_user_preflight.sql; section 1 def_md5 must equal 40f7d0682459c01da59e6410662d7bd2).
--
-- Original definition (the rollback artifact): C:UsersinfoRenoMeta-Backupshandle_invited_user_pre_s1_20261031.csv,
-- column function_definition — owner postgres, SECURITY DEFINER, no SET options, def_md5 40f7d0682459c01da59e6410662d7bd2.
-- Its stored body uses CRLF line endings (only the generated header lines are LF); md5 with every CR removed is
-- b7d38e74b7cef7ed36010c96bd060933.
--
-- Stops the email-confirmation trigger from granting organization access based on user metadata.
--
-- STATUS: UNAPPLIED. Apply as the `postgres` role, as one transaction, ONLY after the preflight in
-- supabase/verification/handle_invited_user_preflight.sql and — this copy has the confirmed production fingerprint filled in.
-- Independent of 20261031_org_memberships_role_office_manager.sql and of the accept-invite.ts change.
--
-- OBSERVED PRODUCTION BEHAVIOR (reviewed 2026-10-31): trigger on_invited_user_confirmed, AFTER UPDATE ON auth.users,
-- EXECUTE FUNCTION public.handle_invited_user(). When raw_user_meta_data has org_id and email_confirmed_at goes from
-- NULL to a value, the function
--   1. inserts org_memberships(member_id, org_id, role) from the METADATA org_id and role, ON CONFLICT DO NOTHING;
--   2. updates profiles.organization_id and first/last name from the metadata;
--   3. marks the org's pending invitations for that email accepted;
-- and validates no invitation first. raw_user_meta_data is client-controlled: anyone with the public anon key can
-- sign up (supabase.auth.signUp / signInWithOtp with options.data = { org_id: <any org>, role: 'owner' }), confirm
-- their own email, and get an owner membership plus profiles.organization_id — org-scoped RLS access — in any
-- organization whose id they know.
--
-- WHY GRANT NOTHING (rather than validate an invitation inside the trigger):
--   - Every legitimate path writes memberships server-side, from the invitation row: accept-invite.ts (token-based;
--     creates the user without metadata, so this trigger never acts for it) and invite-member.ts (roster-only
--     workers: auth user + profile + membership written at roster time).
--   - Email confirmation proves control of an address, not acceptance of a specific invitation.
--   - A SECURITY DEFINER insert in a confirmation trigger can block sign-in when it fails.
--
-- WHAT THIS DOES:
--   1. Preconditions (any mismatch stops the whole transaction, nothing changes):
--      - public.handle_invited_user() exists, returns trigger, and the caller is a member of its owner role;
--      - trigger on_invited_user_confirmed on auth.users is AFTER UPDATE (optionally OF columns / WHEN ...) and
--        executes this function, and it is the ONLY trigger executing this function;
--      - md5(pg_get_functiondef(...)) equals the fingerprint captured by the preflight IMMEDIATELY before deployment
--        (40f7d0682459c01da59e6410662d7bd2 in this copy). This pins the exact reviewed definition — body, SECURITY DEFINER, SET
--        options — so a definition that changed after review is never replaced blindly.
--      If the hardened body is already in place, it does nothing (idempotent; the fingerprint is then not needed).
--   2. Replaces public.handle_invited_user() IN PLACE (CREATE OR REPLACE: same OID, owner and ACL, so the trigger
--      keeps pointing at it and no DDL on auth.users is needed) with a body that grants nothing and returns NEW.
--      It becomes SECURITY INVOKER with search_path pinned to pg_catalog, pg_temp, and references no table.
--   3. Post-checks the replacement.
-- No backup function is created: the rollback uses the definition saved by the preflight (see Rollback). No RLS
-- policy, grant, table, row or the trigger itself is changed. EXECUTE on the function is left as it was (a trigger
-- function cannot be called directly, and leaving the ACL untouched keeps the rollback exact).

begin;

do $migration$
declare
  -- Confirmed production fingerprint (preflight 2026-10-31; backup handle_invited_user_pre_s1_20261031.csv).
  v_expected_def_md5 constant text := '40f7d0682459c01da59e6410662d7bd2';
  v_fn   oid := to_regprocedure('public.handle_invited_user()');
  v_src  text;
  v_def  text;
  v_trig record;
  v_n    int;
begin
  if v_fn is null then
    raise exception 'precondition failed: public.handle_invited_user() does not exist';
  end if;
  if (select prorettype from pg_proc where oid = v_fn) <> 'trigger'::regtype then
    raise exception 'precondition failed: public.handle_invited_user() is not a trigger function';
  end if;
  if not pg_has_role(current_user, (select proowner from pg_proc where oid = v_fn), 'MEMBER') then
    raise exception 'precondition failed: % is not a member of the owner role of public.handle_invited_user()', current_user;
  end if;

  select t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) as def into v_trig
    from pg_trigger t
   where t.tgrelid = 'auth.users'::regclass and t.tgname = 'on_invited_user_confirmed' and not t.tgisinternal;
  if v_trig.tgname is null then
    raise exception 'precondition failed: trigger on_invited_user_confirmed on auth.users not found';
  end if;
  if v_trig.def !~* '\mAFTER UPDATE( OF [^)]*?)? ON auth\.users\M'
     or v_trig.def !~* 'EXECUTE (FUNCTION|PROCEDURE) (public\.)?handle_invited_user\(\)' then
    raise exception 'precondition failed: on_invited_user_confirmed is not AFTER UPDATE ON auth.users -> handle_invited_user(): %', v_trig.def;
  end if;
  if v_trig.tgenabled = 'D' then
    raise notice 'note: on_invited_user_confirmed is currently DISABLED; the function is hardened anyway';
  end if;
  select count(*) into v_n from pg_trigger where tgfoid = v_fn and not tgisinternal;
  if v_n <> 1 then
    raise exception 'precondition failed: expected exactly one trigger executing public.handle_invited_user() (on_invited_user_confirmed), found %; review every trigger before hardening', v_n;
  end if;

  select prosrc into v_src from pg_proc where oid = v_fn;
  if v_src like '%s1:no-metadata-authority%' then
    raise notice 'public.handle_invited_user() is already hardened; nothing to do';
    return;
  end if;

  if v_expected_def_md5 !~ '^[0-9a-f]{32}$' then
    raise exception 'precondition failed: fill in v_expected_def_md5 with def_md5 from the preflight run made immediately before deployment';
  end if;
  v_def := pg_get_functiondef(v_fn);
  if md5(v_def) <> v_expected_def_md5 then
    raise exception 'precondition failed: public.handle_invited_user() changed since the preflight (def_md5 % <> %); re-run the preflight and re-review', md5(v_def), v_expected_def_md5;
  end if;

  execute $fn$
    create or replace function public.handle_invited_user()
    returns trigger
    language plpgsql
    security invoker
    set search_path = pg_catalog, pg_temp
    as $body$
    begin
      -- s1:no-metadata-authority
      -- Email confirmation grants nothing. raw_user_meta_data is client-controlled and is never used for authorization.
      -- Memberships and profile organizations are written only by the server-side onboarding functions
      -- (accept-invite.ts, invite-member.ts) from the invitation row.
      return new;
    end
    $body$
  $fn$;

  select prosrc into v_src from pg_proc where oid = v_fn;
  -- the replacement's code (comments stripped) must reference no table, no metadata and no write
  if v_src !~ 's1:no-metadata-authority'
     or regexp_replace(v_src, '--[^\n]*', '', 'g') ~* 'org_memberships|profiles|invitations|raw_user_meta_data|insert|update|delete' then
    raise exception 'post-check failed: the replacement body is not the hardened one';
  end if;
  if to_regprocedure('public.handle_invited_user()') <> v_fn
     or (select prosecdef from pg_proc where oid = v_fn)
     or (select proconfig from pg_proc where oid = v_fn) is distinct from array['search_path=pg_catalog, pg_temp'] then
    raise exception 'post-check failed: OID, SECURITY or search_path of the replacement is not as intended';
  end if;
end
$migration$;

commit;

-- ── Verification (run after applying) ───────────────────────────────────────
--   select md5(pg_get_functiondef(p.oid)) as def_md5, p.prosrc ~ 's1:no-metadata-authority' as hardened, p.prosecdef,
--          p.proconfig, p.proowner::regrole, p.proacl
--     from pg_proc p where p.oid = 'public.handle_invited_user()'::regprocedure;
--     -> hardened = true, prosecdef = false, proconfig = {"search_path=pg_catalog, pg_temp"}; owner and proacl as in the preflight
--   select tgname, tgenabled, pg_get_triggerdef(oid) from pg_trigger where tgfoid = 'public.handle_invited_user()'::regprocedure;
--     -> same rows as in the preflight
--
-- ── Rollback (deployment-specific) ──────────────────────────────────────────
-- Restores the original definition from the backup above, in place (same OID, owner and ACL; the trigger needs no
-- change). NOTE: this re-opens the metadata-based escalation.
--   1. Copy the function_definition field of the backup CSV EXACTLY (from CREATE OR REPLACE FUNCTION through the
--      closing $function$), without the surrounding CSV quotes, and put it, followed by `;`, on the ROLLBACK ARTIFACT
--      line below. Do not edit the backup file itself.
--   2. Run the block (uncommented) as `postgres`, preferably with psql -f, which keeps the CR bytes and so restores the
--      exact fingerprint. If a tool normalises line endings, the CR-insensitive fingerprint is accepted instead —
--      the restored definition is then identical except for line endings.
-- It refuses unless the S1-hardened body is what is live.
-- ROLLBACK-SQL-BEGIN
-- begin;
-- do $rollback$
-- begin
--   if coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.handle_invited_user()')), '') !~ 's1:no-metadata-authority' then
--     raise exception 'rollback precondition failed: public.handle_invited_user() is not the S1-hardened body; inspect it before restoring';
--   end if;
-- end
-- $rollback$;
-- @@ROLLBACK_ARTIFACT@@
-- do $rollback$
-- declare
--   v_def text := pg_get_functiondef('public.handle_invited_user()'::regprocedure);
-- begin
--   if md5(v_def) = '40f7d0682459c01da59e6410662d7bd2' then
--     raise notice 'restored: exact production fingerprint';
--   elsif md5(replace(v_def, chr(13), '')) = 'b7d38e74b7cef7ed36010c96bd060933' then
--     raise notice 'restored: identical to the production definition except line endings';
--   else
--     raise exception 'rollback verification failed: restored definition does not match the saved production definition';
--   end if;
-- end
-- $rollback$;
-- commit;
-- ROLLBACK-SQL-END
