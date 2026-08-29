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

import { useState, useEffect, useCallback, useId } from "react";
import { supabase } from "@/lib/supabase";
import type { Conversation, Message } from "@/lib/mock-data";

type SmsMetaChannel = "sms" | "whatsapp" | "messenger" | "instagram";

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

// Reusable, org-scoped "mark read" — the single place this logic lives.
// Marks every INBOUND message in this (contact, channel) conversation as
// read; outbound messages are never touched (they can't be unread) and
// this never throws silently — callers decide how to surface failure.
export async function markConversationRead(
  orgId: string,
  contactId: string,
  channel: SmsMetaChannel,
): Promise<void> {
  const { error } = await supabase
    .from("sms_meta_messages")
    .update({ is_read: true })
    .eq("org_id", orgId)
    .eq("contact_id", contactId)
    .eq("channel", channel)
    .eq("direction", "in");
  if (error) throw error;
}

export function useSmsMetaConversations(): {
  conversations: Conversation[];
  messages: Message[];
  loading: boolean;
  refresh: () => void;
  /** Optimistically marks a conversation read locally, then persists via markConversationRead; rolls back on failure. */
  markRead: (contactId: string, channel: SmsMetaChannel) => Promise<void>;
} {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  // Stable per-hook-instance id. Sidebar and Inbox both call this hook
  // independently, and Supabase reuses an existing realtime channel by
  // topic name — a shared topic across instances meant the second
  // instance's .on() call landed on a channel the first instance had
  // already .subscribe()'d, which throws. Suffixing the topic per
  // instance gives each its own channel.
  const instanceId = useId();

  const fetchData = useCallback(async () => {
    const orgId = await getOrgId();
    if (!orgId) {
      setLoading(false);
      return;
    }

    const { data, error } = await supabase
      .from("sms_meta_messages")
      .select("id, contact_id, channel, direction, body, from_address, created_at, meta, is_read, provider_message_id")
      .eq("org_id", orgId)
      .order("created_at", { ascending: true })
      .limit(2000);

    if (error) {
      console.error("[sms-meta-conversations] fetch failed:", error);
      setLoading(false);
      return;
    }

    if (!data || data.length === 0) {
      setConversations([]);
      setMessages([]);
      setLoading(false);
      return;
    }

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

      // Real unread signal: any inbound message not explicitly marked read.
      // is_read is never overwritten to false anywhere, so treating a
      // missing/null value the same as false is a safe default for rows
      // that predate this column being read by the client.
      const hasUnreadInbound = group.rows.some(
        (row) => row.direction === "in" && row.is_read !== true,
      );

      convs.push({
        id: convId,
        contactId: group.contactId,
        contactName,
        channel: group.channel,
        preview: lastRow?.body?.slice(0, 80) ?? "",
        unread: hasUnreadInbound,
        lastAt: lastRow?.created_at ?? new Date().toISOString(),
        callerPhone: contactEntry?.phone || undefined,
        avatarUrl: contactEntry?.avatarUrl ?? null,
        avatarKey: contactEntry?.avatarKey ?? null,
      });

      for (const row of group.rows) {
        msgs.push({
          id: `sm-msg-${row.id}`,
          conversationId: convId,
          channel: group.channel,
          direction: row.direction === "out" ? "out" : "in",
          body: row.body ?? "",
          at: row.created_at ?? new Date().toISOString(),
        });
      }
    }

    setConversations(convs);
    setMessages(msgs);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Realtime: new inbound messages should show up without a manual refresh.
  // Subscribes once per mount; re-fetches the whole set on any change rather
  // than patching incrementally, since message volume here is low enough
  // that a full re-fetch is simpler and cheap than incremental patching.
  useEffect(() => {
    let channelRef: ReturnType<typeof supabase.channel> | null = null;
    (async () => {
      const orgId = await getOrgId();
      if (!orgId) return;
      channelRef = supabase
        .channel(`inbox-sms-meta-${orgId}-${instanceId}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "sms_meta_messages", filter: `org_id=eq.${orgId}` },
          () => fetchData(),
        )
        .subscribe();
    })();
    return () => {
      if (channelRef) supabase.removeChannel(channelRef);
    };
  }, [fetchData, instanceId]);

  const markRead = useCallback(
    async (contactId: string, channel: SmsMetaChannel) => {
      const orgId = await getOrgId();
      if (!orgId) return;

      // Optimistic: flip this conversation's unread flag locally right away.
      const convId = `sm-${contactId}::${channel}`;
      const previousConversations = conversations;
      const previousMessages = messages;
      setConversations((current) =>
        current.map((c) => (c.id === convId ? { ...c, unread: false } : c)),
      );

      try {
        await markConversationRead(orgId, contactId, channel);
      } catch (error) {
        console.error("[sms-meta-conversations] markRead failed:", error);
        setConversations(previousConversations);
        setMessages(previousMessages);
        throw error;
      }
    },
    [conversations, messages],
  );

  return { conversations, messages, loading, refresh: fetchData, markRead };
}