// src/lib/deals-store.ts
import { useEffect, useSyncExternalStore } from "react";
import { supabase } from "@/lib/supabase";
import type { Deal, LostReason } from "@/lib/mock-data";

// ── Org helper ──
async function getOrgId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
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

// ── Pipeline stages ──
type PipelineStage = { id: string; name: string; supabaseId: string };

const FALLBACK_STAGES: PipelineStage[] = [
  { id: "new",         name: "New",         supabaseId: "" },
  { id: "qualified",   name: "Qualified",   supabaseId: "" },
  { id: "site-visit",  name: "Site Visit",  supabaseId: "" },
  { id: "proposal",    name: "Proposal",    supabaseId: "" },
  { id: "negotiation", name: "Negotiation", supabaseId: "" },
  { id: "won",         name: "Won",         supabaseId: "" },
  { id: "lost",        name: "Lost",        supabaseId: "" },
];

let pipelineStagesData: PipelineStage[] = [...FALLBACK_STAGES];
let stageUuidToSlug: Record<string, string> = {};
let stageSlugToUuid: Record<string, string> = {};

const stageListeners = new Set<() => void>();
function emitStages() { for (const l of stageListeners) l(); }

function slugify(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-");
}

async function fetchPipelineStages(): Promise<void> {
  const orgId = await getOrgId();
  if (!orgId) return;

  const { data: pipeline } = await supabase
    .from("pipelines")
    .select("id")
    .eq("org_id", orgId)
    .eq("is_default", true)
    .eq("is_active", true)
    .maybeSingle();

  if (!pipeline) return;

  const { data: stages, error } = await supabase
    .from("pipeline_stages")
    .select("id, name, position, probability")
    .eq("pipeline_id", pipeline.id)
    .order("position", { ascending: true });

  if (error || !stages?.length) return;

  pipelineStagesData = stages.map((s: any) => ({
    id: slugify(s.name),
    name: s.name,
    supabaseId: s.id,
  }));

  stageUuidToSlug = {};
  stageSlugToUuid = {};
  for (const s of pipelineStagesData) {
    stageUuidToSlug[s.supabaseId] = s.id;
    stageSlugToUuid[s.id] = s.supabaseId;
  }
  emitStages();
}

export { pipelineStagesData as pipelineStages };

export function usePipelineStages(): PipelineStage[] {
  useEffect(() => { if (!stageSlugToUuid || !Object.keys(stageSlugToUuid).length) fetchPipelineStages(); }, []);
  return useSyncExternalStore(
    (cb) => { stageListeners.add(cb); return () => stageListeners.delete(cb); },
    () => pipelineStagesData,
    () => [...FALLBACK_STAGES],
  );
}

// ── Map Supabase row → Deal type ──
function mapRow(row: any, contactMap: Record<string, any>): Deal {
  const contact = row.contact_id ? contactMap[row.contact_id] : null;
  const stageSlug = stageUuidToSlug[row.stage_id] ?? "new";
  const cf = row.custom_fields ?? {};
  const createdAt = new Date(row.created_at ?? Date.now());
  const ageDays = Math.floor((Date.now() - createdAt.getTime()) / 86400000);

  return {
    id: row.id,
    name: row.title ?? "Untitled Deal",
    contactId: row.contact_id ?? "",
    contactName: contact?.full_name ?? "—",
    value: parseFloat(String(row.value ?? 0)),
    stage: row.status === "lost" ? "lost" : stageSlug,
    expectedClose: row.expected_close_date ?? "",
    owner: "—",
    ownerInitials: "—",
    ownerId: row.assigned_to ?? undefined,
    ageDays,
    lostReason: cf.lost_reason as LostReason | undefined,
    email: contact?.email ?? "",
    phone: contact?.phone ?? "",
    address: contact?.address ?? "",
  };
}

// ── Reactive store ──
let deals: Deal[] = [];
let loaded = false;
const listeners = new Set<() => void>();
function emit() { for (const l of listeners) l(); }

async function fetchDeals(): Promise<void> {
  const orgId = await getOrgId();
  if (!orgId) return;

  if (!Object.keys(stageUuidToSlug).length) {
    await fetchPipelineStages();
  }

  const { data, error } = await supabase
    .from("deals")
    .select("*")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[deals-store] fetch failed:", error);
    return;
  }

  const contactIds = (data ?? []).map((r: any) => r.contact_id).filter(Boolean) as string[];
  let contactMap: Record<string, any> = {};
  if (contactIds.length > 0) {
    const unique = [...new Set(contactIds)];
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id, full_name, email, phone, address")
      .in("id", unique);
    if (contacts) contactMap = Object.fromEntries(contacts.map((c: any) => [c.id, c]));
  }

  deals = (data ?? []).map((r: any) => mapRow(r, contactMap));
  loaded = true;
  emit();
}

fetchDeals();

// ── Public API ──

export function getDeals(): Deal[] { return deals; }

export function useDeals(): Deal[] {
  useEffect(() => { if (!loaded) fetchDeals(); }, []);
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => deals,
    () => [],
  );
}

// ── Add Deal ─────────────────────────────────────────────────────────────────
// Accepts the full form payload. Upserts the contact first (find by email,
// then by phone, then create), then inserts the deal row with real UUIDs for
// contact_id and assigned_to.

export type AddDealInput = {
  name: string;
  contactName: string;
  email: string;
  phone: string;
  address: string;
  value: number;
  stage: string;       // slug e.g. "new", "qualified"
  ownerId: string;     // user UUID for assigned_to
  ownerName: string;   // display name for optimistic UI
  expectedClose?: string;
};

export async function addDeal(input: AddDealInput): Promise<Deal> {
  const orgId = await getOrgId();
  if (!orgId) throw new Error("Not authenticated");

  if (!Object.keys(stageSlugToUuid).length) {
    await fetchPipelineStages();
  }

  // ── 1. Upsert contact ────────────────────────────────────────────────────
  let contactId: string | null = null;

  if (input.email) {
    const { data: byEmail } = await supabase
      .from("contacts")
      .select("id")
      .eq("org_id", orgId)
      .eq("email", input.email)
      .maybeSingle();
    if (byEmail) contactId = byEmail.id;
  }

  const normalizedPhone = input.phone ? input.phone.replace(/\D/g, "").slice(-10) : null;

  if (!contactId && normalizedPhone) {
    const { data: byPhone } = await supabase
      .from("contacts")
      .select("id")
      .eq("org_id", orgId)
      .eq("phone", normalizedPhone)
      .maybeSingle();
    if (byPhone) contactId = byPhone.id;
  }

  if (!contactId) {
    const { data: created, error: contactErr } = await supabase
      .from("contacts")
      .insert({
        org_id: orgId,
        full_name: input.contactName || "Unknown",
        email: input.email || null,
        phone: normalizedPhone,
        address: input.address || null,
      })
      .select("id")
      .single();

    if (!contactErr && created) {
      contactId = created.id;
    } else if (contactErr?.code === "23505" && normalizedPhone) {
      // Unique constraint on (org_id, phone) — find the existing row
      const { data: fallback } = await supabase
        .from("contacts")
        .select("id")
        .eq("org_id", orgId)
        .eq("phone", normalizedPhone)
        .maybeSingle();
      if (fallback) contactId = fallback.id;
    } else if (contactErr) {
      console.error("[deals-store] contact upsert failed:", contactErr);
    }
  }

  // ── 2. Get default pipeline ──────────────────────────────────────────────
  const { data: pipeline } = await supabase
    .from("pipelines")
    .select("id")
    .eq("org_id", orgId)
    .eq("is_default", true)
    .eq("is_active", true)
    .maybeSingle();

  if (!pipeline) throw new Error("No default pipeline found");

  const stageUuid = stageSlugToUuid[input.stage] ?? Object.values(stageSlugToUuid)[0];
  const expectedClose =
    input.expectedClose ?? new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

  // ── 3. Insert deal ────────────────────────────────────────────────────────
  const { data, error } = await supabase
    .from("deals")
    .insert({
      org_id: orgId,
      pipeline_id: pipeline.id,
      stage_id: stageUuid,
      title: input.name,
      contact_id: contactId,
      assigned_to: input.ownerId || null,
      value: input.value || 0,
      status: "open",
      expected_close_date: expectedClose,
      stage_order: 0,
    })
    .select()
    .single();

  if (error) throw error;

  const ownerInitials = input.ownerName
    .split(" ").map((w) => w[0] ?? "").join("").toUpperCase().slice(0, 2);

  const mapped: Deal = {
    id: data.id,
    name: input.name,
    contactId: contactId ?? "",
    contactName: input.contactName || "Unknown",
    value: input.value || 0,
    stage: input.stage,
    expectedClose,
    owner: input.ownerName,
    ownerInitials,
    ownerId: input.ownerId || undefined,
    ageDays: 0,
    email: input.email,
    phone: input.phone,
    address: input.address,
  };

  deals = [mapped, ...deals];
  emit();
  return mapped;
}

// ── Update Deal ──────────────────────────────────────────────────────────────
export async function updateDeal(id: string, patch: Partial<Deal>): Promise<void> {
  const prev = deals.find((d) => d.id === id);
  deals = deals.map((d) => (d.id === id ? { ...d, ...patch } : d));
  emit();

  const update: Record<string, any> = { updated_at: new Date().toISOString() };

  if (patch.stage !== undefined) {
    if (patch.stage === "lost") {
      update.status = "lost";
    } else if (patch.stage === "won") {
      update.status = "won";
    } else {
      update.status = "open";
      let uuid = stageSlugToUuid[patch.stage];
      if (!uuid) {
        // Maps not populated yet — reload and retry once
        await fetchPipelineStages();
        uuid = stageSlugToUuid[patch.stage];
      }
      if (uuid) update.stage_id = uuid;
      else console.warn("[deals-store] No UUID for stage slug:", patch.stage, "— stage_id will not change");
    }
  }
  if (patch.name          !== undefined) update.title               = patch.name;
  if (patch.value         !== undefined) update.value               = patch.value;
  if (patch.expectedClose !== undefined) update.expected_close_date = patch.expectedClose;
  if (patch.lostReason    !== undefined) update.custom_fields       = { lost_reason: patch.lostReason };

  const { error } = await supabase.from("deals").update(update).eq("id", id);

  if (error) {
    console.error("[deals-store] update failed:", error);
    if (prev) {
      deals = deals.map((d) => (d.id === id ? prev : d));
      emit();
    }
    throw error;
  }
}

export async function deleteDeal(id: string): Promise<void> {
  const prev = deals;
  deals = deals.filter((d) => d.id !== id);
  emit();

  const { error } = await supabase.from("deals").delete().eq("id", id);
  if (error) {
    deals = prev;
    emit();
    throw error;
  }
}

export function setDealsState(next: Deal[]): void {
  deals = next;
  emit();
}

export async function refreshDeals(): Promise<void> {
  await fetchDeals();
}
