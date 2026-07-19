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

import { useState, useEffect, useCallback } from "react";
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

export function useSmsMetaConversations(): {
  conversations: Conversation[];
  messages: Message[];
  loading: boolean;
  refresh: () => void;
} {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    const orgId = await getOrgId();
    if (!orgId) {
      setLoading(false);
      return;
    }

    const { data, error } = await supabase
      .from("sms_meta_messages")
      .select("id, contact_id, channel, direction, body, from_address, created_at, meta")
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

    let contactMap: Record<string, { name: string; phone: string; email: string }> = {};
    if (contactIds.length > 0) {
      const { data: contacts } = await supabase
        .from("contacts")
        .select("id, full_name, phone, email")
        .in("id", contactIds);
      if (contacts) {
        contactMap = Object.fromEntries(
          contacts.map((c: any) => [c.id, { name: c.full_name ?? "", phone: c.phone ?? "", email: c.email ?? "" }]),
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

      convs.push({
        id: convId,
        contactId: group.contactId,
        contactName,
        channel: group.channel,
        preview: lastRow?.body?.slice(0, 80) ?? "",
        unread: lastRow?.direction === "in",
        lastAt: lastRow?.created_at ?? new Date().toISOString(),
        callerPhone: contactEntry?.phone || undefined,
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
        .channel(`inbox-sms-meta-${orgId}`)
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
  }, [fetchData]);

  return { conversations, messages, loading, refresh: fetchData };
}