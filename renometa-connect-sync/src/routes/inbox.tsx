// src/routes/inbox.tsx
import { createFileRoute, Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Mail,
  MessageSquare,
  Phone,
  Inbox as InboxIcon,
  Send,
  Sparkles,
  Paperclip,
  Search,
  Star,
  AtSign,
  CheckCheck,
  Filter,
  ChevronDown,
  MoreHorizontal,
  StickyNote,
  Smile,
  Hash,
  Video,
  Tag,
  Clock,
  ExternalLink,
  Phone as PhoneIcon,
  PhoneCall,
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  Circle,
  Pin,
  Archive,
  Copy,
  Calendar,
  Plus,
  Loader2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  mockContacts,
  mockProjects,
  type Conversation,
  type Message,
} from "@/lib/mock-data";
import {
  messageTemplates,
  resolveMergeTags,
  type MergeContext,
  type SharedMessageTemplate,
  type TemplateInsertLog,
  usePersistentInsertLog,
} from "@/lib/message-templates";
import { recordTemplateUse } from "@/lib/recent-templates";
import { useOrganization } from "@/lib/organization";
import { useContacts } from "@/lib/contacts-store";
import { useContactActivity } from "@/lib/contact-activity";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { TemplatePicker } from "@/components/inbox/template-picker";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { FileText } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { useVoiceConversations } from "@/lib/voice-conversations";
import { useSmsMetaConversations } from "@/lib/sms-meta-conversations";

type InboxSearch = { templateId?: string };

export const Route = createFileRoute("/inbox")({
  validateSearch: (raw: Record<string, unknown>): InboxSearch => ({
    templateId: typeof raw.templateId === "string" && raw.templateId ? raw.templateId : undefined,
  }),
  component: InboxLayout,
});

function InboxLayout() {
  const { pathname } = useLocation();
  // When a child route is active (e.g. /inbox/broadcasts), render it instead
  // of the Conversations UI. /inbox itself still shows InboxPage.
  if (pathname !== "/inbox" && pathname !== "/inbox/") {
    return <Outlet />;
  }
  return <InboxPage />;
}

type FolderId = "all" | "unread" | "assigned" | "mentions" | "starred" | "unassigned" | "archived";
type ChannelFilter = "all" | "email" | "sms" | "voice" | "whatsapp" | "messenger" | "instagram";
type ComposeChannel = "email" | "sms" | "note" | "whatsapp" | "messenger" | "instagram";

// Extends Message with note channel + optimistic send metadata
type LocalMessage = Omit<Message, "channel"> & {
  channel: "email" | "sms" | "voice" | "note" | "whatsapp" | "messenger" | "instagram";
  isScheduled?: boolean;
  scheduledFor?: string;
};

const folders: { id: FolderId; label: string; icon: typeof InboxIcon }[] = [
  { id: "all", label: "All", icon: InboxIcon },
  { id: "unread", label: "Unread", icon: Circle },
  { id: "assigned", label: "Assigned to me", icon: CheckCheck },
  { id: "mentions", label: "Mentions", icon: AtSign },
  { id: "starred", label: "Starred", icon: Star },
  { id: "unassigned", label: "Unassigned", icon: Filter },
  { id: "archived", label: "Archived", icon: Archive },
];

const channelTabs: { id: ChannelFilter; label: string; icon: typeof Mail }[] = [
  { id: "all", label: "All", icon: InboxIcon },
  { id: "email", label: "Email", icon: Mail },
  { id: "sms", label: "SMS", icon: MessageSquare },
  { id: "voice", label: "Voice", icon: Phone },
  { id: "whatsapp", label: "WhatsApp", icon: MessageSquare },
  { id: "messenger", label: "Messenger", icon: MessageSquare },
  { id: "instagram", label: "Instagram", icon: AtSign },
];

const NOW = Date.now();

function bodyToneClass(action: TemplateInsertLog["bodyAction"] | TemplateInsertLog["subjectAction"]): string {
  switch (action) {
    case "replace":
      return "text-warning";
    case "append":
      return "text-primary";
    case "noop":
      return "text-muted-foreground";
    case "n/a":
    default:
      return "text-muted-foreground/60";
  }
}

function formatLogTs(iso: string): string {
  try {
    const d = new Date(iso);
    const date = d.toISOString().slice(5, 10).replace("-", "/"); // MM/DD
    const time = d.toLocaleTimeString(undefined, { hour12: false });
    return `${date} ${time}`;
  } catch {
    return iso;
  }
}

function InboxPage() {
  const { templateId } = Route.useSearch();
  const navigate = useNavigate({ from: "/inbox" });
  const [folder, setFolder] = useState<FolderId>("all");
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("all");
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [subject, setSubject] = useState("");
  const [composeChannel, setComposeChannel] = useState<ComposeChannel>("sms");
  const [search, setSearch] = useState("");
  const [tplOpen, setTplOpen] = useState(false);
  const [tplSearch, setTplSearch] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [localMessages, setLocalMessages] = useState<LocalMessage[]>(() => {
    try { return JSON.parse(localStorage.getItem("inbox-messages") ?? "[]"); } catch { return []; }
  });
  const [localConversations, setLocalConversations] = useState<Conversation[]>(() => {
    try { return JSON.parse(localStorage.getItem("inbox-conversations") ?? "[]"); } catch { return []; }
  });
  useEffect(() => {
    try { localStorage.setItem("inbox-messages", JSON.stringify(localMessages.slice(-1000))); } catch {}
  }, [localMessages]);
  useEffect(() => {
    try { localStorage.setItem("inbox-conversations", JSON.stringify(localConversations)); } catch {}
  }, [localConversations]);

  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleDateTime, setScheduleDateTime] = useState("");
  const [starredIds, setStarredIds] = useState<Set<string>>(new Set());
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [aiDrafting, setAiDrafting] = useState(false);
  const [newConvOpen, setNewConvOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingTemplate, setPendingTemplate] = useState<SharedMessageTemplate | null>(null);
  const [insertLog, appendInsertLog, clearInsertLog] = usePersistentInsertLog("inbox");
  const [showInsertLog, setShowInsertLog] = useState(false);
  // Voice calls from Supabase — merged into conversations when Voice tab is active
  const { conversations: voiceConvs, messages: voiceMsgs } = useVoiceConversations();
  // SMS/WhatsApp/Messenger/Instagram from sms_meta_messages — no mock
  // fallback, these channels only ever show real data. This is the only
  // source of actual message content for these 4 channels; Email has its
  // own separate real tables (not handled here).
  const { conversations: realConvs, messages: realMsgs, refresh: refreshRealConvs } = useSmsMetaConversations();
  // Contacts from the store — uses correct org via getOrgId() + memberships fallback
  const allStoreContacts = useContacts();
  const storeContactMap = useMemo(
    () => new Map(allStoreContacts.map((c) => [c.id, c])),
    [allStoreContacts]
  );
  // One synthetic "start a conversation" placeholder per contact who has no
  // real SMS thread yet, so every contact remains reachable even before a
  // first message is sent. Contacts that already have a real SMS
  // conversation (from realConvs) are excluded here to avoid showing both
  // a placeholder and the real thread for the same contact.
  const contactIdsWithRealSms = useMemo(
    () => new Set(realConvs.filter((c) => c.channel === "sms").map((c) => c.contactId)),
    [realConvs]
  );
  const placeholderConvs = useMemo<Conversation[]>(
    () => allStoreContacts
      .filter((c) => !contactIdsWithRealSms.has(c.id))
      .map((c) => ({
        id: `sb-${c.id}`,
        contactId: c.id,
        contactName: c.name,
        channel: "sms" as const,
        preview: c.phone || c.email || "No contact info",
        lastAt: c.lastActivity ?? c.createdAt ?? new Date().toISOString(),
        unread: false,
      })),
    [allStoreContacts, contactIdsWithRealSms]
  );
  const org = useOrganization();
  const [currentUserName, setCurrentUserName] = useState("");
  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return;
      supabase.from("profiles").select("first_name, last_name").eq("id", user.id).maybeSingle()
        .then(({ data }) => {
          if (data) setCurrentUserName(`${data.first_name ?? ""} ${data.last_name ?? ""}`.trim());
        });
    });
  }, []);
 

  const allConversations = useMemo(
    () => [
      ...realConvs,
      ...placeholderConvs,
      ...voiceConvs,
      ...localConversations,
    ],
    [realConvs, placeholderConvs, voiceConvs, localConversations]
  );
  const allMessages = useMemo(
    () => [...voiceMsgs, ...realMsgs],
    [voiceMsgs, realMsgs]
  );

  const checkStarred = (id: string) => starredIds.has(id) || isStarred(id);

  const conversations = useMemo(() => {
    return allConversations
      .filter((c) => {
        if (channelFilter !== "all" && c.channel !== channelFilter) return false;
        if (folder === "unread" && !c.unread) return false;
        if (folder === "starred" && !checkStarred(c.id)) return false;
        if (folder === "unassigned" && !isUnassigned(c.id)) return false;
        if (folder === "assigned" && !isAssignedToMe(c.id)) return false;
        if (folder === "mentions" && !hasMention(c.id)) return false;
        if (folder === "archived" && !isArchived(c.id)) return false;
        if (folder !== "archived" && isArchived(c.id)) return false;
        if (search && !c.contactName.toLowerCase().includes(search.toLowerCase()) && !c.preview.toLowerCase().includes(search.toLowerCase())) return false;
        return true;
      })
      .sort((a, b) => {
        // Real conversations (sm- = SMS/WhatsApp/Messenger/Instagram with
        // actual message history, voice- = voice calls) sort first, then
        // empty placeholder contacts (sb-) with no messages yet, then
        // anything else — then by recency within each group.
        const tier = (id: string) => id.startsWith("sm-") || id.startsWith("voice-") ? 0 : id.startsWith("sb-") ? 1 : 2;
        const td = tier(a.id) - tier(b.id);
        if (td !== 0) return td;
        return new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, channelFilter, search, starredIds, allConversations]);

  const folderCounts = useMemo(() => {
    const list = allConversations;
    return {
      all: list.filter((c) => !isArchived(c.id)).length,
      unread: list.filter((c) => c.unread && !isArchived(c.id)).length,
      assigned: list.filter((c) => isAssignedToMe(c.id) && !isArchived(c.id)).length,
      mentions: list.filter((c) => hasMention(c.id) && !isArchived(c.id)).length,
      starred: list.filter((c) => checkStarred(c.id) && !isArchived(c.id)).length,
      unassigned: list.filter((c) => isUnassigned(c.id) && !isArchived(c.id)).length,
      archived: list.filter((c) => isArchived(c.id)).length,
    } as Record<FolderId, number>;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allConversations, starredIds]);

  // Prefer a non-voice conversation as the auto-selected default so email/SMS always has a contact with an address
  const active = conversations.find((c) => c.id === activeId)
    ?? conversations.find((c) => !c.id.startsWith("voice-"))
    ?? conversations[0];
  const thread: LocalMessage[] = active
    ? [
        ...(allMessages.filter((m) => m.conversationId === active.id) as LocalMessage[]),
        ...localMessages.filter((m) => m.conversationId === active.id),
      ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
    : [];
  const resolvedStoreContact = active ? (storeContactMap.get(active.contactId) ?? null) : null;
  const contact = active
    ? (resolvedStoreContact
        ? { name: resolvedStoreContact.name, email: resolvedStoreContact.email, phone: resolvedStoreContact.phone, tags: resolvedStoreContact.tags, owner: resolvedStoreContact.owner, messenger_psid: resolvedStoreContact.messenger_psid, instagram_igsid: resolvedStoreContact.instagram_igsid }
        : mockContacts.find((c) => c.id === active.contactId)
          ?? { name: active.contactName, email: "", phone: active.callerPhone ?? "", tags: [], owner: "", messenger_psid: undefined, instagram_igsid: undefined })
    : undefined;
  const contactProjects = contact ? mockProjects.filter((p) => p.client === contact.name) : [];

  // If the active conversation changes to a contact who doesn't have a
  // Messenger/Instagram identifier on file, but composeChannel is still set
  // to one of those, fall back to SMS rather than leaving the compose box
  // pointed at a channel with no visible tab and no valid recipient.
  useEffect(() => {
    if (composeChannel === "messenger" && !contact?.messenger_psid) setComposeChannel("sms");
    if (composeChannel === "instagram" && !contact?.instagram_igsid) setComposeChannel("sms");
  }, [activeId, contact?.messenger_psid, contact?.instagram_igsid, composeChannel]);

  // Real activity timeline for the selected contact
  const { items: contactActivity } = useContactActivity(active?.contactId ?? null);

  // Real projects + lifetime value from Supabase for sidebar
  const [sbProjects, setSbProjects] = useState<{ id: string; name: string; status: string; budget_total: number; completion_percentage: number }[]>([]);
  const [sbInvoiceTotal, setSbInvoiceTotal] = useState(0);
  const [sbInvoiceCount, setSbInvoiceCount] = useState(0);
  useEffect(() => {
    const contactId = active?.contactId;
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!contactId || !UUID_RE.test(contactId)) { setSbProjects([]); setSbInvoiceTotal(0); setSbInvoiceCount(0); return; }
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || cancelled) return;
      const { data: profile } = await supabase.from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
      const orgId = profile?.organization_id;
      if (!orgId || cancelled) return;

      const { data: projs } = await supabase
        .from("projects")
        .select("id, name, status, budget_total, completion_percentage")
        .eq("client_id", contactId).eq("org_id", orgId)
        .order("created_at", { ascending: false });

      const projectIds = ((projs as any[]) ?? []).map((p: any) => p.id);
      const { data: invs } = projectIds.length > 0
        ? await supabase.from("invoices").select("total_amount, status").in("project_id", projectIds)
        : { data: [] as any[] };
      if (cancelled) return;
      setSbProjects((projs ?? []) as any);
      const paid = (invs ?? []).filter((i: any) => i.status === "paid");
      setSbInvoiceTotal(paid.reduce((s: number, i: any) => s + (i.total_amount ?? 0), 0));
      setSbInvoiceCount((invs ?? []).length);
    })();
    return () => { cancelled = true; };
  }, [active?.contactId]);

  const mergeCtx: MergeContext = useMemo(() => {
    const firstProject = contactProjects[0];
    const [first_name = "", ...rest] = (contact?.name ?? "").split(" ");
    const last_name = rest.join(" ");
    const total = firstProject?.contractValue ?? 0;
    const fmtMoney = (n: number) =>
      new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
    return {
      first_name,
      last_name,
      project_address: firstProject?.address ?? "your project address",
      project_type: firstProject?.type ?? "renovation",
      owner_name: currentUserName || "Your Name",
      company_name: org.companyName || "Your Company",
      estimate_total: total ? fmtMoney(total) : "$—",
      deposit_amount: total ? fmtMoney(Math.round(total * 0.5)) : "$—",
      deposit_due: "Friday",
      start_date: firstProject?.startDate
        ? new Date(firstProject.startDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })
        : "next Monday",
    };
  }, [contact, contactProjects, currentUserName, org.companyName]);

  // ── Send handler ──────────────────────────────────────────────────────────
  const handleSend = async () => {
    if (!draft.trim()) { toast.error("Message is empty"); return; }
    if (!active) return;

    const draftText = draft.trim();
    setDraft("");
    setSubject("");

    if (composeChannel === "note") {
      // Notes have no backend table — they only ever exist as local state.
      setLocalMessages((prev) => [...prev, {
        id: `local-${Date.now()}`,
        conversationId: active.id,
        direction: "out",
        channel: composeChannel,
        body: draftText,
        at: new Date().toISOString(),
      }]);
      toast.success("Note added to conversation");
      return;
    }

    const to =
      composeChannel === "sms" || composeChannel === "whatsapp" ? contact?.phone :
      composeChannel === "messenger" ? contact?.messenger_psid :
      composeChannel === "instagram" ? contact?.instagram_igsid :
      contact?.email;

    if (!to) {
      const missing =
        composeChannel === "sms" || composeChannel === "whatsapp" ? "phone number" :
        composeChannel === "messenger" ? "Messenger connection (they must message you first)" :
        composeChannel === "instagram" ? "Instagram connection (they must message you first)" :
        "email address";
      toast.error(`${active.contactName} has no ${missing} on file`);
      return;
    }

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/.netlify/functions/send-inbox-message", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { "Authorization": `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({
          channel: composeChannel,
          to,
          body: draftText,
          subject: composeChannel === "email" ? subject : undefined,
          from_name: mergeCtx.company_name,
          contact_id: active.contactId,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error ?? "Send failed");
        // Keep the failed message visible locally so the user can see what
        // didn't go through and retry, rather than losing it silently.
        setLocalMessages((prev) => [...prev, {
          id: `local-failed-${Date.now()}`,
          conversationId: active.id,
          direction: "out",
          channel: composeChannel,
          body: draftText,
          at: new Date().toISOString(),
        }]);
      } else {
        const result = await res.json().catch(() => ({}));
        const channelLabel =
          composeChannel === "sms" ? "SMS" :
          composeChannel === "email" ? "Email" :
          composeChannel === "whatsapp" ? "WhatsApp" :
          composeChannel === "messenger" ? "Messenger" :
          "Instagram";
        if (result.sentAsTemplate) {
          // WhatsApp's 24-hour session rule: the contact hasn't messaged
          // us recently, so free text isn't allowed — a pre-approved
          // template was sent instead, NOT the message the user typed.
          // This must be surfaced clearly, since silently sending
          // different content than what was drafted would otherwise look
          // like a successful send of the real message.
          toast.warning(
            `${active.contactName} hasn't messaged you in the last 24h, so WhatsApp required a template message instead — your typed text was not sent. Template used: ${result.templateName}.`,
            { duration: 8000 },
          );
        } else {
          toast.success(`${channelLabel} sent`);
        }
        // SMS/WhatsApp/Messenger/Instagram are backed by sms_meta_messages —
        // refresh so the real persisted row shows up. No optimistic local
        // copy is kept for these channels (see top of this function) since
        // that previously caused the same message to render twice: once
        // from a stale localStorage entry, once from the real row.
        if (composeChannel !== "email") refreshRealConvs();
      }
    } catch {
      toast.error("Network error — message not sent");
      setLocalMessages((prev) => [...prev, {
        id: `local-failed-${Date.now()}`,
        conversationId: active.id,
        direction: "out",
        channel: composeChannel,
        body: draftText,
        at: new Date().toISOString(),
      }]);
    }
  };

  // ── Schedule handler ───────────────────────────────────────────────────────
  const handleSchedule = () => {
    if (!draft.trim()) { toast.error("Message is empty"); return; }
    if (!active || !scheduleDateTime) { toast.error("Select a date and time"); return; }

    const msg: LocalMessage = {
      id: `scheduled-${Date.now()}`,
      conversationId: active.id,
      direction: "out",
      channel: composeChannel,
      body: draft.trim(),
      at: new Date(scheduleDateTime).toISOString(),
      isScheduled: true,
      scheduledFor: new Date(scheduleDateTime).toISOString(),
    };
    setLocalMessages((prev) => [...prev, msg]);
    setDraft("");
    setSubject("");
    setScheduleOpen(false);
    toast.success(`Scheduled for ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(scheduleDateTime))}`);
  };

  // ── AI Draft handler ───────────────────────────────────────────────────────
  const handleAiDraft = async () => {
    if (!active || !contact) return;
    setAiDrafting(true);
    try {
      const channel = composeChannel === "note" ? "sms" : composeChannel;
      const history = thread.slice(-8).map((m) => ({
        role: (m.direction === "out" ? "assistant" : "user") as "user" | "assistant",
        content: m.body,
      }));
      const res = await fetch("/.netlify/functions/ai-draft-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, contactName: contact.name, conversationHistory: history, currentDraft: draft }),
      });
      const data = await res.json();
      if (data.error) { toast.error(data.error); return; }
      setDraft(data.draft);
      toast.success("AI draft ready");
    } catch {
      toast.error("AI draft failed — check your connection");
    } finally {
      setAiDrafting(false);
    }
  };

  // ── Copy thread handler ────────────────────────────────────────────────────
  const handleCopyThread = () => {
    if (!active) return;
    const header = `Conversation with ${active.contactName}\n${"─".repeat(40)}`;
    const lines = thread.map((m) => {
      const dir = m.direction === "out" ? "You" : active.contactName;
      const ch = m.channel === "note" ? "[Note]" : `[${m.channel.toUpperCase()}]`;
      const ts = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(m.at));
      return `${ts}  ${dir} ${ch}\n${m.body}`;
    });
    navigator.clipboard.writeText([header, ...lines].join("\n\n"));
    toast.success("Conversation copied to clipboard");
  };

  const visibleTemplates = useMemo(() => {
    const channelMatch = (t: SharedMessageTemplate) =>
      composeChannel === "note" ? true : t.channel === composeChannel;
    const q = tplSearch.trim().toLowerCase();
    return messageTemplates.filter((t) => {
      if (!channelMatch(t)) return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q) ||
        t.body.toLowerCase().includes(q)
      );
    });
  }, [composeChannel, tplSearch]);

  const writeTemplate = (t: SharedMessageTemplate, mode: "replace" | "append") => {
    const body = resolveMergeTags(t.body, mergeCtx);
    let bodyAction: "replace" | "append" | "noop" = "replace";
    setDraft((prev) => {
      if (mode === "append" && prev.trim()) {
        if (prev.includes(body)) {
          bodyAction = "noop";
          return prev;
        }
        bodyAction = "append";
        return `${prev}\n\n${body}`;
      }
      if (prev === body) {
        bodyAction = "noop";
        return prev;
      }
      bodyAction = "replace";
      return body;
    });
    let subjectAction: "replace" | "append" | "noop" | "n/a" = "n/a";
    if (t.channel === "email" && t.subject) {
      const nextSubject = resolveMergeTags(t.subject, mergeCtx);
      setSubject((prev) => {
        if (mode === "append" && prev.trim()) {
          subjectAction = "noop";
          return prev;
        }
        if (prev.trim() === nextSubject) {
          subjectAction = "noop";
          return prev;
        }
        subjectAction = "replace";
        return nextSubject;
      });
      if (composeChannel !== "email") setComposeChannel("email");
    } else if (t.channel === "sms" && composeChannel !== "sms") {
      setComposeChannel("sms");
    }
    setTplOpen(false);
    setTplSearch("");
    recordTemplateUse(t.id);
    const entry: TemplateInsertLog = {
      ts: new Date().toISOString(),
      surface: "inbox",
      templateId: t.id,
      templateName: t.name,
      channel: t.channel,
      mode,
      subjectAction,
      bodyAction,
      userName: "sales@yourco.com",
    };
    appendInsertLog(entry);
    // eslint-disable-next-line no-console
    console.debug("[template-insert]", entry);
  };

  const applyTemplate = (t: SharedMessageTemplate) => {
    const subjectCollides =
      t.channel === "email" &&
      !!t.subject &&
      subject.trim().length > 0 &&
      resolveMergeTags(t.subject, mergeCtx) !== subject.trim();
    if (draft.trim().length > 0 || subjectCollides) {
      setPendingTemplate(t);
      return;
    }
    writeTemplate(t, "replace");
  };

  // Deep-link from /inbox/templates: ?templateId=… inserts and clears the param.
  useEffect(() => {
    if (!templateId) return;
    const tpl = messageTemplates.find((t) => t.id === templateId);
    if (tpl) applyTemplate(tpl);
    navigate({ search: { templateId: undefined }, replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId]);

  return (
    <>
    <div className="-m-6 flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden">
      {/* Inline header — same text sizes as PageHeader, vertically centered */}
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-background pl-5 pr-6 py-4">
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>Workspace</span>
            <span className="text-border-strong">/</span>
            <span>Inbox</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Inbox</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Unified email, SMS, voice, and internal notes across every contact</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-8">
            <Filter className="mr-1.5 h-3.5 w-3.5" /> Filters
          </Button>
          <Button size="sm" className="h-8" onClick={() => setNewConvOpen(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> New Conversation
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[210px_340px_1fr_300px] overflow-hidden border-t border-border">
        {/* PANE 1 — Folders */}
        <aside className="flex min-h-0 flex-col border-r border-border bg-secondary/30">
          <div className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Folders
          </div>
          <nav className="flex flex-col gap-0.5 px-2">
            {folders.map((f) => {
              const Icon = f.icon;
              const isActive = folder === f.id;
              const count = folderCounts[f.id];
              return (
                <button
                  key={f.id}
                  onClick={() => setFolder(f.id)}
                  className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors ${
                    isActive ? "bg-primary-soft text-primary" : "text-foreground hover:bg-secondary"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <Icon className="h-3.5 w-3.5" />
                    {f.label}
                  </span>
                  {count > 0 && (
                    <span className={`text-[10px] tabular-nums ${isActive ? "text-primary" : "text-muted-foreground"}`}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="mt-4 px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Tags
          </div>
          <div className="flex flex-col gap-0.5 px-2">
            {[
              { label: "VIP", count: 4 },
              { label: "New Lead", count: 7 },
              { label: "Hot", count: 3 },
              { label: "Punch List", count: 2 },
            ].map((t, i) => (
              <button
                key={t.label}
                className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-[13px] font-medium text-foreground hover:bg-secondary"
              >
                <span className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${["bg-amber-400","bg-emerald-400","bg-rose-400","bg-sky-400"][i]}`} />
                  {t.label}
                </span>
                <span className="text-[10px] text-muted-foreground">{t.count}</span>
              </button>
            ))}
          </div>

          <div className="mt-auto border-t border-border p-3">
            <div className="rounded-lg border border-border bg-card p-2.5">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold">
                <Sparkles className="h-3 w-3 text-primary" /> AI Assistant
              </div>
              <p className="text-[11px] text-muted-foreground">
                Drafting & summarizing replies. {folderCounts.unread} unread to triage.
              </p>
            </div>
          </div>
        </aside>

        {/* PANE 2 — Conversation list */}
        <section className="flex min-h-0 flex-col border-r border-border">
          <div className="flex flex-wrap items-center gap-1 border-b border-border bg-card px-2 py-1.5">
            {channelTabs.map((t) => {
              const Icon = t.icon;
              const isActive = channelFilter === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setChannelFilter(t.id)}
                  className={`flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-1 text-[11px] font-medium transition-colors ${
                    isActive ? "bg-primary-soft text-primary" : "text-muted-foreground hover:bg-secondary"
                  }`}
                >
                  <Icon className="h-3 w-3" />
                  {t.label}
                </button>
              );
            })}
          </div>
          <div className="border-b border-border p-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search conversations…"
                className="h-8 pl-7 text-xs"
              />
            </div>
          </div>
          <div className="flex items-center justify-between border-b border-border bg-secondary/40 px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            <span>{conversations.length} conversations</span>
            <button className="flex items-center gap-1 hover:text-foreground">
              Newest <ChevronDown className="h-3 w-3" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {conversations.map((c) => (
              <ConversationRow
                key={c.id}
                conv={c}
                active={c.id === active?.id}
                starred={checkStarred(c.id)}
                onClick={() => setActiveId(c.id)}
              />
            ))}
            {conversations.length === 0 && (
              <div className="p-8 text-center text-xs text-muted-foreground">No conversations match these filters</div>
            )}
          </div>
        </section>

        {/* PANE 3 — Thread */}
        <section className="flex min-h-0 flex-col bg-secondary/10">
          {active && contact ? (
            <>
              <div className="flex items-center justify-between border-b border-border bg-card px-4 py-2.5">
                <div className="flex items-center gap-3">
                  <Avatar className="h-9 w-9">
                    <AvatarFallback className="bg-primary-soft text-xs font-semibold text-primary">
                      {initials(active.contactName)}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      {active.contactName}
                      <Badge variant="outline" className="h-4 px-1.5 text-[9px] uppercase">
                        {contact.tags?.[0] ?? "Customer"}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Mail className="h-3 w-3" /> {contact.email}
                      </span>
                      <span>·</span>
                      <span className="flex items-center gap-1">
                        <Phone className="h-3 w-3" /> {contact.phone}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" className="h-7 px-2" title="WhatsApp"
                    onClick={() => setComposeChannel("whatsapp")}>
                    <MessageSquare className={`h-3.5 w-3.5 ${composeChannel === "whatsapp" ? "text-primary" : ""}`} />
                  </Button>
                  {contact?.messenger_psid && (
                    <Button variant="ghost" size="sm" className="h-7 px-2" title="Messenger"
                      onClick={() => setComposeChannel("messenger")}>
                      <MessageSquare className={`h-3.5 w-3.5 ${composeChannel === "messenger" ? "text-primary" : ""}`} />
                    </Button>
                  )}
                  {contact?.instagram_igsid && (
                    <Button variant="ghost" size="sm" className="h-7 px-2" title="Instagram"
                      onClick={() => setComposeChannel("instagram")}>
                      <AtSign className={`h-3.5 w-3.5 ${composeChannel === "instagram" ? "text-primary" : ""}`} />
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" className="h-7 px-2" title="Call"
                    onClick={() => toast.info(`Calling ${contact?.phone ?? ""}…`)}>
                    <PhoneCall className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 px-2" title="Video"
                    onClick={() => toast.info("Video calling coming soon")}>
                    <Video className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost" size="sm" className="h-7 px-2" title="Star"
                    onClick={() => {
                      setStarredIds((prev) => {
                        const next = new Set(prev);
                        next.has(active.id) ? next.delete(active.id) : next.add(active.id);
                        return next;
                      });
                    }}
                  >
                    <Star className={`h-3.5 w-3.5 ${checkStarred(active.id) ? "fill-amber-400 text-amber-400" : ""}`} />
                  </Button>
                  <Button
                    variant="ghost" size="sm" className="h-7 px-2" title="Pin"
                    onClick={() => {
                      setPinnedIds((prev) => {
                        const next = new Set(prev);
                        next.has(active.id) ? next.delete(active.id) : next.add(active.id);
                        toast.success(next.has(active.id) ? "Conversation pinned" : "Conversation unpinned");
                        return next;
                      });
                    }}
                  >
                    <Pin className={`h-3.5 w-3.5 ${pinnedIds.has(active.id) ? "fill-primary text-primary" : ""}`} />
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 px-2" title="Copy conversation" onClick={handleCopyThread}>
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-7 px-2" title="More">
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => toast.success("Marked as read")}>Mark as read</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => toast.success("Conversation assigned")}>Assign to me</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive focus:text-destructive"
                        onClick={() => toast.success("Conversation archived")}>
                        Archive
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
                {groupByDay(thread).map((group) => (
                  <div key={group.day}>
                    <div className="mb-3 flex items-center gap-2">
                      <div className="h-px flex-1 bg-border" />
                      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        {group.day}
                      </span>
                      <div className="h-px flex-1 bg-border" />
                    </div>
                    <div className="space-y-3">
                      {group.messages.map((m) => (
                        <MessageBubble key={m.id} msg={m} />
                      ))}
                    </div>
                  </div>
                ))}
                {thread.length === 0 && (
                  <div className="py-12 text-center text-xs text-muted-foreground">No messages yet</div>
                )}
              </div>

              {/* Composer */}
              <div className="border-t border-border bg-card p-3">
                <div className="mb-2 flex items-center gap-1">
                  <div className="flex h-7 items-center gap-0.5 rounded-md border border-border bg-background p-0.5">
                    <ComposeTab id="sms" current={composeChannel} onSelect={setComposeChannel} icon={MessageSquare} label="SMS" />
                    <ComposeTab id="whatsapp" current={composeChannel} onSelect={setComposeChannel} icon={MessageSquare} label="WhatsApp" />
                    <ComposeTab id="email" current={composeChannel} onSelect={setComposeChannel} icon={Mail} label="Email" />
                    {contact?.messenger_psid && (
                      <ComposeTab id="messenger" current={composeChannel} onSelect={setComposeChannel} icon={MessageSquare} label="Messenger" />
                    )}
                    {contact?.instagram_igsid && (
                      <ComposeTab id="instagram" current={composeChannel} onSelect={setComposeChannel} icon={AtSign} label="Instagram" />
                    )}
                    <ComposeTab id="note" current={composeChannel} onSelect={setComposeChannel} icon={StickyNote} label="Note" />
                  </div>
                  <div className="ml-auto flex items-center gap-1">
                    <Popover open={tplOpen} onOpenChange={setTplOpen}>
                      <PopoverTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-7 text-[11px]">
                          <FileText className="mr-1 h-3 w-3" /> Templates
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-80 p-0">
                        <div className="border-b border-border p-2">
                          <div className="relative">
                            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                            <Input
                              autoFocus
                              value={tplSearch}
                              onChange={(e) => setTplSearch(e.target.value)}
                              placeholder={`Search ${composeChannel === "email" ? "email" : composeChannel === "sms" ? "SMS" : ""} templates…`}
                              className="h-8 pl-7 text-xs"
                            />
                          </div>
                          <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
                            <span>Merging for {contact?.name ?? "—"}</span>
                            <Link to="/settings/templates" className="hover:text-primary">Manage</Link>
                          </div>
                        </div>
                        <div className="max-h-72 overflow-y-auto p-1">
                          {visibleTemplates.length === 0 ? (
                            <div className="p-6 text-center text-[11px] text-muted-foreground">
                              No templates match
                            </div>
                          ) : (
                            visibleTemplates.map((t) => {
                              const previewSrc = t.channel === "email" && t.subject ? t.subject : t.body;
                              return (
                                <button
                                  key={t.id}
                                  onClick={() => applyTemplate(t)}
                                  className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-secondary"
                                >
                                  <div className="flex items-center gap-1.5">
                                    {t.channel === "email" ? (
                                      <Mail className="h-3 w-3 text-muted-foreground" />
                                    ) : (
                                      <MessageSquare className="h-3 w-3 text-muted-foreground" />
                                    )}
                                    <span className="truncate text-[12px] font-medium">{t.name}</span>
                                    {t.starred && <Star className="h-2.5 w-2.5 fill-amber-400 text-amber-400" />}
                                    <Badge variant="outline" className="ml-auto h-4 px-1 text-[9px]">{t.category}</Badge>
                                  </div>
                                  <div className="line-clamp-1 text-[10px] text-muted-foreground">
                                    {resolveMergeTags(previewSrc, mergeCtx)}
                                  </div>
                                </button>
                              );
                            })
                          )}
                        </div>
                      </PopoverContent>
                    </Popover>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-[11px]"
                      onClick={() => setPickerOpen(true)}
                    >
                      <Sparkles className="mr-1 h-3 w-3" /> Pick template
                    </Button>
                    <Button
                      variant="ghost" size="sm"
                      className="h-7 text-[11px] text-primary hover:text-primary"
                      onClick={handleAiDraft}
                      disabled={aiDrafting}
                    >
                      {aiDrafting
                        ? <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        : <Sparkles className="mr-1 h-3 w-3" />}
                      AI Draft
                    </Button>
                    <span className="mx-1 h-4 w-px bg-border" />
                    <Button variant="ghost" size="sm" className="h-7 px-2" title="Mention"
                      onClick={() => setDraft((d) => d ? `${d} @` : "@")}>
                      <Hash className="h-3.5 w-3.5" />
                    </Button>
                    <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
                      <PopoverTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-7 px-2" title="Emoji">
                          <Smile className="h-3.5 w-3.5" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-56 p-2">
                        <div className="grid grid-cols-8 gap-0.5">
                          {["👍","😊","🙏","✅","👋","🏠","🔨","📋","💰","📅","⚡","🎉","👌","💪","🤝","😄"].map((e) => (
                            <button key={e} className="flex h-7 w-7 items-center justify-center rounded hover:bg-secondary text-base"
                              onClick={() => { setDraft((d) => d + e); setEmojiOpen(false); }}>
                              {e}
                            </button>
                          ))}
                        </div>
                      </PopoverContent>
                    </Popover>
                    <Button variant="ghost" size="sm" className="h-7 px-2" title="Attach file"
                      onClick={() => fileInputRef.current?.click()}>
                      <Paperclip className="h-3.5 w-3.5" />
                    </Button>
                    <input ref={fileInputRef} type="file" className="hidden" multiple
                      onChange={(e) => {
                        const files = Array.from(e.target.files ?? []);
                        if (files.length) toast.success(`${files.length} file(s) attached: ${files.map(f => f.name).join(", ")}`);
                        e.target.value = "";
                      }} />
                  </div>
                </div>
                {composeChannel === "email" && (
                  <Input
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="Subject"
                    className="mb-2 h-8 text-xs"
                  />
                )}
                <div
                  className={`rounded-md border ${
                    composeChannel === "note"
                      ? "border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30"
                      : "border-border bg-background"
                  }`}
                >
                  <Textarea
                    placeholder={
                      composeChannel === "email"
                        ? "Write an email…"
                        : composeChannel === "sms"
                          ? "Send a text message…"
                          : "Add an internal note (visible to your team only)…"
                    }
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    className="min-h-18 resize-none border-0 bg-transparent text-sm focus-visible:ring-0"
                  />
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <div className="text-[10px] text-muted-foreground">
                    {composeChannel === "sms" && `${draft.length}/160 chars · 1 segment`}
                    {composeChannel === "email" && "Will reply from sales@yourco.com"}
                    {composeChannel === "note" && "Internal · @mention to notify"}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Popover open={scheduleOpen} onOpenChange={(o) => {
                      setScheduleOpen(o);
                      if (o && !scheduleDateTime) {
                        const d = new Date(Date.now() + 3600_000);
                        d.setSeconds(0, 0);
                        setScheduleDateTime(d.toISOString().slice(0, 16));
                      }
                    }}>
                      <PopoverTrigger asChild>
                        <Button variant="outline" size="sm" className="h-8 text-xs">
                          <Clock className="mr-1 h-3 w-3" /> Schedule
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-72 p-3 space-y-3">
                        <div className="text-xs font-semibold">Schedule message</div>
                        <div className="space-y-1">
                          <label className="text-[11px] text-muted-foreground">Send at</label>
                          <input
                            type="datetime-local"
                            value={scheduleDateTime}
                            onChange={(e) => setScheduleDateTime(e.target.value)}
                            min={new Date().toISOString().slice(0, 16)}
                            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                          />
                        </div>
                        <div className="flex gap-2">
                          <Button variant="outline" size="sm" className="flex-1 h-7 text-xs" onClick={() => setScheduleOpen(false)}>
                            Cancel
                          </Button>
                          <Button size="sm" className="flex-1 h-7 text-xs" onClick={handleSchedule}>
                            <Calendar className="mr-1 h-3 w-3" /> Confirm
                          </Button>
                        </div>
                      </PopoverContent>
                    </Popover>
                    <Button size="sm" className="h-8" onClick={handleSend}>
                      <Send className="mr-1.5 h-3.5 w-3.5" /> Send
                    </Button>
                  </div>
                </div>
                {showInsertLog && (
                  <div className="mt-2 max-h-40 overflow-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-[10px] leading-relaxed">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="font-semibold text-muted-foreground">Template insert log</span>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={clearInsertLog}
                      >
                        clear
                      </button>
                    </div>
                    {insertLog.length === 0 ? (
                      <div className="text-muted-foreground">No template inserts yet.</div>
                    ) : (
                      insertLog.map((e, i) => (
                        <div key={i} className="border-t border-border/60 py-1 first:border-0 first:pt-0">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="text-muted-foreground" title={e.ts}>{formatLogTs(e.ts)}</span>
                            {e.userName && (
                              <span className="text-muted-foreground">· user=<span className="text-foreground">{e.userName}</span></span>
                            )}
                            {e.clientSlug && (
                              <span className="text-muted-foreground">· client=<span className="text-foreground">{e.clientSlug}</span></span>
                            )}
                            <span className="font-semibold">{e.templateName}</span>
                            <span className="text-muted-foreground">[{e.channel}]</span>
                          </div>
                          <div className="pl-1 text-muted-foreground">
                            mode=<span className="font-semibold text-foreground">{e.mode}</span>{" "}
                            body=<span className={bodyToneClass(e.bodyAction)}>{e.bodyAction}</span>{" "}
                            subject=<span className={bodyToneClass(e.subjectAction)}>{e.subjectAction}</span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select a conversation
            </div>
          )}
        </section>

        {/* PANE 4 — Contact context */}
        <aside className="flex min-h-0 flex-col border-l border-border bg-card">
          {active && contact ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="border-b border-border p-4">
                <div className="flex items-start gap-3">
                  <Avatar className="h-12 w-12">
                    <AvatarFallback className="bg-primary-soft text-sm font-semibold text-primary">
                      {initials(contact.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">{contact.name}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{contact.email}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{contact.phone}</div>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-1.5">
                  <Button variant="outline" size="sm" className="h-7 text-[11px]"><Mail className="mr-1 h-3 w-3" /> Email</Button>
                  <Button variant="outline" size="sm" className="h-7 text-[11px]"><MessageSquare className="mr-1 h-3 w-3" /> SMS</Button>
                  <Button variant="outline" size="sm" className="h-7 text-[11px]"><PhoneIcon className="mr-1 h-3 w-3" /> Call</Button>
                </div>
              </div>

              {contact.owner && contact.owner !== "—" && (
                <ContextSection title="Assignment">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Avatar className="h-6 w-6">
                        <AvatarFallback className="bg-primary-soft text-[9px] font-semibold text-primary">
                          {initials(contact.owner)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-xs font-medium">{contact.owner}</span>
                    </div>
                  </div>
                </ContextSection>
              )}

              {contact.tags && contact.tags.length > 0 && (
                <ContextSection title="Tags">
                  <div className="flex flex-wrap gap-1">
                    {contact.tags.map((t) => (
                      <Badge key={t} variant="outline" className="h-5 px-1.5 text-[10px]">{t}</Badge>
                    ))}
                  </div>
                </ContextSection>
              )}

              <ContextSection title={`Active Projects (${sbProjects.length})`}>
                {sbProjects.length === 0 ? (
                  <div className="text-[11px] text-muted-foreground">No active projects</div>
                ) : (
                  <div className="space-y-1.5">
                    {sbProjects.slice(0, 3).map((p) => (
                      <div key={p.id} className="flex items-center justify-between rounded-md border border-border bg-background px-2 py-1.5">
                        <div className="min-w-0">
                          <div className="truncate text-[11px] font-medium">{p.name}</div>
                          <div className="text-[10px] text-muted-foreground capitalize">{p.status.replace(/_/g, " ")}</div>
                        </div>
                        <div className="text-[10px] text-muted-foreground tabular-nums">{p.completion_percentage}%</div>
                      </div>
                    ))}
                  </div>
                )}
              </ContextSection>

              <ContextSection title="Lifetime Value">
                <div className="flex items-baseline gap-2">
                  <span className="text-lg font-semibold tabular-nums">
                    ${sbInvoiceTotal.toLocaleString()}
                  </span>
                </div>
                <div className="mt-1 text-[10px] text-muted-foreground">
                  {sbProjects.length} project{sbProjects.length !== 1 ? "s" : ""} · {sbInvoiceCount} invoice{sbInvoiceCount !== 1 ? "s" : ""}
                </div>
              </ContextSection>

              <ContextSection title="Recent Activity">
                {contactActivity.length === 0 ? (
                  <div className="text-[11px] text-muted-foreground">No activity yet</div>
                ) : (
                  <ul className="space-y-2 text-[11px]">
                    {contactActivity.slice(0, 5).map((item) => (
                      <li key={item.id} className="flex gap-2">
                        <div className="mt-0.5 h-3 w-3 shrink-0 rounded-full bg-muted-foreground/30" />
                        <div>
                          <div className="font-medium">{item.title}</div>
                          <div className="text-muted-foreground">
                            {new Date(item.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </ContextSection>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
              Contact details appear here
            </div>
          )}
        </aside>
      </div>
    </div>

    {/* New Conversation Sheet */}
    <NewConversationSheet
      open={newConvOpen}
      onClose={() => setNewConvOpen(false)}
      onSelect={(c) => {
        // Use the channel currently filtered on (WhatsApp/SMS/Messenger/
        // Instagram/Email) so starting a new conversation from the
        // WhatsApp tab actually creates/opens a WhatsApp thread, not
        // whichever channel that contact happens to already have. "All"
        // and "Voice" aren't valid compose channels — voice has no
        // outbound compose, and "all" has no single channel to pick — so
        // both fall back to SMS as the most universal default.
        //
        // Typed as this exact literal union — not Conversation["channel"]
        // (which includes "voice", invalid for setComposeChannel below) and
        // not ComposeChannel (which includes "note", invalid for the
        // Conversation object below) — because this value is genuinely
        // used as both, and only this 5-value intersection is valid for
        // both at once.
        const targetChannel: "email" | "sms" | "whatsapp" | "messenger" | "instagram" =
          channelFilter === "all" || channelFilter === "voice" ? "sms" : channelFilter;

        const existing = allConversations.find(
          (conv) => conv.contactId === c.id && conv.channel === targetChannel,
        );
        if (existing) {
          setActiveId(existing.id);
        } else {
          const newConv: Conversation = {
            id: `local-conv-${Date.now()}`,
            contactId: c.id,
            contactName: c.name,
            channel: targetChannel,
            preview: "New conversation",
            lastAt: new Date().toISOString(),
            unread: false,
          };
          setLocalConversations((prev) => [newConv, ...prev]);
          setActiveId(newConv.id);
        }
        setComposeChannel(targetChannel);
        setNewConvOpen(false);
      }}
    />

    <Sheet open={pickerOpen} onOpenChange={setPickerOpen}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Pick a template</SheetTitle>
          <SheetDescription>
            Insert a pre-written email or SMS template into your reply. Merge tags are resolved using the active conversation's contact.
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4">
          <TemplatePicker
            compact
            initialChannel={composeChannel === "email" ? "email" : composeChannel === "sms" ? "sms" : "all"}
            onInsert={(t) => {
              applyTemplate(t);
              setPickerOpen(false);
            }}
          />
        </div>
      </SheetContent>
    </Sheet>
    <AlertDialog open={pendingTemplate !== null} onOpenChange={(o) => { if (!o) setPendingTemplate(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Replace or append your draft?</AlertDialogTitle>
          <AlertDialogDescription>
            Your composer already has content{pendingTemplate?.channel === "email" && pendingTemplate?.subject ? " (including a subject)" : ""}. Append keeps your existing subject and adds the template body to the end. Replace overwrites both the subject and body with "{pendingTemplate?.name}".
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            variant="outline"
            onClick={() => {
              if (pendingTemplate) writeTemplate(pendingTemplate, "append");
              setPendingTemplate(null);
            }}
          >
            Append
          </Button>
          <AlertDialogAction
            onClick={() => {
              if (pendingTemplate) writeTemplate(pendingTemplate, "replace");
              setPendingTemplate(null);
            }}
          >
            Replace
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}

function ComposeTab({
  id,
  current,
  onSelect,
  icon: Icon,
  label,
}: {
  id: ComposeChannel;
  current: ComposeChannel;
  onSelect: (id: ComposeChannel) => void;
  icon: typeof Mail;
  label: string;
}) {
  const isActive = current === id;
  return (
    <button
      onClick={() => onSelect(id)}
      className={`flex h-6 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors ${
        isActive
          ? id === "note"
            ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
            : "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-secondary"
      }`}
    >
      <Icon className="h-3 w-3" /> {label}
    </button>
  );
}

function ContextSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-border p-4">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

function ConversationRow({ conv, active, starred, onClick }: { conv: Conversation; active: boolean; starred: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-start gap-3 border-b border-border px-3 py-3 text-left transition-colors ${
        active ? "bg-primary-soft/50" : "hover:bg-secondary/40"
      }`}
    >
      <div className="relative">
        <Avatar className="h-9 w-9">
          <AvatarFallback className="bg-secondary text-[11px] font-semibold">{initials(conv.contactName)}</AvatarFallback>
        </Avatar>
        <span className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full border-2 border-background bg-card">
          <ChannelGlyph channel={conv.channel} />
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className={`truncate text-[13px] ${conv.unread ? "font-semibold text-foreground" : "font-medium text-foreground/90"}`}>
            {conv.contactName}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{relativeShort(conv.lastAt)}</span>
        </div>
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{conv.preview}</div>
        <div className="mt-1.5 flex items-center gap-1">
          {starred && <Star className="h-2.5 w-2.5 fill-amber-400 text-amber-400" />}
          {hasMention(conv.id) && (
            <Badge variant="outline" className="h-4 border-violet-300 bg-violet-50 px-1 text-[9px] text-violet-700 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300">
              @mention
            </Badge>
          )}
          {isUnassigned(conv.id) && (
            <Badge variant="outline" className="h-4 border-amber-300 bg-amber-50 px-1 text-[9px] text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
              unassigned
            </Badge>
          )}
        </div>
      </div>
      {active && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-primary" />}
    </button>
  );
}

function MessageBubble({ msg }: { msg: LocalMessage }) {
  const isOut = msg.direction === "out";

  // Internal note
  if (msg.channel === "note") {
    return (
      <div className="flex justify-center">
        <div className="max-w-[80%] rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          <span className="mr-1.5 font-semibold">Note:</span>{msg.body}
          <div className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">{fmtTime(msg.at)} · Internal only</div>
        </div>
      </div>
    );
  }

  // Voice call
  if (msg.channel === "voice") {
    return (
      <div className={`flex ${isOut ? "justify-end" : "justify-start"}`}>
        <div className="flex max-w-[70%] items-center gap-3 rounded-lg border border-border bg-card px-3 py-2">
          {isOut ? <ArrowUpRight className="h-4 w-4 text-emerald-500" /> : <ArrowDownLeft className="h-4 w-4 text-sky-500" />}
          <div className="flex-1">
            <div className="text-xs font-medium">{isOut ? "Outbound call" : "Inbound call"} · 4m 12s</div>
            <div className="text-[10px] text-muted-foreground">Recording available · {fmtTime(msg.at)}</div>
          </div>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]">Play</Button>
        </div>
      </div>
    );
  }

  // SMS / Email (+ scheduled variant)
  return (
    <div className={`flex ${isOut ? "justify-end" : "justify-start"}`}>
      <div className={`flex max-w-[72%] flex-col gap-1 ${isOut ? "items-end" : "items-start"}`}>
        <div
          className={`rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
            msg.isScheduled
              ? "rounded-br-sm border border-dashed border-primary/50 bg-primary/10 text-foreground"
              : isOut
                ? "rounded-br-sm bg-primary text-primary-foreground"
                : "rounded-bl-sm border border-border bg-card text-foreground"
          }`}
        >
          {msg.body}
        </div>
        <div className="flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground">
          <ChannelGlyph channel={msg.channel} />
          <span>{fmtTime(msg.at)}</span>
          {msg.isScheduled ? (
            <>
              <span>·</span>
              <Clock className="h-3 w-3 text-primary/70" />
              <span className="text-primary/80">Scheduled</span>
            </>
          ) : isOut ? (
            <>
              <span>·</span>
              <CheckCheck className="h-3 w-3 text-primary/70" />
              <span>Delivered</span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ── New Conversation Sheet ────────────────────────────────────────────────────

function NewConversationSheet({
  open, onClose, onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (c: { id: string; name: string }) => void;
}) {
  const [query, setQuery] = useState("");
  const [sbList, setSbList] = useState<{ id: string; name: string; email: string; phone: string }[]>([]);
  const [sbLoading, setSbLoading] = useState(true);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSbLoading(true);
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || cancelled) { setSbLoading(false); return; }
      const { data: profile } = await supabase.from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
      const orgId = profile?.organization_id;
      if (!orgId || cancelled) { setSbLoading(false); return; }
      const { data } = await supabase
        .from("contacts")
        .select("id, full_name, email, phone")
        .eq("org_id", orgId)
        .order("full_name", { ascending: true })
        .limit(500);
      if (cancelled) return;
      setSbList((data ?? []).map((c: any) => ({
        id: c.id,
        name: c.full_name ?? "Unknown",
        email: c.email ?? "",
        phone: c.phone ?? "",
      })));
      setSbLoading(false);
    })();
    return () => { cancelled = true; };
  }, [open]);

  const contacts = useMemo(() => {
    const q = query.toLowerCase();
    return sbList
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q) || c.phone.includes(q))
      .slice(0, 100);
  }, [query, sbList]);

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-sm flex flex-col">
        <SheetHeader className="border-b border-border pb-4">
          <SheetTitle>New Conversation</SheetTitle>
          <SheetDescription>Choose a contact to start a conversation with.</SheetDescription>
        </SheetHeader>
        <div className="relative mt-4">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search contacts…"
            className="h-8 pl-8 text-sm"
          />
        </div>
        <div className="mt-3 flex-1 overflow-y-auto space-y-0.5">
          {sbLoading && (
            <p className="p-6 text-center text-xs text-muted-foreground">Loading contacts…</p>
          )}
          {!sbLoading && contacts.length === 0 && (
            <p className="p-6 text-center text-xs text-muted-foreground">No contacts found</p>
          )}
          {contacts.map((c) => (
            <button
              key={c.id}
              onClick={() => onSelect({ id: c.id, name: c.name })}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left hover:bg-secondary transition-colors"
            >
              <Avatar className="h-8 w-8 shrink-0">
                <AvatarFallback className="bg-primary-soft text-[11px] font-semibold text-primary">
                  {c.name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{c.name}</div>
                <div className="truncate text-[11px] text-muted-foreground">{c.phone || c.email}</div>
              </div>
            </button>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ChannelGlyph({ channel }: { channel: LocalMessage["channel"] }) {
  if (channel === "email") return <Mail className="h-3 w-3 text-muted-foreground" />;
  if (channel === "sms" || channel === "note") return <MessageSquare className="h-3 w-3 text-muted-foreground" />;
  if (channel === "whatsapp" || channel === "messenger") return <MessageSquare className="h-3 w-3 text-muted-foreground" />;
  if (channel === "instagram") return <AtSign className="h-3 w-3 text-muted-foreground" />;
  return <Phone className="h-3 w-3 text-muted-foreground" />;
}

function initials(name: string) {
  return name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();
}

function relativeShort(iso: string) {
  const days = Math.round((NOW - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "now";
  if (days === 1) return "1d";
  if (days < 7) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}

function fmtTime(iso: string) {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(iso));
}

function fmtDay(iso: string) {
  const d = new Date(iso);
  const days = Math.round((NOW - d.getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(d);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(d);
}

function groupByDay(messages: LocalMessage[]) {
  const map = new Map<string, LocalMessage[]>();
  for (const m of messages) {
    const key = fmtDay(m.at);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(m);
  }
  return Array.from(map.entries()).map(([day, messages]) => ({ day, messages }));
}

// Deterministic mock helpers (no random per render → no hydration drift)
function hash(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}
function isStarred(id: string) { return hash(id) % 5 === 0; }
function hasMention(id: string) { return hash(id) % 6 === 0; }
function isUnassigned(id: string) { return hash(id) % 4 === 0; }
function isAssignedToMe(id: string) { return hash(id) % 3 === 0; }
function isArchived(id: string) { return hash(id) % 11 === 0; }