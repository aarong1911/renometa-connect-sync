// src/lib/deals-store.ts
//
// Platform State Sync Phase S4A — Deals / Pipeline shared server state.
//
// BEFORE S4A: three module-level singletons (`deals`, `pipelines`,
// `stages`) + three listener Sets + three `emit*()` fns + `useSyncExternalStore`,
// all hydrated by one `fetchSalesData()` (`loaded`/`loadingPromise` guard).
// No realtime coverage; every mutation re-ran the whole `fetchSalesData()`.
//
// AFTER S4A: ONE TanStack Query per org (`queryKeys.deals(orgId)`) whose
// payload is the same co-loaded bundle `{ deals, pipelines, stages }` the
// old store hydrated together (a Deal can't be mapped without its stage,
// and every screen that reads deals also reads stages). `useDeals()`,
// `usePipelines()`, `usePipelineStages()` keep their EXACT public shapes —
// they're now thin slices of that one shared query, so every consumer
// (Pipeline board, Deal drawer, Leads, Inbox, Command Center, entity
// pickers, account/contact related tabs) reads the same cache. The
// imperative mutation functions keep their signatures; after a confirmed DB
// write + `deal_activities` log they invalidate `["deals"]` (+ scoped
// dependents) on the shared client instead of calling `fetchSalesData()`.
// The central RealtimeBridge now also invalidates `queryKeys.deals(orgId)`
// on any `deals` row change.
//
// UNCHANGED by S4A:
//  - `mapDeal` / `mapStage` / `resolveDealStatusForOutcome` normalisation
//  - `logDealActivity` and every activity it writes (created / stage_changed
//    / won / lost / updated / contact_linked / contact_unlinked) — Pipeline
//    Pulse and Recent Activity depend on these
//  - the `convert_lead_to_deal` RPC path (server-side; `upsertDealFromCanonical`
//    just reflects its result into the cache)
//  - `getDealActivities` / `getDealContacts` one-off reads
//  - all Pipeline Settings CRUD behaviour (pipelines / stages)

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { getQueryClient } from "@/lib/query-client";
import { useOrgId } from "@/lib/org-id";
import { queryKeys } from "@/lib/query-keys";
import type {
  AddDealInput,
  CreateDealInput,
  Deal,
  DealActivity,
  DealActivityType,
  DealAccountSummary,
  DealContact,
  DealContactSummary,
  DealOwnerSummary,
  DealStatus,
  LostReason,
  SalesPipeline,
  SalesPipelineStage,
  StageOutcome,
  UpdateDealInput,
} from "@/lib/sales/types";

export type SupabaseDealRow = {
  id: string;
  org_id: string;
  lead_id: string | null;
  contact_id: string | null;
  company_id: string | null;
  pipeline_id: string;
  stage_id: string;
  title: string;
  description: string | null;
  value: number | string;
  probability: number;
  expected_close_date: string | null;
  actual_close_date: string | null;
  assigned_to: string | null;
  status: DealStatus;
  lost_reason: string | null;
  notes: string | null;
  custom_fields: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  stage_order: number | null;
  source: string | null;
  service_type: string | null;
  budget: string | null;
  timeline: string | null;
  project_address: string | null;
  next_activity_at: string | null;
  next_activity_title: string | null;
  tags: string[] | null;
};

export type ContactRow = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  company_id: string | null;
  company: string | null;
  avatar_key: string | null;
  avatar_url: string | null;
};

// Phase 9.4 — a bounded subset of the canonical Company type (companies-store.ts),
// matching this file's own deliberately narrow `.select(...)` (it only ever
// needs these columns for deal cards, not a full company row). Re-declared
// as a Pick rather than importing Company directly so the select statement
// and the type can't silently drift apart, while still deriving field names
// from one canonical source instead of a second independent definition.
export type CompanyRow = Pick<
  import("@/lib/companies-store").Company,
  "id" | "name" | "slug" | "logo_url" | "email" | "phone" | "address" | "city" | "state"
>;

export type ProfileRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  avatar_url: string | null;
};

type DealContactRow = {
  id: string;
  org_id: string;
  deal_id: string;
  contact_id: string;
  relationship_title: string | null;
  role: string | null;
  is_primary: boolean;
  created_at: string;
  updated_at: string;
};

type DealActivityRow = {
  id: string;
  org_id: string;
  deal_id: string;
  activity_type: string;
  title: string;
  description: string | null;
  actor_id: string | null;
  actor_name: string | null;
  metadata: Record<string, unknown> | null;
  occurred_at: string;
  created_at: string;
};

const FALLBACK_STAGES: SalesPipelineStage[] = [
  ["new", "New", 0, 10, "#3b82f6"],
  ["qualified", "Qualified", 1, 25, "#8b5cf6"],
  ["site-visit", "Site Visit", 2, 40, "#06b6d4"],
  ["proposal", "Proposal", 3, 60, "#f59e0b"],
  ["negotiation", "Negotiation", 4, 80, "#f97316"],
  ["won", "Won", 5, 100, "#10b981"],
  ["lost", "Lost", 6, 0, "#ef4444"],
].map(([slug, name, position, probability, color]) => ({
  id: String(slug),
  pipelineId: "",
  name: String(name),
  slug: String(slug),
  position: Number(position),
  probability: Number(probability),
  color: String(color),
  outcome: (String(slug) === "won" ? "won" : String(slug) === "lost" ? "lost" : "open") as StageOutcome,
  createdAt: "",
  updatedAt: "",
}));

// ── The co-loaded sales bundle (one Query payload) ────────────────────────
export type SalesData = {
  deals: Deal[];
  pipelines: SalesPipeline[];
  stages: SalesPipelineStage[];
};

const EMPTY_SALES: SalesData = { deals: [], pipelines: [], stages: [...FALLBACK_STAGES] };

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function initials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
}

function profileName(profile?: ProfileRow | null): string {
  if (!profile) return "Unassigned";
  return (
    [profile.first_name, profile.last_name].filter(Boolean).join(" ") ||
    profile.email ||
    "Unassigned"
  );
}

async function getOrgId(): Promise<string | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("organization_id")
    .eq("id", user.id)
    .maybeSingle();
  if (profile?.organization_id) return profile.organization_id;
  const { data: membership } = await supabase
    .from("org_memberships")
    .select("org_id")
    .eq("member_id", user.id)
    .maybeSingle();
  return membership?.org_id ?? null;
}

async function getCurrentActor(): Promise<{ id: string | null; name: string | null }> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { id: null, name: null };
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, first_name, last_name, email")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile) return { id: user.id, name: user.email ?? "User" };
  return { id: profile.id, name: profileName(profile as ProfileRow) };
}

function mapPipeline(row: any): SalesPipeline {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    description: row.description ?? null,
    isDefault: Boolean(row.is_default),
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapStage(row: any): SalesPipelineStage {
  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    name: row.name,
    slug: slugify(row.name),
    position: Number(row.position ?? 0),
    probability: Number(row.probability ?? 50),
    color: row.color ?? "#3b82f6",
    outcome: (row.outcome as StageOutcome) ?? "open",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function clampProbability(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

// ── Single source of truth for deriving a Deal's status (and
// actual_close_date) from a pipeline stage's outcome. Every write path that
// moves a Deal into a stage or explicitly sets its status (addDeal,
// updateDeal — and, through those, the Pipeline board's drag-and-drop, the
// Deal drawer's Edit/Mark Won/Mark Lost actions, Leads' and Inbox's Create
// Deal flows) goes through this — nothing computes status independently.
// The convert_lead_to_deal RPC has its own equivalent derivation
// (v_stage.outcome -> deals.status) since it runs server-side in Postgres,
// not through this module — but follows the identical rule.
//
// `actualCloseDate: undefined` in the return means "leave the column
// untouched" (the caller should omit it from the update payload entirely);
// `null` or a date string means "set it explicitly".
export function resolveDealStatusForOutcome(
  outcome: StageOutcome,
  current: { status: DealStatus; actualCloseDate: string | null },
): { status: DealStatus; actualCloseDate: string | null | undefined } {
  if (outcome === "open") {
    // Only clear actual_close_date when actually leaving won/lost — if the
    // deal was already open, leave the column untouched.
    return { status: "open", actualCloseDate: current.status === "open" ? undefined : null };
  }
  // Entering won/lost: populate actual_close_date only if it isn't already
  // set — never overwrite an existing one.
  return {
    status: outcome,
    actualCloseDate: current.actualCloseDate ? undefined : new Date().toISOString().slice(0, 10),
  };
}

export function mapDeal(args: {
  row: SupabaseDealRow;
  contactsById: Record<string, ContactRow>;
  companiesById: Record<string, CompanyRow>;
  profilesById: Record<string, ProfileRow>;
  stagesById: Record<string, SalesPipelineStage>;
}): Deal {
  const { row, contactsById, companiesById, profilesById, stagesById } = args;
  const contact = row.contact_id ? contactsById[row.contact_id] : null;
  const company = row.company_id ? companiesById[row.company_id] : null;
  const ownerProfile = row.assigned_to ? profilesById[row.assigned_to] : null;
  const dbStage = stagesById[row.stage_id];
  const stage =
    row.status === "won" ? "won" : row.status === "lost" ? "lost" : (dbStage?.slug ?? "new");
  const stageName =
    row.status === "won" ? "Won" : row.status === "lost" ? "Lost" : (dbStage?.name ?? "New");
  const stageColor =
    row.status === "won"
      ? "#10b981"
      : row.status === "lost"
        ? "#ef4444"
        : (dbStage?.color ?? "#3b82f6");
  const ageDays = Math.max(
    0,
    Math.floor((Date.now() - new Date(row.created_at).getTime()) / 86_400_000),
  );
  const owner = profileName(ownerProfile);
  const primaryContact: DealContactSummary | null = contact
    ? {
        id: contact.id,
        fullName: contact.full_name,
        email: contact.email,
        phone: contact.phone,
        address: contact.address,
        companyId: contact.company_id,
        companyName: company?.name ?? contact.company,
        avatarKey: contact.avatar_key,
        avatarUrl: contact.avatar_url,
      }
    : null;
  const account: DealAccountSummary | null = company
    ? {
        id: company.id,
        name: company.name,
        slug: company.slug,
        logoUrl: company.logo_url,
        email: company.email,
        phone: company.phone,
        address: company.address,
        city: company.city,
        state: company.state,
      }
    : null;
  const ownerProfileSummary: DealOwnerSummary | null = ownerProfile
    ? {
        id: ownerProfile.id,
        name: owner,
        email: ownerProfile.email,
        avatarUrl: ownerProfile.avatar_url,
      }
    : null;

  return {
    id: row.id,
    orgId: row.org_id,
    leadId: row.lead_id,
    pipelineId: row.pipeline_id,
    stageId: row.stage_id,
    stage,
    stageName,
    stageColor,
    stagePosition: dbStage?.position ?? 0,
    status: row.status,
    name: row.title,
    description: row.description,
    value: Number(row.value ?? 0),
    probability: Number(row.probability ?? dbStage?.probability ?? 50),
    expectedClose: row.expected_close_date ?? "",
    actualCloseDate: row.actual_close_date,
    contactId: contact?.id ?? "",
    contactName: contact?.full_name ?? "No contact",
    contactAvatarKey: contact?.avatar_key ?? null,
    contactAvatarUrl: contact?.avatar_url ?? null,
    email: contact?.email ?? "",
    phone: contact?.phone ?? "",
    address: contact?.address ?? "",
    companyId: company?.id ?? row.company_id,
    companyName: company?.name ?? "",
    companySlug: company?.slug ?? null,
    companyLogoUrl: company?.logo_url ?? null,
    ownerId: ownerProfile?.id ?? undefined,
    owner,
    ownerInitials: initials(owner),
    ownerAvatarUrl: ownerProfile?.avatar_url ?? null,
    source: row.source,
    serviceType: row.service_type,
    budget: row.budget,
    timeline: row.timeline,
    projectAddress: row.project_address,
    nextActivityAt: row.next_activity_at,
    nextActivityTitle: row.next_activity_title,
    tags: row.tags ?? [],
    lostReason: (row.lost_reason as LostReason | null) ?? undefined,
    lostAt: row.status === "lost" ? (row.actual_close_date ?? row.updated_at) : undefined,
    notes: row.notes,
    customFields: row.custom_fields ?? {},
    ageDays,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stageOrder: Number(row.stage_order ?? 0),
    primaryContact,
    account,
    ownerProfile: ownerProfileSummary,
  };
}

/**
 * The sales bundle queryFn — org-scoped pipelines + stages + fully-enriched
 * deals (contact / company / owner batch sub-selects, exactly as the pre-S4A
 * store did). Self-contained (no React, no other query's cache) so it is
 * safe to run from `useQuery`, `ensureQueryData`, or `refetchQueries`.
 */
export async function fetchSalesDataForOrg(orgId: string): Promise<SalesData> {
  const [pipelineResult, stageResult, dealResult] = await Promise.all([
    supabase
      .from("pipelines")
      .select("*")
      .eq("org_id", orgId)
      .eq("is_active", true)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: true }),
    supabase.from("pipeline_stages").select("*").order("position", { ascending: true }),
    supabase
      .from("deals")
      .select("*")
      .eq("org_id", orgId)
      .order("stage_order", { ascending: true })
      .order("created_at", { ascending: false }),
  ]);
  if (pipelineResult.error) throw pipelineResult.error;
  if (stageResult.error) throw stageResult.error;
  if (dealResult.error) throw dealResult.error;

  const pipelines = (pipelineResult.data ?? []).map(mapPipeline);
  const pipelineIds = new Set(pipelines.map((pipeline) => pipeline.id));
  const mappedStages = (stageResult.data ?? [])
    .filter((row: any) => pipelineIds.has(row.pipeline_id))
    .map(mapStage);
  const stages = mappedStages.length ? mappedStages : [...FALLBACK_STAGES];

  const rows = (dealResult.data ?? []) as SupabaseDealRow[];
  const contactIds = [...new Set(rows.map((row) => row.contact_id).filter(Boolean))] as string[];
  const companyIds = [...new Set(rows.map((row) => row.company_id).filter(Boolean))] as string[];
  const ownerIds = [...new Set(rows.map((row) => row.assigned_to).filter(Boolean))] as string[];

  const [contactsResult, companiesResult, profilesResult] = await Promise.all([
    contactIds.length
      ? supabase
          .from("contacts")
          .select(
            "id, full_name, email, phone, address, company_id, company, avatar_key, avatar_url",
          )
          .eq("org_id", orgId)
          .in("id", contactIds)
      : Promise.resolve({ data: [], error: null }),
    companyIds.length
      ? supabase
          .from("companies")
          .select("id, name, slug, logo_url, email, phone, address, city, state")
          .eq("org_id", orgId)
          .in("id", companyIds)
      : Promise.resolve({ data: [], error: null }),
    ownerIds.length
      ? supabase
          .from("profiles")
          .select("id, first_name, last_name, email, avatar_url")
          .in("id", ownerIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (contactsResult.error) throw contactsResult.error;
  if (companiesResult.error) throw companiesResult.error;
  if (profilesResult.error) throw profilesResult.error;

  const contactsById = Object.fromEntries(
    ((contactsResult.data ?? []) as ContactRow[]).map((row) => [row.id, row]),
  );
  const companiesById = Object.fromEntries(
    ((companiesResult.data ?? []) as CompanyRow[]).map((row) => [row.id, row]),
  );
  const profilesById = Object.fromEntries(
    ((profilesResult.data ?? []) as ProfileRow[]).map((row) => [row.id, row]),
  );
  const stagesById = Object.fromEntries(
    stages.filter((stage) => stage.id.length > 20).map((stage) => [stage.id, stage]),
  );
  const deals = rows.map((row) =>
    mapDeal({ row, contactsById, companiesById, profilesById, stagesById }),
  );

  return { deals, pipelines, stages };
}

// ── Query cache helpers (module-level; the shared client is one instance) ──

const qc = () => getQueryClient();

/** Read the currently-cached sales bundle (any org key — normally exactly one). Read-only; used by mutations that need to resolve a stage/pipeline before writing. */
function getCachedSalesData(): SalesData {
  const entries = qc().getQueriesData<SalesData>({ queryKey: ["deals"] });
  for (const [, data] of entries) {
    if (data) return data;
  }
  return EMPTY_SALES;
}

/** Guarantee the sales bundle is loaded (fetch once if missing), then return it — the Query-backed replacement for the old `ensureSalesDataLoaded()`. */
async function ensureSalesData(): Promise<SalesData> {
  const orgId = await getOrgId();
  if (!orgId) return EMPTY_SALES;
  return qc().ensureQueryData({
    queryKey: queryKeys.deals(orgId),
    queryFn: () => fetchSalesDataForOrg(orgId),
  });
}

/** Immediately reflect a CONFIRMED change into the cached bundle so the UI updates before the reconciling refetch. Only ever called with real persisted data. */
function patchSalesCache(fn: (data: SalesData) => SalesData) {
  qc().setQueriesData<SalesData>({ queryKey: ["deals"] }, (old) => (old ? fn(old) : old));
}

function invalidateDeals() {
  void qc().invalidateQueries({ queryKey: ["deals"] });
}

/**
 * Deal change that also moves Command Center numbers (Pipeline Value KPI,
 * Live Pipeline donut, Needs Attention Deals). Pipeline Pulse is NOT here —
 * it reads `deal_activities`, whose INSERT already invalidates
 * dashboard.pipelinePulse via the RealtimeBridge. Scoped fan-out — not
 * invalidate-all.
 */
function invalidateDealsWithDependents() {
  void qc().invalidateQueries({ queryKey: ["deals"] });
  void qc().invalidateQueries({ queryKey: ["dashboard"] });
}

function resolveStageBySlug(stages: SalesPipelineStage[], slug?: string | null) {
  return slug ? (stages.find((stage) => stage.slug === slug) ?? null) : null;
}
function resolveStageById(stages: SalesPipelineStage[], id?: string | null) {
  return id ? (stages.find((stage) => stage.id === id) ?? null) : null;
}

async function findOrCreateContact(orgId: string, input: CreateDealInput): Promise<string | null> {
  if (input.contactId) return input.contactId;
  const email = input.email?.trim().toLowerCase() ?? "";
  const phone = input.phone ? input.phone.replace(/\D/g, "").slice(-10) : "";
  if (email) {
    const { data } = await supabase
      .from("contacts")
      .select("id")
      .eq("org_id", orgId)
      .ilike("email", email)
      .maybeSingle();
    if (data?.id) return data.id;
  }
  if (phone) {
    const { data } = await supabase
      .from("contacts")
      .select("id")
      .eq("org_id", orgId)
      .eq("phone", phone)
      .maybeSingle();
    if (data?.id) return data.id;
  }
  if (!input.contactName?.trim() && !email && !phone) return null;
  const { data, error } = await supabase
    .from("contacts")
    .insert({
      org_id: orgId,
      full_name: input.contactName?.trim() || "Unknown contact",
      email: email || null,
      phone: phone || null,
      address: input.address?.trim() || input.projectAddress?.trim() || null,
      company_id: input.companyId || null,
      source: input.source || "deal",
      labels: [],
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function logDealActivity(args: {
  orgId: string;
  dealId: string;
  activityType: DealActivityType | string;
  title: string;
  description?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const actor = await getCurrentActor();
  const { error } = await supabase.from("deal_activities").insert({
    org_id: args.orgId,
    deal_id: args.dealId,
    activity_type: args.activityType,
    title: args.title,
    description: args.description ?? null,
    actor_id: actor.id,
    actor_name: actor.name,
    metadata: args.metadata ?? {},
    occurred_at: new Date().toISOString(),
  });
  if (error) console.error("[deals-store] activity logging failed:", error);
}

// ── Public hooks (unchanged shapes) ──────────────────────────────────────

function useSalesData() {
  const orgId = useOrgId();
  return useQuery({
    queryKey: orgId ? queryKeys.deals(orgId) : ["deals", "_pending"],
    queryFn: () => fetchSalesDataForOrg(orgId as string),
    enabled: !!orgId,
    // Realtime + mutation invalidation drive freshness; staleTime just caps
    // redundant refetches on remount/focus churn. refetchOnWindowFocus is
    // inherited from the shared client defaults.
    staleTime: 45_000,
  });
}

export function useDeals(): Deal[] {
  return useSalesData().data?.deals ?? [];
}

export function usePipelines(): SalesPipeline[] {
  return useSalesData().data?.pipelines ?? [];
}

export function usePipelineStages(): SalesPipelineStage[] {
  return useSalesData().data?.stages ?? FALLBACK_STAGES;
}

// ── Imperative mutations (unchanged signatures) ─────────────────────────────

export async function addDeal(input: AddDealInput): Promise<Deal> {
  const { pipelines, stages } = await ensureSalesData();
  const orgId = await getOrgId();
  if (!orgId) throw new Error("Not authenticated");
  const pipeline =
    pipelines.find((item) => item.id === input.pipelineId) ??
    pipelines.find((item) => item.isDefault) ??
    pipelines[0];
  if (!pipeline) throw new Error("No active pipeline found");
  const stage =
    resolveStageById(stages, input.stageId) ??
    resolveStageBySlug(stages, input.stage) ??
    stages
      .filter((item) => item.pipelineId === pipeline.id)
      .sort((a, b) => a.position - b.position)[0];
  if (!stage || stage.id.length < 20) throw new Error("No valid pipeline stage found");
  const contactId = await findOrCreateContact(orgId, input);
  const expectedClose =
    input.expectedClose ?? new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  // A brand-new Deal always starts "open" per the resolution rule (there is
  // no prior status/actual_close_date to preserve) — unless it's created
  // directly into a stage already classified won/lost, in which case the
  // stage's outcome is the source of truth from the very first insert.
  const statusResolution = resolveDealStatusForOutcome(stage.outcome, {
    status: "open",
    actualCloseDate: null,
  });
  const { data, error } = await supabase
    .from("deals")
    .insert({
      org_id: orgId,
      lead_id: input.leadId ?? null,
      contact_id: contactId,
      company_id: input.companyId ?? null,
      pipeline_id: pipeline.id,
      stage_id: stage.id,
      title: input.name.trim(),
      description: input.description?.trim() || null,
      value: Number(input.value ?? 0),
      probability: Math.min(100, Math.max(0, Number(input.probability ?? stage.probability ?? 50))),
      expected_close_date: expectedClose || null,
      assigned_to: input.ownerId ?? null,
      status: statusResolution.status,
      actual_close_date: statusResolution.actualCloseDate ?? null,
      notes: input.notes?.trim() || null,
      custom_fields: input.customFields ?? {},
      source: input.source ?? null,
      service_type: input.serviceType ?? null,
      budget: input.budget ?? null,
      timeline: input.timeline ?? null,
      project_address: input.projectAddress?.trim() || input.address?.trim() || null,
      next_activity_at: input.nextActivityAt ?? null,
      next_activity_title: input.nextActivityTitle ?? null,
      tags: input.tags ?? [],
      stage_order: 0,
    })
    .select("*")
    .single();
  if (error) throw error;
  await logDealActivity({
    orgId,
    dealId: data.id,
    activityType: "created",
    title: "Deal created",
    description: input.name.trim(),
    metadata: {
      stage_id: stage.id,
      stage_name: stage.name,
      contact_id: contactId,
      company_id: input.companyId ?? null,
      value: Number(input.value ?? 0),
    },
  });
  // Force a refetch so the returned Deal is the fully-enriched, mapped row
  // (contact avatar/name, owner, stage) — same guarantee the old
  // `await fetchSalesData(); deals.find(...)` gave. Then reconcile the
  // Command Center's deal-backed numbers.
  await qc().refetchQueries({ queryKey: ["deals"] });
  void qc().invalidateQueries({ queryKey: ["dashboard"] });
  const created = getCachedSalesData().deals.find((deal) => deal.id === data.id);
  if (!created) throw new Error("Deal created but could not be reloaded");
  return created;
}

export async function updateDeal(
  id: string,
  patch: UpdateDealInput | Partial<Deal>,
): Promise<void> {
  const { deals, stages } = await ensureSalesData();
  const current = deals.find((deal) => deal.id === id);
  if (!current) throw new Error("Deal not found");
  // Optimistic: reflect the patch into the shared cache immediately so every
  // consumer (Pipeline board, drawer, related tabs) updates without waiting
  // for the reconciling refetch. Rolled back below if the write fails.
  patchSalesCache((d) => ({
    ...d,
    deals: d.deals.map((deal) => (deal.id === id ? ({ ...deal, ...patch } as Deal) : deal)),
  }));
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  let nextStatus = current.status;
  let resolvedStage: SalesPipelineStage | null = null;
  let explicitOutcome: StageOutcome | null = null;

  if ("stageId" in patch && patch.stageId) {
    resolvedStage = resolveStageById(stages, patch.stageId);
  } else if ("stage" in patch && patch.stage) {
    resolvedStage = resolveStageBySlug(stages, patch.stage);
    if (!resolvedStage && (patch.stage === "won" || patch.stage === "lost")) {
      // No real stage matches "won"/"lost" — these strings are used as
      // virtual pseudo-stages elsewhere in the app (winning/losing a Deal
      // doesn't require moving it to an actual stage row). Treat as an
      // explicit outcome rather than a stage resolution failure.
      explicitOutcome = patch.stage;
    }
  }
  if ("status" in patch && patch.status) explicitOutcome = patch.status;

  if (resolvedStage) {
    update.stage_id = resolvedStage.id;
    if (!("probability" in patch)) update.probability = resolvedStage.probability;
  }

  // pipeline_stages.outcome is the single source of truth for status
  // whenever a real stage is resolved — it wins over any redundant explicit
  // status/stage string the caller also passed alongside it.
  const outcome: StageOutcome | null = resolvedStage ? resolvedStage.outcome : explicitOutcome;
  if (outcome) {
    const resolution = resolveDealStatusForOutcome(outcome, {
      status: current.status,
      actualCloseDate: current.actualCloseDate,
    });
    nextStatus = resolution.status;
    update.status = resolution.status;
    if (resolution.actualCloseDate !== undefined) update.actual_close_date = resolution.actualCloseDate;
  }
  if ("name" in patch && patch.name !== undefined) update.title = patch.name;
  if ("description" in patch && patch.description !== undefined)
    update.description = patch.description;
  if ("value" in patch && patch.value !== undefined) update.value = patch.value;
  if ("probability" in patch && patch.probability !== undefined)
    update.probability = Math.min(100, Math.max(0, patch.probability));
  if ("expectedClose" in patch && patch.expectedClose !== undefined)
    update.expected_close_date = patch.expectedClose || null;
  if ("ownerId" in patch && patch.ownerId !== undefined) update.assigned_to = patch.ownerId || null;
  if ("contactId" in patch && patch.contactId !== undefined)
    update.contact_id = patch.contactId || null;
  if ("companyId" in patch && patch.companyId !== undefined)
    update.company_id = patch.companyId || null;
  if ("source" in patch && patch.source !== undefined) update.source = patch.source;
  if ("serviceType" in patch && patch.serviceType !== undefined)
    update.service_type = patch.serviceType;
  if ("budget" in patch && patch.budget !== undefined) update.budget = patch.budget;
  if ("timeline" in patch && patch.timeline !== undefined) update.timeline = patch.timeline;
  if ("projectAddress" in patch && patch.projectAddress !== undefined)
    update.project_address = patch.projectAddress;
  if ("nextActivityAt" in patch && patch.nextActivityAt !== undefined)
    update.next_activity_at = patch.nextActivityAt;
  if ("nextActivityTitle" in patch && patch.nextActivityTitle !== undefined)
    update.next_activity_title = patch.nextActivityTitle;
  if ("tags" in patch && patch.tags !== undefined) update.tags = patch.tags;
  if ("notes" in patch && patch.notes !== undefined) update.notes = patch.notes;
  if ("lostReason" in patch && patch.lostReason !== undefined)
    update.lost_reason = patch.lostReason;
  if ("customFields" in patch && patch.customFields !== undefined)
    update.custom_fields = patch.customFields;
  const { error } = await supabase
    .from("deals")
    .update(update)
    .eq("id", id)
    .eq("org_id", current.orgId);
  if (error) {
    // Roll back the optimistic patch to the exact pre-mutation row.
    patchSalesCache((d) => ({
      ...d,
      deals: d.deals.map((deal) => (deal.id === id ? current : deal)),
    }));
    throw error;
  }
  const stageChanged =
    ("stage" in patch && patch.stage !== current.stage) ||
    ("stageId" in patch && patch.stageId !== current.stageId);
  if (stageChanged) {
    const destinationName =
      nextStatus === "won"
        ? "Won"
        : nextStatus === "lost"
          ? "Lost"
          : (resolvedStage?.name ?? "Updated stage");
    await logDealActivity({
      orgId: current.orgId,
      dealId: id,
      activityType: nextStatus === "won" ? "won" : nextStatus === "lost" ? "lost" : "stage_changed",
      title:
        nextStatus === "won"
          ? "Deal marked as won"
          : nextStatus === "lost"
            ? "Deal marked as lost"
            : `Stage changed to ${destinationName}`,
      metadata: {
        from_stage: current.stage,
        to_stage: nextStatus === "open" ? resolvedStage?.slug : nextStatus,
        lost_reason: "lostReason" in patch ? (patch.lostReason ?? null) : null,
      },
    });
  } else {
    await logDealActivity({
      orgId: current.orgId,
      dealId: id,
      activityType: "updated",
      title: "Deal updated",
      metadata: { changed_fields: Object.keys(patch) },
    });
  }
  // Reconcile: refetch the bundle (recomputes derived stage/status/enrichment
  // fields the optimistic spread above can't) + refresh Command Center.
  invalidateDealsWithDependents();
}

export async function deleteDeal(id: string): Promise<void> {
  const { deals } = await ensureSalesData();
  const current = deals.find((deal) => deal.id === id);
  if (!current) return;
  const previousDeals = deals;
  patchSalesCache((d) => ({ ...d, deals: d.deals.filter((deal) => deal.id !== id) }));
  const { error } = await supabase.from("deals").delete().eq("id", id).eq("org_id", current.orgId);
  if (error) {
    patchSalesCache((d) => ({ ...d, deals: previousDeals }));
    throw error;
  }
  invalidateDealsWithDependents();
}

// Reflects a canonical Deal — plus the raw Contact/Company/Stage/Owner rows
// that came back alongside it (e.g. from the convert_lead_to_deal RPC) —
// into the shared Query cache without a second fetch. Reuses the exact same
// mapDeal()/mapStage() logic every other read path already trusts, so the
// resulting Deal is identical in shape to one loaded through
// fetchSalesDataForOrg. A follow-up `["deals"]` invalidation reconciles the
// full bundle (stage_order, sibling deals, etc.) in the background.
export function upsertDealFromCanonical(args: {
  deal: SupabaseDealRow;
  contact: ContactRow | null;
  company: CompanyRow | null;
  stage: any;
  ownerProfile: ProfileRow | null;
}): Deal {
  const mappedStage = mapStage(args.stage);
  const stagesById: Record<string, SalesPipelineStage> = { [mappedStage.id]: mappedStage };
  const contactsById: Record<string, ContactRow> = args.contact ? { [args.contact.id]: args.contact } : {};
  const companiesById: Record<string, CompanyRow> = args.company ? { [args.company.id]: args.company } : {};
  const profilesById: Record<string, ProfileRow> = args.ownerProfile ? { [args.ownerProfile.id]: args.ownerProfile } : {};

  const mapped = mapDeal({ row: args.deal, contactsById, companiesById, profilesById, stagesById });

  patchSalesCache((d) => {
    const stages = d.stages.some((s) => s.id === mappedStage.id) ? d.stages : [...d.stages, mappedStage];
    const idx = d.deals.findIndex((x) => x.id === mapped.id);
    const deals = idx >= 0 ? d.deals.map((x, i) => (i === idx ? mapped : x)) : [mapped, ...d.deals];
    return { ...d, deals, stages };
  });
  invalidateDealsWithDependents();

  return mapped;
}

export async function refreshDeals(): Promise<void> {
  await qc().refetchQueries({ queryKey: ["deals"] });
}

export async function getDealActivities(dealId: string): Promise<DealActivity[]> {
  const orgId = await getOrgId();
  if (!orgId) return [];
  const { data, error } = await supabase
    .from("deal_activities")
    .select("*")
    .eq("org_id", orgId)
    .eq("deal_id", dealId)
    .order("occurred_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as DealActivityRow[]).map((row) => ({
    id: row.id,
    orgId: row.org_id,
    dealId: row.deal_id,
    activityType: row.activity_type,
    title: row.title,
    description: row.description,
    actorId: row.actor_id,
    actorName: row.actor_name,
    metadata: row.metadata ?? {},
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  }));
}

export async function getDealContacts(dealId: string): Promise<DealContact[]> {
  const orgId = await getOrgId();
  if (!orgId) return [];
  const { data: links, error: linksError } = await supabase
    .from("deal_contacts")
    .select("*")
    .eq("org_id", orgId)
    .eq("deal_id", dealId)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true });
  if (linksError) throw linksError;
  const contactIds = ((links ?? []) as DealContactRow[]).map((link) => link.contact_id);
  let contactsById: Record<string, ContactRow> = {};
  if (contactIds.length) {
    const { data: contacts, error } = await supabase
      .from("contacts")
      .select("id, full_name, email, phone, address, company_id, company, avatar_key, avatar_url")
      .eq("org_id", orgId)
      .in("id", contactIds);
    if (error) throw error;
    contactsById = Object.fromEntries(
      ((contacts ?? []) as ContactRow[]).map((contact) => [contact.id, contact]),
    );
  }
  return ((links ?? []) as DealContactRow[]).map((link) => {
    const contact = contactsById[link.contact_id];
    return {
      id: link.id,
      orgId: link.org_id,
      dealId: link.deal_id,
      contactId: link.contact_id,
      relationshipTitle: link.relationship_title,
      role: link.role,
      isPrimary: link.is_primary,
      createdAt: link.created_at,
      updatedAt: link.updated_at,
      contact: contact
        ? {
            id: contact.id,
            fullName: contact.full_name,
            email: contact.email,
            phone: contact.phone,
            address: contact.address,
            companyId: contact.company_id,
            companyName: contact.company,
            avatarKey: contact.avatar_key,
            avatarUrl: contact.avatar_url,
          }
        : null,
    };
  });
}

export async function linkDealContact(args: {
  dealId: string;
  contactId: string;
  relationshipTitle?: string | null;
  role?: string | null;
  isPrimary?: boolean;
}) {
  const orgId = await getOrgId();
  if (!orgId) throw new Error("Not authenticated");
  const isPrimary = args.isPrimary ?? false;
  if (isPrimary) {
    await supabase
      .from("deal_contacts")
      .update({ is_primary: false })
      .eq("org_id", orgId)
      .eq("deal_id", args.dealId);
    await supabase
      .from("deals")
      .update({ contact_id: args.contactId, updated_at: new Date().toISOString() })
      .eq("org_id", orgId)
      .eq("id", args.dealId);
  }
  const { error } = await supabase
    .from("deal_contacts")
    .upsert(
      {
        org_id: orgId,
        deal_id: args.dealId,
        contact_id: args.contactId,
        relationship_title: args.relationshipTitle ?? null,
        role: args.role ?? null,
        is_primary: isPrimary,
      },
      { onConflict: "deal_id,contact_id" },
    );
  if (error) throw error;
  await logDealActivity({
    orgId,
    dealId: args.dealId,
    activityType: "contact_linked",
    title: "Contact linked to deal",
    metadata: {
      contact_id: args.contactId,
      is_primary: isPrimary,
      relationship_title: args.relationshipTitle ?? null,
      role: args.role ?? null,
    },
  });
  invalidateDeals();
}

// ── Pipeline Settings: real Supabase-backed CRUD ──────────────────────────
// Additive only — every existing export above is untouched. All mutations
// follow the same convention: write to Supabase, then invalidate/refetch
// the shared sales Query so the board, New Deal dialog, and Deal drawer all
// pick up the change immediately without a page reload.

export async function createPipeline(input: {
  name: string;
  description?: string | null;
  isDefault?: boolean;
}): Promise<SalesPipeline> {
  const orgId = await getOrgId();
  if (!orgId) throw new Error("Not authenticated");
  if (!input.name?.trim()) throw new Error("Pipeline name is required");

  if (input.isDefault) {
    const { error: unsetError } = await supabase
      .from("pipelines")
      .update({ is_default: false })
      .eq("org_id", orgId)
      .eq("is_default", true);
    if (unsetError) throw unsetError;
  }

  const { data, error } = await supabase
    .from("pipelines")
    .insert({
      org_id: orgId,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      is_default: Boolean(input.isDefault),
      is_active: true,
    })
    .select("*")
    .single();
  if (error) throw error;

  await qc().refetchQueries({ queryKey: ["deals"] });
  const created = getCachedSalesData().pipelines.find((p) => p.id === data.id);
  if (!created) throw new Error("Pipeline created but could not be reloaded");
  return created;
}

export async function updatePipeline(
  id: string,
  patch: { name?: string; description?: string | null },
): Promise<void> {
  const orgId = await getOrgId();
  if (!orgId) throw new Error("Not authenticated");
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new Error("Pipeline name is required");
    update.name = patch.name.trim();
  }
  if (patch.description !== undefined) update.description = patch.description?.trim() || null;
  const { error } = await supabase.from("pipelines").update(update).eq("id", id).eq("org_id", orgId);
  if (error) throw error;
  invalidateDeals();
}

export async function renamePipeline(id: string, name: string): Promise<void> {
  await updatePipeline(id, { name });
}

export async function setDefaultPipeline(id: string): Promise<void> {
  const orgId = await getOrgId();
  if (!orgId) throw new Error("Not authenticated");
  const { error: unsetError } = await supabase
    .from("pipelines")
    .update({ is_default: false })
    .eq("org_id", orgId)
    .eq("is_default", true)
    .neq("id", id);
  if (unsetError) throw unsetError;
  const { error } = await supabase
    .from("pipelines")
    .update({ is_default: true, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) throw error;
  invalidateDeals();
}

export async function setPipelineActive(id: string, isActive: boolean): Promise<void> {
  const orgId = await getOrgId();
  if (!orgId) throw new Error("Not authenticated");
  if (!isActive) {
    const { pipelines } = getCachedSalesData();
    const activeCount = pipelines.filter((p) => p.isActive).length;
    const target = pipelines.find((p) => p.id === id);
    if (target?.isActive && activeCount <= 1) {
      throw new Error("Cannot archive the only active pipeline. Activate another pipeline first.");
    }
  }
  const { error } = await supabase
    .from("pipelines")
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) throw error;
  invalidateDeals();
}

export async function deletePipeline(id: string): Promise<void> {
  const orgId = await getOrgId();
  if (!orgId) throw new Error("Not authenticated");

  const { count, error: countError } = await supabase
    .from("deals")
    .select("id", { count: "exact", head: true })
    .eq("pipeline_id", id)
    .eq("org_id", orgId);
  if (countError) throw countError;
  if (count && count > 0) {
    throw new Error(`Cannot delete this pipeline — ${count} deal${count === 1 ? "" : "s"} still reference it.`);
  }

  const { pipelines } = getCachedSalesData();
  const target = pipelines.find((p) => p.id === id);
  if (target?.isActive && pipelines.filter((p) => p.isActive).length <= 1) {
    throw new Error("Cannot delete the only active pipeline.");
  }

  const { error: stagesError } = await supabase.from("pipeline_stages").delete().eq("pipeline_id", id);
  if (stagesError) throw stagesError;
  const { error } = await supabase.from("pipelines").delete().eq("id", id).eq("org_id", orgId);
  if (error) throw error;
  invalidateDeals();
}

export async function createPipelineStage(
  pipelineId: string,
  input: { name: string; color?: string; probability?: number; outcome?: StageOutcome },
): Promise<SalesPipelineStage> {
  if (!input.name?.trim()) throw new Error("Stage name is required");
  const { pipelines, stages } = getCachedSalesData();
  const pipeline = pipelines.find((p) => p.id === pipelineId);
  if (!pipeline) throw new Error("Pipeline not found");

  const stagesInPipeline = stages.filter((s) => s.pipelineId === pipelineId);
  const maxPosition = stagesInPipeline.length
    ? Math.max(...stagesInPipeline.map((s) => s.position))
    : -1;

  const { data, error } = await supabase
    .from("pipeline_stages")
    .insert({
      pipeline_id: pipelineId,
      name: input.name.trim(),
      color: input.color ?? "#3b82f6",
      probability: clampProbability(input.probability ?? 50),
      position: maxPosition + 1,
      outcome: input.outcome ?? "open",
    })
    .select("*")
    .single();
  if (error) throw error;

  await qc().refetchQueries({ queryKey: ["deals"] });
  const created = getCachedSalesData().stages.find((s) => s.id === data.id);
  if (!created) throw new Error("Stage created but could not be reloaded");
  return created;
}

export async function updatePipelineStage(
  stageId: string,
  patch: { name?: string; color?: string; probability?: number; outcome?: StageOutcome },
): Promise<void> {
  const { stages } = getCachedSalesData();
  const stage = stages.find((s) => s.id === stageId);
  if (!stage) throw new Error("Stage not found");

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new Error("Stage name is required");
    update.name = patch.name.trim();
  }
  if (patch.color !== undefined) update.color = patch.color;
  if (patch.probability !== undefined) update.probability = clampProbability(patch.probability);
  if (patch.outcome !== undefined) {
    if (patch.outcome !== "open") {
      const openStagesRemaining = stages.filter(
        (s) => s.pipelineId === stage.pipelineId && s.id !== stageId && s.outcome === "open",
      ).length;
      if (openStagesRemaining === 0) {
        throw new Error("At least one open stage must remain in this pipeline.");
      }
    }
    update.outcome = patch.outcome;
  }

  const { error } = await supabase.from("pipeline_stages").update(update).eq("id", stageId);
  if (error) throw error;
  invalidateDeals();
}

export async function renamePipelineStage(stageId: string, name: string): Promise<void> {
  await updatePipelineStage(stageId, { name });
}
export async function updatePipelineStageColor(stageId: string, color: string): Promise<void> {
  await updatePipelineStage(stageId, { color });
}
export async function updatePipelineStageProbability(stageId: string, probability: number): Promise<void> {
  await updatePipelineStage(stageId, { probability });
}
export async function updatePipelineStageOutcome(stageId: string, outcome: StageOutcome): Promise<void> {
  await updatePipelineStage(stageId, { outcome });
}

export async function reorderPipelineStages(pipelineId: string, orderedStageIds: string[]): Promise<void> {
  // Two-pass update: push everything to negative placeholder positions
  // first, then assign final sequential positions. Avoids a transient
  // collision if a (pipeline_id, position) uniqueness constraint exists.
  const tempResults = await Promise.all(
    orderedStageIds.map((id, i) =>
      supabase.from("pipeline_stages").update({ position: -(i + 1) }).eq("id", id).eq("pipeline_id", pipelineId),
    ),
  );
  const tempError = tempResults.find((r) => r.error)?.error;
  if (tempError) throw tempError;

  const finalResults = await Promise.all(
    orderedStageIds.map((id, i) =>
      supabase.from("pipeline_stages").update({ position: i }).eq("id", id).eq("pipeline_id", pipelineId),
    ),
  );
  const finalError = finalResults.find((r) => r.error)?.error;
  if (finalError) throw finalError;

  invalidateDeals();
}

export async function deletePipelineStage(stageId: string): Promise<void> {
  const { stages } = getCachedSalesData();
  const stage = stages.find((s) => s.id === stageId);
  if (!stage) throw new Error("Stage not found");

  const { count, error: countError } = await supabase
    .from("deals")
    .select("id", { count: "exact", head: true })
    .eq("stage_id", stageId);
  if (countError) throw countError;
  if (count && count > 0) {
    throw new Error(`Cannot delete this stage — ${count} deal${count === 1 ? "" : "s"} still reference it.`);
  }

  const stagesInPipeline = stages.filter((s) => s.pipelineId === stage.pipelineId);
  if (stagesInPipeline.length <= 1) {
    throw new Error("A pipeline must have at least one stage.");
  }

  const { error } = await supabase.from("pipeline_stages").delete().eq("id", stageId);
  if (error) throw error;
  invalidateDeals();
}

export async function unlinkDealContact(args: { dealId: string; contactId: string }) {
  const orgId = await getOrgId();
  if (!orgId) throw new Error("Not authenticated");
  const { error } = await supabase
    .from("deal_contacts")
    .delete()
    .eq("org_id", orgId)
    .eq("deal_id", args.dealId)
    .eq("contact_id", args.contactId);
  if (error) throw error;
  await logDealActivity({
    orgId,
    dealId: args.dealId,
    activityType: "contact_unlinked",
    title: "Contact removed from deal",
    metadata: { contact_id: args.contactId },
  });
  invalidateDeals();
}
