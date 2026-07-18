// src/lib/voice-conversations.ts
// Fetches voice_calls from Supabase and groups them by (contact_id or
// caller_number) into ONE conversation per caller — not one per call row.
// Calls whose voice_calls.contact_id is null are matched against the
// contacts table by phone number, so a caller who already exists as a
// contact (e.g. from an SMS thread) shows up under their real name and
// merges into the same identity rather than appearing as a separate
// unnamed "(954) 871-8466" conversation per call.

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import type { Conversation, Message } from "@/lib/mock-data";

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

function formatCallerNumber(raw: string | null | undefined): string {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits[0] === "1") {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw;
}

// Normalize to bare digits for matching across formats — "(954) 871-8466",
// "9548718466", and "+19548718466" should all match the same contact.
function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  return digits.length === 11 && digits[0] === "1" ? digits.slice(1) : digits;
}

function formatTranscriptPreview(transcript: any): string {
  if (!transcript) return "Voice call — no transcript";
  if (typeof transcript === "string") return transcript.slice(0, 80) + "…";
  if (Array.isArray(transcript)) {
    const lastMsg = [...transcript]
      .reverse()
      .find((m: any) => m.role && m.message);
    if (lastMsg) {
      const role = lastMsg.role === "assistant" ? "Agent" : "Caller";
      return `${role}: ${lastMsg.message.slice(0, 70)}…`;
    }
  }
  return "Voice call";
}

export function useVoiceConversations(): {
  conversations: Conversation[];
  messages: Message[];
  loading: boolean;
} {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    const orgId = await getOrgId();
    if (!orgId) {
      setLoading(false);
      return;
    }

    const { data, error } = await supabase
      .from("voice_calls")
      .select(`
        id,
        vapi_call_id,
        started_at,
        ended_at,
        caller_number,
        direction,
        duration_sec,
        status,
        summary,
        transcript,
        contact_id,
        voice_agents ( name )
      `)
      .eq("tenant_id", orgId)
      .order("started_at", { ascending: false })
      .limit(200);

    if (error) {
      console.error("[voice-conversations] fetch failed:", error);
      setLoading(false);
      return;
    }

    if (!data || data.length === 0) {
      setConversations([]);
      setMessages([]);
      setLoading(false);
      return;
    }

    // Batch-fetch ALL org contacts with a phone number — needed both for
    // calls that already have contact_id set, and for matching calls that
    // don't by normalized phone number.
    const { data: allContacts } = await supabase
      .from("contacts")
      .select("id, full_name, phone")
      .eq("org_id", orgId)
      .not("phone", "is", null);

    const contactById: Record<string, { name: string; phone: string }> = {};
    const contactByPhone: Record<string, { id: string; name: string; phone: string }> = {};
    for (const c of allContacts ?? []) {
      const entry = { id: c.id, name: c.full_name ?? "", phone: c.phone ?? "" };
      contactById[c.id] = { name: entry.name, phone: entry.phone };
      const norm = normalizePhone(c.phone);
      if (norm) contactByPhone[norm] = entry;
    }

    // Group call rows by resolved identity: prefer contact_id if the row
    // has one, otherwise match by normalized caller_number against known
    // contacts, otherwise group by the raw normalized number itself (still
    // one thread per number even with no matching contact).
    type Group = { groupKey: string; contactId: string; contactName: string; phone: string; rows: any[] };
    const groups = new Map<string, Group>();

    for (const row of data as any[]) {
      const normNumber = normalizePhone(row.caller_number);
      const matchedContact = row.contact_id
        ? { id: row.contact_id, ...contactById[row.contact_id] }
        : (normNumber ? contactByPhone[normNumber] : undefined);

      const groupKey = matchedContact?.id ?? (normNumber || `voice-unknown-${row.id}`);

      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          groupKey,
          contactId: matchedContact?.id ?? `voice-contact-${groupKey}`,
          contactName: matchedContact?.name || formatCallerNumber(row.caller_number) || "Unknown Caller",
          phone: row.caller_number ?? "",
          rows: [],
        });
      }
      groups.get(groupKey)!.rows.push(row);
    }

    const convs: Conversation[] = [];
    const msgs: Message[] = [];

    for (const [groupKey, group] of groups) {
      const convId = `voice-${groupKey}`;
      // rows within a group are already newest-first from the query order
      const newestRow = group.rows[0];

      convs.push({
        id: convId,
        contactId: group.contactId,
        contactName: group.contactName,
        channel: "voice",
        preview: formatTranscriptPreview(newestRow.transcript),
        unread: false,
        lastAt: newestRow.started_at ?? new Date().toISOString(),
        callerPhone: group.phone || undefined,
      });

      // Messages across ALL calls in this group, oldest first within the
      // thread, with a short header per call so multiple calls are still
      // distinguishable inside one merged conversation.
      const rowsOldestFirst = [...group.rows].reverse();
      for (const row of rowsOldestFirst) {
        const callLabel = row.started_at
          ? new Date(row.started_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
          : "";

        if (Array.isArray(row.transcript) && row.transcript.length > 0) {
          row.transcript
            .filter((m: any) => m.role && m.message)
            .forEach((m: any, i: number) => {
              msgs.push({
                id: `voice-msg-${row.id}-${i}`,
                conversationId: convId,
                channel: "voice",
                direction: m.role === "assistant" ? "out" : "in",
                body: i === 0 && callLabel ? `[Call ${callLabel}] ${m.message}` : m.message,
                at: row.started_at ?? new Date().toISOString(),
              });
            });
        } else if (row.summary) {
          msgs.push({
            id: `voice-msg-${row.id}-summary`,
            conversationId: convId,
            channel: "voice",
            direction: "in",
            body: callLabel ? `[Call ${callLabel}] ${row.summary}` : row.summary,
            at: row.started_at ?? new Date().toISOString(),
          });
        } else {
          msgs.push({
            id: `voice-msg-${row.id}-empty`,
            conversationId: convId,
            channel: "voice",
            direction: "in",
            body: callLabel ? `[Call ${callLabel}] Voice call — no transcript` : "Voice call — no transcript",
            at: row.started_at ?? new Date().toISOString(),
          });
        }
      }
    }

    setConversations(convs);
    setMessages(msgs);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { conversations, messages, loading };
}