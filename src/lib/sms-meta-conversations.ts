// src/lib/sms-meta-conversations.ts
//
// Fetches sms_meta_messages (see supabase/migrations/005_sms_meta_messages.sql)
// and groups rows by (contact_id, channel) into Conversation/Message entries,
// the same pattern voice-conversations.ts uses for voice_calls.
//
// Covers SMS, WhatsApp, Messenger, and Instagram — the four channels that
// have no other real persistence table (Email has its own dedicated
// inbox_emails/emails/gmail_messages tables; Voice has voice_calls). None
// of these four have a mock-data fallback in inbox.tsx — there's nothing to
// show for a contact until a real message has actually been sent or
// received through the corresponding webhook/send function.
//
// Originally written as meta-conversations.ts covering only the 3 Meta
// channels, before it was discovered that SMS also had no real table and
// the two were merged into one shared table + one shared hook.
//
// is_read / deleted_at are written ONLY via
// netlify/functions/conversation-message-state.ts (service role), never by
// a direct browser-side `.update()` against this table. A live grants query
// found `anon`/`authenticated` both still hold table-level UPDATE privilege
// on sms_meta_messages, but there is no RLS UPDATE policy — so a client
// `.update()` here has no policy authorizing it and was, in effect, either
// silently failing (RLS default-deny) or would have required an org-scoped
// UPDATE policy that — combined with that pre-existing grant — could not
// restrict which COLUMNS a caller changes, not just which rows. See the
// comment at the top of conversation-message-state.ts for the full
// reasoning. This file no longer performs any UPDATE against
// sms_meta_messages at all.
//
// PLATFORM STATE SYNC — PHASE S1 (Query migration):
// Previously this hook owned its own useState + a per-instance realtime
// subscription — every mounted call site (Inbox AND Sidebar) fetched and
// held an INDEPENDENT copy of the same org's data, and Supabase channel
// topics had to be suffixed with useId() specifically because two
// independent subscriptions to the identical table/filter existed at once.
// That was the CRITICAL finding in the platform-wide server-state audit.
// Fixed by making this a thin adapter over useQuery/useMutation: the fetch
// logic below (fetchSmsMetaConversations) is unchanged business logic, now
// called as one queryFn cached under ONE key
// (queryKeys.conversations.sms(orgId)) that every mounted useSmsMetaConversations()
// call site shares — Inbox and Sidebar now read the exact same cached
// object, and there is exactly one INSERT/UPDATE subscription for this
// table in the whole app (see src/lib/realtime-bridge.tsx, mounted once at
// the app root), which invalidates this query key on change instead of
// each hook instance independently refetching itself. The public API
// (conversations, messages, loading, refresh, markRead, markUnread,
// deleteMessage) is unchanged — no call site needed to change.

import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Conversation, Message } from "@/lib/mock-data";
import { useOrgId } from "@/lib/org-id";
import { queryKeys } from "@/lib/query-keys";

type SmsMetaChannel = "sms" | "whatsapp" | "messenger" | "instagram";

// Shared call helper for conversation-message-state.ts — every action needs
// the same "get a session, attach the bearer token, POST, surface a
// meaningful error" shape.
async function callMessageStateFn(body: Record<string, unknown>): Promise<any> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Not signed in");
  const res = await fetch("/.netlify/functions/conversation-message-state", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error ?? "Request failed");
  return json;
}

// Marks every INBOUND, currently-unread message in this (contact, channel)
// conversation as read, via the server function (service role) — never a
// direct client UPDATE. Outbound messages are never touched (they can't be
// unread). The `orgId` parameter is kept for call-site compatibility but is
// no longer sent to the server — the function derives org membership itself
// from the caller's JWT, exactly like every other write path in this repo.
export async function markConversationRead(
  _orgId: string,
  contactId: string,
  channel: SmsMetaChannel,
): Promise<void> {
  await callMessageStateFn({ action: "mark_conversation_read", contact_id: contactId, channel });
}

// Marks ONLY the latest inbound message in this (contact, channel)
// conversation as unread — never every historical message. Matches this
// app's message-based unread semantics (unreadCount), so this always
// results in unreadCount becoming exactly 1, never a fabricated larger
// count. A no-op (server returns updated: 0) if the conversation has no
// inbound message at all — never invents unread state on an outbound-only
// thread. Returns the server's real `updated` count (0 or 1) so callers can
// tell a genuine success apart from a safe no-op — this used to be
// silently discarded, which meant the UI always showed "Marked as unread"
// even when the server updated nothing.
export async function markConversationUnread(
  contactId: string,
  channel: SmsMetaChannel,
): Promise<{ updated: number }> {
  const result = await callMessageStateFn({ action: "mark_conversation_unread", contact_id: contactId, channel });
  return { updated: typeof result?.updated === "number" ? result.updated : 0 };
}

// CRM-local soft delete only — see conversation-message-state.ts. Never
// implies the message was unsent/recalled/removed from the provider side.
export async function deleteSmsMetaMessage(messageId: string): Promise<void> {
  await callMessageStateFn({ action: "delete_message", message_id: messageId });
}

// ── queryFn — unchanged business logic, just no longer inline in the hook ──
async function fetchSmsMetaConversations(orgId: string): Promise<{ conversations: Conversation[]; messages: Message[] }> {
  // SOFT_DELETE_COLUMN_LIVE: flip to true ONLY after
  // supabase/migrations/20260908_sms_meta_messages_soft_delete.sql has
  // actually been applied (via the Supabase SQL Editor — never
  // `supabase db push`) and its deleted_at column confirmed to exist.
  // Until then this MUST stay false: a query filtering on a column that
  // doesn't exist yet fails outright ("column deleted_at does not
  // exist"), and that failure is silent from the UI's point of view — the
  // query would error out and every consumer would just see an empty
  // list with no visible error banner. That silent-empty failure is
  // confirmed to be exactly what caused the live "0 Messenger
  // conversations" / "0 Instagram conversations" regression after this
  // filter was added ahead of the migration being applied — kept false.
  const SOFT_DELETE_COLUMN_LIVE = false;
  let query = supabase
    .from("sms_meta_messages")
    .select("id, contact_id, channel, direction, body, from_address, created_at, meta, is_read, provider_message_id")
    .eq("org_id", orgId);
  if (SOFT_DELETE_COLUMN_LIVE) query = query.is("deleted_at", null);
  const { data, error } = await query
    .order("created_at", { ascending: true })
    .limit(2000);

  if (error) throw error;
  if (!data || data.length === 0) return { conversations: [], messages: [] };

  const contactIds = [...new Set(data.map((r: any) => r.contact_id).filter(Boolean))] as string[];

  let contactMap: Record<string, { name: string; phone: string; email: string; avatarUrl: string | null; avatarKey: string | null }> = {};
  if (contactIds.length > 0) {
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id, full_name, phone, email, avatar_url, avatar_key")
      .in("id", contactIds);
    if (contacts) {
      contactMap = Object.fromEntries(
        contacts.map((c: any) => [c.id, {
          name: c.full_name ?? "",
          phone: c.phone ?? "",
          email: c.email ?? "",
          avatarUrl: c.avatar_url ?? null,
          avatarKey: c.avatar_key ?? null,
        }]),
      );
    }
  }

  // Group rows by (contact_id, channel) — a contact could in principle
  // have threads on more than one of these channels, each is its own
  // conversation entry, matching how Email/Voice are each separate.
  const groups = new Map<string, { contactId: string; channel: SmsMetaChannel; rows: any[] }>();
  for (const row of data as any[]) {
    const contactId = row.contact_id ?? `unknown-${row.from_address ?? row.id}`;
    const key = `${contactId}::${row.channel}`;
    if (!groups.has(key)) {
      groups.set(key, { contactId, channel: row.channel, rows: [] });
    }
    groups.get(key)!.rows.push(row);
  }

  const convs: Conversation[] = [];
  const msgs: Message[] = [];

  const channelLabels: Record<SmsMetaChannel, string> = {
    sms: "SMS",
    whatsapp: "WhatsApp",
    messenger: "Messenger",
    instagram: "Instagram",
  };

  for (const [key, group] of groups) {
    const convId = `sm-${key}`;
    const lastRow = group.rows[group.rows.length - 1];
    const contactEntry = contactMap[group.contactId];
    const contactName = contactEntry?.name || `${channelLabels[group.channel]} Contact`;

    // Real unread COUNT (Phase 9 — True Unread Message Count): every
    // inbound message not explicitly marked read, counted directly —
    // never a separately maintained counter that could drift from the
    // actual per-message state. Outbound messages, notes, and anything
    // already is_read=true are never counted. is_read is never
    // overwritten to false anywhere, so treating a missing/null value the
    // same as false is a safe default for rows that predate this column
    // being read by the client.
    const unreadCount = group.rows.filter(
      (row) => row.direction === "in" && row.is_read !== true,
    ).length;

    convs.push({
      id: convId,
      contactId: group.contactId,
      contactName,
      channel: group.channel,
      preview: lastRow?.body?.slice(0, 80) ?? "",
      unread: unreadCount > 0,
      unreadCount,
      lastAt: lastRow?.created_at ?? new Date().toISOString(),
      callerPhone: contactEntry?.phone || undefined,
      avatarUrl: contactEntry?.avatarUrl ?? null,
      avatarKey: contactEntry?.avatarKey ?? null,
    });

    for (const row of group.rows) {
      msgs.push({
        id: `sm-msg-${row.id}`,
        dbId: row.id,
        conversationId: convId,
        channel: group.channel,
        direction: row.direction === "out" ? "out" : "in",
        body: row.body ?? "",
        at: row.created_at ?? new Date().toISOString(),
      });
    }
  }

  return { conversations: convs, messages: msgs };
}

export function useSmsMetaConversations(): {
  conversations: Conversation[];
  messages: Message[];
  loading: boolean;
  refresh: () => void;
  /**
   * Marks a conversation read via the server function, THEN invalidates the
   * shared query cache — the database is the source of truth, never a
   * local optimistic flip. (Previously optimistic-then-rollback against a
   * direct client UPDATE; that UPDATE had no RLS policy authorizing it and
   * was a real contributor to the sidebar/Unread-folder disagreement bug —
   * local state could say "read" while the persisted row never actually
   * changed.) Throws on failure so the caller can surface an error toast.
   * The central realtime bridge (realtime-bridge.tsx) also independently
   * invalidates this same query once the write lands, so every mounted
   * consumer — not just the one that triggered the mutation — updates.
   */
  markRead: (contactId: string, channel: SmsMetaChannel) => Promise<void>;
  /**
   * Marks only the latest inbound message unread via the server function,
   * then invalidates. Returns `{ updated }` — 1 on genuine success, 0 when
   * the conversation has no inbound message at all (a safe no-op, not an
   * error) — so callers can show an honest result instead of always saying
   * "Marked as unread". See markConversationUnread.
   */
  markUnread: (contactId: string, channel: SmsMetaChannel) => Promise<{ updated: number }>;
  /** CRM-local soft delete via the server function, then invalidates. See deleteSmsMetaMessage. */
  deleteMessage: (messageId: string) => Promise<void>;
} {
  const orgId = useOrgId();
  const queryClient = useQueryClient();

  const query = useQuery({
    // A stable placeholder key while orgId is still resolving — `enabled`
    // below keeps this from ever actually fetching with it; once orgId
    // resolves, the hook re-renders with the real, shared key.
    queryKey: orgId ? queryKeys.conversations.sms(orgId) : ["conversations", "sms", "pending"],
    queryFn: () => fetchSmsMetaConversations(orgId as string),
    enabled: !!orgId,
    // Fast tier per the platform audit — realtime (via the central bridge)
    // is the primary freshness mechanism here; this just avoids a refetch
    // storm from staleTime:0 on every remount/focus.
    staleTime: 15_000,
  });

  const conversations = query.data?.conversations ?? [];
  const messages = query.data?.messages ?? [];
  const loading = !orgId || query.isPending;

  // Invalidates the query THIS hook reads, and returns the invalidation's
  // own promise so a caller `await`ing markRead/markUnread/deleteMessage
  // only resolves once fresh data has actually been refetched — same
  // observable timing as the old "await fetchData()" pattern, but now
  // refreshing the ONE shared cache entry (every mounted consumer) instead
  // of just this hook instance's local state.
  const invalidate = useCallback(async () => {
    if (!orgId) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.conversations.sms(orgId) });
  }, [orgId, queryClient]);

  const markReadMutation = useMutation({
    mutationFn: ({ contactId, channel }: { contactId: string; channel: SmsMetaChannel }) =>
      markConversationRead("", contactId, channel),
    onSuccess: () => invalidate(),
  });
  const markUnreadMutation = useMutation({
    mutationFn: ({ contactId, channel }: { contactId: string; channel: SmsMetaChannel }) =>
      markConversationUnread(contactId, channel),
    onSuccess: () => invalidate(),
  });
  const deleteMessageMutation = useMutation({
    mutationFn: (messageId: string) => deleteSmsMetaMessage(messageId),
    onSuccess: () => invalidate(),
  });

  const markRead = useCallback(
    (contactId: string, channel: SmsMetaChannel) => markReadMutation.mutateAsync({ contactId, channel }),
    [markReadMutation],
  );
  const markUnread = useCallback(
    (contactId: string, channel: SmsMetaChannel) => markUnreadMutation.mutateAsync({ contactId, channel }),
    [markUnreadMutation],
  );
  const deleteMessage = useCallback(
    (messageId: string) => deleteMessageMutation.mutateAsync(messageId),
    [deleteMessageMutation],
  );

  const refresh = useCallback(() => {
    query.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  return { conversations, messages, loading, refresh, markRead, markUnread, deleteMessage };
}
