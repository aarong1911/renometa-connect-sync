// src/routes/inbox.tsx
import { createFileRoute, Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  CalendarPlus,
  Tag,
  Clock,
  ExternalLink,
  Phone as PhoneIcon,
  PhoneCall,
  CheckCircle2,
  Circle,
  Pin,
  Archive,
  Copy,
  Calendar,
  Plus,
  Loader2,
  Trash2,
  RefreshCw,
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
import { updateContact, useContacts, useContactsLoading } from "@/lib/contacts-store";
import { useContactActivity } from "@/lib/contact-activity";
import { NewDealDialog } from "@/components/sales/new-deal-dialog";
import { AppointmentDialog } from "@/components/calendar/appointment-dialog";
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
import { analyzeSmsLength } from "@/lib/sms-segments";
import { conversationMapKey, resolveConversationIdentity, useConversationArchiveStates, useConversationStarStates } from "@/lib/conversation-states";
import { normalizeEmail, useGmailConversations } from "@/lib/gmail-conversations";
import { getOrgId } from "@/lib/org-id";
import { UnmatchedGmailSenderBanner } from "@/components/inbox/unmatched-gmail-sender-banner";
import { GmailSenderAvatar } from "@/components/inbox/gmail-sender-avatar";
import { unlinkGmailContactFromThread } from "@/lib/gmail-contact-actions";
import { extractReplyAddress, resolveComposerRecipient } from "@/lib/composer-recipient";
import { triggerGmailSync, fetchGmailConnectionStatus } from "@/lib/gmail-sync-client";
import { tagDisplayLabel, tagComparisonKey, isManuallyAssignableTag } from "@/lib/tag-utils";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ChannelIcon = ComponentType<{ className?: string }>;

type InboxSearch = { templateId?: string; contactId?: string };

export const Route = createFileRoute("/inbox")({
  validateSearch: (raw: Record<string, unknown>): InboxSearch => ({
    templateId: typeof raw.templateId === "string" && raw.templateId ? raw.templateId : undefined,
    contactId: typeof raw.contactId === "string" && raw.contactId ? raw.contactId : undefined,
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

type FolderId = "all" | "unread" | "assigned" | "starred" | "unassigned" | "archived";
type ChannelFilter = "all" | "email" | "sms" | "voice" | "whatsapp" | "messenger" | "instagram";
type ComposeChannel = "email" | "sms" | "note" | "whatsapp" | "messenger" | "instagram";

// Extends Message with note channel + optimistic send metadata
type LocalMessage = Omit<Message, "channel"> & {
  channel: "email" | "sms" | "voice" | "note" | "whatsapp" | "messenger" | "instagram";
  isScheduled?: boolean;
  scheduledFor?: string;
  // Email-only optimistic-echo reconciliation metadata (see the "GMAIL
  // RECONCILIATION" block below) — subject/toEmail are captured at send
  // time so a later real gmail_messages row can be matched against them;
  // pendingGmailSync marks this as a successful send still awaiting sync,
  // as opposed to a failed-send echo (which is never reconciled/hidden).
  subject?: string;
  toEmail?: string;
  pendingGmailSync?: boolean;
  // Captured from send-inbox-message.ts's response (nodemailer's own RFC
  // Message-ID for this exact send) when available — lets reconciliation
  // match this echo against the real gmail_messages row by strong identity
  // instead of only the subject/timestamp/body heuristics below.
  rfcMessageId?: string;
};

const folders: { id: FolderId; label: string; icon: typeof InboxIcon }[] = [
  { id: "all", label: "Inbox", icon: InboxIcon },
  { id: "unread", label: "Unread", icon: Circle },
  { id: "assigned", label: "Assigned to me", icon: CheckCheck },
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
  const { templateId, contactId: deepLinkContactId } = Route.useSearch();
  const navigate = useNavigate({ from: "/inbox" });
  const contactsLoading = useContactsLoading();
  const [folder, setFolder] = useState<FolderId>("all");
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("all");
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  // Records which conversation id the user genuinely, explicitly navigated
  // to (a row click, a deep-link "Message" action, or picking a contact in
  // New Conversation) — as opposed to `active` silently landing on a
  // conversation via the passive fallback chain below (e.g. on first load,
  // or historically when a filter change reshuffled the fallback pick).
  // The auto-mark-read effect checks this before ever calling markRead, so
  // a conversation can only be auto-read as a direct result of the user
  // opening it — never as a side effect of a filter change, a query
  // refetch/reorder, or another conversation leaving the current filter.
  // Always set together with setActiveId via selectConversation() below —
  // never call setActiveId directly for a genuine navigation action.
  const explicitSelectionRef = useRef<string | null>(null);
  const selectConversation = useCallback((id: string) => {
    explicitSelectionRef.current = id;
    setActiveId(id);
  }, []);
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
    // Same canonical Contact tag catalog Contacts uses (CANONICAL_CONTACT_TAGS
    // in tag-utils.ts) — previously this was its own hardcoded, diverged
    // list that invented "Estimate Sent"/"Hot" (not real Contact tags
    // anywhere) while omitting real ones (Architect/Client/Homeowner/Lead/
    // Past Client/Prospect/Vendor) from the "Assign tags" picker entirely.
    // Only the color-per-label assignment is Inbox-specific; the label set
    // itself must match Contacts exactly.
    const defaults = [
      { label: "VIP", color: "bg-amber-400" },
      { label: "New Lead", color: "bg-emerald-400" },
      { label: "Needs Reply", color: "bg-rose-400" },
      { label: "Follow Up", color: "bg-cyan-400" },
      { label: "Lead", color: "bg-blue-400" },
      { label: "Client", color: "bg-sky-400" },
      { label: "Homeowner", color: "bg-lime-400" },
      { label: "Past Client", color: "bg-fuchsia-400" },
      { label: "Prospect", color: "bg-indigo-400" },
      { label: "Vendor", color: "bg-orange-400" },
      { label: "Architect", color: "bg-violet-400" },
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
  const [appointmentDialogOpen, setAppointmentDialogOpen] = useState(false);
  // Real, persisted Star state — replaces the old local-only starredIds Set
  // OR'd with a hash(id)-based fake "isStarred" mock (see git history):
  // that mock made an arbitrary ~20% of conversations appear pre-starred to
  // every user, which is exactly the "fake counts displayed as production
  // CRM data" problem this audit was asked to remove. Same table/column
  // conversation_states.is_starred already used for Archive, just
  // previously unused for its own stated purpose.
  const { starredMap, setStarred } = useConversationStarStates();
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [aiDrafting, setAiDrafting] = useState(false);
  const [newConvOpen, setNewConvOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingTemplate, setPendingTemplate] = useState<SharedMessageTemplate | null>(null);
  // CRM-local soft delete confirmation — holds the real sms_meta_messages.id
  // (Message.dbId) of the message pending confirmation, not the prefixed
  // React-key `id`. null = dialog closed.
  const [deleteMessageId, setDeleteMessageId] = useState<string | null>(null);
  const [deletingMessage, setDeletingMessage] = useState(false);
  const handleConfirmDeleteMessage = async () => {
    if (!deleteMessageId) return;
    setDeletingMessage(true);
    try {
      await deleteMessage(deleteMessageId);
      toast.success("Message deleted from RenoMeta");
      setDeleteMessageId(null);
    } catch (error) {
      console.error("[inbox] delete message failed:", error);
      toast.error("Could not delete this message");
    } finally {
      setDeletingMessage(false);
    }
  };
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
  const { conversations: realConvs, messages: realMsgs, refresh: refreshRealConvs, markRead, markUnread, deleteMessage } = useSmsMetaConversations();
  // Real Gmail history — no mock fallback, same principle as realConvs above.
  const { conversations: gmailConvs, messages: gmailMsgs, refresh: refreshGmailConvs } = useGmailConversations();
  // Manual "Sync Gmail" action in the channel toolbar (Email tab only) —
  // reuses the same gmail-sync.ts call Settings → Integrations already
  // makes, via the shared src/lib/gmail-sync-client.ts helper.
  const [gmailSyncing, setGmailSyncing] = useState(false);
  // CRM relevance filter (Part 6 of the Conversations audit): by default,
  // only show Gmail threads that resolve to a real saved Contact (a real
  // UUID contactId — gmail-conversations.ts already returns a synthetic
  // `gmail-unknown-<address>`/`gmail-unknown-thread-<id>` id for anything
  // that doesn't match a contact by address or an explicit
  // conversation_states link). This is a client-side view filter, not a
  // fetch filter — gmailConvs itself is untouched so the existing "Create
  // Contact"/"Create Lead"/"Link to Existing Contact" flow on an unmatched
  // sender (UnmatchedGmailSenderBanner) stays fully reachable via this
  // toggle rather than being removed outright.
  const [showAllMail, setShowAllMail] = useState(false);
  const [gmailLastSyncAt, setGmailLastSyncAt] = useState<string | null>(null);
  useEffect(() => {
    if (channelFilter !== "email") return;
    fetchGmailConnectionStatus().then((status) => {
      if (status) setGmailLastSyncAt(status.lastSyncAt);
    });
  }, [channelFilter]);

  // Connected Gmail account's own address + Google profile photo (see
  // gmail-connection-status.ts) — used only to detect when a thread's
  // sender IS this org's own connected account, so GmailSenderAvatar can
  // show its real photo instead of a guessed domain logo. Fetched once on
  // mount (not gated to the Email tab like gmailLastSyncAt above) since
  // avatars render in the conversation list regardless of which channel
  // filter tab is currently selected.
  const [gmailAccountEmail, setGmailAccountEmail] = useState<string | null>(null);
  const [gmailAccountPictureUrl, setGmailAccountPictureUrl] = useState<string | null>(null);
  useEffect(() => {
    fetchGmailConnectionStatus().then((status) => {
      if (!status) return;
      setGmailAccountEmail(status.accountEmail);
      setGmailAccountPictureUrl(status.accountPictureUrl);
    });
  }, []);

  // Real configured SMTP sender (see smtp-config-status.ts) — replaces the
  // old hardcoded "Will reply from sales@yourco.com" composer footer text.
  // Never exposes the App Password itself, only email + configured status.
  const [smtpEmail, setSmtpEmail] = useState<string | null>(null);
  const [smtpConfigured, setSmtpConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      try {
        const res = await fetch("/.netlify/functions/smtp-config-status", {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (!res.ok) return;
        const json = await res.json().catch(() => ({}));
        setSmtpConfigured(!!json.configured);
        setSmtpEmail(typeof json.email === "string" ? json.email : null);
      } catch {
        // Best-effort — the composer footer just omits the line below.
      }
    })();
  }, []);

  const handleSyncGmailInInbox = async () => {
    setGmailSyncing(true);
    try {
      const result = await triggerGmailSync();
      if (!result.ok) {
        toast.error(result.error, {
          action: {
            label: "Open Settings",
            onClick: () => navigate({ to: "/settings/integrations" }),
          },
        });
        return;
      }
      toast.success(`Gmail synced: ${result.inserted} new, ${result.updated} updated`);
      refreshGmailConvs();
      fetchGmailConnectionStatus().then((status) => {
        if (status) setGmailLastSyncAt(status.lastSyncAt);
      });
    } finally {
      setGmailSyncing(false);
    }
  };
  // Real, persisted Archive state — replaces the old hash-based mock
  // isArchived() below. Org-wide, keyed by (contactId, channel).
  const { archivedMap, setArchived } = useConversationArchiveStates();
  const checkArchived = (c: Conversation) => {
    const key = conversationMapKey(c);
    return key ? !!archivedMap[key] : false;
  };
  // Contacts from the store — uses correct org via getOrgId() + memberships fallback
  const allStoreContacts = useContacts();
  const storeContactMap = useMemo(
    () => new Map(allStoreContacts.map((c) => [c.id, c])),
    [allStoreContacts]
  );

  // (S3 stabilization) The Conversation-header "Lead"/tag/Customer
  // classification chip was removed — see the header render below. The
  // useLeads()-derived "contact ids with an active Lead" set that fed it is
  // gone with it; a Contact's Lead relationship is shown on the Contacts
  // page (derived badge) and can be re-introduced to the Inbox right
  // sidebar in a later pass if a product requirement asks for it.

  // A Contact existing in the CRM does NOT mean a Conversation exists — the
  // Inbox previously spread ONE synthetic "sb-<contactId>" row per Contact
  // with no real SMS thread into allConversations below (removed), which is
  // the exact root cause of the "Contacts appearing as fake Inbox rows"
  // regression: every Contact with no message history at all showed up as
  // a permanent Inbox row (timestamped from `contact.createdAt` — a
  // Contact-record date, not any real communication — which is also why
  // rows showed ages like "44w" unrelated to any actual activity), and
  // opening one always landed on "No conversation history yet" because
  // there was, correctly, no real thread behind it. A Contact with no
  // communications remains reachable through the Contacts page and through
  // "New Conversation" (NewConversationSheet below, which reads
  // allStoreContacts directly and creates a real `local-conv-` entry only
  // when the user explicitly picks a contact to message) — it must not
  // appear passively in the Inbox list, sidebar counts, or channel tabs
  // until at least one real communication record exists for it.
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
 

  // CRM relevance filter — only SMS/WhatsApp/Messenger/Instagram/Voice are
  // exempt (those channels only ever produce a conversation via a real
  // contact/webhook already, per sms-meta-conversations.ts/
  // voice-conversations.ts). Gmail is the one source that otherwise
  // surfaces generic mailbox traffic (Google notices, marketing email,
  // newsletters) with no CRM identity at all — see showAllMail above.
  const crmRelevantGmailConvs = useMemo(
    () => (showAllMail ? gmailConvs : gmailConvs.filter((c) => UUID_RE.test(c.contactId))),
    [gmailConvs, showAllMail]
  );
  const allConversations = useMemo(
    () => [
      ...realConvs,
      ...crmRelevantGmailConvs,
      ...voiceConvs,
      ...localConversations,
    ],
    [realConvs, crmRelevantGmailConvs, voiceConvs, localConversations]
  );

  // Deep-link entry (from Contacts' "Message" action, ?contactId=…): prefer
  // a real, already-persisted thread (sm-/voice-/gm-) when one exists. If
  // this contact has no communication history at all, there is correctly no
  // conversation row to select — rather than leaving an empty pane, this
  // creates the SAME kind of local-conv- placeholder NewConversationSheet's
  // own onSelect creates below (not the old always-on `sb-` row removed
  // above), so the composer opens ready to send. Consumes ?contactId= once
  // (clears it via replace) so refreshing the resulting /inbox URL doesn't
  // re-trigger selection after the user has since picked something else; an
  // unknown/inaccessible contactId simply finds nothing and leaves the
  // existing empty state, no crash.
  useEffect(() => {
    if (!deepLinkContactId || contactsLoading) return;
    const tier = (id: string) => (id.startsWith("sm-") || id.startsWith("voice-") || id.startsWith("gm-") ? 0 : 1);
    const match = allConversations
      .filter((c) => c.contactId === deepLinkContactId)
      .sort((a, b) => tier(a.id) - tier(b.id) || new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime())[0];
    if (match) {
      selectConversation(match.id);
    } else {
      const contact = storeContactMap.get(deepLinkContactId);
      if (contact) {
        const newConv: Conversation = {
          id: `local-conv-${Date.now()}`,
          contactId: contact.id,
          contactName: contact.name,
          channel: "sms",
          preview: "New conversation",
          lastAt: new Date().toISOString(),
          unread: false,
        };
        setLocalConversations((prev) => [newConv, ...prev]);
        selectConversation(newConv.id);
        setComposeChannel("sms");
      }
    }
    navigate({ search: (s) => ({ ...s, contactId: undefined }), replace: true });
  }, [deepLinkContactId, contactsLoading, allConversations, storeContactMap, navigate]);
  const allMessages = useMemo(
    () => [...voiceMsgs, ...realMsgs, ...gmailMsgs],
    [voiceMsgs, realMsgs, gmailMsgs]
  );

  // Real "Assigned to me" / "Unassigned" — derived from the SAME
  // contacts.owner field Contacts/the contact panel already use ("Owned by
  // {owner}" above), not a separately maintained inbox-only concept.
  // contacts.owner is a plain display-name string (legacy design, not a
  // foreign key — see contacts-store.ts), so comparison is by trimmed,
  // case-insensitive name against the signed-in user's own display name,
  // consistent with how the rest of the app already treats this column.
  // Replaces the old hash(id)-based fake isAssignedToMe/isUnassigned mocks,
  // which classified conversations by a deterministic-but-meaningless
  // formula unrelated to any real assignment.
  const isUnassigned = (contactId: string) => {
    const owner = storeContactMap.get(contactId)?.owner;
    return !owner || owner === "—";
  };
  const isAssignedToMe = (contactId: string) => {
    const owner = storeContactMap.get(contactId)?.owner;
    return !!owner && owner !== "—" && !!currentUserName && owner.trim().toLowerCase() === currentUserName.trim().toLowerCase();
  };

  const checkStarred = (c: { id: string; contactId: string; channel: string }) => {
    const key = conversationMapKey(c);
    return key ? !!starredMap[key] : false;
  };
  const toggleStarred = async (c: { id: string; contactId: string; channel: string }) => {
    try {
      await setStarred(c, !checkStarred(c));
    } catch (error) {
      console.error("[inbox] star toggle failed:", error);
      toast.error("Could not update star");
    }
  };

  const conversations = useMemo(() => {
    return allConversations
      .filter((c) => {
        if (channelFilter !== "all" && c.channel !== channelFilter) return false;
        if (folder === "unread" && !c.unread) return false;
        if (folder === "starred" && !checkStarred(c)) return false;
        if (folder === "unassigned" && !isUnassigned(c.contactId)) return false;
        if (folder === "assigned" && !isAssignedToMe(c.contactId)) return false;
        if (folder === "archived" && !checkArchived(c)) return false;
        if (folder !== "archived" && checkArchived(c)) return false;

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
        // Real, persisted conversations (sm- = SMS/WhatsApp/Messenger/
        // Instagram, voice- = voice calls, gm- = Gmail threads) sort first;
        // a conversation just started via "New Conversation"
        // (local-conv-, no persisted history yet) sorts after — then by
        // recency (real communication timestamps only — see
        // sms-meta-conversations.ts/gmail-conversations.ts/
        // voice-conversations.ts) within each group.
        const tier = (id: string) => id.startsWith("sm-") || id.startsWith("voice-") || id.startsWith("gm-") ? 0 : 1;
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
    starredMap,
    allConversations,
    storeContactMap,
    currentUserName,
    contactTagOverrides,
    archivedMap,
  ]);

  const folderCounts = useMemo(() => {
    const list = allConversations;
    return {
      all: list.filter((c) => !checkArchived(c)).length,
      // Unread is deliberately a MESSAGE total (Phase 9/True Unread Message
      // Count follow-up), not a conversation count like every other folder
      // here — this must match the per-conversation row badge and the
      // sidebar Conversations badge exactly, or the three disagree (the
      // reported bug). c.unreadCount is the real per-message count from
      // sms-meta-conversations.ts; falls back to 1 for a conversation
      // source with no real count yet (none exist today — Gmail/Voice are
      // always unread:false, contributing 0 either way).
      unread: list.filter((c) => !checkArchived(c)).reduce((sum, c) => sum + (c.unreadCount ?? (c.unread ? 1 : 0)), 0),
      assigned: list.filter((c) => isAssignedToMe(c.contactId) && !checkArchived(c)).length,
      starred: list.filter((c) => checkStarred(c) && !checkArchived(c)).length,
      unassigned: list.filter((c) => isUnassigned(c.contactId) && !checkArchived(c)).length,
      archived: list.filter((c) => checkArchived(c)).length,
    } as Record<FolderId, number>;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allConversations, storeContactMap, currentUserName, starredMap, archivedMap]);

  // Look up the active conversation in allConversations (UNFILTERED) first,
  // not the folder/channel-filtered `conversations` list — this is what
  // keeps a conversation on screen after it stops matching the current
  // filter (e.g. it just got marked read while viewing the Unread folder),
  // instead of `active` silently reassigning itself to whatever conversation
  // happens to be first in the now-different filtered list.
  //
  // ROOT CAUSE of the "reading Messenger also auto-reads Instagram" cascade:
  // this used to search the FILTERED `conversations` array as its primary
  // lookup. Sequence: user clicks Messenger (Unread folder showing
  // Messenger+Instagram) -> markRead -> Query invalidates -> Messenger's
  // unreadCount hits 0 -> Messenger no longer passes the Unread folder
  // filter -> next render, `conversations` (filtered) no longer contains
  // it -> `conversations.find(id===activeId)` finds nothing even though
  // `activeId` (state) still literally equals Messenger's id -> falls
  // through to `conversations.find(!voice)`, which now resolves to
  // Instagram (the only item left in the filtered list) -> `active.id`
  // silently becomes Instagram's id, indistinguishable from the user having
  // clicked it -> the auto-read effect (keyed on active.id) treated this as
  // a fresh conversation to auto-mark-read. Fixed by making the PRIMARY
  // lookup search the unfiltered `allConversations` — a still-selected
  // conversation is always found there regardless of what the current
  // folder/channel filter shows, so `active.id` no longer changes just
  // because the filter's membership changed. The `conversations` (filtered)
  // fallback below now only ever runs when activeId is unset or points to
  // something that's gone from the app entirely (not just filtered out).
  const active = allConversations.find((c) => c.id === activeId)
    ?? conversations.find((c) => !c.id.startsWith("voice-"))
    ?? conversations[0];
  const thread: LocalMessage[] = active
    ? [
        ...(allMessages.filter((m) => m.conversationId === active.id) as LocalMessage[]),
        ...localMessages
          .filter((m) => m.conversationId === active.id)
          .filter((m) => !isLocalEmailReconciled(m, active, gmailConvs, gmailMsgs)),
      ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
    : [];

  // Whether the active thread's ALREADY-LOADED messages include at least
  // one inbound one — used to proactively disable "Mark as unread" (Part 4
  // of the unread-cascade fix) rather than let the user trigger a request
  // that the server will honestly report as a no-op. Uses the same
  // `thread` data already rendered on screen, so this can never disagree
  // with what the user is looking at; it's a UX nicety on top of, not a
  // replacement for, the server's own real check (an outbound-only thread
  // still safely no-ops server-side if this were ever stale).
  const activeHasInboundMessage = thread.some((m) => m.direction === "in");

  // Opening a conversation marks its unread inbound messages read — ONCE
  // per conversation identity, not every time active.unread flips true.
  //
  // ROOT CAUSE of "Mark as unread immediately reverts to 0": this effect's
  // dependency array included `active.unread` directly. That value is
  // `unreadCount > 0`, recomputed fresh after every server round-trip
  // (including the "Mark as unread" action's own refetch). Sequence that
  // reproduced the bug: open a 3-unread conversation -> effect fires,
  // marks read, active.unread flips true->false (effect reruns on that
  // change too, but its own `!active.unread` guard makes it a no-op) ->
  // user clicks "Mark as unread" -> server flips the latest inbound
  // message back to is_read=false -> refetch -> active.unread flips
  // false->true -> the DEPENDENCY ARRAY sees a changed value and reruns
  // the WHOLE effect body -> `!active.unread` is now false, so it proceeds
  // straight into ANOTHER markRead() call, immediately undoing the user's
  // explicit action. The effect could not tell "just became unread because
  // I navigated here" apart from "just became unread because the user
  // explicitly asked for that."
  //
  // Fixed with `autoReadHandledForId` — records the conversation identity
  // this effect has already acted on (read OR confirmed nothing to do).
  // Once set for a given active.id, this effect no longer does anything
  // for that id no matter how many more times active.unread toggles while
  // the user stays there — an explicit "Mark as unread"/"Mark as read"
  // from the menu is the only thing that can change is_read after that
  // point. The moment active.id itself changes (navigating to a different
  // conversation), the comparison naturally fails and this effect runs
  // fresh for the new identity — which is also the correct "clear
  // suppression on navigation" behavior with no separate reset needed.
  // Only sms_meta_messages-backed channels carry a real is_read signal;
  // other channels (voice, email, note) have nothing to mark here, but are
  // still recorded as "handled" so a channel change doesn't leave a stale
  // comparison.
  //
  // SECOND guard, on top of the allConversations-first `active` lookup
  // above: `explicitSelectionRef.current !== active.id` blocks this effect
  // unless the CURRENT active conversation is exactly the one the user
  // most recently, genuinely navigated to via selectConversation() (a row
  // click, a deep-link open, or New Conversation). Belt-and-suspenders with
  // the `active` derivation fix — that fix already stops `active.id` from
  // silently changing when a conversation drops out of the current filter,
  // but this guard also independently blocks the initial passive-fallback
  // pick on first load (activeId never set, explicitSelectionRef.current is
  // still null) from being treated as a user-initiated open. A folder/
  // channel filter change, a query refetch/reorder, or a conversation
  // disappearing from the current filter can never satisfy this check on
  // their own — only an actual call to selectConversation() sets the ref.
  const explicitReadEligible = !!active && explicitSelectionRef.current === active.id;
  const autoReadHandledForId = useRef<string | null>(null);
  useEffect(() => {
    if (!active) return;
    if (!explicitReadEligible) return;
    if (autoReadHandledForId.current === active.id) return;

    const channel = active.channel;
    if (channel !== "sms" && channel !== "whatsapp" && channel !== "messenger" && channel !== "instagram") {
      autoReadHandledForId.current = active.id;
      return;
    }
    if (!active.unread) {
      autoReadHandledForId.current = active.id;
      return;
    }

    // Mark BEFORE the async call resolves — a re-render while this await
    // is in flight (e.g. a realtime refetch) must not re-enter and fire a
    // second concurrent markRead for the same conversation.
    autoReadHandledForId.current = active.id;
    markRead(active.contactId, channel).catch((error) => {
      console.error("[inbox] auto markRead failed:", error);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.unread]);
  const resolvedStoreContact = active ? (storeContactMap.get(active.contactId) ?? null) : null;
  const contact = active
    ? (resolvedStoreContact
        ? { name: resolvedStoreContact.name, email: resolvedStoreContact.email, phone: resolvedStoreContact.phone, tags: resolvedStoreContact.tags, owner: resolvedStoreContact.owner, messenger_psid: resolvedStoreContact.messenger_psid, instagram_igsid: resolvedStoreContact.instagram_igsid, avatar_url: resolvedStoreContact.avatar_url, avatar_key: resolvedStoreContact.avatar_key }
        : mockContacts.find((c) => c.id === active.contactId)
          ?? { name: active.contactName, email: "", phone: active.callerPhone ?? "", tags: [], owner: "", messenger_psid: undefined, instagram_igsid: undefined, avatar_url: undefined, avatar_key: undefined })
    : undefined;
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
      "bg-blue-400": "border-blue-400",
      "bg-indigo-400": "border-indigo-400",
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

  // Subject derivation for the newly-displayed conversation. Keyed on
  // active?.id (the conversation actually being shown — see below), not the
  // raw activeId state, and only email needs it — nothing here depends on
  // contact hydration, so it can run immediately.
  useEffect(() => {
    if (!active || active.channel !== "email") return;
    if (active.id.startsWith("gm-") && active.emailSubject) {
      const already = /^re:/i.test(active.emailSubject.trim());
      setSubject(already ? active.emailSubject : `Re: ${active.emailSubject}`);
    } else {
      // A brand-new email conversation (not an existing Gmail thread) —
      // its own subject behavior is simply to start blank, never a
      // leftover reply subject from whatever thread was open before.
      setSubject("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  // ── Default compose channel — ONE centralized effect, not two ──────────
  //
  // Fixes two distinct, previously-conflated bugs:
  //
  // BUG 1 (auto-selection never initializes composeChannel): `active` above
  // is a FALLBACK chain — `conversations.find(id===activeId) ?? first
  // non-voice ?? conversations[0]` — so the conversation actually on screen
  // can differ from the `activeId` STATE whenever activeId is still
  // undefined (first paint) or no longer present in the current filtered
  // `conversations` list (e.g. the top channel filter just changed away
  // from wherever the previously-active conversation lived). In both
  // cases `active` (the rendered object) changes but the `activeId` STRING
  // does not, so an effect keyed on raw `activeId` never re-fires — this is
  // exactly why clicking the Messenger/Instagram top filter and having a
  // thread auto-selected left the composer on "sms" (its untouched initial
  // value) while a MANUAL row click (which does call setActiveId with a
  // real id) worked. Fixed by keying on `active?.id` — the identity that's
  // actually displayed — instead of the `activeId` state variable.
  //
  // BUG 2 (stale-state race between two effects): the previous code split
  // this into two effects — one that unconditionally set composeChannel to
  // the conversation's own channel, and a second "guard" that downgraded to
  // SMS if the required Messenger/Instagram identity was missing. Both were
  // keyed so they could fire in the SAME commit (e.g. on every activeId
  // change), and the guard effect's condition read `composeChannel` from
  // ITS OWN render closure — the value from BEFORE the first effect's
  // setComposeChannel call had been applied. Switching from an active
  // Messenger conversation directly to an Instagram one reproduced this
  // exactly: the guard fired with the STALE composeChannel === "messenger"
  // (leftover from before this render) against the NEW (Instagram) contact,
  // which genuinely has no messenger_psid — satisfying the guard's downgrade
  // condition and overwriting the first effect's correct "instagram" value
  // with "sms" inside the same batch. Fixed by using exactly one effect
  // that computes the target channel purely from `active.channel` plus the
  // CURRENT render's `contact` fields — it never reads `composeChannel`
  // itself to decide, so there is nothing for it to race against.
  //
  // Manual-override preservation: `initializedForConvId` records the last
  // conversation identity this effect actually made a decision for. Once
  // set, later re-renders for the SAME conversation (e.g. contact data
  // refreshing in the background) skip straight past — so a manual compose
  // tab click is never stomped while staying on one conversation. It is
  // intentionally NOT set while still waiting on contactsLoading, so the
  // effect re-fires and actually decides once loading completes, instead of
  // permanently locking in a premature "sms" downgrade (the historical
  // Messenger/WhatsApp bug this whole redesign traces back to).
  const initializedForConvId = useRef<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const channel = active.channel;
    if (channel !== "email" && channel !== "sms" && channel !== "whatsapp" && channel !== "messenger" && channel !== "instagram") {
      // Voice/note: nothing to initialize — leave composeChannel exactly as
      // it already was, and don't mark this id "handled" so a real
      // text-capable selection later still gets evaluated fresh.
      return;
    }

    // Messenger/Instagram need the real Contact record to know whether the
    // platform identity actually exists — wait rather than guess. Do NOT
    // mark initializedForConvId yet, so this effect re-fires (contactsLoading
    // is a dependency below) the instant loading completes for this same
    // conversation.
    if ((channel === "messenger" || channel === "instagram") && contactsLoading) return;

    if (initializedForConvId.current === active.id) return;
    initializedForConvId.current = active.id;

    const hasRequiredIdentity =
      channel === "messenger" ? !!contact?.messenger_psid :
      channel === "instagram" ? !!contact?.instagram_igsid :
      true; // email/sms/whatsapp never gate on a Meta platform identity

    // Temporary, safe diagnostic (dev builds only) — booleans/ids only,
    // never the actual psid/igsid value, never message content, never a
    // token. If Instagram still lands on "sms" after this fix, this line
    // tells you whether it's this effect misfiring again vs. the resolved
    // Contact genuinely lacking instagram_igsid (a data/backend question,
    // not a frontend one) — see the audit report for the SQL to check that.
    if (import.meta.env.DEV && (channel === "messenger" || channel === "instagram")) {
      console.debug("[inbox] compose-channel default:", {
        channel,
        contactFound: !!contact,
        contactId: active.contactId,
        hasRequiredIdentity,
        resolvedTo: hasRequiredIdentity ? channel : "sms",
      });
    }

    setComposeChannel(hasRequiredIdentity ? channel : "sms");
  }, [active?.id, active?.channel, contactsLoading, contact?.messenger_psid, contact?.instagram_igsid]);

  // Real activity timeline for the selected contact
  const { items: contactActivity } = useContactActivity(active?.contactId ?? null);

  // Real projects + lifetime value from Supabase for sidebar
  const [sbProjects, setSbProjects] = useState<{ id: string; name: string; status: string; budget_total: number; completion_percentage: number; address: string | null; start_date: string | null; updated_at: string | null }[]>([]);
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
      const orgId = await getOrgId();
      if (!orgId || cancelled) return;

      const { data: projs } = await supabase
        .from("projects")
        .select("id, name, status, budget_total, completion_percentage, address, start_date, updated_at")
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

  // Deterministic "which real project represents this contact for template
  // merge purposes" rule: an active/open project (anything not completed or
  // cancelled — the real `projects.status` values are cancelled, completed,
  // planning, pre-construction) wins first; among ties, the most recently
  // updated wins; if none are active, fall back to the first project
  // returned (already newest-created-first from the query order). No
  // mock-data fallback — a contact with no real projects simply gets the
  // generic placeholder copy below.
  const mergedProject = useMemo(() => {
    if (sbProjects.length === 0) return null;
    const isActive = (p: (typeof sbProjects)[number]) => p.status !== "completed" && p.status !== "cancelled";
    const active = sbProjects.filter(isActive);
    if (active.length > 0) {
      return [...active].sort((a, b) => {
        const at = a.updated_at ? new Date(a.updated_at).getTime() : 0;
        const bt = b.updated_at ? new Date(b.updated_at).getTime() : 0;
        return bt - at;
      })[0];
    }
    return sbProjects[0];
  }, [sbProjects]);

  const mergeCtx: MergeContext = useMemo(() => {
    const [first_name = "", ...rest] = (contact?.name ?? "").split(" ");
    const last_name = rest.join(" ");
    const total = mergedProject?.budget_total ?? 0;
    const fmtMoney = (n: number) =>
      new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
    return {
      first_name,
      last_name,
      project_address: mergedProject?.address || "your project address",
      // The real projects table has no `type` column — this is a static
      // default, not sourced from any (mock or real) project data.
      project_type: "renovation",
      owner_name: currentUserName || "Your Name",
      company_name: org.companyName || "Your Company",
      estimate_total: total ? fmtMoney(total) : "$—",
      deposit_amount: total ? fmtMoney(Math.round(total * 0.5)) : "$—",
      deposit_due: "Friday",
      start_date: mergedProject?.start_date
        ? new Date(mergedProject.start_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })
        : "next Monday",
    };
  }, [contact, mergedProject, currentUserName, org.companyName]);

  // Real GSM-7/UCS-2 char + segment count for the SMS composer (Phase 7 Part 6).
  const smsInfo = useMemo(() => analyzeSmsLength(draft), [draft]);

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

    const recipientResult = resolveComposerRecipient({
      composeChannel,
      activeConversation: active,
      selectedContact: contact,
    });
    if (!recipientResult.ok) {
      toast.error(recipientResult.error);
      return;
    }
    const to = recipientResult.to;

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
          // Gmail's own thread id (not an RFC Message-ID) — only meaningful
          // when replying inside an existing Gmail-backed email
          // conversation, so send-inbox-message.ts can look up that
          // thread's real threading headers itself. Read from
          // active.emailThreadId — NOT sliced from active.id — because a
          // CRM-matched conversation's id is now `gm-contact-<contactId>`
          // (Conversations Consolidation, gmail-conversations.ts merges
          // every thread for one Contact into one row), so the real thread
          // to reply into is carried explicitly on the Conversation object
          // (always the most recently active of that Contact's threads),
          // not recoverable by slicing the id. Omitted for a brand-new
          // email conversation with no Gmail thread yet.
          email_thread_id: composeChannel === "email" ? active.emailThreadId : undefined,
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
        if (composeChannel !== "email") {
          refreshRealConvs();
        } else {
          // Email has no equivalent "refresh and see the real row" path —
          // it's sent via SMTP (send-inbox-message.ts), not the Gmail API,
          // so there's no way to know when (or whether) it lands in
          // gmail_messages. Show it immediately as a local echo, flagged
          // pendingGmailSync so it can be reconciled away once/if a
          // matching real row shows up (see GMAIL RECONCILIATION below).
          setLocalMessages((prev) => [...prev, {
            id: `local-email-${Date.now()}`,
            conversationId: active.id,
            direction: "out",
            channel: "email",
            body: draftText,
            subject: subject || undefined,
            toEmail: to,
            at: new Date().toISOString(),
            pendingGmailSync: true,
            rfcMessageId: typeof result.smtpMessageId === "string" ? result.smtpMessageId : undefined,
          }]);
        }
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
  // A Gmail sender with no matching saved contact — the UnmatchedGmailSenderBanner
  // surfaces this state with Create Contact / Create Lead / Link actions.
  const activeIsUnmatchedGmailSender = !!active && active.channel === "email" && !activeContactHasRealId;

  // (S3 stabilization) The Conversation header no longer renders a Contact
  // tag / "Customer" / derived-"Lead" classification chip — the right
  // sidebar's TAGS section is the single canonical place for that, and the
  // "Customer" fallback was never backed by real Contact data.

  // Composer button label: "Reply" for a real, already-persisted thread
  // (sm- = SMS/WhatsApp/Messenger/Instagram, gm- = Gmail, voice- = voice
  // calls), "Send" for a conversation that doesn't have a persisted message
  // yet (local-conv- = the New Conversation sheet's/deep-link's brand-new
  // placeholder). Deliberately keyed off the conversation id's identity,
  // not thread length — a placeholder with a locally-echoed failed-send/
  // note message is still a brand-new conversation, not an existing one.
  const activeIsExistingThread =
    !!active && (active.id.startsWith("sm-") || active.id.startsWith("gm-") || active.id.startsWith("voice-"));

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
                if (checkArchived(conversation)) return false;

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
          <div className="conversation-channel-tabs flex items-center justify-between gap-2 border-b border-border bg-background px-4 py-3">
            <div className="flex items-center gap-2 overflow-x-auto">
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
            {channelFilter === "email" && (
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowAllMail((v) => !v)}
                  title="By default, only email tied to a saved Contact is shown. Toggle to see all synced mail, including unmatched senders."
                  className={`h-8 shrink-0 rounded-md border px-2.5 text-[11px] font-medium transition-colors ${
                    showAllMail
                      ? "border-[#E8D4AA] bg-[#FAF3E4] text-[#9A6821]"
                      : "border-[#E5E7EB] bg-white text-[#667085] hover:bg-[#F8FAFC]"
                  }`}
                >
                  {showAllMail ? "Showing all mail" : "CRM contacts only"}
                </button>
                {gmailLastSyncAt && (
                  <span className="hidden text-[11px] text-muted-foreground sm:inline" title={new Date(gmailLastSyncAt).toLocaleString()}>
                    Last synced {relativeShort(gmailLastSyncAt)}
                  </span>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0 text-xs"
                  disabled={gmailSyncing}
                  onClick={handleSyncGmailInInbox}
                >
                  {gmailSyncing ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Sync Gmail
                </Button>
              </div>
            )}
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
                starred={checkStarred(c)}
                unassigned={isUnassigned(c.contactId)}
                contactTags={
                  allStoreContacts.find((contact) => contact.id === c.contactId)?.tags ?? []
                }
                tagDefinitions={managedTags}
                onClick={() => selectConversation(c.id)}
                gmailAccountEmail={gmailAccountEmail}
                gmailAccountPictureUrl={gmailAccountPictureUrl}
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
                  {active.channel === "email" ? (
                    <GmailSenderAvatar
                      senderName={active.contactName}
                      senderEmail={active.senderEmail ?? ""}
                      matchedContactId={active.contactId}
                      connectedAccountEmail={gmailAccountEmail}
                      connectedAccountPictureUrl={gmailAccountPictureUrl}
                      size="md"
                      className="h-10 w-10"
                    />
                  ) : (
                    <ContactAvatar id={active.contactId} name={active.contactName} avatarUrl={contact?.avatar_url} avatarKey={contact?.avatar_key} size="md" className="h-10 w-10" />
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-[15px] font-semibold">
                      <span className="truncate">{active.contactName}</span>
                      {/* S3 stabilization: no Contact tag / "Customer" /
                          derived-"Lead" classification chip in the header.
                          That was a duplicate of the right sidebar's TAGS
                          section (which is the canonical place), and the
                          "Customer" fallback wasn't backed by any real
                          Contact data. Name + channel identity + email/phone
                          + controls are all still here. */}
                    </div>
                    {active.channel === "email" ? (
                      <SenderEmailLine senderEmail={active.senderEmail} className="mt-0.5" />
                    ) : (
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Mail className="h-3 w-3" /> {contact.email}
                        </span>
                        <span>·</span>
                        <span className="flex items-center gap-1">
                          <Phone className="h-3 w-3" /> {contact.phone}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2"
                    title={checkStarred(active) ? "Unstar conversation" : "Star conversation"}
                    onClick={() => toggleStarred(active)}
                  >
                    <Star
                      className={`h-4 w-4 ${
                        checkStarred(active)
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
                  <Button variant="ghost" size="sm" className="h-8 px-2" title="Schedule appointment"
                    onClick={() => setAppointmentDialogOpen(true)}>
                    <CalendarPlus className="h-4 w-4" />
                  </Button>
                  <span className="mx-1 h-5 w-px bg-border" />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-8 px-2" title="More">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {/* Single dynamic action, never two simultaneous menu
                          items — label/action switch on the SAME real
                          unreadCount signal every other badge already uses
                          (never a separate locally-tracked read/unread
                          flag). Only sms_meta_messages-backed channels
                          (sms/whatsapp/messenger/instagram) have real
                          per-message unread state; email/voice/note keep
                          the old static "Mark as read" no-op — there is no
                          real unread concept to toggle there. */}
                      <DropdownMenuItem
                        onClick={async () => {
                          if (!active) return;
                          const channel = active.channel;
                          if (channel !== "sms" && channel !== "whatsapp" && channel !== "messenger" && channel !== "instagram") {
                            toast.success("Marked as read");
                            return;
                          }
                          const markingUnread = (active.unreadCount ?? 0) === 0;
                          try {
                            if (markingUnread) {
                              // Server truth, not an assumed success — the
                              // endpoint only marks the latest INBOUND
                              // message unread and returns updated: 0 as a
                              // safe no-op when there isn't one (never marks
                              // an outbound message unread). The menu item
                              // is already disabled ahead of time when the
                              // loaded thread has no inbound message (see
                              // activeHasInboundMessage below), so this
                              // branch is mainly a safety net for a thread
                              // that hasn't fully loaded yet.
                              const result = await markUnread(active.contactId, channel);
                              if (result.updated > 0) {
                                toast.success("Marked as unread");
                              } else {
                                toast("No inbound message to mark unread");
                              }
                            } else {
                              await markRead(active.contactId, channel);
                              toast.success("Marked as read");
                            }
                          } catch {
                            toast.error(markingUnread ? "Could not mark as unread" : "Could not mark as read");
                          }
                        }}
                        disabled={
                          !!active
                          && (active.channel === "sms" || active.channel === "whatsapp" || active.channel === "messenger" || active.channel === "instagram")
                          && (active.unreadCount ?? 0) === 0
                          && !activeHasInboundMessage
                        }
                      >
                        {active && (active.channel === "sms" || active.channel === "whatsapp" || active.channel === "messenger" || active.channel === "instagram") && (active.unreadCount ?? 0) === 0
                          ? "Mark as unread"
                          : "Mark as read"}
                      </DropdownMenuItem>
                      {activeContactHasRealId && (
                        <DropdownMenuItem
                          onClick={async () => {
                            if (!active || !currentUserName) return;
                            try {
                              await updateContact(active.contactId, { owner: currentUserName });
                              toast.success("Conversation assigned to you");
                            } catch (error) {
                              console.error("[inbox] assign to me failed:", error);
                              toast.error("Could not assign this conversation");
                            }
                          }}
                        >
                          Assign to me
                        </DropdownMenuItem>
                      )}
                      {activeContactHasRealId && (
                        <DropdownMenuItem onClick={() => setDealDialogOpen(true)}>Create Deal</DropdownMenuItem>
                      )}
                      {/* Only for a genuine single-thread email conversation
                          (gm-<thread_id>). A CRM-matched, consolidated
                          conversation (gm-contact-<contactId> — see
                          Conversations Consolidation in
                          gmail-conversations.ts) can represent SEVERAL
                          merged Gmail threads, each with its own
                          independent explicit-link state; "unlink" has no
                          single well-defined target there, so it's hidden
                          rather than operating on the wrong (or no) thread. */}
                      {active?.channel === "email" && activeContactHasRealId && !active.id.startsWith("gm-contact-") && (
                        <DropdownMenuItem
                          onClick={async () => {
                            if (!active) return;
                            try {
                              const result = await unlinkGmailContactFromThread({ id: active.id, channel: active.channel });
                              if (!result.ok) { toast.error(result.error); return; }
                              if (!result.hadLink) {
                                toast.info("This contact is matched by email, not an explicit link — nothing to unlink");
                                return;
                              }
                              toast.success("Contact unlinked");
                              refreshGmailConvs();
                            } catch {
                              toast.error("Could not unlink this contact");
                            }
                          }}
                        >
                          Unlink contact
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => toggleStarred(active)}>
                        {checkStarred(active) ? "Unstar conversation" : "Star conversation"}
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
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={async () => {
                          if (!active) return;
                          // Archiving needs a stable identity — a real
                          // saved contact for SMS/WhatsApp/Messenger/
                          // Instagram (and Gmail threads matched to one),
                          // or a gmail:<thread_id> external key for
                          // unmatched Gmail threads (see
                          // resolveConversationIdentity). We never
                          // auto-create a contact just to allow archiving.
                          const identity = resolveConversationIdentity(active);
                          if (!identity.contactId && !identity.externalKey) {
                            toast.error("This contact must be saved before archiving conversations");
                            return;
                          }
                          const nowArchived = checkArchived(active);
                          try {
                            await setArchived(active, !nowArchived);
                            toast.success(nowArchived ? "Conversation unarchived" : "Conversation archived");
                          } catch {
                            toast.error("Could not update archive state");
                          }
                        }}
                      >
                        {active && checkArchived(active) ? "Unarchive" : "Archive"}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              {activeIsUnmatchedGmailSender && active?.senderEmail && (
                <UnmatchedGmailSenderBanner
                  conversationId={active.id}
                  senderEmail={active.senderEmail}
                  senderName={active.contactName}
                  senderDisplayName={active.senderDisplayName}
                  snippet={thread[0]?.body}
                  onConverted={refreshGmailConvs}
                />
              )}

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
                        // onDelete intentionally omitted for now — the
                        // deleted_at migration is still unapplied and the
                        // server function's delete_message action is
                        // disabled (returns 503) until it's live. See
                        // conversation-message-state.ts. Re-enable by
                        // restoring `m.dbId ? () => setDeleteMessageId(m.dbId!) : undefined`
                        // once the migration is applied and confirmed.
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
                    {composeChannel === "sms" && (
                      <span className={smsInfo.isUnusuallyLong ? "text-warning" : ""}>
                        {smsInfo.length}/{smsInfo.singleSegmentLimit} chars · {smsInfo.segments || 1} segment{smsInfo.segments === 1 ? "" : "s"} ({smsInfo.encoding})
                        {smsInfo.isUnusuallyLong && " · unusually long message"}
                      </span>
                    )}
                    {composeChannel === "email" && (
                      smtpConfigured === true && smtpEmail
                        ? `Will reply from ${smtpEmail}`
                        : smtpConfigured === false
                          ? "Gmail sending isn't configured — add an App Password in Settings → Integrations"
                          : null
                    )}
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
                    <Button size="sm" className="conversation-send h-10 rounded-xl border border-blue-500 bg-white px-5 text-sm font-semibold text-slate-700 shadow-sm hover:border-blue-600 hover:bg-blue-50 hover:text-slate-800" onClick={handleSend}>
                      <Send className="mr-1.5 h-3.5 w-3.5" /> {activeIsExistingThread ? "Reply" : "Send"}
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
                  {active.channel === "email" ? (
                    <GmailSenderAvatar
                      senderName={contact.name}
                      senderEmail={active.senderEmail ?? ""}
                      matchedContactId={active.contactId}
                      connectedAccountEmail={gmailAccountEmail}
                      connectedAccountPictureUrl={gmailAccountPictureUrl}
                      size="lg"
                      className="h-12 w-12"
                    />
                  ) : (
                    <ContactAvatar id={active.contactId} name={contact.name} avatarUrl={contact.avatar_url} avatarKey={contact.avatar_key} size="lg" className="h-12 w-12" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-semibold">{contact.name}</div>
                    {active.channel === "email" ? (
                      <SenderEmailLine senderEmail={active.senderEmail} className="mt-1" />
                    ) : (
                      <div className="mt-1 truncate text-xs text-muted-foreground">{contact.email}</div>
                    )}
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
                        {tagDisplayLabel(tag)}
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
                      {/* S3 stabilization: hide derived-relationship tags
                          ("Lead"/"New Lead") from the manual assign picker —
                          Lead status is derived from real Lead records, not
                          a manually-assigned Contact tag. */}
                      {managedTags.filter((t) => isManuallyAssignableTag(tagComparisonKey(t.label))).map((tag) => {
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
          selectConversation(existing.id);
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
          selectConversation(newConv.id);
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
    <AlertDialog open={deleteMessageId !== null} onOpenChange={(o) => { if (!o && !deletingMessage) setDeleteMessageId(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this message?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the message from RenoMeta only. It will NOT be unsent, recalled, or deleted from Instagram, Messenger, WhatsApp, or the recipient's phone — the other party will still have it in their own conversation history.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deletingMessage}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={deletingMessage}
            onClick={(e) => { e.preventDefault(); handleConfirmDeleteMessage(); }}
          >
            {deletingMessage ? "Deleting…" : "Delete message"}
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
              <ContactAvatar id={active.contactId} name={contact.name} avatarUrl={contact.avatar_url} avatarKey={contact.avatar_key} size="lg" className="h-14 w-14" />
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
                        {tagDisplayLabel(tag)}
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
                    {managedTags.filter((t) => isManuallyAssignableTag(tagComparisonKey(t.label))).map((tag) => {
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

    {/* Phase 10.3 — real "Schedule appointment" action, distinct from the
        composer's "Schedule" button above (which schedules a message SEND,
        not a calendar appointment). Prefills the customer from the active
        conversation's matched Contact when one exists. */}
    <AppointmentDialog
      open={appointmentDialogOpen}
      onOpenChange={setAppointmentDialogOpen}
      prefill={active ? {
        // Best available CRM relation: the matched Contact when one truly
        // exists, otherwise the Contact's linked Account/Company when
        // known, otherwise left unlinked — there is no lead↔conversation
        // link in this codebase to fall back to honestly.
        entityType: activeContactHasRealId ? "contact" : contactCompanyId ? "company" : undefined,
        entityId: activeContactHasRealId ? active.contactId : contactCompanyId ?? undefined,
        contactName: active.contactName,
        contactEmail: contact?.email || active.senderEmail || undefined,
        contactPhone: contact?.phone || undefined,
        address: (contact as { address?: string } | undefined)?.address || undefined,
        source: "inbox",
        metadata: { conversationId: active.id },
      } : undefined}
      onSaved={() => toast.success("Appointment scheduled")}
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

// The real Gmail reply address for the active thread — deliberately fed
// from `senderEmail` (the conversation's own from-address, see
// gmail-conversations.ts/composer-recipient.ts), never `contact.email`,
// since a linked/matched CRM contact's email can legitimately differ from
// the actual thread it's linked to (see composer-recipient.ts's header
// comment). Renders nothing when there's no address to show — never a
// placeholder like "Unknown email".
function SenderEmailLine({ senderEmail, className }: { senderEmail: string | null | undefined; className?: string }) {
  const address = extractReplyAddress(senderEmail);
  if (!address) return null;
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(address);
        toast.success("Email address copied");
      }}
      title={address}
      className={`block max-w-full truncate text-left text-xs text-muted-foreground hover:text-foreground hover:underline ${className ?? ""}`}
    >
      {address}
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
  unassigned,
  contactTags,
  tagDefinitions,
  onClick,
  gmailAccountEmail,
  gmailAccountPictureUrl,
}: {
  conv: Conversation;
  active: boolean;
  starred: boolean;
  /** Real CRM state — the linked Contact has no `owner` set. See isUnassigned() in InboxPage. */
  unassigned: boolean;
  contactTags: string[];
  tagDefinitions: { label: string; color: string }[];
  onClick: () => void;
  gmailAccountEmail?: string | null;
  gmailAccountPictureUrl?: string | null;
}) {
  const badges = [
    // "Mentioned" was previously a hash(id)-based mock with no real @mention
    // data behind it anywhere in the schema — removed rather than kept as a
    // permanently-fake badge. A real @mentions feature would need a new
    // table/column; flagged in the audit report rather than built here.
    ...(unassigned
      ? [{
          key: "unassigned",
          label: "Unassigned",
          className:
            "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300",
        }]
      : []),
    // A derived "Needs reply" badge used to render here whenever
    // conv.unread was true — removed (Needs Reply count-consistency audit):
    // it read as the same thing as the real, canonical Contact tag "Needs
    // Reply" (assignable from Contacts/the tag picker, counted in the
    // sidebar Tags section), but was actually a completely different,
    // derived-from-unread-state signal with no relationship to that tag —
    // hence the sidebar showing "Needs Reply 0" while unread rows all
    // displayed a same-looking badge. The row already has an unambiguous,
    // real unread indicator (the numeric badge/dot below, sourced from the
    // same conv.unreadCount), so this was also pure duplication, not just a
    // naming collision. "Needs Reply" now refers to exactly one thing
    // everywhere in the app: the real Contact tag.
    ...contactTags.slice(0, 3).map((tag) => {
      const definition = tagDefinitions.find(
        (item) => item.label.toLowerCase() === tag.toLowerCase(),
      );

      return {
        key: `tag-${tag}`,
        // Raw stored value (e.g. "new_lead") formatted to a human-readable
        // label ("New Lead") via the SAME canonical formatter Contacts uses
        // (src/lib/tag-utils.ts) — one shared source, not a second inbox-
        // only formatter, so a tag reads identically on both pages.
        label: tagDisplayLabel(tag),
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
        {conv.channel === "email" ? (
          <GmailSenderAvatar
            senderName={conv.contactName}
            senderEmail={conv.senderEmail ?? ""}
            matchedContactId={conv.contactId}
            connectedAccountEmail={gmailAccountEmail}
            connectedAccountPictureUrl={gmailAccountPictureUrl}
            size="sm"
            className="h-10 w-10"
          />
        ) : (
          <ContactAvatar id={conv.contactId} name={conv.contactName} avatarUrl={conv.avatarUrl} avatarKey={conv.avatarKey} size="sm" className="h-10 w-10" />
        )}
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
        // True unread INBOUND message count (Phase 9), not a maintained
        // counter — sourced directly from sms_meta_messages.is_read via
        // sms-meta-conversations.ts. Numeric badge when the exact count is
        // known and > 0; falls back to the plain dot only for a
        // conversation source with no real per-message count yet
        // (conv.unreadCount undefined — none exist today, since Gmail/Voice
        // always report unread:false).
        typeof conv.unreadCount === "number" && conv.unreadCount > 0 ? (
          <span className="mt-1.5 flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full bg-info px-1 text-[10px] font-semibold leading-none text-white">
            {conv.unreadCount > 99 ? "99+" : conv.unreadCount}
          </span>
        ) : (
          <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-info" />
        )
      )}
    </button>
  );
}

function MessageBubble({ msg, onDelete }: { msg: LocalMessage; onDelete?: () => void }) {
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

  // Voice call — rendered as a real transcript-turn/summary text bubble
  // below (voice-conversations.ts already composes msg.body as real
  // transcript lines or the call summary; there is no per-call duration or
  // recording-availability field at the message level, so it is NOT given
  // a special-cased card here — doing so previously meant hardcoded
  // placeholder values ("4m 12s", a fixed "Recording available" time) with
  // no real data behind them. Voice recordings are played from Call Logs,
  // where real per-call duration/recording data is available.

  // SMS / Email (+ scheduled variant)
  return (
    <div className={`group flex ${isOut ? "justify-end" : "justify-start"}`}>
      <div className={`flex max-w-[72%] flex-col gap-1 sm:max-w-md lg:max-w-lg ${isOut ? "items-end" : "items-start"}`}>
        <div className={`flex items-start gap-1 ${isOut ? "flex-row-reverse" : ""}`}>
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
          {/* CRM-local delete only — see the confirmation dialog's copy.
              Only offered for messages that carry a real database id
              (SMS/WhatsApp/Messenger/Instagram, via Message.dbId); email,
              voice, and notes have no delete support in this pass. */}
          {onDelete && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="mt-1 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-secondary group-hover:opacity-100"
                  aria-label="Message actions"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align={isOut ? "start" : "end"}>
                <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={onDelete}>
                  <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete message
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
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
    avatar_url?: string | null;
    avatar_key?: string | null;
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
                  avatarUrl={contact.avatar_url}
                  avatarKey={contact.avatar_key}
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
  // Finer-grained than pure day-rounding: the old `days <= 0 -> "now"`
  // check collapsed anything from earlier the same day into "now" (up to
  // ~24h), which made a batch of Gmail messages received at different
  // times throughout today look identical/wrong. Only genuinely-recent
  // (<1 minute, or slightly in the future due to clock skew) shows "now".
  const diffMs = NOW - new Date(iso).getTime();
  const diffMinutes = Math.round(diffMs / 60_000);
  if (diffMinutes < 1) return "now";
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const diffHours = Math.round(diffMs / 3_600_000);
  if (diffHours < 24) return `${diffHours}h`;
  const days = Math.round(diffMs / 86_400_000);
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

// ── GMAIL RECONCILIATION (Phase 7, Part 1) ──────────────────────────────────
// Isolated on purpose, so it can be deleted cleanly if/when a real
// gmail-sync path starts returning provider-side ids for our own sends.
//
// Email is sent via SMTP (netlify/functions/send-inbox-message.ts), not the
// Gmail API, so a successful send has no thread_id/message_id to correlate
// against the eventual gmail_messages row that (if/when Gmail sync picks it
// up) represents the same email. Until then, the just-sent email is shown
// from an optimistic local echo (LocalMessage.pendingGmailSync) so it's
// visible immediately. This function decides when that echo has been
// superseded by a real synced row, so it stops being shown — it never
// deletes the local echo/localStorage entry, only excludes it from the
// currently-rendered thread.
//
// Matching, most confident first:
//   1. RFC Message-ID — nodemailer's Message-ID for the send (captured from
//      send-inbox-message.ts's response) compared against the same header
//      Gmail sync parses off the synced copy (gmail-sync.ts). Sufficient on
//      its own when both sides have it; falls through to the heuristics
//      below for any email sent/synced before this field existed.
//   2. normalized recipient email — real gmail conversations are already
//      matched to a contact by email address (see gmail-conversations.ts),
//      so "same contactId as this local echo's conversation" IS the
//      normalized-email match when the contact resolved; when it didn't
//      resolve to a real contact, gmailConvs carries a synthetic
//      `gmail-unknown-{address}` id that's compared directly instead.
//   3. subject — case-insensitive containment against the real message body
//      (real bodies are "subject\n\nsnippet" or bare snippet/subject).
//   4. timestamp proximity — within 15 minutes of the local echo.
//   5. body/snippet overlap — last resort, a short prefix of the local
//      body appearing in the real message body.
// A real outbound message is treated as a match if it satisfies the email
// tier AND at least one of subject/timestamp/body — email address alone is
// too weak (a contact can easily receive more than one real email), but
// full agreement isn't required either since we're matching a short snippet
// against a real message body, not a full body against a full body.
function isLocalEmailReconciled(
  local: LocalMessage,
  activeConv: Conversation,
  gmailConvsList: Conversation[],
  gmailMsgsList: Message[],
): boolean {
  if (!local.pendingGmailSync) return false;

  // Tier 1 — strong identity: nodemailer's RFC Message-ID for this send
  // (captured at send time from send-inbox-message.ts's response) equals
  // the same header Gmail sync later parses off the synced copy of that
  // same sent message (see gmail-sync.ts). When present, this alone is
  // sufficient — no email-address/subject/timestamp corroboration needed,
  // since a Message-ID collision across two different emails is not a
  // realistic concern.
  if (local.rfcMessageId) {
    const strongMatch = gmailMsgsList.some((m) => m.rfcMessageId && m.rfcMessageId === local.rfcMessageId);
    if (strongMatch) return true;
  }

  const candidateConvIds = new Set(
    gmailConvsList
      .filter((c) => {
        if (c.contactId === activeConv.contactId) return true;
        const normTo = local.toEmail ? normalizeEmail(local.toEmail) : "";
        return normTo && c.contactId === `gmail-unknown-${normTo}`;
      })
      .map((c) => c.id),
  );
  if (candidateConvIds.size === 0) return false;

  const candidates = gmailMsgsList.filter(
    (m) => candidateConvIds.has(m.conversationId) && m.direction === "out",
  );
  if (candidates.length === 0) return false;

  const localTime = new Date(local.at).getTime();
  const localSubject = (local.subject ?? "").trim().toLowerCase();
  const localBodyPrefix = local.body.trim().slice(0, 40).toLowerCase();

  return candidates.some((m) => {
    const body = m.body.toLowerCase();
    const subjectMatches = localSubject.length > 0 && body.includes(localSubject);
    const timeMatches = Math.abs(new Date(m.at).getTime() - localTime) <= 15 * 60_000;
    const bodyMatches = localBodyPrefix.length > 0 && body.includes(localBodyPrefix);
    return subjectMatches || timeMatches || bodyMatches;
  });
}

// The old hash(id)-based fake isStarred/hasMention/isUnassigned/
// isAssignedToMe mocks (and isArchived before them) are gone — every
// conversation-list predicate is now backed by real, persisted data. See
// checkStarred/isUnassigned/isAssignedToMe in InboxPage and
// useConversationArchiveStates()/useConversationStarStates() in
// conversation-states.ts.