-- Phase 6, Item 1 — transactional Lead-to-Deal conversion
--
-- Adds idempotency support to leads, adds won/lost stage classification to
-- pipeline_stages (backfilled narrowly, deals.status remains the
-- compatibility fallback for existing Deals until Phase 6 Items 3/4), and
-- creates the convert_lead_to_deal SECURITY DEFINER RPC.
--
-- DDL is written idempotently (if not exists / if exists guards) so an
-- interrupted deployment can be safely re-run or inspected.

-- ─────────────────────────────────────────────────────────────────────────
-- 1) leads: idempotency key
-- ─────────────────────────────────────────────────────────────────────────

alter table public.leads
  add column if not exists conversion_idempotency_key uuid;

create unique index if not exists leads_org_idempotency_key_uq
  on public.leads (org_id, conversion_idempotency_key)
  where conversion_idempotency_key is not null;

-- ─────────────────────────────────────────────────────────────────────────
-- 2) pipeline_stages: outcome classification + narrow backfill
-- ─────────────────────────────────────────────────────────────────────────

alter table public.pipeline_stages
  add column if not exists outcome text;

-- Backfill only confirmed exact terminal stage names from live data.
-- No fuzzy/normalized matching here — see column comment below.
update public.pipeline_stages
set outcome = 'won'
where lower(trim(name)) = 'won';

update public.pipeline_stages
set outcome = 'lost'
where lower(trim(name)) = 'lost';

update public.pipeline_stages
set outcome = 'open'
where outcome is null;

alter table public.pipeline_stages
  alter column outcome set default 'open';

alter table public.pipeline_stages
  alter column outcome set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'pipeline_stages_outcome_check'
  ) then
    alter table public.pipeline_stages
      add constraint pipeline_stages_outcome_check
      check (outcome in ('open', 'won', 'lost'));
  end if;
end $$;

comment on column public.pipeline_stages.outcome is
  'Source of truth for a STAGE''s own won/lost classification. Do NOT use '
  'this to reclassify existing Deals — most existing won/lost Deals belong '
  'to pipelines with no won/lost terminal stage yet. deals.status remains '
  'the compatibility fallback for existing Deal classification until every '
  'active Pipeline has configured won/lost terminal stages and existing '
  'Deals are reconciled onto them in Phase 6 Items 3 and 4.';

-- ─────────────────────────────────────────────────────────────────────────
-- 3) convert_lead_to_deal RPC
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.convert_lead_to_deal(
  p_lead_id uuid,
  p_idempotency_key uuid,

  p_contact_id uuid default null,
  p_new_contact jsonb default null,

  p_company_id uuid default null,
  p_new_company jsonb default null,
  p_company_contact_relationship jsonb default null,

  p_pipeline_id uuid default null,
  p_stage_id uuid default null,
  p_title text default null,
  p_value numeric default null,
  p_owner_id uuid default null,
  p_expected_close_date date default null,
  p_service_type text default null,
  p_project_address text default null,

  p_migrated_notes text default null,
  p_notes_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_uid uuid := auth.uid();
  v_org_id uuid;
  v_owner_id uuid;
  v_actor_name text;
  v_is_primary boolean;
  v_stored_notes_hash text;
  v_notes_migrated boolean;

  v_lead public.leads%rowtype;
  v_contact public.contacts%rowtype;
  v_company public.companies%rowtype;
  v_deal public.deals%rowtype;
  v_pipeline public.pipelines%rowtype;
  v_stage public.pipeline_stages%rowtype;
  v_owner_profile public.profiles%rowtype;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED: no authenticated user' using errcode = '28000';
  end if;

  if p_idempotency_key is null then
    raise exception 'IDEMPOTENCY_KEY_REQUIRED: p_idempotency_key must not be null' using errcode = '22004';
  end if;

  if (p_migrated_notes is null) <> (p_notes_hash is null) then
    raise exception 'INVALID_NOTES_PAYLOAD: p_migrated_notes and p_notes_hash must both be null or both be provided'
      using errcode = '22023';
  end if;

  -- Select, authorize, and lock in ONE statement. Because this function is
  -- SECURITY DEFINER, the row lock happens with elevated privilege
  -- regardless of RLS, so authorization must be baked into the WHERE
  -- clause itself rather than checked after an unauthorized lock is taken.
  -- A missing Lead and a cross-org Lead produce the identical NOT FOUND
  -- outcome below, so neither case leaks anything about cross-org data.
  select l.* into v_lead
  from public.leads l
  where l.id = p_lead_id
    and (
      exists (select 1 from public.org_memberships om where om.member_id = v_uid and om.org_id = l.org_id)
      or exists (select 1 from public.profiles p where p.id = v_uid and p.organization_id = l.org_id)
    )
  for update of l;

  if not found then
    raise exception 'LEAD_NOT_FOUND_OR_FORBIDDEN' using errcode = 'P0002';
  end if;

  v_org_id := v_lead.org_id;

  select coalesce(nullif(trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')), ''), email, 'Team member')
    into v_actor_name
    from public.profiles where id = v_uid;

  if exists (
    select 1 from public.leads
    where org_id = v_org_id
      and conversion_idempotency_key = p_idempotency_key
      and id <> p_lead_id
  ) then
    raise exception 'IDEMPOTENCY_KEY_REUSED: key already used on a different lead' using errcode = '23505';
  end if;

  -- Idempotency short-circuit: this lead already converted. Every
  -- canonical record is re-validated against v_org_id — a partial or
  -- inconsistent response is never returned. Note: converted_to_deal_id
  -- REFERENCES deals(id) ON DELETE SET NULL, so a normally deleted Deal
  -- already clears this column and allows a fresh conversion; the
  -- ORPHANED_CONVERSION branch below is defensive only.
  if v_lead.converted_to_deal_id is not null then
    select * into v_deal from public.deals where id = v_lead.converted_to_deal_id and org_id = v_org_id;
    if not found then
      raise exception 'ORPHANED_CONVERSION: lead.converted_to_deal_id % is missing or cross-org', v_lead.converted_to_deal_id
        using errcode = 'P0002';
    end if;

    select * into v_contact from public.contacts where id = v_deal.contact_id and org_id = v_org_id;
    if not found then
      raise exception 'CANONICAL_CONVERSION_DATA_INVALID: contact % missing or cross-org', v_deal.contact_id
        using errcode = 'P0002';
    end if;

    if v_deal.company_id is not null then
      select * into v_company from public.companies where id = v_deal.company_id and org_id = v_org_id;
      if not found then
        raise exception 'CANONICAL_CONVERSION_DATA_INVALID: company % missing or cross-org', v_deal.company_id
          using errcode = 'P0002';
      end if;
    end if;

    select * into v_pipeline from public.pipelines where id = v_deal.pipeline_id and org_id = v_org_id;
    if not found then
      raise exception 'CANONICAL_CONVERSION_DATA_INVALID: pipeline % missing or cross-org', v_deal.pipeline_id
        using errcode = 'P0002';
    end if;

    select * into v_stage from public.pipeline_stages where id = v_deal.stage_id and pipeline_id = v_pipeline.id;
    if not found then
      raise exception 'CANONICAL_CONVERSION_DATA_INVALID: stage % does not belong to pipeline %', v_deal.stage_id, v_pipeline.id
        using errcode = 'P0002';
    end if;

    if v_deal.assigned_to is not null then
      if not (
        exists (
          select 1
          from public.org_memberships
          where member_id = v_deal.assigned_to
            and org_id = v_org_id
        )
        or exists (
          select 1
          from public.profiles
          where id = v_deal.assigned_to
            and organization_id = v_org_id
        )
      ) then
        raise exception
          'CANONICAL_CONVERSION_DATA_INVALID: owner % is not a member of org %',
          v_deal.assigned_to,
          v_org_id
          using errcode = 'P0002';
      end if;

      select *
      into v_owner_profile
      from public.profiles
      where id = v_deal.assigned_to;

      if not found then
        raise exception
          'CANONICAL_CONVERSION_DATA_INVALID: owner profile % is missing',
          v_deal.assigned_to
          using errcode = 'P0002';
      end if;
    end if;

    -- Prove notes_migrated rather than assuming it. deal_activities.created_at
    -- is a real column (confirmed), so no fallback to occurred_at is needed.
    -- The metadata->>'lead_id' match guards against ever reading an
    -- unrelated activity row that happens to share deal_id/type/title.
    select metadata->>'notes_hash' into v_stored_notes_hash
    from public.deal_activities
    where deal_id = v_deal.id
      and activity_type = 'created'
      and title = 'Converted from lead'
      and metadata->>'lead_id' = v_lead.id::text
    order by created_at asc
    limit 1;

    if p_notes_hash is null then
      v_notes_migrated := true;
    elsif v_stored_notes_hash is not null and v_stored_notes_hash = p_notes_hash then
      v_notes_migrated := true;
    else
      v_notes_migrated := false;
    end if;

    return jsonb_build_object(
      'lead', to_jsonb(v_lead),
      'contact', to_jsonb(v_contact),
      'account', case when v_company.id is null then null else to_jsonb(v_company) end,
      'deal', to_jsonb(v_deal),
      'stage', to_jsonb(v_stage),
      'pipeline', to_jsonb(v_pipeline),
      'owner_profile', case when v_owner_profile.id is null then null else to_jsonb(v_owner_profile) end,
      'conversion_state', jsonb_build_object('created', false, 'reused_existing', true, 'notes_migrated', v_notes_migrated)
    );
  end if;

  -- ── Resolve Contact ──
  if p_contact_id is not null and p_new_contact is not null then
    raise exception 'INVALID_INPUT: pass either p_contact_id or p_new_contact, not both';
  end if;

  if p_contact_id is not null then
    select * into v_contact from public.contacts where id = p_contact_id and org_id = v_org_id;
    if not found then
      raise exception 'CONTACT_NOT_FOUND: % not in caller org', p_contact_id using errcode = 'P0002';
    end if;
  elsif p_new_contact is not null then
    insert into public.contacts (org_id, full_name, email, phone, address, source, labels)
    values (
      v_org_id,
      coalesce(p_new_contact->>'full_name', 'Unknown contact'),
      nullif(lower(trim(p_new_contact->>'email')), ''),
      nullif(regexp_replace(coalesce(p_new_contact->>'phone', ''), '\D', '', 'g'), ''),
      nullif(p_new_contact->>'address', ''),
      'lead_conversion',
      '{}'::text[]
    )
    returning * into v_contact;
  else
    raise exception 'INVALID_INPUT: p_contact_id or p_new_contact is required';
  end if;

  -- ── Resolve Account (optional — all-null means "no Account") ──
  if p_company_id is not null and p_new_company is not null then
    raise exception 'INVALID_INPUT: pass either p_company_id or p_new_company, not both';
  end if;

  if p_company_id is not null then
    -- Lock the company row now, before the primary-contact check below
    -- reads its dependent company_contacts state, closing the race
    -- between the check and the insert.
    select * into v_company from public.companies where id = p_company_id and org_id = v_org_id for update;
    if not found then
      raise exception 'COMPANY_NOT_FOUND: % not in caller org', p_company_id using errcode = 'P0002';
    end if;
  elsif p_new_company is not null then
    insert into public.companies (org_id, name)
    values (v_org_id, coalesce(p_new_company->>'name', 'Unknown account'))
    returning * into v_company;
    -- No lock needed: this row was just created in this same transaction
    -- and is invisible to any other transaction until commit.
  end if;

  if v_company.id is not null then
    v_is_primary := coalesce((p_company_contact_relationship->>'is_primary')::boolean, true);

    -- Resolve the company_contacts_one_primary_idx partial unique index
    -- explicitly, before insert — never rely on catching a unique
    -- violation. If another contact already holds primary for this
    -- company, downgrade this relationship rather than failing the whole
    -- conversion over a secondary metadata flag.
    if v_is_primary and exists (
      select 1 from public.company_contacts
      where company_id = v_company.id and is_primary = true and contact_id <> v_contact.id
    ) then
      v_is_primary := false;
    end if;

    insert into public.company_contacts (org_id, company_id, contact_id, relationship_title, department, is_primary)
    values (
      v_org_id, v_company.id, v_contact.id,
      p_company_contact_relationship->>'relationship_title',
      p_company_contact_relationship->>'department',
      v_is_primary
    )
    on conflict on constraint company_contacts_unique do nothing;
  end if;

  -- ── Resolve Pipeline ──
  if p_pipeline_id is not null then
    select * into v_pipeline from public.pipelines where id = p_pipeline_id and org_id = v_org_id and is_active;
    if not found then
      raise exception 'PIPELINE_NOT_FOUND: % not active in caller org', p_pipeline_id using errcode = 'P0002';
    end if;
  else
    select * into v_pipeline
      from public.pipelines
      where org_id = v_org_id and is_active
      order by is_default desc, created_at asc
      limit 1;
    if not found then
      raise exception 'NO_ACTIVE_PIPELINE: org % has no active pipeline', v_org_id using errcode = 'P0002';
    end if;
  end if;

  -- ── Resolve Stage — must belong to the resolved Pipeline ──
  if p_stage_id is not null then
    select * into v_stage from public.pipeline_stages where id = p_stage_id and pipeline_id = v_pipeline.id;
    if not found then
      raise exception 'STAGE_NOT_IN_PIPELINE: % does not belong to pipeline %', p_stage_id, v_pipeline.id
        using errcode = 'P0002';
    end if;
  else
    select * into v_stage
      from public.pipeline_stages
      where pipeline_id = v_pipeline.id and outcome = 'open'
      order by position asc
      limit 1;
    if not found then
      raise exception 'NO_OPEN_STAGE: pipeline % has no open-outcome stage', v_pipeline.id using errcode = 'P0002';
    end if;
  end if;

  -- ── Validate the EFFECTIVE owner, after coalescing p_owner_id and the
  --    Lead's own assigned_to — via both org_memberships and
  --    profiles.organization_id, since there is no evidence every
  --    assignable owner has an org_memberships row. ──
  v_owner_id := coalesce(p_owner_id, v_lead.assigned_to);
  if v_owner_id is not null then
    if not exists (
      select 1 from public.org_memberships where member_id = v_owner_id and org_id = v_org_id
      union
      select 1 from public.profiles where id = v_owner_id and organization_id = v_org_id
    ) then
      raise exception 'OWNER_NOT_IN_ORG: % is not a member of caller org', v_owner_id using errcode = 'P0002';
    end if;
    select * into v_owner_profile from public.profiles where id = v_owner_id;
  end if;

  -- deals.status = v_stage.outcome is a one-time derivation for THIS new
  -- Deal only — it does not reclassify any other Deal. Existing Deals
  -- elsewhere in the app keep relying on their own stored deals.status
  -- until Phase 6 Items 3/4 land (see column comment above).
  insert into public.deals (
    org_id, lead_id, contact_id, company_id, pipeline_id, stage_id,
    title, value, probability, expected_close_date, assigned_to,
    status, source, service_type, project_address, notes, stage_order
  )
  values (
    v_org_id, v_lead.id, v_contact.id, v_company.id, v_pipeline.id, v_stage.id,
    coalesce(p_title, v_contact.full_name || ' — ' || coalesce(p_service_type, 'Project')),
    coalesce(p_value, v_lead.estimated_value, 0),
    v_stage.probability,
    p_expected_close_date,
    v_owner_id,
    v_stage.outcome,
    v_lead.source,
    p_service_type,
    p_project_address,
    p_migrated_notes,
    0
  )
  returning * into v_deal;

  insert into public.deal_activities (org_id, deal_id, activity_type, title, description, actor_id, actor_name, metadata, occurred_at)
  values (
    v_org_id, v_deal.id, 'created', 'Converted from lead',
    'Converted from Lead ' || v_lead.id::text,
    v_uid, v_actor_name,
    jsonb_build_object(
      'lead_id', v_lead.id,
      'lead_source', v_lead.source,
      'original_lead_status', v_lead.status,
      'idempotency_key', p_idempotency_key,
      'notes_hash', p_notes_hash
    ),
    now()
  );

  update public.leads
  set status = 'converted',
      converted_to_deal_id = v_deal.id,
      conversion_idempotency_key = p_idempotency_key,
      updated_at = now()
  where id = v_lead.id
  returning * into v_lead;

  -- The Deal, activity, and Lead update above all happened in this same
  -- transaction — if execution reaches this point, the notes (if any were
  -- provided) are durably migrated.
  return jsonb_build_object(
    'lead', to_jsonb(v_lead),
    'contact', to_jsonb(v_contact),
    'account', case when v_company.id is null then null else to_jsonb(v_company) end,
    'deal', to_jsonb(v_deal),
    'stage', to_jsonb(v_stage),
    'pipeline', to_jsonb(v_pipeline),
    'owner_profile', case when v_owner_profile.id is null then null else to_jsonb(v_owner_profile) end,
    'conversion_state', jsonb_build_object('created', true, 'reused_existing', false, 'notes_migrated', true)
  );
end;
$function$;

revoke all on function public.convert_lead_to_deal(
  uuid, uuid, uuid, jsonb, uuid, jsonb, jsonb, uuid, uuid, text, numeric, uuid, date, text, text, text, text
) from public, anon;

grant execute on function public.convert_lead_to_deal(
  uuid, uuid, uuid, jsonb, uuid, jsonb, jsonb, uuid, uuid, text, numeric, uuid, date, text, text, text, text
) to authenticated;
