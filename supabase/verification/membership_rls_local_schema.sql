-- supabase/verification/membership_rls_local_schema.sql
--
-- THROWAWAY POSTGRES ONLY. A minimal reconstruction of the production objects that
-- supabase/migrations/20261031_membership_rls_containment.sql touches, for membership_rls_pg_check.sh:
--   - Supabase's anon / authenticated / service_role (BYPASSRLS) roles and auth.uid() (reads request.jwt.claim.sub);
--   - organizations, profiles, org_memberships, invitations with the production keys, foreign keys and checks the policies
--     and the app's writes depend on (other columns omitted);
--   - Supabase's default grants (ALL on tables, and on new functions, to anon/authenticated/service_role);
--   - the production RLS flags and EVERY production policy on these four tables, copied VERBATIM from the production schema
--     dump of 2026-10-30 (connect-prod-20261030T154610Z-pre-pr31/schema.sql), plus public.get_user_id_by_email and its grants.
-- The org_memberships role check is the nine-role version now live (20261031_org_memberships_role_office_manager.sql).

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
end $$;

create schema auth;
create table auth.users (id uuid primary key, email text unique);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;

create table public.organizations (
  id uuid default gen_random_uuid() not null primary key,
  name text,
  created_by uuid,
  logo_url text,
  onboarding_complete boolean default false
);

create table public.profiles (
  id uuid not null primary key,
  email text not null unique,
  organization_id uuid references public.organizations(id) on delete set null,
  role text default 'member',
  first_name text,
  last_name text,
  phone text,
  ssn text,
  ein text
);

create table public.org_memberships (
  org_id uuid not null references public.organizations(id) on delete cascade,
  member_id uuid not null references public.profiles(id) on delete cascade,
  role text default 'member' not null,
  worker_type text,
  name text,
  primary key (org_id, member_id),
  constraint org_memberships_role_check check (role = any (array['owner', 'admin', 'office_manager', 'estimator', 'sales',
    'project_manager', 'field_worker', 'accountant', 'viewer']))
);

create table public.invitations (
  id uuid default gen_random_uuid() not null primary key,
  organization_id uuid references public.organizations(id) on delete cascade,
  email text not null,
  role text default 'member',
  token text not null unique,
  status text default 'pending',
  expires_at timestamptz not null,
  invited_by uuid,
  ssn text,
  ein text,
  project_id uuid,
  portal_slug text
);

alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.org_memberships enable row level security;
alter table public.invitations enable row level security;

-- ── Production policies and get_user_id_by_email (verbatim from the 2026-10-30 dump) ──
CREATE POLICY "Anyone can look up invitation by token" ON "public"."invitations" FOR SELECT USING (true);
CREATE POLICY "Authenticated users can create organizations" ON "public"."organizations" FOR INSERT TO "authenticated" WITH CHECK (("created_by" = "auth"."uid"()));
CREATE POLICY "Authenticated users can view all profiles" ON "public"."profiles" FOR SELECT TO "authenticated" USING (true);
CREATE POLICY "Delete memberships in own org" ON "public"."org_memberships" FOR DELETE TO "authenticated" USING (("org_id" IN ( SELECT "profiles"."organization_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));
CREATE POLICY "Insert memberships in own org" ON "public"."org_memberships" FOR INSERT TO "authenticated" WITH CHECK (("org_id" IN ( SELECT "profiles"."organization_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));
CREATE POLICY "Members can update organization branding" ON "public"."organizations" FOR UPDATE TO "authenticated" USING (("id" IN ( SELECT "org_memberships"."org_id"
   FROM "public"."org_memberships"
  WHERE ("org_memberships"."member_id" = "auth"."uid"())))) WITH CHECK (("id" IN ( SELECT "org_memberships"."org_id"
   FROM "public"."org_memberships"
  WHERE ("org_memberships"."member_id" = "auth"."uid"()))));
CREATE POLICY "Organization members can update" ON "public"."organizations" FOR UPDATE TO "authenticated" USING (("id" IN ( SELECT "profiles"."organization_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())))) WITH CHECK (("id" IN ( SELECT "profiles"."organization_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));
CREATE POLICY "Owners/Admins delete memberships" ON "public"."org_memberships" FOR DELETE TO "authenticated" USING ((("org_id" = ( SELECT "profiles"."organization_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())
 LIMIT 1)) AND (( SELECT "profiles"."role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())
 LIMIT 1) = ANY (ARRAY['owner'::"text", 'admin'::"text"]))));
CREATE POLICY "Owners/Admins insert memberships" ON "public"."org_memberships" FOR INSERT TO "authenticated" WITH CHECK ((("org_id" = ( SELECT "profiles"."organization_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())
 LIMIT 1)) AND (( SELECT "profiles"."role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())
 LIMIT 1) = ANY (ARRAY['owner'::"text", 'admin'::"text"]))));
CREATE POLICY "Owners/Admins update memberships" ON "public"."org_memberships" FOR UPDATE TO "authenticated" USING ((("org_id" = ( SELECT "profiles"."organization_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())
 LIMIT 1)) AND (( SELECT "profiles"."role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())
 LIMIT 1) = ANY (ARRAY['owner'::"text", 'admin'::"text"])))) WITH CHECK (("org_id" = ( SELECT "profiles"."organization_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())
 LIMIT 1)));
CREATE POLICY "Read memberships in own org" ON "public"."org_memberships" FOR SELECT TO "authenticated" USING (("org_id" IN ( SELECT "profiles"."organization_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));
CREATE POLICY "Select memberships for same org" ON "public"."org_memberships" FOR SELECT TO "authenticated" USING (("org_id" = ( SELECT "profiles"."organization_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())
 LIMIT 1)));
CREATE POLICY "Service role can manage memberships" ON "public"."org_memberships" TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "Service role can manage profiles" ON "public"."profiles" TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access memberships" ON "public"."org_memberships" TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access profiles" ON "public"."profiles" TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "Service role has full access" ON "public"."organizations" TO "service_role" USING (true) WITH CHECK (true);
CREATE POLICY "Update memberships in own org" ON "public"."org_memberships" FOR UPDATE TO "authenticated" USING (("org_id" IN ( SELECT "profiles"."organization_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())))) WITH CHECK (("org_id" IN ( SELECT "profiles"."organization_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));
CREATE POLICY "Users can create invitations for their org" ON "public"."invitations" FOR INSERT TO "authenticated" WITH CHECK (("organization_id" IN ( SELECT "profiles"."organization_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));
CREATE POLICY "Users can create their own membership" ON "public"."org_memberships" FOR INSERT TO "authenticated" WITH CHECK (("member_id" = "auth"."uid"()));
CREATE POLICY "Users can create their own organization" ON "public"."organizations" FOR INSERT TO "authenticated" WITH CHECK (("created_by" = "auth"."uid"()));
CREATE POLICY "Users can insert own profile" ON "public"."profiles" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "id"));
CREATE POLICY "Users can read their own memberships" ON "public"."org_memberships" FOR SELECT TO "authenticated" USING (("member_id" = "auth"."uid"()));
CREATE POLICY "Users can read their own organization" ON "public"."organizations" FOR SELECT TO "authenticated" USING (("created_by" = "auth"."uid"()));
CREATE POLICY "Users can update own profile" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "id")) WITH CHECK (("auth"."uid"() = "id"));
CREATE POLICY "Users can update their organization branding" ON "public"."organizations" FOR UPDATE TO "authenticated" USING (("id" IN ( SELECT "profiles"."organization_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())))) WITH CHECK (("id" IN ( SELECT "profiles"."organization_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));
CREATE POLICY "Users can update their own org" ON "public"."organizations" FOR UPDATE TO "authenticated" USING (("id" IN ( SELECT "profiles"."organization_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())
UNION
 SELECT "org_memberships"."org_id"
   FROM "public"."org_memberships"
  WHERE ("org_memberships"."member_id" = "auth"."uid"()))));
CREATE POLICY "Users can update their own organization" ON "public"."organizations" FOR UPDATE TO "authenticated" USING (("created_by" = "auth"."uid"()));
CREATE POLICY "Users can upsert their own profile" ON "public"."profiles" TO "authenticated" USING (("id" = "auth"."uid"())) WITH CHECK (("id" = "auth"."uid"()));
CREATE POLICY "Users can view invitations for their org" ON "public"."invitations" FOR SELECT TO "authenticated" USING (("organization_id" IN ( SELECT "profiles"."organization_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));
CREATE POLICY "Users can view their organization" ON "public"."organizations" FOR SELECT TO "authenticated" USING (("id" IN ( SELECT "profiles"."organization_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));
CREATE OR REPLACE FUNCTION "public"."get_user_id_by_email"("user_email" "text") RETURNS TABLE("id" "uuid")
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
  select id from auth.users where email = user_email limit 1;
$$;
GRANT ALL ON FUNCTION "public"."get_user_id_by_email"("user_email" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_user_id_by_email"("user_email" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_user_id_by_email"("user_email" "text") TO "service_role";
