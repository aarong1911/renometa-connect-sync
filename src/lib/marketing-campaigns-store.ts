// src/lib/marketing-campaigns-store.ts
//
// Supabase-backed store for Phase 14.1 Campaigns. Queries the LIVE
// `campaigns` / `marketing_templates` tables (provisioned outside this
// repo's migration history, reconciled — not duplicated — by
// 20260829_marketing_campaigns_foundation.sql) plus the new
// `marketing_segments` table (user-facing "Audiences"). Draft campaigns,
// templates, and audiences are read/written directly against Supabase
// (RLS-scoped to org, same pattern as contacts-store.ts). Sending/
// scheduling a campaign for real always goes through the trusted
// marketing-campaign-send Netlify function — never a direct client-side
// status write to queued/sending/completed (RLS + the campaigns write-
// guard trigger both block that).
//
// This module's own exported field names (channel, emailSubject, body,
// audienceFilters, recipientsTotal, …) are kept stable even though the
// underlying live columns are named differently (campaign_type, subject,
// content, target_audience, total_recipients, …) — see mapCampaign() /
// mapTemplate() below for the exact mapping. Nothing outside this file
// needs to know the live column names.

import { useEffect, useSyncExternalStore } from "react";
import { supabase } from "@/lib/supabase";
import { getOrgId } from "@/lib/contacts-store";
import type { AudienceFilters } from "@/lib/marketing-audience";

export type CampaignChannel = "email" | "sms";
export type CampaignStatus = "draft" | "scheduled" | "queued" | "sending" | "paused" | "completed" | "canceled" | "failed";
export type PausedFromStatus = "scheduled" | "queued" | "sending";

export type MarketingTemplate = {
  id: string;
  name: string;
  channel: CampaignChannel;
  emailSubject: string | null;
  body: string;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MarketingSegment = {
  id: string;
  name: string;
  filters: AudienceFilters;
  createdAt: string;
  updatedAt: string;
};

export type MarketingCampaign = {
  id: string;
  name: string;
  channel: CampaignChannel;
  status: CampaignStatus;
  emailSubject: string | null;
  body: string;
  templateId: string | null;
  segmentId: string | null;
  audienceFilters: AudienceFilters | null;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  pausedAt: string | null;
  pausedFromStatus: PausedFromStatus | null;
  recipientsTotal: number;
  recipientsSent: number;
  recipientsDelivered: number;
  recipientsFailed: number;
  recipientsExcluded: number;
  createdAt: string;
  updatedAt: string;
};

// marketing_templates: template_type is the live column name for channel
// (kept as-is rather than adding a redundant `channel` column — see the
// migration's reconciliation notes). email_subject/body/is_archived are
// new columns added directly under those names, so no remapping needed
// for those three.
function mapTemplate(row: any): MarketingTemplate {
  return {
    id: row.id,
    name: row.name,
    channel: row.template_type,
    emailSubject: row.email_subject ?? null,
    body: row.body ?? "",
    isArchived: !!row.is_archived,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSegment(row: any): MarketingSegment {
  return {
    id: row.id,
    name: row.name,
    filters: row.filters ?? { conditions: [] },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// campaigns: campaign_type/subject/content/target_audience/total_recipients
// are the live column names for channel/emailSubject/body/audienceFilters/
// recipientsTotal — see the migration's Part 4 reconciliation notes for
// why these were kept rather than renamed (avoids unnecessary churn on an
// existing live table with real rows). recipients_sent/delivered/failed/
// excluded are new columns added directly under those names.
function mapCampaign(row: any): MarketingCampaign {
  return {
    id: row.id,
    name: row.name,
    channel: row.campaign_type,
    status: row.status,
    emailSubject: row.subject ?? null,
    body: row.content ?? "",
    templateId: row.template_id ?? null,
    segmentId: row.segment_id ?? null,
    // target_audience defaults to '{}'::jsonb on the live table (not
    // null), unlike the old audience_filters column this replaced —
    // normalize an empty/absent object back to null so callers can keep
    // treating "no filters" as null rather than distinguishing {} from null.
    audienceFilters: row.target_audience && Object.keys(row.target_audience).length > 0 ? row.target_audience : null,
    scheduledAt: row.scheduled_at ?? null,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    pausedAt: row.paused_at ?? null,
    pausedFromStatus: row.paused_from_status ?? null,
    recipientsTotal: row.total_recipients ?? 0,
    recipientsSent: row.recipients_sent ?? 0,
    recipientsDelivered: row.recipients_delivered ?? 0,
    recipientsFailed: row.recipients_failed ?? 0,
    recipientsExcluded: row.recipients_excluded ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Generic reactive-store factory (same shape as contacts-store.ts) ──
function createStore<TRow, TMapped extends { id: string }>(
  table: string,
  mapRow: (row: TRow) => TMapped,
  orderColumn = "created_at",
) {
  let items: TMapped[] = [];
  let loaded = false;
  const listeners = new Set<() => void>();
  const emit = () => { for (const l of listeners) l(); };

  async function fetchAll(): Promise<void> {
    const orgId = await getOrgId();
    if (!orgId) return;
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .eq("org_id", orgId)
      .order(orderColumn, { ascending: false });
    if (error) {
      console.error(`[marketing-campaigns-store:${table}] fetch failed:`, error);
      return;
    }
    items = (data ?? []).map(mapRow);
    loaded = true;
    emit();
  }

  fetchAll();

  return {
    getAll: () => items,
    isLoaded: () => loaded,
    refresh: fetchAll,
    use: (): TMapped[] => {
      useEffect(() => { if (!loaded) fetchAll(); }, []);
      return useSyncExternalStore(
        (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
        () => items,
        () => [],
      );
    },
    useLoading: (): boolean => {
      useSyncExternalStore(
        (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
        () => loaded,
        () => false,
      );
      return !loaded;
    },
    upsertLocal: (mapped: TMapped) => {
      const idx = items.findIndex((i) => i.id === mapped.id);
      items = idx >= 0 ? items.map((i, n) => (n === idx ? mapped : i)) : [mapped, ...items];
      emit();
    },
    removeLocal: (id: string) => {
      items = items.filter((i) => i.id !== id);
      emit();
    },
  };
}

const templatesStore = createStore("marketing_templates", mapTemplate);
const segmentsStore = createStore("marketing_segments", mapSegment);
const campaignsStore = createStore("campaigns", mapCampaign);

export const useMarketingTemplates = templatesStore.use;
export const useMarketingSegments = segmentsStore.use;
export const useMarketingCampaigns = campaignsStore.use;
export const getMarketingCampaigns = campaignsStore.getAll;
export const refreshMarketingCampaigns = campaignsStore.refresh;
export const refreshMarketingTemplates = templatesStore.refresh;
export const refreshMarketingSegments = segmentsStore.refresh;

// ── Templates CRUD ──

export async function createTemplate(input: { name: string; channel: CampaignChannel; emailSubject?: string; body: string }): Promise<MarketingTemplate | null> {
  const orgId = await getOrgId();
  if (!orgId) return null;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.id) return null; // marketing_templates.created_by is NOT NULL live
  const { data, error } = await supabase
    .from("marketing_templates")
    .insert({
      org_id: orgId,
      name: input.name,
      template_type: input.channel,
      email_subject: input.channel === "email" ? (input.emailSubject || null) : null,
      body: input.body,
      created_by: user.id,
    })
    .select()
    .single();
  if (error) { console.error("[marketing-campaigns-store] createTemplate failed:", error); return null; }
  const mapped = mapTemplate(data);
  templatesStore.upsertLocal(mapped);
  return mapped;
}

export async function updateTemplate(id: string, patch: Partial<{ name: string; emailSubject: string | null; body: string; isArchived: boolean }>): Promise<MarketingTemplate | null> {
  const update: Record<string, any> = {};
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.emailSubject !== undefined) update.email_subject = patch.emailSubject;
  if (patch.body !== undefined) update.body = patch.body;
  if (patch.isArchived !== undefined) update.is_archived = patch.isArchived;
  const { data, error } = await supabase.from("marketing_templates").update(update).eq("id", id).select().single();
  if (error) { console.error("[marketing-campaigns-store] updateTemplate failed:", error); return null; }
  const mapped = mapTemplate(data);
  templatesStore.upsertLocal(mapped);
  return mapped;
}

export async function deleteTemplate(id: string): Promise<boolean> {
  const { error } = await supabase.from("marketing_templates").delete().eq("id", id);
  if (error) { console.error("[marketing-campaigns-store] deleteTemplate failed:", error); return false; }
  templatesStore.removeLocal(id);
  return true;
}

// ── Segments (Audiences) CRUD ──

export async function createSegment(input: { name: string; filters: AudienceFilters }): Promise<MarketingSegment | null> {
  const orgId = await getOrgId();
  if (!orgId) return null;
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from("marketing_segments")
    .insert({ org_id: orgId, name: input.name, filters: input.filters, created_by: user?.id ?? null })
    .select()
    .single();
  if (error) { console.error("[marketing-campaigns-store] createSegment failed:", error); return null; }
  const mapped = mapSegment(data);
  segmentsStore.upsertLocal(mapped);
  return mapped;
}

export async function updateSegment(id: string, patch: Partial<{ name: string; filters: AudienceFilters }>): Promise<MarketingSegment | null> {
  const update: Record<string, any> = {};
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.filters !== undefined) update.filters = patch.filters;
  const { data, error } = await supabase.from("marketing_segments").update(update).eq("id", id).select().single();
  if (error) { console.error("[marketing-campaigns-store] updateSegment failed:", error); return null; }
  const mapped = mapSegment(data);
  segmentsStore.upsertLocal(mapped);
  return mapped;
}

export async function deleteSegment(id: string): Promise<boolean> {
  const { error } = await supabase.from("marketing_segments").delete().eq("id", id);
  if (error) { console.error("[marketing-campaigns-store] deleteSegment failed:", error); return false; }
  segmentsStore.removeLocal(id);
  return true;
}

// ── Campaigns CRUD — DRAFT ONLY ──
//
// Phase 14.1 pre-apply hardening pass: an ordinary authenticated
// insert/update can now only ever create or edit a 'draft' campaign — RLS
// and a database write-guard trigger both enforce this independently (see
// 20260829_marketing_campaigns_foundation.sql), so this store never sends
// a 'scheduled'/'canceled' status itself. Scheduling, sending, and
// canceling are exclusively trusted-backend transitions — see
// sendCampaign() / cancelCampaign() in marketing-campaign-client.ts.

export type CreateCampaignInput = {
  name: string;
  channel: CampaignChannel;
  emailSubject?: string;
  body: string;
  templateId?: string | null;
  segmentId?: string | null;
  audienceFilters?: AudienceFilters | null;
};

export async function createCampaign(input: CreateCampaignInput): Promise<MarketingCampaign | null> {
  const orgId = await getOrgId();
  if (!orgId) return null;
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from("campaigns")
    .insert({
      org_id: orgId,
      name: input.name,
      campaign_type: input.channel,
      status: "draft",
      subject: input.channel === "email" ? (input.emailSubject || null) : null,
      content: input.body,
      template_id: input.templateId ?? null,
      segment_id: input.segmentId ?? null,
      target_audience: input.audienceFilters ?? null,
      created_by: user?.id ?? null,
    })
    .select()
    .single();
  if (error) { console.error("[marketing-campaigns-store] createCampaign failed:", error); return null; }
  const mapped = mapCampaign(data);
  campaignsStore.upsertLocal(mapped);
  return mapped;
}

export async function updateCampaignDraft(id: string, patch: Partial<{
  name: string; channel: CampaignChannel; emailSubject: string | null; body: string;
  templateId: string | null; segmentId: string | null; audienceFilters: AudienceFilters | null;
}>): Promise<MarketingCampaign | null> {
  const update: Record<string, any> = {};
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.channel !== undefined) update.campaign_type = patch.channel;
  if (patch.emailSubject !== undefined) update.subject = patch.emailSubject;
  if (patch.body !== undefined) update.content = patch.body;
  if (patch.templateId !== undefined) update.template_id = patch.templateId;
  if (patch.segmentId !== undefined) update.segment_id = patch.segmentId;
  if (patch.audienceFilters !== undefined) update.target_audience = patch.audienceFilters;
  const { data, error } = await supabase.from("campaigns").update(update).eq("id", id).select().single();
  if (error) { console.error("[marketing-campaigns-store] updateCampaignDraft failed:", error); return null; }
  const mapped = mapCampaign(data);
  campaignsStore.upsertLocal(mapped);
  return mapped;
}

// Deletion is only ever valid for status = 'draft' — RLS (campaigns_delete
// policy, 20260829) already enforces this as the real boundary, but the
// explicit .eq("status", "draft") here is a client-side guard so a
// campaign that moved on (e.g. someone else just scheduled it) fails this
// delete with a clear "nothing matched" result instead of silently
// relying on RLS alone to explain why nothing happened. .select() lets
// the caller distinguish "deleted" from "matched nothing" — a bare
// .delete() with no .select() returns no error either way.
export async function deleteDraftCampaign(id: string): Promise<{ ok: boolean; notFoundOrNotDraft?: boolean }> {
  const { data, error } = await supabase.from("campaigns").delete().eq("id", id).eq("status", "draft").select("id");
  if (error) { console.error("[marketing-campaigns-store] deleteDraftCampaign failed:", error); return { ok: false }; }
  if (!data || data.length === 0) return { ok: false, notFoundOrNotDraft: true };
  campaignsStore.removeLocal(id);
  return { ok: true };
}

export async function duplicateCampaignAsDraft(campaign: MarketingCampaign): Promise<MarketingCampaign | null> {
  return createCampaign({
    name: `${campaign.name} (copy)`,
    channel: campaign.channel,
    emailSubject: campaign.emailSubject ?? undefined,
    body: campaign.body,
    templateId: campaign.templateId,
    segmentId: campaign.segmentId,
    audienceFilters: campaign.audienceFilters,
  });
}

// Reflects the campaign row this Netlify function returns (post send/schedule) back into the local store — see marketing-campaign-send.ts response shape.
export function upsertCampaignFromRow(row: any) {
  campaignsStore.upsertLocal(mapCampaign(row));
}
