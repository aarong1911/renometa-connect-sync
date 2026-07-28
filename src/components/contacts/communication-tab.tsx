// src/components/contacts/communication-tab.tsx
//
// Phase 9.3 — a contact-focused communication history, reusing the exact
// same Phase 7 hooks Inbox/Conversations already use
// (useSmsMetaConversations, useGmailConversations) rather than composing
// anything new. This file does NOT touch Gmail sync, thread identity, or
// Inbox behavior — it only reads the same reactive conversation lists and
// filters them down to one contact's rows.
//
// Deep-linking to a specific conversation inside Inbox is not supported by
// the current /inbox route (confirmed — its validateSearch only accepts
// `templateId`, no conversationId/activeId param exists), so "Open in
// Inbox" navigates to the generic Inbox page rather than sending an
// invalid search param.

import { Link } from "@tanstack/react-router";
import { Mail, MessageCircle, Instagram, Smartphone, Phone, ArrowRight } from "lucide-react";
import { useSmsMetaConversations } from "@/lib/sms-meta-conversations";
import { useGmailConversations } from "@/lib/gmail-conversations";
import { useVoiceConversations } from "@/lib/voice-conversations";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

function channelIcon(channel: string) {
  switch (channel) {
    case "whatsapp": return MessageCircle;
    case "instagram": return Instagram;
    case "messenger": return MessageCircle;
    case "email": return Mail;
    case "voice": return Phone;
    default: return Smartphone;
  }
}

function channelLabel(channel: string): string {
  switch (channel) {
    case "sms": return "SMS";
    case "whatsapp": return "WhatsApp";
    case "messenger": return "Messenger";
    case "instagram": return "Instagram";
    case "email": return "Gmail";
    case "voice": return "Voice call";
    default: return channel;
  }
}

export function CommunicationTab({ contactId }: { contactId: string }) {
  const { conversations: smsMeta, loading: smsMetaLoading } = useSmsMetaConversations();
  const { conversations: gmail, loading: gmailLoading } = useGmailConversations();
  const { conversations: voice, loading: voiceLoading } = useVoiceConversations();

  const loading = smsMetaLoading || gmailLoading || voiceLoading;

  const items = [...smsMeta, ...gmail, ...voice]
    .filter((c) => c.contactId === contactId)
    .sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime());

  if (loading) {
    return <div className="py-8 text-center text-xs text-muted-foreground">Loading communication history…</div>;
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center rounded-xl border border-dashed py-10 text-center">
        <Mail className="h-8 w-8 text-muted-foreground/35" />
        <p className="mt-2 text-sm font-medium">No communication history yet</p>
        <p className="mt-1 max-w-xs text-xs text-muted-foreground">
          Gmail, SMS, WhatsApp, Messenger, Instagram, and voice-call activity for this contact will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((c) => {
        const Icon = channelIcon(c.channel);
        return (
          <div
            key={c.id}
            className={cn(
              "flex items-start gap-3 rounded-xl border bg-white p-3",
              c.unread && "border-info/40 bg-info-soft/30",
            )}
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
              <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {channelLabel(c.channel)}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {formatDistanceToNow(new Date(c.lastAt), { addSuffix: true })}
                </span>
              </div>
              <p className="mt-0.5 truncate text-sm text-foreground/90">{c.preview || "(no preview available)"}</p>
              {c.unread && <span className="mt-1 inline-block rounded bg-info-soft px-1.5 py-0.5 text-[10px] font-medium text-info-soft-foreground">Needs reply</span>}
            </div>
          </div>
        );
      })}
      <Link
        to="/inbox"
        className="mt-1 flex items-center justify-center gap-1.5 rounded-md border border-border py-2 text-xs font-medium text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
      >
        Open in Inbox <ArrowRight className="h-3 w-3" />
      </Link>
    </div>
  );
}
