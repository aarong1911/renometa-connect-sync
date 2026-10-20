-- Estimate transactional RPC hardening.
--
-- STATUS: UNAPPLIED. Written for review; applied manually (Supabase SQL Editor) by the owner only after
-- review. Not applied by any tool or script. Adds three new functions + one internal validator, and REPLACES exactly one
-- existing trigger function (public.sync_project_estimate_total, see section "pre-0" below) so that it can run under the
-- RPCs' hardened search_path. Nothing else changes.
--
-- WHY: three estimate mutations were multi-statement sequences with compensating deletes, i.e. NOT atomic:
--   (1) AI create_estimate_draft  : insert header -> insert items -> (delete header on failure) -> fix activity
--   (2) AI add_estimate_line_items: read status/items -> insert items -> recompute+update totals -> (delete items)
--   (3) editor save               : update header -> insert replacement items -> delete old items -> (compensate)
-- A crash or a failed compensation left orphan headers, header/items drift, or duplicate item sets (live
-- incident: EST-000006). Each RPC below runs as ONE statement from the caller's point of view, i.e. one
-- transaction: any failure rolls back everything. No BEGIN/COMMIT appears inside a function (PL/pgSQL
-- functions run inside the caller's transaction; an unhandled exception aborts all of the function's writes).
--
-- LIVE SCHEMA AUDITED (user-provided pg_policies / information_schema.triggers output + PostgREST OpenAPI
-- column definitions; the repo's migrations do NOT fully reconstruct estimates/estimate_items):
--   estimates.created_by       uuid NOT NULL default auth.uid()  (NULL under service_role => must be supplied)
--   estimates.metadata         jsonb NOT NULL default '{}'
--   estimates.client_total     nullable default 0; live trigger trg_sync_total does NEW.total := NEW.client_total,
--                              so every write of `total` MUST write client_total identically (done below)
--   estimate_items.metadata    jsonb NOT NULL default '{}'
--   estimate_items.quantity/unit_price/total/position/taxable/optional/selected_by_customer/is_heading: NOT NULL w/ defaults
-- TRIGGERS PRESERVED (not replaced, not disabled): estimates_set_number, estimates_validate_relationships,
--   estimates_log_activity, estimates_prevent_number_change, trg_sync_total, on_estimate_update,
--   estimate_sent_trigger, estimates_link_approved_contract.
--
-- ERROR CONTRACT: every deliberate failure is `raise exception 'estimate_rpc:<code>' using errcode = 'P0001'`.
-- The TypeScript callers map <code> to the same safe user-facing messages as before; codes:
--   invalid_arguments | invalid_items | invalid_item | invalid_item_field | invalid_header_field |
--   invalid_metadata_field | attribution_required | attribution_failed | contact_required | not_found |
--   not_draft | delete_blocked
-- `not_found` is deliberately identical for "does not exist" and "belongs to another organization".
--
-- SEARCH PATH: SET search_path = pg_catalog, pg_temp on every function (pg_temp LAST so a temp object can never
-- shadow a catalog name); every table is schema-qualified (public.*). No reliance on `public` being searched.

-- ──────────────────────────────────────────────────────────────────────────────────────────────────────────
-- pre-0) Make the existing on_estimate_update trigger function safe under a hardened search_path.
--
-- FOUND BY REAL-SCHEMA TESTING: replace_estimate_items_transaction UPDATEs public.estimates, which fires the live
-- trigger on_estimate_update (AFTER UPDATE ... WHEN new.total IS DISTINCT FROM old.total) -> sync_project_estimate_total().
-- That function had NO search_path of its own and an UNQUALIFIED relation (`update projects`), so it inherits the calling
-- RPC's search_path (pg_catalog, pg_temp) and fails with: relation "projects" does not exist.
--
-- FIX (narrow, behavior-preserving): schema-qualify the one relation and pin the function's own search_path to
-- pg_catalog, pg_temp (every referenced relation is now qualified). SECURITY INVOKER is unchanged (still runs as the
-- caller under the caller's RLS, exactly as before); the trigger itself is not touched; the body is otherwise identical:
--   update projects set original_estimate_total = new.total where estimate_id = new.id
-- CREATE OR REPLACE keeps the function's owner and privileges. The RPC search_path is NOT broadened to include public.
--
-- AUDIT of the other trigger functions directly reachable from these RPCs (production definitions):
--   sync_total_to_client_total     references no relation (NEW.total := NEW.client_total)                    -> safe
--   log_estimate_activity          own search_path (public, pg_temp), qualifies public.estimate_activities    -> safe
--   validate_estimate_relationships own search_path (public, pg_temp)                                        -> safe
--   prevent_estimate_number_change own search_path (public, pg_temp)                                        -> safe
--   set_estimate_number            own search_path (public, pg_temp)                                        -> safe
--   link_approved_estimate_to_project own search_path (public, pg_temp), qualified, runs only on status->approved -> safe
--   set_updated_at (projects BEFORE UPDATE, reached via the update above) only calls now()                   -> safe
--   move_deal_to_proposal_sent     UNQUALIFIED pipeline_stages / pipelines / deals and NO search_path, BUT every
--       statement that names them sits behind `IF NEW.sent_at IS NOT NULL AND (OLD.sent_at IS NULL OR OLD.sent_at IS
--       DISTINCT FROM NEW.sent_at)`. None of the three RPCs can change sent_at (replace_ whitelists it out, add_/create_
--       never write it), so those statements are never planned or run from these RPCs. NOT changed here; it is a separate
--       pre-existing hardening item (it still fails if run under a hardened search_path by a sent_at-changing UPDATE).
-- ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.sync_project_estimate_total()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  update public.projects
  set original_estimate_total = new.total
  where estimate_id = new.id;
  return new;
end;
$$;

-- ──────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 0) Internal validator for AI-supplied line items.
--    Item JSON may contribute ONLY name / description / itemType. ANY other key (price, unit_price, quantity,
--    total, tax, discount, deposit, markup, margin, budget, ids ...) is rejected, not ignored.
--    Returns a normalized jsonb array of {name, description, item_type}. Pure (no table access).
-- ──────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.estimate_rpc_normalize_ai_items(p_items jsonb, p_min integer, p_max integer)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_elem jsonb;
  v_key  text;
  v_name text;
  v_desc text;
  v_type text;
  v_out  jsonb := '[]'::jsonb;
  v_count integer;
begin
  if p_items is null or jsonb_typeof(p_items) = 'null' then
    p_items := '[]'::jsonb;
  end if;
  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'estimate_rpc:invalid_items' using errcode = 'P0001';
  end if;
  v_count := jsonb_array_length(p_items);
  if v_count < p_min or v_count > p_max then
    raise exception 'estimate_rpc:invalid_items' using errcode = 'P0001';
  end if;

  for v_elem in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_elem) <> 'object' then
      raise exception 'estimate_rpc:invalid_item' using errcode = 'P0001';
    end if;
    for v_key in select jsonb_object_keys(v_elem) loop
      if v_key <> all (array['name', 'description', 'itemType']) then
        raise exception 'estimate_rpc:invalid_item_field' using errcode = 'P0001';
      end if;
    end loop;

    if jsonb_typeof(v_elem -> 'name') is distinct from 'string' then
      raise exception 'estimate_rpc:invalid_item' using errcode = 'P0001';
    end if;
    v_name := btrim(v_elem ->> 'name');
    if char_length(v_name) < 1 or char_length(v_name) > 200 then
      raise exception 'estimate_rpc:invalid_item' using errcode = 'P0001';
    end if;

    v_desc := null;
    if (v_elem ? 'description') and jsonb_typeof(v_elem -> 'description') <> 'null' then
      if jsonb_typeof(v_elem -> 'description') <> 'string' then
        raise exception 'estimate_rpc:invalid_item' using errcode = 'P0001';
      end if;
      v_desc := btrim(v_elem ->> 'description');
      if char_length(v_desc) < 1 or char_length(v_desc) > 1000 then
        raise exception 'estimate_rpc:invalid_item' using errcode = 'P0001';
      end if;
    end if;

    v_type := 'custom';
    if (v_elem ? 'itemType') and jsonb_typeof(v_elem -> 'itemType') <> 'null' then
      if jsonb_typeof(v_elem -> 'itemType') <> 'string' then
        raise exception 'estimate_rpc:invalid_item' using errcode = 'P0001';
      end if;
      v_type := v_elem ->> 'itemType';
      -- "discount" is deliberately NOT allowed: a discount is a price decision the assistant must never make.
      if v_type <> all (array['labor', 'material', 'service', 'equipment', 'allowance', 'fee', 'custom']) then
        raise exception 'estimate_rpc:invalid_item' using errcode = 'P0001';
      end if;
    end if;

    v_out := v_out || jsonb_build_array(jsonb_build_object('name', v_name, 'description', v_desc, 'item_type', v_type));
  end loop;

  return v_out;
end;
$$;

-- INTERNAL ONLY: not executable by ANY application role. The two SECURITY DEFINER RPCs below call it as the
-- function OWNER (a definer function executes with its owner's privileges, so the privilege check on this call uses
-- the owner, who always keeps EXECUTE on its own function; revoking from PUBLIC/anon/authenticated/service_role never
-- removes the owner's privilege). Hence no grant is needed or given. Both RPCs are created by the same migration,
-- so they share the owner.
revoke all on function public.estimate_rpc_normalize_ai_items(jsonb, integer, integer) from public, anon, authenticated, service_role;

comment on function public.estimate_rpc_normalize_ai_items(jsonb, integer, integer) is
  'Internal validator for AI-supplied estimate line items: only name/description/itemType may be present; anything else (money, quantity, ids) is rejected. Used by the AI estimate RPCs; not an API.';

-- ──────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 1) create_estimate_draft_transaction  (AI, trusted server only)
--
-- SECURITY DEFINER because it must write estimates / estimate_items / estimate_activities and verify
-- membership across tables on behalf of the approving user, with service-role semantics. EXECUTE is revoked
-- from public/anon/authenticated and granted ONLY to service_role (called solely by the trusted Netlify
-- function after the Level-2 human approval). p_org_id and p_created_by are NEVER model/browser input: they
-- come from the executor's trusted context. Authorization is re-verified here, inside the transaction:
--   * p_created_by must be a member of p_org_id (profiles.organization_id OR org_memberships) else
--     attribution_required (no fallback to an owner/admin/system identity, no fabricated actor);
--   * lead / project / contact must belong to p_org_id, else not_found (indistinguishable from "missing").
-- Money/quantity are HARDCODED here — the caller cannot supply any (see the validator above).
-- Idempotency: a transaction advisory lock on (org, execution id) serializes replays; a replay returns the
-- existing estimate instead of creating a second one.
-- ──────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.create_estimate_draft_transaction(
  p_org_id       uuid,
  p_created_by   uuid,
  p_client_id    uuid,
  p_lead_id      uuid,
  p_project_id   uuid,
  p_title        text,
  p_scope        text,
  p_items        jsonb,
  p_execution_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_items        jsonb;
  v_title        text;
  v_scope        text;
  v_exec         text;
  v_exec_meta    jsonb := '{}'::jsonb;
  v_lead_contact uuid;
  v_client       uuid;
  v_existing     record;
  v_id           uuid;
  v_number       text;
  v_updated      integer;
  v_count        integer;
begin
  if p_org_id is null or p_created_by is null then
    raise exception 'estimate_rpc:invalid_arguments' using errcode = 'P0001';
  end if;
  v_title := btrim(coalesce(p_title, ''));
  if char_length(v_title) < 1 or char_length(v_title) > 200 then
    raise exception 'estimate_rpc:invalid_arguments' using errcode = 'P0001';
  end if;
  v_scope := nullif(btrim(coalesce(p_scope, '')), '');
  if v_scope is not null and char_length(v_scope) > 4000 then
    raise exception 'estimate_rpc:invalid_arguments' using errcode = 'P0001';
  end if;
  v_exec  := nullif(btrim(coalesce(p_execution_id, '')), '');
  v_items := public.estimate_rpc_normalize_ai_items(p_items, 0, 25);

  -- Actor: must be a real member of THIS organization (checked before anything else is read or written).
  if not (
    exists (select 1 from public.profiles pr where pr.id = p_created_by and pr.organization_id = p_org_id)
    or exists (select 1 from public.org_memberships m where m.member_id = p_created_by and m.org_id = p_org_id)
  ) then
    raise exception 'estimate_rpc:attribution_required' using errcode = 'P0001';
  end if;

  -- Replay / concurrent duplicate approval: serialize, then return the existing estimate if this execution
  -- already created one.
  if v_exec is not null then
    perform pg_advisory_xact_lock(hashtextextended('estimate_rpc:create:' || p_org_id::text || ':' || v_exec, 0));
    select e.id, e.number, e.status into v_existing
      from public.estimates e
     where e.org_id = p_org_id and e.metadata ->> 'ai_execution_id' = v_exec
     limit 1;
    if found then
      select count(*) into v_count from public.estimate_items i where i.estimate_id = v_existing.id;
      return jsonb_build_object(
        'estimate_id', v_existing.id, 'number', v_existing.number, 'status', v_existing.status,
        'item_count', v_count, 'already_created', true
      );
    end if;
    v_exec_meta := jsonb_build_object('ai_execution_id', v_exec);
  end if;

  -- Relationships: same-organization only.
  if p_lead_id is not null then
    select l.contact_id into v_lead_contact from public.leads l where l.id = p_lead_id and l.org_id = p_org_id;
    if not found then
      raise exception 'estimate_rpc:not_found' using errcode = 'P0001';
    end if;
  end if;
  if p_project_id is not null then
    perform 1 from public.projects p where p.id = p_project_id and p.org_id = p_org_id;
    if not found then
      raise exception 'estimate_rpc:not_found' using errcode = 'P0001';
    end if;
  end if;
  v_client := coalesce(p_client_id, v_lead_contact);
  if v_client is null then
    raise exception 'estimate_rpc:contact_required' using errcode = 'P0001';
  end if;
  perform 1 from public.contacts c where c.id = v_client and c.org_id = p_org_id;
  if not found then
    raise exception 'estimate_rpc:not_found' using errcode = 'P0001';
  end if;

  -- Header. `number` is generated by the existing estimates_set_number trigger. total and client_total are
  -- written together (live trg_sync_total does NEW.total := NEW.client_total). All money is zero by design.
  insert into public.estimates (
    org_id, created_by, status, client_id, lead_id, project_id, title, scope,
    tax_rate, discount_type, discount_value, deposit_type, deposit_value,
    subtotal, discount_total, tax_total, total, client_total, deposit_amount, balance_due, metadata
  ) values (
    p_org_id, p_created_by, 'draft', v_client, p_lead_id, p_project_id, v_title, v_scope,
    0, null, 0, null, 0,
    0, 0, 0, 0, 0, 0, 0,
    jsonb_build_object('ai_generated', true, 'ai_source', 'estimate_assistant') || v_exec_meta
  )
  returning id, number into v_id, v_number;

  -- Items: structure only. Every quantity/price/total is hardcoded; the caller contributed name/description/type.
  insert into public.estimate_items (
    estimate_id, category, item_type, name, description, quantity, unit, unit_price, total,
    position, taxable, optional, selected_by_customer, is_heading, metadata
  )
  select
    v_id,
    case t.elem ->> 'item_type'
      when 'labor' then 'Labor' when 'material' then 'Material' when 'service' then 'Service'
      when 'equipment' then 'Equipment' when 'allowance' then 'Allowance' when 'fee' then 'Fee'
      else 'Custom' end,
    t.elem ->> 'item_type',
    t.elem ->> 'name',
    t.elem ->> 'description',
    1, 'each', 0, 0,
    (t.ord - 1)::integer, true, false, true, false,
    jsonb_build_object('ai_proposed', true, 'price_pending', true, 'quantity_pending', true) || v_exec_meta
  from jsonb_array_elements(v_items) with ordinality as t(elem, ord);

  -- Exactly ONE 'created' activity, attributed to the verified approver. The AFTER INSERT trigger
  -- (log_estimate_activity) wrote it with auth.uid() = NULL => actor_type 'system', actor_id NULL. Correct that
  -- single row. STRICT: the update must touch EXACTLY one row; zero (trigger missing/changed, row already
  -- attributed) or more than one (ambiguous) raises and rolls back the whole create. There is deliberately NO
  -- fallback insert: an activity is never fabricated. Existing activity metadata is merged, not replaced.
  update public.estimate_activities a
     set actor_id = p_created_by,
         actor_type = 'user',
         description = 'Drafted by the Estimate Assistant and approved by a team member.',
         metadata = coalesce(a.metadata, '{}'::jsonb)
                    || jsonb_build_object('attributed_via', 'estimate_assistant_approval', 'originally_recorded_as', 'system')
                    || v_exec_meta
   where a.org_id = p_org_id and a.estimate_id = v_id
     and a.activity_type = 'created' and a.actor_type = 'system' and a.actor_id is null;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'estimate_rpc:attribution_failed' using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'estimate_id', v_id, 'number', v_number, 'status', 'draft',
    'item_count', jsonb_array_length(v_items), 'already_created', false
  );
end;
$$;

revoke all on function public.create_estimate_draft_transaction(uuid, uuid, uuid, uuid, uuid, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.create_estimate_draft_transaction(uuid, uuid, uuid, uuid, uuid, text, text, jsonb, text) to service_role;

comment on function public.create_estimate_draft_transaction(uuid, uuid, uuid, uuid, uuid, text, text, jsonb, text) is
  'Atomic AI estimate draft: header + unpriced placeholder items + a single created-activity attributed to the verified approver, or nothing. SECURITY DEFINER, service_role only; org/actor come from trusted server context; money is hardcoded to zero; replays serialized by an advisory lock on (org, execution id).';

-- ──────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 2) add_estimate_line_items_transaction  (AI, trusted server only)
--
-- SECURITY DEFINER, service_role only (same reasoning as above). Locks the estimate row FOR UPDATE, requires
-- status = 'draft' INSIDE the transaction (closes the check-then-write race with a concurrent send), computes
-- the append position under that lock, skips names already on the estimate (case/whitespace-insensitive),
-- and is replay-safe (items already stamped with this execution id => returned, nothing inserted).
-- DOES NOT touch totals: every added line is a $0 pending placeholder, which cannot change any total, tax,
-- discount or deposit — so there is no totals write to fail or to clobber a concurrent editor save.
-- ──────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.add_estimate_line_items_transaction(
  p_org_id       uuid,
  p_estimate_id  uuid,
  p_items        jsonb,
  p_execution_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_items    jsonb;
  v_exec     text;
  v_exec_meta jsonb := '{}'::jsonb;
  v_status   text;
  v_total    numeric;
  v_replay   uuid[];
  v_ids      uuid[];
  v_skipped  text[];
  v_max      integer;
  v_count    integer;
begin
  if p_org_id is null or p_estimate_id is null then
    raise exception 'estimate_rpc:invalid_arguments' using errcode = 'P0001';
  end if;
  v_exec  := nullif(btrim(coalesce(p_execution_id, '')), '');
  v_items := public.estimate_rpc_normalize_ai_items(p_items, 1, 25);

  select e.status, e.total into v_status, v_total
    from public.estimates e
   where e.id = p_estimate_id and e.org_id = p_org_id
   for update;
  if not found then
    raise exception 'estimate_rpc:not_found' using errcode = 'P0001';
  end if;
  if v_status <> 'draft' then
    raise exception 'estimate_rpc:not_draft' using errcode = 'P0001';
  end if;

  if v_exec is not null then
    v_exec_meta := jsonb_build_object('ai_execution_id', v_exec);
    select array_agg(i.id order by i.position, i.id) into v_replay
      from public.estimate_items i
     where i.estimate_id = p_estimate_id and i.metadata ->> 'ai_execution_id' = v_exec;
    if v_replay is not null then
      select count(*) into v_count from public.estimate_items i where i.estimate_id = p_estimate_id;
      return jsonb_build_object(
        'estimate_id', p_estimate_id, 'added_item_ids', to_jsonb(v_replay), 'skipped_duplicate_names', '[]'::jsonb,
        'item_count', v_count, 'total', v_total, 'already_applied', true
      );
    end if;
  end if;

  select coalesce(max(i.position), -1) into v_max from public.estimate_items i where i.estimate_id = p_estimate_id;

  with incoming as (
    select t.ord,
           t.elem ->> 'name' as name,
           t.elem ->> 'description' as description,
           t.elem ->> 'item_type' as item_type,
           lower(regexp_replace(btrim(t.elem ->> 'name'), '\s+', ' ', 'g')) as norm
      from jsonb_array_elements(v_items) with ordinality as t(elem, ord)
  ), existing as (
    select lower(regexp_replace(btrim(coalesce(i.name, '')), '\s+', ' ', 'g')) as norm
      from public.estimate_items i
     where i.estimate_id = p_estimate_id and not i.is_heading
  ), picked as (
    select distinct on (n.norm) n.*
      from incoming n
     where n.norm not in (select x.norm from existing x)
     order by n.norm, n.ord
  ), ins as (
    insert into public.estimate_items (
      estimate_id, category, item_type, name, description, quantity, unit, unit_price, total,
      position, taxable, optional, selected_by_customer, is_heading, metadata
    )
    select
      p_estimate_id,
      case p.item_type
        when 'labor' then 'Labor' when 'material' then 'Material' when 'service' then 'Service'
        when 'equipment' then 'Equipment' when 'allowance' then 'Allowance' when 'fee' then 'Fee'
        else 'Custom' end,
      p.item_type, p.name, p.description,
      1, 'each', 0, 0,
      (v_max + row_number() over (order by p.ord))::integer, true, false, true, false,
      jsonb_build_object('ai_proposed', true, 'price_pending', true, 'quantity_pending', true) || v_exec_meta
    from picked p
    order by p.ord
    returning id
  ), skipped as (
    select array_agg(n.name order by n.ord) as names
      from incoming n
     where not exists (select 1 from picked p where p.ord = n.ord)
  )
  select coalesce((select array_agg(ins.id) from ins), '{}'::uuid[]),
         coalesce((select s.names from skipped s), '{}'::text[])
    into v_ids, v_skipped;

  if cardinality(v_ids) > 0 then
    update public.estimates set updated_at = now() where id = p_estimate_id;
  end if;

  select count(*) into v_count from public.estimate_items i where i.estimate_id = p_estimate_id;
  return jsonb_build_object(
    'estimate_id', p_estimate_id, 'added_item_ids', to_jsonb(v_ids), 'skipped_duplicate_names', to_jsonb(v_skipped),
    'item_count', v_count, 'total', v_total, 'already_applied', false
  );
end;
$$;

revoke all on function public.add_estimate_line_items_transaction(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.add_estimate_line_items_transaction(uuid, uuid, jsonb, text) to service_role;

comment on function public.add_estimate_line_items_transaction(uuid, uuid, jsonb, text) is
  'Atomic AI add-items: locks the estimate FOR UPDATE, requires draft status in-transaction, appends unpriced placeholder lines (deduped, replay-safe), never touches totals. SECURITY DEFINER, service_role only.';

-- ──────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 3) replace_estimate_items_transaction  (editor, called directly by the signed-in browser user)
--
-- SECURITY INVOKER ON PURPOSE: it runs as the caller (role `authenticated`), so the existing live RLS on
-- estimates / estimate_items is the tenant + permission boundary, exactly as for the editor's current direct
-- table writes. The function can do nothing the caller could not already do with plain UPDATE/DELETE/INSERT
-- calls; it only makes them atomic. There is NO org parameter: the estimate is located under the caller's own
-- RLS, so another organization's estimate is indistinguishable from a missing one (not_found).
-- Because RLS filters writes silently, the function VERIFIES that its UPDATE touched the row and that its
-- DELETE removed every item it counted — it raises (and rolls back) instead of silently duplicating items.
--
-- p_header is an EXPLICIT WHITELIST of editor-owned columns (unknown keys are REJECTED, not ignored). It can
-- never change org_id, created_by, number, status, version_number, public_token, any lifecycle timestamp, or
-- lead_id/project_id/deal_id/converted_*. A key that is ABSENT leaves the column unchanged; a present key
-- sets it. `client_total` is not accepted: it is always set equal to `total` (live trg_sync_total contract).
-- p_metadata_patch may contain ONLY editor-owned metadata keys (currently `serviceAddress`) and is MERGED
-- (metadata || patch) so ai_generated / ai_execution_id / any provenance survives.
-- p_items is the complete replacement set (may be empty). Each row: whitelisted keys only; `metadata` is
-- always stored as an object ('{}' when null/absent; a non-object is rejected). Row `metadata` is otherwise
-- stored exactly as given — the editor owns price_pending semantics (pending iff metadata.price_pending = true
-- AND price <= 0 AND not heading), unchanged here.
-- Concurrency: the estimate row is locked FOR UPDATE first (same lock order as the AI add-items RPC:
-- estimate -> items), so interleaved saves / AI appends serialize instead of producing duplicate item sets.
-- ──────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.replace_estimate_items_transaction(
  p_estimate_id    uuid,
  p_header         jsonb,
  p_metadata_patch jsonb,
  p_items          jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  v_header_allowed constant text[] := array[
    'title', 'client_id', 'client_name', 'company_id', 'owner_id', 'valid_until', 'scope', 'notes',
    'customer_note', 'terms', 'exclusions', 'assumptions', 'tax_rate', 'discount_type', 'discount_value',
    'deposit_type', 'deposit_value', 'subtotal', 'discount_total', 'tax_total', 'total', 'deposit_amount',
    'balance_due'
  ];
  v_meta_allowed constant text[] := array['serviceAddress'];
  v_item_allowed constant text[] := array[
    'category', 'item_type', 'name', 'description', 'quantity', 'unit', 'unit_price', 'total', 'position',
    'taxable', 'optional', 'is_heading', 'metadata'
  ];
  v_item_types constant text[] := array['labor', 'material', 'service', 'equipment', 'allowance', 'fee', 'discount', 'custom'];
  v_hk     text[];
  v_patch  jsonb;
  v_key    text;
  v_elem   jsonb;
  v_id     uuid;
  v_before integer;
  v_deleted integer;
  v_updated integer;
  v_ids    uuid[];
begin
  if p_estimate_id is null or p_header is null or jsonb_typeof(p_header) <> 'object' then
    raise exception 'estimate_rpc:invalid_arguments' using errcode = 'P0001';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'estimate_rpc:invalid_items' using errcode = 'P0001';
  end if;

  -- Input whitelist checks (before any lock or write).
  select coalesce(array_agg(k), '{}'::text[]) into v_hk from jsonb_object_keys(p_header) as k;
  foreach v_key in array v_hk loop
    if v_key <> all (v_header_allowed) then
      raise exception 'estimate_rpc:invalid_header_field' using errcode = 'P0001';
    end if;
  end loop;

  v_patch := case when p_metadata_patch is null or jsonb_typeof(p_metadata_patch) = 'null' then '{}'::jsonb else p_metadata_patch end;
  if jsonb_typeof(v_patch) <> 'object' then
    raise exception 'estimate_rpc:invalid_metadata_field' using errcode = 'P0001';
  end if;
  for v_key in select jsonb_object_keys(v_patch) loop
    if v_key <> all (v_meta_allowed) then
      raise exception 'estimate_rpc:invalid_metadata_field' using errcode = 'P0001';
    end if;
  end loop;

  for v_elem in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_elem) <> 'object' then
      raise exception 'estimate_rpc:invalid_item' using errcode = 'P0001';
    end if;
    for v_key in select jsonb_object_keys(v_elem) loop
      if v_key <> all (v_item_allowed) then
        raise exception 'estimate_rpc:invalid_item_field' using errcode = 'P0001';
      end if;
    end loop;
    if (v_elem ? 'metadata') and jsonb_typeof(v_elem -> 'metadata') not in ('object', 'null') then
      raise exception 'estimate_rpc:invalid_item' using errcode = 'P0001';
    end if;
    if (v_elem ? 'item_type') and jsonb_typeof(v_elem -> 'item_type') = 'string'
       and (v_elem ->> 'item_type') <> all (v_item_types) then
      raise exception 'estimate_rpc:invalid_item' using errcode = 'P0001';
    end if;
  end loop;

  -- Lock the estimate (under the CALLER'S RLS: invisible/foreign => not_found).
  select e.id into v_id from public.estimates e where e.id = p_estimate_id for update;
  if not found then
    raise exception 'estimate_rpc:not_found' using errcode = 'P0001';
  end if;

  -- Header: only whitelisted, present keys. total and client_total are always written together.
  update public.estimates e set
    title          = case when 'title'          = any (v_hk) then p_header ->> 'title'                       else e.title          end,
    client_id      = case when 'client_id'      = any (v_hk) then (p_header ->> 'client_id')::uuid           else e.client_id      end,
    client_name    = case when 'client_name'    = any (v_hk) then p_header ->> 'client_name'                 else e.client_name    end,
    company_id     = case when 'company_id'     = any (v_hk) then (p_header ->> 'company_id')::uuid          else e.company_id     end,
    owner_id       = case when 'owner_id'       = any (v_hk) then (p_header ->> 'owner_id')::uuid            else e.owner_id       end,
    valid_until    = case when 'valid_until'    = any (v_hk) then (p_header ->> 'valid_until')::date         else e.valid_until    end,
    scope          = case when 'scope'          = any (v_hk) then p_header ->> 'scope'                       else e.scope          end,
    notes          = case when 'notes'          = any (v_hk) then p_header ->> 'notes'                       else e.notes          end,
    customer_note  = case when 'customer_note'  = any (v_hk) then p_header ->> 'customer_note'              else e.customer_note  end,
    terms          = case when 'terms'          = any (v_hk) then p_header ->> 'terms'                       else e.terms          end,
    exclusions     = case when 'exclusions'     = any (v_hk) then p_header ->> 'exclusions'                  else e.exclusions     end,
    assumptions    = case when 'assumptions'    = any (v_hk) then p_header ->> 'assumptions'                 else e.assumptions    end,
    tax_rate       = case when 'tax_rate'       = any (v_hk) then (p_header ->> 'tax_rate')::numeric         else e.tax_rate       end,
    discount_type  = case when 'discount_type'  = any (v_hk) then p_header ->> 'discount_type'              else e.discount_type  end,
    discount_value = case when 'discount_value' = any (v_hk) then (p_header ->> 'discount_value')::numeric   else e.discount_value end,
    deposit_type   = case when 'deposit_type'   = any (v_hk) then p_header ->> 'deposit_type'               else e.deposit_type   end,
    deposit_value  = case when 'deposit_value'  = any (v_hk) then (p_header ->> 'deposit_value')::numeric    else e.deposit_value  end,
    subtotal       = case when 'subtotal'       = any (v_hk) then (p_header ->> 'subtotal')::numeric         else e.subtotal       end,
    discount_total = case when 'discount_total' = any (v_hk) then (p_header ->> 'discount_total')::numeric   else e.discount_total end,
    tax_total      = case when 'tax_total'      = any (v_hk) then (p_header ->> 'tax_total')::numeric        else e.tax_total      end,
    total          = case when 'total'          = any (v_hk) then (p_header ->> 'total')::numeric            else e.total          end,
    client_total   = case when 'total'          = any (v_hk) then (p_header ->> 'total')::numeric            else e.client_total   end,
    deposit_amount = case when 'deposit_amount' = any (v_hk) then (p_header ->> 'deposit_amount')::numeric   else e.deposit_amount end,
    balance_due    = case when 'balance_due'    = any (v_hk) then (p_header ->> 'balance_due')::numeric      else e.balance_due    end,
    metadata       = e.metadata || v_patch,
    updated_at     = now()
  where e.id = p_estimate_id;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    -- RLS silently filtered the write: treat as not permitted (rolls everything back).
    raise exception 'estimate_rpc:not_found' using errcode = 'P0001';
  end if;

  -- Items: replace the whole set. Atomic, so delete-then-insert has no data-loss window.
  select count(*) into v_before from public.estimate_items i where i.estimate_id = p_estimate_id;
  delete from public.estimate_items i where i.estimate_id = p_estimate_id;
  get diagnostics v_deleted = row_count;
  if v_deleted <> v_before then
    raise exception 'estimate_rpc:delete_blocked' using errcode = 'P0001';
  end if;

  with ins as (
    insert into public.estimate_items (
      estimate_id, category, item_type, name, description, quantity, unit, unit_price, total,
      position, taxable, optional, is_heading, metadata
    )
    select
      p_estimate_id,
      t.elem ->> 'category',
      t.elem ->> 'item_type',
      t.elem ->> 'name',
      t.elem ->> 'description',
      coalesce((t.elem ->> 'quantity')::numeric, 1),
      t.elem ->> 'unit',
      coalesce((t.elem ->> 'unit_price')::numeric, 0),
      coalesce((t.elem ->> 'total')::numeric, 0),
      coalesce((t.elem ->> 'position')::integer, (t.ord - 1)::integer),
      coalesce((t.elem ->> 'taxable')::boolean, true),
      coalesce((t.elem ->> 'optional')::boolean, false),
      coalesce((t.elem ->> 'is_heading')::boolean, false),
      case when jsonb_typeof(t.elem -> 'metadata') = 'object' then t.elem -> 'metadata' else '{}'::jsonb end
    from jsonb_array_elements(p_items) with ordinality as t(elem, ord)
    returning id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_ids from ins;

  return jsonb_build_object('estimate_id', p_estimate_id, 'item_ids', to_jsonb(v_ids), 'item_count', cardinality(v_ids));
end;
$$;

-- authenticated ONLY (the signed-in browser calls it; nothing server-side does, so service_role gets nothing).
revoke all on function public.replace_estimate_items_transaction(uuid, jsonb, jsonb, jsonb) from public, anon, service_role;
grant execute on function public.replace_estimate_items_transaction(uuid, jsonb, jsonb, jsonb) to authenticated;

comment on function public.replace_estimate_items_transaction(uuid, jsonb, jsonb, jsonb) is
  'Atomic estimate editor save: whitelisted header fields + merged editor metadata + full item replacement in one transaction. SECURITY INVOKER (existing RLS is the boundary); locks the estimate FOR UPDATE; any failure leaves the header and old items unchanged.';

-- ──────────────────────────────────────────────────────────────────────────────────────────────────────────
-- VERIFICATION (run AFTER applying, before trusting the change)
-- ──────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 1) Functions exist with the intended security mode, search_path and config:
--   select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef as security_definer, p.proconfig
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('create_estimate_draft_transaction','add_estimate_line_items_transaction',
--                        'replace_estimate_items_transaction','estimate_rpc_normalize_ai_items')
--    order by 1;
--   -- expect: the two AI RPCs security_definer = true; replace_* = false; all proconfig = {"search_path=pg_catalog, pg_temp"}
-- 2) Grants (AI RPCs service_role-only; the editor RPC authenticated-only; the normalize helper NO application role; never anon/public):
--   select routine_name, grantee, privilege_type from information_schema.role_routine_grants
--    where routine_schema = 'public' and routine_name in
--      ('create_estimate_draft_transaction','add_estimate_line_items_transaction','replace_estimate_items_transaction','estimate_rpc_normalize_ai_items')
--    order by 1, 2;
-- 3) Existing triggers are untouched (compare to the pre-apply list):
--   select event_object_table, trigger_name from information_schema.triggers
--    where event_object_table in ('estimates','estimate_items','estimate_activities') order by 1, 2;
-- 4) Atomicity / authorization behavior: run supabase/verification/estimate_transactional_rpcs_verification.sql
--    on a NON-PRODUCTION database (it is rollback-wrapped, but still not for production).
