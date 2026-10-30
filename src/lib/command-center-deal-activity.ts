// src/lib/command-center-deal-activity.ts
//
// Command Center → Recent Activity: deal created/won/lost events.
//
// Reads REAL persisted events from deal_activities (the same event log
// Pipeline Pulse reads, written by deals-store.ts's logDealActivity() on
// every actual create/win/lose). Only the three meaningful business
// milestones surface in the feed — never `updated`/`contact_linked`/
// `stage_changed` noise.
//
// The deal's display column is `deals.title` — there is NO `deals.name`
// (requesting it made PostgREST return 400 / 42703 "column deals_1.name does
// not exist" and the feed silently lost every deal event). It is aliased to
// `name` so the row shape stays the same as deals-store.ts's UI `Deal.name`
// (which is also mapped from `title`).

import type { SupabaseClient } from "@supabase/supabase-js";

export const DEAL_ACTIVITY_FEED_SELECT =
  "id, activity_type, title, description, occurred_at, deals!deal_id(name:title, contact_id, contacts!contact_id(id, full_name, avatar_url, avatar_key))";
export const DEAL_ACTIVITY_FEED_TYPES = ["created", "won", "lost"] as const;
export const DEAL_ACTIVITY_FEED_LIMIT = 4;

type ContactEmbed = { id: string | null; full_name: string | null; avatar_url: string | null; avatar_key: string | null };
type DealEmbed = { name: string | null; contact_id: string | null; contacts: ContactEmbed | ContactEmbed[] | null };
export type DealActivityRow = {
  id: string;
  activity_type: string;
  title: string | null;
  description: string | null;
  occurred_at: string;
  deals: DealEmbed | DealEmbed[] | null;
};

/** Same shape as the other Recent Activity items built in routes/index.tsx. */
export type DealActivityFeedItem = {
  id: string; who: string; t: string; s: string; when: string; at: string; kind: "deal";
  contactId?: string; avatarUrl: string | null; avatarKey: string | null;
};

/** The org-scoped query — org filter, milestone types, newest first, 4 rows. */
export function queryRecentDealActivity(client: SupabaseClient, orgId: string) {
  return client
    .from("deal_activities")
    .select(DEAL_ACTIVITY_FEED_SELECT)
    .eq("org_id", orgId)
    .in("activity_type", [...DEAL_ACTIVITY_FEED_TYPES])
    .order("occurred_at", { ascending: false })
    .limit(DEAL_ACTIVITY_FEED_LIMIT);
}

// A to-one embed is normally an object, but tolerate an array or null so a
// deleted deal or contact can never crash the Command Center.
function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * `who` prefers the linked Contact's name so it reads like the other
 * Contact-anchored rows; the avatar comes from that same joined contacts row
 * (canonical S2 identity), or the entity icon when the deal has no primary
 * contact.
 */
export function toDealActivityFeedItems(rows: DealActivityRow[] | null | undefined): DealActivityFeedItem[] {
  return (rows ?? []).map((d) => {
    const deal = one(d.deals);
    const contact = one(deal?.contacts);
    const label = d.activity_type === "won" ? "Deal won" : d.activity_type === "lost" ? "Deal lost" : "Deal created";
    return {
      id: `d${d.id}`,
      who: contact?.full_name ?? deal?.name ?? "Deal",
      t: label,
      s: contact?.full_name ? (deal?.name ?? "") : "",
      when: "",
      at: d.occurred_at,
      kind: "deal",
      contactId: contact?.id ?? undefined,
      avatarUrl: contact?.avatar_url ?? null,
      avatarKey: contact?.avatar_key ?? null,
    };
  });
}

/** Never throws: a failed query logs a warning and the feed simply shows no deal events. */
export async function loadRecentDealActivityItems(client: SupabaseClient, orgId: string): Promise<DealActivityFeedItem[]> {
  try {
    const { data, error } = await queryRecentDealActivity(client, orgId);
    if (error) {
      console.warn("[command-center] deal activity query failed", { code: error.code ?? null, message: error.message ?? null });
      return [];
    }
    return toDealActivityFeedItems(data as DealActivityRow[] | null);
  } catch (err) {
    console.warn("[command-center] deal activity query threw", { message: err instanceof Error ? err.message : String(err) });
    return [];
  }
}
