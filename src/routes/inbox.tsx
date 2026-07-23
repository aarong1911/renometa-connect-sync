// src/routes/inbox.tsx
import { createFileRoute, Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType } from "react";
import { FaFacebookMessenger, FaInstagram, FaWhatsapp } from "react-icons/fa";
import "./inbox.css";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { ContactAvatar } from "@/components/ui/contact-avatar";
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
  Trash2,
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
import { useOrganization, useTeam } from "@/lib/organization";
import { updateContact, useContacts } from "@/lib/contacts-store";
import { useContactActivity } from "@/lib/contact-activity";
import { NewDealDialog } from "@/components/sales/new-deal-dialog";
import { DealDetailDrawer } from "@/components/sales/deal-detail-drawer";
import {
  deleteDeal as storeDeleteDeal, updateDeal as storeUpdateDeal,
  useDeals, usePipelineStages,
} from "@/lib/deals-store";
import type { Deal, LostReason } from "@/lib/sales/types";
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ChannelIcon = ComponentType<{ className?: string }>;

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
  { id: "all", label: "Inbox", icon: InboxIcon },
  { id: "unread", label: "Unread", icon: Circle },
  { id: "assigned", label: "Assigned to me", icon: CheckCheck },
  { id: "mentions", label: "Mentions", icon: AtSign },
  { id: "starred", label: "Starred", icon: Star },
  { id: "unassigned", label: "Unassigned", icon: Filter },
  { id: "archived", label: "Archived", icon: Archive },
];

const channelTabs: {
  id: ChannelFilter;
  label: string;
  icon: ChannelIcon;
  iconClass?: string;
}[] = [
  { id: "all", label: "All", icon: InboxIcon },
  { id: "email", label: "Email", icon: Mail },
  { id: "sms", label: "SMS", icon: MessageSquare },
  { id: "voice", label: "Voice", icon: Phone },
  { id: "whatsapp", label: "WhatsApp", icon: FaWhatsapp, iconClass: "text-[#25D366]" },
  { id: "messenger", label: "Messenger", icon: FaFacebookMessenger, iconClass: "text-[#0084FF]" },
  { id: "instagram", label: "Instagram", icon: FaInstagram, iconClass: "text-[#E4405F]" },
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
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [tplOpen, setTplOpen] = useState(false);
  const [tplSearch, setTplSearch] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [contactDrawerOpen, setContactDrawerOpen] = useState(false);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [managedTags, setManagedTags] = useState<{ label: string; color: string }[]>(() => {
    const defaults = [
      { label: "VIP", color: "bg-amber-400" },
      { label: "New Lead", color: "bg-emerald-400" },
      { label: "Needs Reply", color: "bg-rose-400" },
      { label: "Follow Up", color: "bg-sky-400" },
      { label: "Estimate Sent", color: "bg-violet-400" },
      { label: "Hot", color: "bg-orange-400" },
    ];

    try {
      const saved = JSON.parse(localStorage.getItem("inbox-managed-tags") ?? "[]") as {
        label: string;
        color: string;
      }[];

      if (Array.isArray(saved) && saved.length > 0) {
        const merged = [...saved];
        for (const tag of defaults) {
          if (!merged.some((item) => item.label.toLowerCase() === tag.label.toLowerCase())) {
            merged.push(tag);
          }
        }
        return merged;
      }
    } catch {}

    return defaults;
  });
  const [contactTagOverrides, setContactTagOverrides] = useState<Record<string, string[]>>({});
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
  useEffect(() => {
    try { localStorage.setItem("inbox-managed-tags", JSON.stringify(managedTags)); } catch {}
  }, [managedTags]);

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
  const [dealDialogOpen, setDealDialogOpen] = useState(false);
  const [dealDrawerId, setDealDrawerId] = useState<string | null>(null);
  const teamMembers = useTeam();
  const pipelineStages = usePipelineStages();
  const deals = useDeals();
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

        if (selectedTag) {
          const contactTags =
            contactTagOverrides[c.contactId] ??
            storeContactMap.get(c.contactId)?.tags ??
            [];

          if (
            !contactTags.some(
              (tag) => tag.toLowerCase() === selectedTag.toLowerCase(),
            )
          ) {
            return false;
          }
        }

        if (
          search &&
          !c.contactName.toLowerCase().includes(search.toLowerCase()) &&
          !c.preview.toLowerCase().includes(search.toLowerCase())
        ) {
          return false;
        }

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
  }, [
    folder,
    channelFilter,
    search,
    selectedTag,
    starredIds,
    allConversations,
    storeContactMap,
    contactTagOverrides,
  ]);

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
  const activeContactTags = active
    ? (contactTagOverrides[active.contactId] ?? contact?.tags ?? [])
    : [];

  const getTagColor = (tagName: string) =>
    managedTags.find((tag) => tag.label.toLowerCase() === tagName.toLowerCase())?.color ??
    "bg-slate-400";

  const getTagBorderColor = (tagName: string) => {
    const color = getTagColor(tagName);

    const borderByBackground: Record<string, string> = {
      "bg-amber-400": "border-amber-400",
      "bg-emerald-400": "border-emerald-400",
      "bg-rose-400": "border-rose-400",
      "bg-sky-400": "border-sky-400",
      "bg-violet-400": "border-violet-400",
      "bg-orange-400": "border-orange-400",
      "bg-fuchsia-400": "border-fuchsia-400",
      "bg-cyan-400": "border-cyan-400",
      "bg-lime-400": "border-lime-400",
      "bg-slate-400": "border-slate-400",
    };

    return borderByBackground[color] ?? "border-slate-400";
  };

  const handleToggleContactTag = async (tag: string) => {
    if (!active || !activeContactHasRealId) {
      toast.error("This contact must be saved before assigning tags");
      return;
    }

    const previous = activeContactTags;
    const next = previous.some((item) => item.toLowerCase() === tag.toLowerCase())
      ? previous.filter((item) => item.toLowerCase() !== tag.toLowerCase())
      : [...previous, tag];

    setContactTagOverrides((current) => ({
      ...current,
      [active.contactId]: next,
    }));

    try {
      await updateContact(active.contactId, { tags: next });
      toast.success(
        next.some((item) => item.toLowerCase() === tag.toLowerCase())
          ? `${tag} assigned`
          : `${tag} removed`,
      );
    } catch (error) {
      setContactTagOverrides((current) => ({
        ...current,
        [active.contactId]: previous,
      }));
      console.error("[inbox] failed to update contact labels:", error);
      toast.error("Could not update contact tags");
    }
  };

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
  const [sbDeals, setSbDeals] = useState<{ id: string; name: string; value: number; status: string }[]>([]);
  const [sbAppointments, setSbAppointments] = useState<{ id: string; service: string | null; scheduled_at: string }[]>([]);
  const [contactCompanyId, setContactCompanyId] = useState<string | null>(null);
  useEffect(() => {
    const contactId = active?.contactId;
    if (!contactId || !UUID_RE.test(contactId)) { setSbProjects([]); setSbInvoiceTotal(0); setSbInvoiceCount(0); setSbDeals([]); setSbAppointments([]); setContactCompanyId(null); return; }
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

      const { data: dealsRows } = await supabase
        .from("deals")
        .select("id, title, value, status")
        .eq("contact_id", contactId).eq("org_id", orgId)
        .eq("status", "open")
        .order("created_at", { ascending: false });

      const { data: contactRow } = await supabase
        .from("contacts")
        .select("company_id")
        .eq("id", contactId).eq("org_id", orgId)
        .maybeSingle();

      const nowIso = new Date().toISOString();
      const { data: apptRows } = await supabase
        .from("appointments")
        .select("id, service, scheduled_at")
        .eq("contact_id", contactId).eq("org_id", orgId)
        .neq("status", "cancelled")
        .gte("scheduled_at", nowIso)
        .order("scheduled_at", { ascending: true })
        .limit(3);

      if (cancelled) return;
      setSbProjects((projs ?? []) as any);
      const paid = (invs ?? []).filter((i: any) => i.status === "paid");
      setSbInvoiceTotal(paid.reduce((s: number, i: any) => s + (i.total_amount ?? 0), 0));
      setSbInvoiceCount((invs ?? []).length);
      setSbDeals(((dealsRows ?? []) as any[]).map((d) => ({ id: d.id, name: d.title, value: Number(d.value ?? 0), status: d.status })));
      setSbAppointments(((apptRows ?? []) as any[]).map((a) => ({ id: a.id, service: a.service, scheduled_at: a.scheduled_at })));
      setContactCompanyId(contactRow?.company_id ?? null);
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

  // ── Create Deal from this conversation's contact ────────────────────────────
  const activeContactHasRealId = !!active?.contactId && UUID_RE.test(active.contactId);

  const dealPrefill = useMemo(() => {
    if (!active || !contact) return undefined;
    return {
      contactId: activeContactHasRealId ? active.contactId : "",
      contactName: contact.name ?? "",
      email: contact.email ?? "",
      phone: contact.phone ?? "",
      companyId: contactCompanyId ?? "",
      source: "Inbox",
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.contactId, contact?.name, contact?.email, contact?.phone, contactCompanyId, activeContactHasRealId]);

  const handleDealCreated = (deal: Deal) => {
    setSbDeals((current) => [{ id: deal.id, name: deal.name, value: deal.value, status: deal.status }, ...current]);
    setDealDrawerId(deal.id);
  };

  const dealDrawerDeal = useMemo(
    () => (dealDrawerId ? (deals.find((d) => d.id === dealDrawerId) ?? null) : null),
    [dealDrawerId, deals],
  );

  const handleDealStageChange = async (dealId: string, newStage: string) => {
    try {
      await storeUpdateDeal(dealId, { stage: newStage } as Partial<Deal>);
    } catch (error) {
      console.error("[inbox] deal stage change failed:", error);
      toast.error("Failed to update the deal stage.");
    }
  };

  const handleDealMarkLost = async (dealId: string, reason: LostReason, notes: string) => {
    try {
      await storeUpdateDeal(dealId, { stage: "lost", status: "lost", lostReason: reason, notes: notes || undefined });
    } catch (error) {
      console.error("[inbox] mark lost failed:", error);
      toast.error("Failed to mark the deal as lost.");
    }
  };

  const handleDealUpdate = async (dealId: string, patch: Partial<Deal>) => {
    try {
      await storeUpdateDeal(dealId, patch);
    } catch (error) {
      console.error("[inbox] deal update failed:", error);
      toast.error("Failed to save the deal.");
      throw error;
    }
  };

  const handleDealDelete = async (dealId: string) => {
    try {
      await storeDeleteDeal(dealId);
      setDealDrawerId(null);
      setSbDeals((current) => current.filter((d) => d.id !== dealId));
    } catch (error) {
      console.error("[inbox] delete deal failed:", error);
      toast.error("Failed to delete the deal.");
      throw error;
    }
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
    <div className="conversations-page -m-6 flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden">
      <div className="conversations-page-header shrink-0 border-b border-border bg-background px-6 py-5">
        <PageHeader
          icon={MessageSquare}
          iconBg="bg-cyan-soft"
          iconColor="text-cyan"
          title="Conversations"
          subtitle="Manage every customer conversation across email, SMS, voice, and messaging channels."
          actions={
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="h-9">
                <Filter className="mr-1.5 h-3.5 w-3.5" /> Filters
              </Button>
              <Button size="sm" className="h-9 bg-[#C88D22] text-white hover:bg-[#B77E18]" onClick={() => setNewConvOpen(true)}>
                <Plus className="mr-1.5 h-3.5 w-3.5" /> New Conversation
              </Button>
            </div>
          }
        />
      </div>

      <div className="conversations-grid grid min-h-0 flex-1 grid-cols-[340px_1fr] overflow-hidden lg:grid-cols-[196px_350px_1fr] xl:grid-cols-[196px_350px_1fr_310px]">
        {/* PANE 1 — Folders (collapses below lg to keep the conversation list + composer usable) */}
        <aside className="hidden min-h-0 flex-col border-r border-border bg-background lg:flex">
          <div className="px-3.5 pb-2 pt-5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Folders
          </div>
          <nav className="flex flex-col gap-1 px-2.5">
            {folders.map((f) => {
              const Icon = f.icon;
              const isActive = folder === f.id;
              const count = folderCounts[f.id];
              return (
                <button
                  key={f.id}
                  onClick={() => {
                    setFolder(f.id);
                    setSelectedTag(null);
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                    isActive ? "bg-gold-soft text-gold-soft-foreground" : "text-foreground hover:bg-secondary"
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="whitespace-nowrap">{f.label}</span>
                  </span>
                  {count > 0 && (
                    <span className={`ml-2 shrink-0 text-[11px] tabular-nums ${isActive ? "text-gold-soft-foreground" : "text-muted-foreground"}`}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="mt-6 px-3.5 pb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Tags
          </div>
          <div className="flex flex-col gap-1 px-2.5">
            {managedTags.map((t) => {
              const isActive =
                selectedTag?.toLowerCase() === t.label.toLowerCase();

              const count = allConversations.filter((conversation) => {
                if (isArchived(conversation.id)) return false;

                const tags =
                  contactTagOverrides[conversation.contactId] ??
                  storeContactMap.get(conversation.contactId)?.tags ??
                  [];

                return tags.some(
                  (tag) => tag.toLowerCase() === t.label.toLowerCase(),
                );
              }).length;

              return (
                <button
                  key={t.label}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => {
                    setSelectedTag((current) =>
                      current?.toLowerCase() === t.label.toLowerCase()
                        ? null
                        : t.label,
                    );
                    setFolder("all");
                    setSearch("");
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-secondary text-foreground"
                      : "text-foreground hover:bg-secondary"
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    <span className={`h-2 w-2 rounded-full ${t.color}`} />
                    {t.label}
                  </span>
                  <span
                    className={`text-[11px] tabular-nums ${
                      isActive
                        ? "font-semibold text-foreground"
                        : "text-muted-foreground"
                    }`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setTagManagerOpen(true)}
              className="mt-0.5 flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[13px] text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <Tag className="h-4 w-4" /> Manage tags
            </button>
          </div>

        </aside>

        {/* PANE 2 — Conversation list */}
        <section className="conversation-list-pane flex min-h-0 flex-col border-r border-border">
          <div className="conversation-channel-tabs flex items-center gap-2 overflow-x-auto border-b border-border bg-background px-4 py-3">
            {channelTabs.map((t) => {
              const Icon = t.icon;
              const isActive = channelFilter === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setChannelFilter(t.id)}
                  className={`conversation-channel-tab flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-xl border px-4 text-[13px] font-medium transition-colors ${
                    isActive
                      ? "is-active border-[#E8D4AA] bg-[#FAF3E4] text-[#9A6821]"
                      : "border-[#E5E7EB] bg-white text-[#344054] hover:bg-[#F8FAFC]"
                  }`}
                >
                  <Icon className={`h-4 w-4 ${t.iconClass ?? ""}`} />
                  {t.label}
                </button>
              );
            })}
          </div>
          <div className="border-b border-border p-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search conversations..."
                className="h-9 pl-8 text-sm"
              />
            </div>
          </div>
          <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5 text-[10px] uppercase tracking-wider text-muted-foreground">
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
                contactTags={
                  allStoreContacts.find((contact) => contact.id === c.contactId)?.tags ?? []
                }
                tagDefinitions={managedTags}
                onClick={() => setActiveId(c.id)}
              />
            ))}
            {conversations.length === 0 && (
              <div className="p-8 text-center">
                <p className="text-sm font-medium text-foreground">
                  {selectedTag
                    ? `No conversations tagged ${selectedTag}`
                    : channelFilter === "messenger"
                      ? "No Messenger conversations yet"
                      : channelFilter === "instagram"
                        ? "No Instagram conversations yet"
                        : "No conversations match these filters"}
                </p>
                {selectedTag ? (
                  <button
                    type="button"
                    onClick={() => setSelectedTag(null)}
                    className="mt-2 text-xs font-medium text-gold-soft-foreground hover:underline"
                  >
                    Clear tag filter
                  </button>
                ) : (
                  (channelFilter === "messenger" || channelFilter === "instagram") && (
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      Conversations appear after someone messages your connected{" "}
                      {channelFilter === "messenger"
                        ? "Facebook Page"
                        : "Instagram account"}.
                    </p>
                  )
                )}
              </div>
            )}
          </div>
        </section>

        {/* PANE 3 — Thread */}
        <section className="conversation-thread-pane flex min-h-0 flex-col bg-background">
          {active && contact ? (
            <>
              <div className="flex items-center justify-between border-b border-border bg-background px-5 py-4">
                <div className="flex min-w-0 items-center gap-3">
                  <ContactAvatar id={active.contactId} name={active.contactName} size="md" className="h-10 w-10" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-[15px] font-semibold">
                      <span className="truncate">{active.contactName}</span>
                      <Badge variant="outline" className="h-4.5 shrink-0 px-1.5 text-[9px] uppercase">
                        {activeContactTags[0] ?? "Customer"}
                      </Badge>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
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
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2"
                    title={checkStarred(active.id) ? "Unstar conversation" : "Star conversation"}
                    onClick={() => {
                      setStarredIds((prev) => {
                        const next = new Set(prev);
                        next.has(active.id) ? next.delete(active.id) : next.add(active.id);
                        return next;
                      });
                    }}
                  >
                    <Star
                      className={`h-4 w-4 ${
                        checkStarred(active.id)
                          ? "fill-amber-400 text-amber-400"
                          : "text-muted-foreground"
                      }`}
                    />
                  </Button>
                  <Button variant="ghost" size="sm" className="h-8 px-2" title="WhatsApp"
                    onClick={() => setComposeChannel("whatsapp")}>
                    <FaWhatsapp className={`h-4 w-4 ${composeChannel === "whatsapp" ? "text-[#25D366]" : "text-[#667085]"}`} />
                  </Button>
                  {contact?.messenger_psid && (
                    <Button variant="ghost" size="sm" className="h-8 px-2" title="Messenger"
                      onClick={() => setComposeChannel("messenger")}>
                      <FaFacebookMessenger className={`h-4 w-4 ${composeChannel === "messenger" ? "text-[#0084FF]" : "text-[#667085]"}`} />
                    </Button>
                  )}
                  {contact?.instagram_igsid && (
                    <Button variant="ghost" size="sm" className="h-8 px-2" title="Instagram"
                      onClick={() => setComposeChannel("instagram")}>
                      <FaInstagram className={`h-4 w-4 ${composeChannel === "instagram" ? "text-[#E4405F]" : "text-[#667085]"}`} />
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" className="h-8 px-2" title="Call"
                    onClick={() => toast.info(`Calling ${contact?.phone ?? ""}…`)}>
                    <PhoneCall className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="sm" className="h-8 px-2" title="Video"
                    onClick={() => toast.info("Video calling coming soon")}>
                    <Video className="h-4 w-4" />
                  </Button>
                  <span className="mx-1 h-5 w-px bg-border" />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-8 px-2" title="More">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => toast.success("Marked as read")}>Mark as read</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => toast.success("Conversation assigned")}>Assign to me</DropdownMenuItem>
                      {activeContactHasRealId && (
                        <DropdownMenuItem onClick={() => setDealDialogOpen(true)}>Create Deal</DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => {
                          setStarredIds((prev) => {
                            const next = new Set(prev);
                            next.has(active.id) ? next.delete(active.id) : next.add(active.id);
                            return next;
                          });
                        }}
                      >
                        {checkStarred(active.id) ? "Unstar conversation" : "Star conversation"}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          setPinnedIds((prev) => {
                            const next = new Set(prev);
                            next.has(active.id) ? next.delete(active.id) : next.add(active.id);
                            toast.success(next.has(active.id) ? "Conversation pinned" : "Conversation unpinned");
                            return next;
                          });
                        }}
                      >
                        {pinnedIds.has(active.id) ? "Unpin conversation" : "Pin conversation"}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={handleCopyThread}>Copy conversation</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive focus:text-destructive"
                        onClick={() => toast.success("Conversation archived")}>
                        Archive
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              <div className="conversation-thread-body min-h-0 flex-1 space-y-7 overflow-y-auto px-8 py-6">
                {groupByDay(thread).map((group) => (
                  <div key={group.day}>
                    <div className="mb-4 flex items-center gap-3">
                      <div className="h-px flex-1 bg-border" />
                      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        {group.day}
                      </span>
                      <div className="h-px flex-1 bg-border" />
                    </div>
                    <div className="space-y-4">
                      {group.messages.map((m) => (
                        <MessageBubble key={m.id} msg={m} />
                      ))}
                    </div>
                  </div>
                ))}
                {thread.length === 0 && (
                  <div className="flex h-full flex-col items-center justify-center py-12 text-center">
                    <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-gold-soft">
                      <MessageSquare className="h-6 w-6 text-gold-soft-foreground" />
                    </div>
                    <p className="text-sm font-semibold text-foreground">No conversation history yet</p>
                    <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                      Start the conversation by sending an email, SMS, or placing a call.
                    </p>
                    <div className="mt-4 flex items-center gap-2">
                      <Button variant="outline" size="sm" className="h-8" onClick={() => setComposeChannel("email")}>
                        <Mail className="mr-1.5 h-3.5 w-3.5" /> Email
                      </Button>
                      <Button variant="outline" size="sm" className="h-8" onClick={() => setComposeChannel("sms")}>
                        <MessageSquare className="mr-1.5 h-3.5 w-3.5" /> SMS
                      </Button>
                      <Button variant="outline" size="sm" className="h-8" onClick={() => toast.info(`Calling ${contact?.phone ?? ""}…`)}>
                        <PhoneCall className="mr-1.5 h-3.5 w-3.5" /> Call
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              {/* Composer */}
              <div className="conversation-composer-wrap border-t border-border p-4">
              <div className="conversation-composer rounded-2xl border border-[#E5E7EB] bg-white p-4">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <div className="conversation-compose-tabs flex min-h-10 items-center gap-1 rounded-xl border border-[#E5E7EB] bg-white p-1">
                    <ComposeTab id="sms" current={composeChannel} onSelect={setComposeChannel} icon={MessageSquare} label="SMS" />
                    <ComposeTab id="whatsapp" current={composeChannel} onSelect={setComposeChannel} icon={FaWhatsapp} label="WhatsApp" />
                    <ComposeTab id="email" current={composeChannel} onSelect={setComposeChannel} icon={Mail} label="Email" />
                    {contact?.messenger_psid && (
                      <ComposeTab id="messenger" current={composeChannel} onSelect={setComposeChannel} icon={FaFacebookMessenger} label="Messenger" />
                    )}
                    {contact?.instagram_igsid && (
                      <ComposeTab id="instagram" current={composeChannel} onSelect={setComposeChannel} icon={FaInstagram} label="Instagram" />
                    )}
                    <ComposeTab id="note" current={composeChannel} onSelect={setComposeChannel} icon={StickyNote} label="Note" />
                  </div>
                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-[11px]"
                      onClick={() => setPickerOpen(true)}
                    >
                      <FileText className="mr-1 h-3.5 w-3.5 text-[#B7791F]" />
                      <span className="font-medium text-[#9A6821]">Pick Template</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-[11px] hover:bg-violet-50"
                      onClick={handleAiDraft}
                      disabled={aiDrafting}
                    >
                      {aiDrafting ? (
                        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin text-violet-600" />
                      ) : (
                        <Sparkles className="mr-1 h-3.5 w-3.5 text-violet-600" />
                      )}
                      <span className="font-medium text-violet-700">AI Draft</span>
                    </Button>
                    <span className="mx-1 h-4 w-px bg-border" />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2"
                      title="Mention contact or teammate"
                      onClick={() => setDraft((d) => (d ? `${d} @` : "@"))}
                    >
                      <AtSign className="h-3.5 w-3.5" />
                    </Button>
                    <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
                      <PopoverTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-7 px-2" title="Emoji">
                          <Smile className="h-3.5 w-3.5" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-72 p-3">
                        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Add emoji
                        </div>
                        <div className="grid max-h-56 grid-cols-8 gap-1 overflow-y-auto pr-1">
                          {[
                            "👍","👎","👏","🙌","🤝","🙏","👋","👌",
                            "✅","❌","⭐","❤️","🔥","🎉","💯","⚡",
                            "😊","😄","😁","😂","🙂","😉","😍","🥳",
                            "😎","🤔","😕","😅","😢","😮","😴","🤯",
                            "🏠","🏢","🔨","🧰","📋","📄","📎","✏️",
                            "📅","⏰","📞","📧","💬","📍","🚚","🛠️",
                            "💰","💳","🧾","📈","🔑","🚪","🪟","🧱",
                          ].map((emoji) => (
                            <button
                              key={emoji}
                              type="button"
                              className="flex h-8 w-8 items-center justify-center rounded-md text-lg transition-colors hover:bg-secondary"
                              onClick={() => setDraft((current) => current + emoji)}
                              aria-label={`Insert ${emoji}`}
                            >
                              {emoji}
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
                          : composeChannel === "whatsapp"
                            ? "Send a WhatsApp message…"
                            : composeChannel === "messenger"
                              ? "Send a Messenger message…"
                              : composeChannel === "instagram"
                                ? "Send an Instagram message…"
                                : "Add an internal note (visible to your team only)…"
                    }
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    className="min-h-[86px] resize-none border-0 bg-transparent px-4 py-3 text-sm text-[#273142] placeholder:text-[#8A94A6] focus-visible:ring-0"
                  />
                </div>
                <div className="conversation-composer-bottom mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-[#EEF0F3] pt-3">
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
                    <Button size="sm" className="conversation-send h-10 rounded-xl bg-[#C88D22] px-5 text-sm font-semibold text-white shadow-sm hover:bg-[#B77E18]" onClick={handleSend}>
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
              </div>
            </>
          ) : (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-gold-soft">
                <MessageSquare className="h-6 w-6 text-gold-soft-foreground" />
              </div>
              <p className="text-sm font-medium text-muted-foreground">Select a conversation to get started</p>
            </div>
          )}
        </section>

        {/* PANE 4 — Contact context (collapses below xl to keep more room for the thread) */}
        <aside className="hidden min-h-0 flex-col border-l border-border bg-card xl:flex">
          {active && contact ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="border-b border-border p-5">
                <div className="flex items-start gap-3">
                  <ContactAvatar id={active.contactId} name={contact.name} size="lg" className="h-12 w-12" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-semibold">{contact.name}</div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">{contact.email}</div>
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">{contact.phone}</div>
                    {activeContactHasRealId && (
                      <button
                        type="button"
                        onClick={() => setContactDrawerOpen(true)}
                        className="mt-1.5 inline-block text-xs font-medium text-gold hover:underline"
                      >
                        View full contact
                      </button>
                    )}
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2">
                  <Button variant="outline" size="sm" className="h-8 text-xs"><Mail className="mr-1 h-3 w-3" /> Email</Button>
                  <Button variant="outline" size="sm" className="h-8 text-xs"><MessageSquare className="mr-1 h-3 w-3" /> SMS</Button>
                  <Button variant="outline" size="sm" className="h-8 text-xs"><PhoneIcon className="mr-1 h-3 w-3" /> Call</Button>
                </div>
              </div>

              {contact.owner && contact.owner !== "—" && (
                <ContextSection title="Assignment">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <Avatar className="h-7 w-7">
                        <AvatarFallback className="bg-primary-soft text-[10px] font-semibold text-primary">
                          {initials(contact.owner)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-sm font-medium">{contact.owner}</span>
                    </div>
                  </div>
                </ContextSection>
              )}

              <ContextSection title="Tags">
                <div className="flex flex-wrap gap-1.5">
                  {activeContactTags.length > 0 ? (
                    activeContactTags.map((tag) => (
                      <Badge
                        key={tag}
                        variant="outline"
                        className={`h-6 gap-1.5 bg-white px-2 text-[11px] text-foreground ${getTagBorderColor(tag)}`}
                      >
                        <span className={`h-2 w-2 rounded-full ${getTagColor(tag)}`} />
                        {tag}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-xs text-muted-foreground">No tags assigned</span>
                  )}
                </div>

                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-3 h-8 w-full justify-center text-xs"
                      disabled={!activeContactHasRealId}
                    >
                      <Tag className="mr-1.5 h-3.5 w-3.5" />
                      Assign tags
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-64 p-2">
                    <div className="px-2 pb-2 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Contact tags
                    </div>
                    <div className="max-h-64 space-y-1 overflow-y-auto">
                      {managedTags.map((tag) => {
                        const selected = activeContactTags.some(
                          (item) => item.toLowerCase() === tag.label.toLowerCase(),
                        );

                        return (
                          <button
                            key={tag.label}
                            type="button"
                            onClick={() => handleToggleContactTag(tag.label)}
                            className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm hover:bg-secondary"
                          >
                            <span className="flex items-center gap-2">
                              <span className={`h-2 w-2 rounded-full ${tag.color}`} />
                              {tag.label}
                            </span>
                            {selected && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                          </button>
                        );
                      })}
                    </div>
                    <div className="mt-2 border-t border-border pt-2">
                      <button
                        type="button"
                        onClick={() => setTagManagerOpen(true)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
                      >
                        <Tag className="h-3.5 w-3.5" />
                        Manage available tags
                      </button>
                    </div>
                  </PopoverContent>
                </Popover>
              </ContextSection>

              <ContextSection title={`Active Projects (${sbProjects.length})`}>
                {sbProjects.length === 0 ? (
                  <div className="text-xs text-muted-foreground">No active projects</div>
                ) : (
                  <div className="space-y-2">
                    {sbProjects.slice(0, 3).map((p) => (
                      <div key={p.id} className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2.5">
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium">{p.name}</div>
                          <div className="text-[11px] text-muted-foreground capitalize">{p.status.replace(/_/g, " ")}</div>
                        </div>
                        <div className="text-[11px] text-muted-foreground tabular-nums">{p.completion_percentage}%</div>
                      </div>
                    ))}
                  </div>
                )}
              </ContextSection>

              <ContextSection title="Lifetime Value">
                <div className="flex items-baseline gap-2">
                  <span className="text-xl font-semibold tabular-nums">
                    ${sbInvoiceTotal.toLocaleString()}
                  </span>
                </div>
                <div className="mt-1.5 text-xs text-muted-foreground">
                  {sbProjects.length} project{sbProjects.length !== 1 ? "s" : ""} · {sbInvoiceCount} invoice{sbInvoiceCount !== 1 ? "s" : ""}
                </div>
              </ContextSection>

              <div className="border-b border-border p-5">
                <div className="mb-3 flex items-center justify-between">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Open Deals ({sbDeals.length})
                  </div>
                  {sbDeals.length > 0 && (
                    <button className="text-xs font-medium text-muted-foreground hover:text-foreground">View all</button>
                  )}
                </div>

                {sbDeals.length === 0 ? (
                  <div className="space-y-3 rounded-lg border border-dashed border-border p-3.5">
                    <p className="text-xs text-muted-foreground">No open deals for this contact yet.</p>
                    {activeContactHasRealId && (
                      <Button
                        size="sm"
                        className="h-9 w-full border border-gold-soft bg-gold-soft text-gold-soft-foreground hover:bg-gold-soft/80"
                        onClick={() => setDealDialogOpen(true)}
                      >
                        <Plus className="mr-1.5 h-3.5 w-3.5" /> Create Deal
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    <div className="space-y-2">
                      {sbDeals.slice(0, 3).map((d) => (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() => setDealDrawerId(d.id)}
                          className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-left shadow-sm transition-colors hover:border-gold-soft hover:bg-gold-soft/30"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-[13px] font-medium">{d.name}</span>
                            <span className="shrink-0 text-[13px] font-semibold tabular-nums">${d.value.toLocaleString()}</span>
                          </div>
                          <div className="mt-1 flex items-center gap-1.5">
                            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${d.status === "open" ? "bg-info" : d.status === "won" ? "bg-success" : "bg-destructive"}`} />
                            <span className="text-[11px] capitalize text-muted-foreground">{d.status}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                    {activeContactHasRealId && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 w-full border-gold-soft bg-gold-soft/40 text-xs text-gold-soft-foreground hover:bg-gold-soft/70"
                        onClick={() => setDealDialogOpen(true)}
                      >
                        <Plus className="mr-1 h-3 w-3" /> Create Deal
                      </Button>
                    )}
                  </div>
                )}
              </div>

              <ContextSection title="Upcoming Appointments">
                {sbAppointments.length === 0 ? (
                  <div className="text-xs text-muted-foreground">No upcoming appointments</div>
                ) : (
                  <div className="space-y-2">
                    {sbAppointments.map((a) => (
                      <div key={a.id} className="rounded-lg border border-border bg-background px-3 py-2.5">
                        <div className="truncate text-[13px] font-medium">{a.service || "Appointment"}</div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          {new Date(a.scheduled_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })} · {new Date(a.scheduled_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </ContextSection>

              <ContextSection title="Recent Activity">
                {contactActivity.length === 0 ? (
                  <div className="text-xs text-muted-foreground">No activity yet</div>
                ) : (
                  <ul className="space-y-3 text-xs">
                    {contactActivity.slice(0, 5).map((item) => (
                      <li key={item.id} className="flex gap-2.5">
                        <div className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-gold" />
                        <div>
                          <div className="font-medium text-foreground">{item.title}</div>
                          <div className="mt-0.5 text-[11px] text-muted-foreground">
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
      contacts={allStoreContacts}
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

    <Sheet open={contactDrawerOpen} onOpenChange={setContactDrawerOpen}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Contact details</SheetTitle>
          <SheetDescription>
            Review this contact without leaving Conversations.
          </SheetDescription>
        </SheetHeader>

        {active && contact && (
          <div className="mt-6 space-y-6">
            <div className="flex items-center gap-3">
              <ContactAvatar id={active.contactId} name={contact.name} size="lg" className="h-14 w-14" />
              <div className="min-w-0">
                <div className="truncate text-lg font-semibold text-foreground">{contact.name}</div>
                <div className="mt-0.5 text-sm text-muted-foreground">
                  {contact.owner && contact.owner !== "—" ? `Owned by ${contact.owner}` : "Unassigned"}
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-border bg-card">
              <div className="border-b border-border p-4">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Email</div>
                <div className="mt-1 break-all text-sm text-foreground">{contact.email || "No email on file"}</div>
              </div>
              <div className="border-b border-border p-4">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Phone</div>
                <div className="mt-1 text-sm text-foreground">{contact.phone || "No phone on file"}</div>
              </div>
              <div className="p-4">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Tags</div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {activeContactTags.length > 0 ? (
                    activeContactTags.map((tag) => (
                      <Badge
                        key={tag}
                        variant="outline"
                        className={`h-6 gap-1.5 bg-white px-2 text-[11px] text-foreground ${getTagBorderColor(tag)}`}
                      >
                        <span className={`h-2 w-2 rounded-full ${getTagColor(tag)}`} />
                        {tag}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-sm text-muted-foreground">No tags</span>
                  )}
                </div>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-3 h-8"
                      disabled={!activeContactHasRealId}
                    >
                      <Tag className="mr-1.5 h-3.5 w-3.5" />
                      Assign tag
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-64 p-2">
                    {managedTags.map((tag) => {
                      const selected = activeContactTags.some(
                        (item) => item.toLowerCase() === tag.label.toLowerCase(),
                      );
                      return (
                        <button
                          key={tag.label}
                          type="button"
                          onClick={() => handleToggleContactTag(tag.label)}
                          className="flex w-full items-center justify-between rounded-md px-2 py-2 text-sm hover:bg-secondary"
                        >
                          <span className="flex items-center gap-2">
                            <span className={`h-2 w-2 rounded-full ${tag.color}`} />
                            {tag.label}
                          </span>
                          {selected && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                        </button>
                      );
                    })}
                  </PopoverContent>
                </Popover>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setComposeChannel("email");
                  setContactDrawerOpen(false);
                }}
              >
                <Mail className="mr-1.5 h-3.5 w-3.5" /> Email
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setComposeChannel("sms");
                  setContactDrawerOpen(false);
                }}
              >
                <MessageSquare className="mr-1.5 h-3.5 w-3.5" /> SMS
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => toast.info(`Calling ${contact.phone || ""}…`)}
              >
                <PhoneCall className="mr-1.5 h-3.5 w-3.5" /> Call
              </Button>
            </div>

            <div className="rounded-xl border border-border p-4">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Related records
              </div>
              <div className="mt-3 grid grid-cols-3 gap-3 text-center">
                <div>
                  <div className="text-lg font-semibold">{sbDeals.length}</div>
                  <div className="text-[11px] text-muted-foreground">Open deals</div>
                </div>
                <div>
                  <div className="text-lg font-semibold">{sbProjects.length}</div>
                  <div className="text-[11px] text-muted-foreground">Projects</div>
                </div>
                <div>
                  <div className="text-lg font-semibold">{sbAppointments.length}</div>
                  <div className="text-[11px] text-muted-foreground">Appointments</div>
                </div>
              </div>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>

    <Sheet open={tagManagerOpen} onOpenChange={setTagManagerOpen}>
      <SheetContent side="right" className="w-full sm:max-w-sm">
        <SheetHeader>
          <SheetTitle>Manage conversation tags</SheetTitle>
          <SheetDescription>
            Add or remove the tags shown in the Conversations sidebar.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-4">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const label = newTagName.trim();
              if (!label) return;
              if (managedTags.some((tag) => tag.label.toLowerCase() === label.toLowerCase())) {
                toast.error("That tag already exists");
                return;
              }
              const colors = ["bg-violet-400", "bg-cyan-400", "bg-orange-400", "bg-fuchsia-400", "bg-lime-400"];
              setManagedTags((current) => [
                ...current,
                { label, color: colors[current.length % colors.length] },
              ]);
              setNewTagName("");
              toast.success("Tag added");
            }}
          >
            <Input
              value={newTagName}
              onChange={(event) => setNewTagName(event.target.value)}
              placeholder="New tag name"
              className="h-9"
            />
            <Button type="submit" size="sm" className="h-9">
              <Plus className="mr-1 h-3.5 w-3.5" /> Add
            </Button>
          </form>

          <div className="space-y-2">
            {managedTags.map((tag) => (
              <div
                key={tag.label}
                className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2.5"
              >
                <div className="flex items-center gap-2.5">
                  <span className={`h-2.5 w-2.5 rounded-full ${tag.color}`} />
                  <span className="text-sm font-medium">{tag.label}</span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    setManagedTags((current) => current.filter((item) => item.label !== tag.label));
                    toast.success("Tag removed");
                  }}
                  aria-label={`Remove ${tag.label}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      </SheetContent>
    </Sheet>

    <NewDealDialog
      open={dealDialogOpen}
      onOpenChange={setDealDialogOpen}
      initialValues={dealPrefill}
      onCreated={handleDealCreated}
    />

    <DealDetailDrawer
      deal={dealDrawerDeal}
      onOpenChange={(open) => { if (!open) setDealDrawerId(null); }}
      onStageChange={handleDealStageChange}
      onMarkLost={handleDealMarkLost}
      onDealUpdate={handleDealUpdate}
      onDelete={handleDealDelete}
      stages={pipelineStages}
      teamMembers={teamMembers.map((m) => ({ id: m.id, name: m.name }))}
    />
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
  icon: ChannelIcon;
  label: string;
}) {
  const isActive = current === id;
  const iconClass =
    id === "whatsapp"
      ? "text-[#25D366]"
      : id === "messenger"
        ? "text-[#0084FF]"
        : id === "instagram"
          ? "text-[#E4405F]"
          : "";

  return (
    <button
      onClick={() => onSelect(id)}
      className={`conversation-compose-tab flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12px] font-medium transition-colors ${
        isActive
          ? id === "note"
            ? "border border-amber-200 bg-amber-50 text-amber-700"
            : "border border-[#E8D4AA] bg-[#FAF3E4] text-[#9A6821]"
          : "border border-transparent text-[#667085] hover:bg-[#F8FAFC]"
      }`}
    >
      <Icon className={`h-3.5 w-3.5 ${iconClass}`} /> {label}
    </button>
  );
}

function ContextSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-border p-5">
      <div className="mb-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

function conversationTagBadgeClasses(dotColor: string) {
  const styles: Record<string, string> = {
    "bg-amber-400":
      "border-amber-400 bg-amber-50 text-amber-800 dark:border-amber-500 dark:bg-amber-950/50 dark:text-amber-300",
    "bg-emerald-400":
      "border-emerald-400 bg-emerald-50 text-emerald-800 dark:border-emerald-500 dark:bg-emerald-950/50 dark:text-emerald-300",
    "bg-rose-400":
      "border-rose-400 bg-rose-50 text-rose-800 dark:border-rose-500 dark:bg-rose-950/50 dark:text-rose-300",
    "bg-sky-400":
      "border-sky-400 bg-sky-50 text-sky-800 dark:border-sky-500 dark:bg-sky-950/50 dark:text-sky-300",
    "bg-violet-400":
      "border-violet-400 bg-violet-50 text-violet-800 dark:border-violet-500 dark:bg-violet-950/50 dark:text-violet-300",
    "bg-orange-400":
      "border-orange-400 bg-orange-50 text-orange-800 dark:border-orange-500 dark:bg-orange-950/50 dark:text-orange-300",
    "bg-fuchsia-400":
      "border-fuchsia-400 bg-fuchsia-50 text-fuchsia-800 dark:border-fuchsia-500 dark:bg-fuchsia-950/50 dark:text-fuchsia-300",
    "bg-cyan-400":
      "border-cyan-400 bg-cyan-50 text-cyan-800 dark:border-cyan-500 dark:bg-cyan-950/50 dark:text-cyan-300",
    "bg-lime-400":
      "border-lime-400 bg-lime-50 text-lime-800 dark:border-lime-500 dark:bg-lime-950/50 dark:text-lime-300",
    "bg-blue-400":
      "border-blue-400 bg-blue-50 text-blue-800 dark:border-blue-500 dark:bg-blue-950/50 dark:text-blue-300",
    "bg-indigo-400":
      "border-indigo-400 bg-indigo-50 text-indigo-800 dark:border-indigo-500 dark:bg-indigo-950/50 dark:text-indigo-300",
    "bg-slate-400":
      "border-slate-400 bg-slate-50 text-slate-800 dark:border-slate-500 dark:bg-slate-900/60 dark:text-slate-300",
  };

  return styles[dotColor] ?? styles["bg-slate-400"];
}

function ConversationRow({
  conv,
  active,
  starred,
  contactTags,
  tagDefinitions,
  onClick,
}: {
  conv: Conversation;
  active: boolean;
  starred: boolean;
  contactTags: string[];
  tagDefinitions: { label: string; color: string }[];
  onClick: () => void;
}) {
  const badges = [
    ...(hasMention(conv.id)
      ? [{
          key: "mentioned",
          label: "Mentioned",
          className:
            "border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300",
        }]
      : []),
    ...(isUnassigned(conv.id)
      ? [{
          key: "unassigned",
          label: "Unassigned",
          className:
            "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300",
        }]
      : []),
    ...(conv.unread
      ? [{
          key: "needs-reply",
          label: "Needs reply",
          className:
            "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300",
        }]
      : []),
    ...contactTags.slice(0, 3).map((tag) => {
      const definition = tagDefinitions.find(
        (item) => item.label.toLowerCase() === tag.toLowerCase(),
      );

      return {
        key: `tag-${tag}`,
        label: tag,
        className: conversationTagBadgeClasses(definition?.color ?? "bg-slate-400"),
      };
    }),
  ].slice(0, 3);

  return (
    <button
      onClick={onClick}
      className={`flex w-full items-start gap-3 border-b border-border px-3.5 py-3.5 text-left transition-colors ${
        active ? "bg-gold-soft" : "hover:bg-secondary/40"
      }`}
    >
      <div className="relative shrink-0">
        <ContactAvatar id={conv.contactId} name={conv.contactName} size="sm" className="h-10 w-10" />
        <span className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full border-2 border-background bg-card">
          <ChannelGlyph channel={conv.channel} />
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span
            className={`truncate text-sm ${
              conv.unread
                ? "font-semibold text-foreground"
                : "font-medium text-foreground/90"
            } ${active ? "text-gold-soft-foreground" : ""}`}
          >
            {conv.contactName}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {relativeShort(conv.lastAt)}
          </span>
        </div>

        <div className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-muted-foreground">
          {conv.preview}
        </div>

        {(starred || badges.length > 0) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {starred && (
              <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" />
            )}

            {badges.map((badge) => (
              <Badge
                key={badge.key}
                variant="outline"
                className={`h-4.5 px-1.5 text-[9px] ${badge.className}`}
              >
                {badge.label}
              </Badge>
            ))}
          </div>
        )}
      </div>

      {active && !conv.unread && (
        <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-gold" />
      )}
      {conv.unread && (
        <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-info" />
      )}
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
      <div className={`flex max-w-[72%] flex-col gap-1 sm:max-w-md lg:max-w-lg ${isOut ? "items-end" : "items-start"}`}>
        <div
          className={`conversation-message-bubble rounded-2xl border px-4 py-3 text-sm leading-relaxed ${
            msg.isScheduled
              ? "rounded-br-md border-dashed border-[#E3C98F] bg-[#FAF3E4] text-[#273142]"
              : isOut
                ? "rounded-br-md border-[#F0E0C1] bg-[#FAF3E4] text-[#273142]"
                : "rounded-bl-md border-[#E5E7EB] bg-[#F3F4F6] text-[#273142]"
          }`}
        >
          {msg.body}
        </div>
        <div className={`conversation-message-meta flex items-center gap-1.5 px-1 text-[10px] ${isOut ? "text-[#9A7B45]" : "text-[#8A94A6]"}`}>
          <ChannelGlyph channel={msg.channel} />
          <span>{fmtTime(msg.at)}</span>
          {msg.isScheduled ? (
            <>
              <span>·</span>
              <Clock className="h-3 w-3 text-gold" />
              <span className="text-gold-soft-foreground">Scheduled</span>
            </>
          ) : isOut ? (
            <>
              <span>·</span>
              <CheckCheck className="h-3 w-3 text-gold" />
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
  open,
  contacts,
  onClose,
  onSelect,
}: {
  open: boolean;
  contacts: Array<{
    id: string;
    name: string;
    email: string;
    phone: string;
    tags?: string[];
  }>;
  onClose: () => void;
  onSelect: (c: { id: string; name: string }) => void;
}) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const filteredContacts = useMemo(() => {
    const q = query.trim().toLowerCase();

    return contacts
      .filter((contact) => {
        if (!q) return true;

        return (
          contact.name.toLowerCase().includes(q) ||
          contact.email.toLowerCase().includes(q) ||
          contact.phone.toLowerCase().includes(q) ||
          (contact.tags ?? []).some((tag) => tag.toLowerCase().includes(q))
        );
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 150);
  }, [contacts, query]);

  return (
    <Sheet open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-md">
        <SheetHeader className="border-b border-border pb-4">
          <SheetTitle>New Conversation</SheetTitle>
          <SheetDescription>
            Choose a contact to start a conversation with.
          </SheetDescription>
        </SheetHeader>

        <div className="relative mt-4">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, email, phone, or tag…"
            className="h-10 pl-9 text-sm"
          />
        </div>

        <div className="mt-4 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
          {contacts.length === 0 && (
            <div className="rounded-xl border border-dashed border-border p-8 text-center">
              <p className="text-sm font-medium text-foreground">No contacts available</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Add a contact first, then return here to start a conversation.
              </p>
            </div>
          )}

          {contacts.length > 0 && filteredContacts.length === 0 && (
            <div className="rounded-xl border border-dashed border-border p-8 text-center">
              <p className="text-sm font-medium text-foreground">No contacts found</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Try searching by name, email, phone number, or tag.
              </p>
            </div>
          )}

          {filteredContacts.map((contact) => {
            const tags = contact.tags ?? [];

            return (
              <button
                key={contact.id}
                type="button"
                onClick={() => onSelect({ id: contact.id, name: contact.name })}
                className="group flex w-full items-start gap-3 rounded-xl border border-transparent px-3 py-3 text-left transition-colors hover:border-[#E8D4AA] hover:bg-[#FAF3E4]/60"
              >
                <ContactAvatar
                  id={contact.id}
                  name={contact.name}
                  size="md"
                  className="h-10 w-10 shrink-0"
                />

                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="truncate text-sm font-semibold text-foreground">
                      {contact.name}
                    </div>

                    {tags[0] && (
                      <Badge
                        variant="outline"
                        className="h-5 shrink-0 border-[#E8D4AA] bg-[#FAF3E4] px-1.5 text-[9px] font-medium text-[#9A6821]"
                      >
                        {tags[0]}
                      </Badge>
                    )}
                  </div>

                  <div className="mt-1 space-y-0.5">
                    {contact.email && (
                      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Mail className="h-3 w-3 shrink-0" />
                        <span className="truncate">{contact.email}</span>
                      </div>
                    )}

                    {contact.phone && (
                      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Phone className="h-3 w-3 shrink-0" />
                        <span className="truncate">{contact.phone}</span>
                      </div>
                    )}

                    {!contact.email && !contact.phone && (
                      <div className="text-[11px] text-muted-foreground">
                        No contact information
                      </div>
                    )}
                  </div>

                  {tags.length > 1 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {tags.slice(1, 4).map((tag) => (
                        <Badge
                          key={tag}
                          variant="outline"
                          className="h-5 px-1.5 text-[9px] text-muted-foreground"
                        >
                          {tag}
                        </Badge>
                      ))}
                      {tags.length > 4 && (
                        <span className="self-center text-[10px] text-muted-foreground">
                          +{tags.length - 4}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ChannelGlyph({ channel }: { channel: LocalMessage["channel"] }) {
  if (channel === "email") return <Mail className="h-3 w-3 text-[#667085]" />;
  if (channel === "sms" || channel === "note") return <MessageSquare className="h-3 w-3 text-[#667085]" />;
  if (channel === "whatsapp") return <FaWhatsapp className="h-3 w-3 text-[#25D366]" />;
  if (channel === "messenger") return <FaFacebookMessenger className="h-3 w-3 text-[#0084FF]" />;
  if (channel === "instagram") return <FaInstagram className="h-3 w-3 text-[#E4405F]" />;
  return <Phone className="h-3 w-3 text-[#667085]" />;
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