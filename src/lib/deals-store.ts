// src/lib/deals-store.ts

import { useEffect, useSyncExternalStore } from "react";
import { supabase } from "@/lib/supabase";
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
  UpdateDealInput,
} from "@/lib/sales/types";

type SupabaseDealRow = {
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

type ContactRow = {
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

type CompanyRow = {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
};

type ProfileRow = {
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
  createdAt: "",
  updatedAt: "",
}));

let deals: Deal[] = [];
let pipelines: SalesPipeline[] = [];
let stages: SalesPipelineStage[] = [...FALLBACK_STAGES];
let loaded = false;
let loadingPromise: Promise<void> | null = null;

const dealListeners = new Set<() => void>();
const pipelineListeners = new Set<() => void>();
const stageListeners = new Set<() => void>();

function emitDeals() {
  for (const listener of dealListeners) listener();
}
function emitPipelines() {
  for (const listener of pipelineListeners) listener();
}
function emitStages() {
  for (const listener of stageListeners) listener();
}

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

function mapStage(row: any): SalesPipelineStage {
  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    name: row.name,
    slug: slugify(row.name),
    position: Number(row.position ?? 0),
    probability: Number(row.probability ?? 50),
    color: row.color ?? "#3b82f6",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDeal(args: {
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

async function fetchSalesData(): Promise<void> {
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    const orgId = await getOrgId();
    if (!orgId) {
      deals = [];
      pipelines = [];
      stages = [...FALLBACK_STAGES];
      loaded = true;
      emitDeals();
      emitPipelines();
      emitStages();
      return;
    }

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

    pipelines = (pipelineResult.data ?? []).map(mapPipeline);
    const pipelineIds = new Set(pipelines.map((pipeline) => pipeline.id));
    const mappedStages = (stageResult.data ?? [])
      .filter((row: any) => pipelineIds.has(row.pipeline_id))
      .map(mapStage);
    stages = mappedStages.length ? mappedStages : [...FALLBACK_STAGES];

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
    deals = rows.map((row) =>
      mapDeal({ row, contactsById, companiesById, profilesById, stagesById }),
    );
    loaded = true;
    emitDeals();
    emitPipelines();
    emitStages();
  })()
    .catch((error) => {
      console.error("[deals-store] fetch failed:", error);
      loaded = true;
      emitDeals();
      emitPipelines();
      emitStages();
      throw error;
    })
    .finally(() => {
      loadingPromise = null;
    });
  return loadingPromise;
}

function resolveStageBySlug(slug?: string | null) {
  return slug ? (stages.find((stage) => stage.slug === slug) ?? null) : null;
}
function resolveStageById(id?: string | null) {
  return id ? (stages.find((stage) => stage.id === id) ?? null) : null;
}
async function ensureSalesDataLoaded() {
  if (!loaded) await fetchSalesData();
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

export function getDeals() {
  return deals;
}
export function useDeals() {
  useEffect(() => {
    if (!loaded) void fetchSalesData();
  }, []);
  return useSyncExternalStore(
    (callback) => {
      dealListeners.add(callback);
      return () => dealListeners.delete(callback);
    },
    () => deals,
    () => [],
  );
}
export function getPipelines() {
  return pipelines;
}
export function usePipelines() {
  useEffect(() => {
    if (!loaded) void fetchSalesData();
  }, []);
  return useSyncExternalStore(
    (callback) => {
      pipelineListeners.add(callback);
      return () => pipelineListeners.delete(callback);
    },
    () => pipelines,
    () => [],
  );
}
export function getPipelineStages() {
  return stages;
}
export function usePipelineStages() {
  useEffect(() => {
    if (!loaded) void fetchSalesData();
  }, []);
  return useSyncExternalStore(
    (callback) => {
      stageListeners.add(callback);
      return () => stageListeners.delete(callback);
    },
    () => stages,
    () => FALLBACK_STAGES,
  );
}

export async function addDeal(input: AddDealInput): Promise<Deal> {
  await ensureSalesDataLoaded();
  const orgId = await getOrgId();
  if (!orgId) throw new Error("Not authenticated");
  const pipeline =
    pipelines.find((item) => item.id === input.pipelineId) ??
    pipelines.find((item) => item.isDefault) ??
    pipelines[0];
  if (!pipeline) throw new Error("No active pipeline found");
  const stage =
    resolveStageById(input.stageId) ??
    resolveStageBySlug(input.stage) ??
    stages
      .filter((item) => item.pipelineId === pipeline.id)
      .sort((a, b) => a.position - b.position)[0];
  if (!stage || stage.id.length < 20) throw new Error("No valid pipeline stage found");
  const contactId = await findOrCreateContact(orgId, input);
  const expectedClose =
    input.expectedClose ?? new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
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
      status: "open",
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
  await fetchSalesData();
  const created = deals.find((deal) => deal.id === data.id);
  if (!created) throw new Error("Deal created but could not be reloaded");
  return created;
}

export async function updateDeal(
  id: string,
  patch: UpdateDealInput | Partial<Deal>,
): Promise<void> {
  await ensureSalesDataLoaded();
  const current = deals.find((deal) => deal.id === id);
  if (!current) throw new Error("Deal not found");
  deals = deals.map((deal) => (deal.id === id ? ({ ...deal, ...patch } as Deal) : deal));
  emitDeals();
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  let nextStatus = current.status;
  let resolvedStage: SalesPipelineStage | null = null;
  if ("stageId" in patch && patch.stageId) resolvedStage = resolveStageById(patch.stageId);
  else if ("stage" in patch && patch.stage) {
    if (patch.stage === "won") nextStatus = "won";
    else if (patch.stage === "lost") nextStatus = "lost";
    else {
      resolvedStage = resolveStageBySlug(patch.stage);
      nextStatus = "open";
    }
  }
  if ("status" in patch && patch.status) nextStatus = patch.status;
  if (resolvedStage) {
    update.stage_id = resolvedStage.id;
    if (!("probability" in patch)) update.probability = resolvedStage.probability;
  }
  if (nextStatus !== current.status || "status" in patch || "stage" in patch) {
    update.status = nextStatus;
    update.actual_close_date =
      nextStatus === "won" || nextStatus === "lost" ? new Date().toISOString().slice(0, 10) : null;
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
    deals = deals.map((deal) => (deal.id === id ? current : deal));
    emitDeals();
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
  await fetchSalesData();
}

export async function deleteDeal(id: string): Promise<void> {
  await ensureSalesDataLoaded();
  const current = deals.find((deal) => deal.id === id);
  if (!current) return;
  const previous = deals;
  deals = deals.filter((deal) => deal.id !== id);
  emitDeals();
  const { error } = await supabase.from("deals").delete().eq("id", id).eq("org_id", current.orgId);
  if (error) {
    deals = previous;
    emitDeals();
    throw error;
  }
}

export async function refreshDeals() {
  await fetchSalesData();
}
export function setDealsState(next: Deal[]) {
  deals = next;
  loaded = true;
  emitDeals();
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
  await fetchSalesData();
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
}