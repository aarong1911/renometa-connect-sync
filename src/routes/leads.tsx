// src/routes/leads.tsx
import { createFileRoute, useNavigate, useSearch, Link } from "@tanstack/react-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AddressAutocomplete } from "@/components/ui/address-autocomplete";
import { Badge } from "@/components/ui/badge";
import { ContactAvatar } from "@/components/ui/contact-avatar";
import { Card } from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectSeparator,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Plus, Search, Mail, Phone, MapPin, Target, Flame, Thermometer, Snowflake,
  ArrowRight, MoreHorizontal, DollarSign, Calendar, User, Building2,
  ExternalLink, SlidersHorizontal, FileText, Sparkles, Users, CheckCircle2 as CheckCircleIcon,
} from "lucide-react";
import { Download, Upload, Trash2, Pencil as PencilIcon, Loader2 } from "lucide-react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { StickyNote, Pencil, Check, X as XIcon } from "lucide-react";
import { type Lead, type LeadStatus, type LeadScore } from "@/lib/mock-data";
import { formatMoney, formatDateShort, formatPhone } from "@/lib/format";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { useTeam, type TeamMember } from "@/lib/organization";
import {
  useLeads, addLead as storeAddLead, updateLeadStatus as storeUpdateStatus,
  updateLeadsStatusBulk, updateLead as storeUpdateLead,
  updateLeadOwner as storeUpdateLeadOwner, updateLeadsOwnerBulk,
  deleteLead as storeDeleteLead, deleteLeadsBulk, addLeadsBatch,
} from "@/lib/leads-store";
import { useLeadNotes, addLeadNote } from "@/lib/leads-store";
import { updateLeadNote } from "@/lib/leads-store";
import { useEntityNotes } from "@/lib/contact-notes";
import { EntityTasksPanel } from "@/components/tasks/entity-tasks-panel";
import { EntityAppointmentsPanel } from "@/components/appointments/entity-appointments-panel";
import { ConvertLeadDialog } from "@/components/leads/convert-lead-dialog";
import { DealDetailDrawer } from "@/components/sales/deal-detail-drawer";
import {
  deleteDeal as storeDeleteDeal, updateDeal as storeUpdateDeal,
  useDeals, usePipelineStages,
} from "@/lib/deals-store";
import type { Deal, LostReason } from "@/lib/sales/types";
import {
  leadsToCSV, downloadCSV, parseCSVPreview, autoMapHeaders, applyMappingToLeads,
  LEAD_FIELDS, type ColumnMapping, type LeadFieldKey, type TemplateType,
} from "@/lib/leads-csv";
import { LEAD_STATUSES, LEAD_STATUS_LABELS, leadStatusLabel, leadStatusBadgeVariant } from "@/lib/lead-status";
import { leadSourceLabel, normalizeLeadSource, CANONICAL_LEAD_SOURCE_OPTIONS } from "@/lib/lead-source";
import { fetchGoogleAdsCampaignLeadIds, fetchGoogleAdsAdGroupLeadIds } from "@/lib/google-ads-client";
import { normalizeEmail, findDuplicateContactCandidates } from "@/lib/identity-normalization";
import { getOrgId as getContactsOrgId } from "@/lib/contacts-store";
import { CSV_MAX_SYNC_IMPORT_ROWS, CSV_WARN_ROW_THRESHOLD } from "@/lib/csv-utils";
import { createImportJob, logImportRows, completeImportJob, prefetchContactIdentitySets } from "@/lib/import-jobs-store";
import { ImportHistoryDialog } from "@/components/crm/import-history-dialog";
import { History } from "lucide-react";

// Google Ads Campaign -> CRM Leads Deep Link phase — `source` is always a
// CANONICAL machine value (e.g. "google_ads"), never a display label like
// "Google Ads" (Step 2). `campaignId`/`campaignName` carry campaign
// context only when arriving from the Campaign Detail Sheet's "View CRM
// Leads" button — campaignId is canonical/preferred, campaignName is a
// fallback only consulted server-side when a submission row has no
// campaign_id, mirroring the exact attribution rule already implemented
// in google-ads-campaign-crm-outcomes.ts/google-ads-campaign-leads.ts.
// Ad Group -> CRM Leads Deep Link phase — adGroupId is the canonical
// selector (digit-only, same validation policy as campaignId); adGroupName
// is DISPLAY ONLY (Step 27) — it is never sent to the server for
// attribution, never used to filter, purely for the chip label.
type LeadsSearch = {
  leadId?: string; source?: string;
  campaignId?: string; campaignName?: string;
  adGroupId?: string; adGroupName?: string;
};

// Defensive backward-compatibility normalization only (Google Ads Campaign
// Deep Link Quoting + Fallback fix) — the producer (marketing.tsx's "View
// CRM Leads" Link) never wraps its own values in quotes, and TanStack
// Router's own default search serializer already round-trips a plain
// numeric-looking string cleanly back through validateSearch (it
// JSON-quote-wraps such values only in the visible address bar, to keep
// them typed as strings rather than silently coercing to numbers on
// decode — see stringifySearchWith/parseSearchWith in
// @tanstack/router-core/searchParams.js). This helper exists purely to
// tolerate a STALE or manually-pasted URL that genuinely contains a
// literal, single matching pair of wrapping quote characters (e.g.
// "24152601041") — never a general character-stripping routine.
function stripOneMatchingQuotePair(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

// campaignId is always a Google Ads numeric campaign identifier — after
// normalization, anything containing non-digit content is treated as
// invalid and omitted entirely rather than sent to the server as a
// malformed selector (Step 4). Kept as a string throughout (never
// Number(...)) so no precision risk exists for large IDs.
function normalizeDeepLinkCampaignId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = stripOneMatchingQuotePair(raw);
  return /^\d+$/.test(normalized) ? normalized : undefined;
}

// campaignName has no digit-only constraint — just quote/whitespace
// normalization.
function normalizeDeepLinkCampaignName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = stripOneMatchingQuotePair(raw);
  return normalized.length > 0 ? normalized : undefined;
}

// adGroupId — identical policy to campaignId (digit-only, quote-stripped,
// kept as a string, invalid -> undefined rather than thrown).
function normalizeDeepLinkAdGroupId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = stripOneMatchingQuotePair(raw);
  return /^\d+$/.test(normalized) ? normalized : undefined;
}

// adGroupName — DISPLAY ONLY (Step 27). Identical normalization to
// campaignName, but never consulted for server-side filtering anywhere in
// this file — only ever read for the Ad Group chip's label.
function normalizeDeepLinkAdGroupName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = stripOneMatchingQuotePair(raw);
  return normalized.length > 0 ? normalized : undefined;
}

export const Route = createFileRoute("/leads")({
  validateSearch: (raw: Record<string, unknown>): LeadsSearch => {
    // An invalid/unknown source value safely falls back to "no source
    // filter" (All Sources) rather than throwing or silently corrupting
    // the filter state (Step 2) — validated against the same canonical
    // catalog the Source filter dropdown itself renders.
    const rawSource = typeof raw.source === "string" ? raw.source : undefined;
    const validSource = rawSource && CANONICAL_LEAD_SOURCE_OPTIONS.some((o) => o.value === rawSource)
      ? rawSource
      : undefined;
    return {
      leadId: typeof raw.leadId === "string" ? raw.leadId : undefined,
      source: validSource,
      campaignId: normalizeDeepLinkCampaignId(raw.campaignId),
      campaignName: normalizeDeepLinkCampaignName(raw.campaignName),
      adGroupId: normalizeDeepLinkAdGroupId(raw.adGroupId),
      adGroupName: normalizeDeepLinkAdGroupName(raw.adGroupName),
    };
  },
  component: LeadsPage,
});

// STATUS_FILTERS/ALL_STATUSES/STATUS_LABELS/statusBadgeVariant previously
// duplicated the same 5-value list inline (Phase 9 audit finding) — now
// sourced from src/lib/lead-status.ts, the single shared definition.
const STATUS_FILTERS = ["All statuses", ...LEAD_STATUSES] as const;
const SCORE_FILTERS = ["All scores", "hot", "warm", "cold"] as const;
// Lead-source normalization pass — the Add Lead form's own option list.
// `value` is always the canonical machine value persisted to
// leads.source; `label` is what the user sees. Never use a display
// string as the option value (that was the original bug: leads.source
// ending up with literal "Google Ads"/"Website" text instead of a
// canonical value, which is exactly what produced duplicate-looking
// entries in the source filter dropdown once a second casing variant
// existed alongside it).
//
// Lead Source Filter Enhancement — reuses the single canonical ordered
// export from lib/lead-source.ts (Paid, then Owned channels) rather than
// keeping a parallel array; the Leads source filter below reuses the same
// export directly. Legacy values (advertising, cold_call, referral, angi,
// thumbtack, walk_in, social_media, etc.) are intentionally excluded —
// they remain valid, readable, filterable historical data
// (src/lib/lead-source.ts), just no longer offered as new choices.
const ADD_LEAD_SOURCE_OPTIONS = CANONICAL_LEAD_SOURCE_OPTIONS;
const ALL_STATUSES: LeadStatus[] = LEAD_STATUSES;
const ALL_SCORES: LeadScore[] = ["hot", "warm", "cold"];
const PROJECT_TYPES = ["Kitchen Remodel", "Bath Remodel", "Whole Home Renovation", "Basement Finish", "Addition", "Outdoor Living", "Primary Suite"];

const STATUS_LABELS: Record<LeadStatus, string> = LEAD_STATUS_LABELS;

function scoreIcon(score: LeadScore) {
  switch (score) {
    case "hot": return { Icon: Flame, className: "text-red-500" };
    case "warm": return { Icon: Thermometer, className: "text-amber-500" };
    case "cold": return { Icon: Snowflake, className: "text-sky-500" };
  }
}

// leads.assigned_to (a real FK-shaped UUID, confirmed live — see Phase 9.2
// report) is now canonical. `owner`/`ownerInitials` are legacy
// custom_fields display text kept only as a fallback for rows created
// before assignedTo existed. Resolving the name from the live team list
// (rather than trusting a possibly-renamed cached string) means a renamed
// team member's leads show the CURRENT name immediately, with no backfill.
function resolveOwnerName(lead: Lead, teamMembers: TeamMember[]): string {
  if (lead.assignedTo) {
    const member = teamMembers.find((m) => m.id === lead.assignedTo);
    if (member) return member.name;
    // assignedTo is set but doesn't match any current team member (removed
    // member, or a member from a different org — shouldn't happen since
    // useTeam() is already org-scoped, but fails safe either way).
    return "Unknown member";
  }
  return lead.owner && lead.owner !== "—" ? lead.owner : "Unassigned";
}

// Phase 9.2 consistency pass — a converted lead is retained as a historical
// source record and is never individually or bulk-deletable from this page.
// The store (deleteLead/deleteLeadsBulk in leads-store.ts) enforces this
// independently of the UI; this local check only decides what the delete
// dialog itself shows (no destructive "delete anyway" action for these).
const CONVERTED_LEAD_DELETE_MESSAGE = "Converted leads are retained to preserve the sales history associated with their deal.";

function isDeleteBlockedConverted(lead: Pick<Lead, "status" | "convertedDealId">): boolean {
  return lead.status === "converted" || !!lead.convertedDealId;
}

function LeadsPage() {
  const {
    leadId, source: sourceParam,
    campaignId: campaignIdParam, campaignName: campaignNameParam,
    adGroupId: adGroupIdParam, adGroupName: adGroupNameParam,
  } = useSearch({ from: "/leads" });
  const navigate = useNavigate({ from: "/leads" });
  const teamMembers = useTeam();
  const pipelineStages = usePipelineStages();
  const deals = useDeals();
  const leads = useLeads();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  // Lazy-initialized from the URL so a direct navigation / browser refresh
  // shows the right filter immediately, without waiting for an effect to
  // run after first paint (Step 3). Back/forward and other in-app search
  // changes are handled by the sync effect below.
  const [sourceFilter, setSourceFilter] = useState<string>(() => sourceParam ?? "All sources");
  // Campaign context (Step 4) — only ever set from the URL (arriving via
  // the Campaign Detail Sheet's "View CRM Leads" button) or cleared by the
  // user (chip's X, Clear filters, or manually changing Source away from
  // Google Ads). Never derived from anything else.
  const [campaignContext, setCampaignContext] = useState<{ campaignId?: string; campaignName?: string } | null>(
    () => (campaignIdParam || campaignNameParam) ? { campaignId: campaignIdParam, campaignName: campaignNameParam } : null,
  );
  const [campaignLeadIds, setCampaignLeadIds] = useState<Set<string> | null>(null);
  const [campaignLeadIdsLoading, setCampaignLeadIdsLoading] = useState(false);
  // Ad Group context (Ad Group -> CRM Leads Deep Link phase) — nested
  // under campaign context, exactly like the product hierarchy it mirrors
  // (Campaign -> Ad Group). Same "only ever set from the URL or cleared by
  // the user" rule as campaignContext.
  const [adGroupContext, setAdGroupContext] = useState<{ adGroupId?: string; adGroupName?: string } | null>(
    () => (adGroupIdParam || adGroupNameParam) ? { adGroupId: adGroupIdParam, adGroupName: adGroupNameParam } : null,
  );
  const [adGroupLeadIds, setAdGroupLeadIds] = useState<Set<string> | null>(null);
  const [adGroupLeadIdsLoading, setAdGroupLeadIdsLoading] = useState(false);
  // Unlike campaignLeadIds (which fails OPEN on a fetch error — see the
  // effect below), Ad Group attribution fails CLOSED (Step 22): a load
  // failure must never risk silently showing the broader, unfiltered
  // Google Ads lead set as if Ad Group filtering had succeeded. This error
  // string drives both a compact retry banner and forces the visible rows
  // to 0 while it's set.
  const [adGroupLeadIdsError, setAdGroupLeadIdsError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("All statuses");
  const [scoreFilter, setScoreFilter] = useState<string>("All scores");
  // "More filters" (Priority 7) — kept as separate controlled state rather
  // than folded into the always-visible filter row, so the existing
  // filter-bar layout doesn't change; these live inside a popover opened
  // from the same "More filters" button that was previously a no-op.
  const [ownerFilter, setOwnerFilter] = useState<string>("All owners");
  const [convertedFilter, setConvertedFilter] = useState<"all" | "converted" | "unconverted">("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [budgetMin, setBudgetMin] = useState("");
  const [budgetMax, setBudgetMax] = useState("");
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const [selected, setSelected] = useState<Lead | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [convertLead, setConvertLead] = useState<Lead | null>(null);
  const [convertOpen, setConvertOpen] = useState(false);
  const [dealDrawerId, setDealDrawerId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [csvRaw, setCsvRaw] = useState("");
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvPreview, setCsvPreview] = useState<string[][]>([]);
  const [csvTotalRows, setCsvTotalRows] = useState(0);
  const [colMapping, setColMapping] = useState<ColumnMapping | null>(null);
  const [templateType, setTemplateType] = useState<TemplateType>("lead");
  const [importChecking, setImportChecking] = useState(false);
  const [importFilename, setImportFilename] = useState("leads.csv");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [newLead, setNewLead] = useState({
    name: "", email: "", phone: "", address: "", source: "" as string,
    projectType: "", estimatedBudget: "", score: "" as string,
    // assignedTo holds a team member id ("" = unassigned) — the canonical
    // owner field. Never a display name (Priority 1, Phase 9.2 consistency
    // pass).
    assignedTo: "", notes: "",
  });

  // Edit Lead (Priority 2)
  const [editLead, setEditLead] = useState<Lead | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editForm, setEditForm] = useState({
    name: "", email: "", phone: "", address: "", source: "", projectType: "",
    estimatedBudget: "", status: "new" as LeadStatus, assignedTo: "", notes: "",
  });

  // Delete (Priority 5 — no archive column exists on `leads`, confirmed
  // live; hard delete with confirmation is the only option implemented
  // this pass).
  const [deleteTarget, setDeleteTarget] = useState<Lead | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);
  const [bulkActionLoading, setBulkActionLoading] = useState(false);

  // Search debounce (Priority 8) — 250ms, matching the debounce interval
  // topbar.tsx's global search already uses.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Deep-link
  useEffect(() => {
    if (leadId) {
      const found = leads.find((l) => l.id === leadId);
      if (found && found.id !== selected?.id) setSelected(found);
    } else {
      setSelected(null);
    }
  }, [leadId, leads]);

  // Google Ads Campaign -> CRM Leads Deep Link (Step 3/4) — re-syncs
  // sourceFilter/campaignContext whenever the URL's own source/campaignId/
  // campaignName actually change (direct navigation, browser refresh,
  // back/forward). A manual in-page filter change never triggers this —
  // it only sets local state, so it never fights with a stale URL value
  // (Step 11). validateSearch() has already rejected an unrecognized
  // source value down to undefined, so no re-validation is needed here.
  useEffect(() => {
    setSourceFilter(sourceParam ?? "All sources");
    setCampaignContext((campaignIdParam || campaignNameParam) ? { campaignId: campaignIdParam, campaignName: campaignNameParam } : null);
    setAdGroupContext((adGroupIdParam || adGroupNameParam) ? { adGroupId: adGroupIdParam, adGroupName: adGroupNameParam } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceParam, campaignIdParam, campaignNameParam, adGroupIdParam, adGroupNameParam]);

  // Resolves the campaign-attributed lead_id set for the active campaign
  // context (Step 5) — reuses the exact same server-side attribution rule
  // as the Campaign Detail Sheet's CRM outcomes via
  // google-ads-campaign-leads.ts, never a client-side re-implementation.
  useEffect(() => {
    if (!campaignContext || (!campaignContext.campaignId && !campaignContext.campaignName)) {
      setCampaignLeadIds(null);
      setCampaignLeadIdsLoading(false);
      return;
    }
    let cancelled = false;
    setCampaignLeadIdsLoading(true);
    fetchGoogleAdsCampaignLeadIds({
      campaignId: campaignContext.campaignId ?? null,
      campaignName: campaignContext.campaignName ?? null,
    }).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setCampaignLeadIds(new Set(result.data.leadIds));
      } else {
        // Fails open (no campaign restriction) rather than showing a
        // broken/empty Leads page over a transient network or connection
        // issue — the campaign chip stays visible so the user can still
        // see context was requested, but the extra filter simply doesn't
        // apply until it resolves successfully.
        console.error("[leads] campaign_lead_ids_fetch_failed", result.kind);
        setCampaignLeadIds(null);
      }
      setCampaignLeadIdsLoading(false);
    });
    return () => { cancelled = true; };
  }, [campaignContext?.campaignId, campaignContext?.campaignName]);

  // Resolves the Ad Group-attributed lead_id set (Step 5/12) — reuses the
  // exact same server-side ad_group_id attribution rule as the Ad Group
  // Detail view's CRM outcomes via google-ads-ad-group-leads.ts. Per Step
  // 7, this set is authoritative on its own once an Ad Group context is
  // active — it is never intersected against a separately fetched campaign
  // lead-ID set. Unlike the campaign fetch above, a failure here fails
  // CLOSED (Step 22): adGroupLeadIdsError is set and `filtered` below
  // forces zero visible rows rather than silently falling back to the
  // broader campaign/source result.
  useEffect(() => {
    if (!adGroupContext?.adGroupId || !campaignContext?.campaignId) {
      setAdGroupLeadIds(null);
      setAdGroupLeadIdsLoading(false);
      setAdGroupLeadIdsError(null);
      return;
    }
    let cancelled = false;
    setAdGroupLeadIdsLoading(true);
    setAdGroupLeadIdsError(null);
    fetchGoogleAdsAdGroupLeadIds({
      campaignId: campaignContext.campaignId,
      adGroupId: adGroupContext.adGroupId,
    }).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setAdGroupLeadIds(new Set(result.data.leadIds));
      } else {
        console.error("[leads] ad_group_lead_ids_fetch_failed", result.kind);
        setAdGroupLeadIds(null);
        setAdGroupLeadIdsError("Unable to load Ad Group leads right now.");
      }
      setAdGroupLeadIdsLoading(false);
    });
    return () => { cancelled = true; };
  }, [adGroupContext?.adGroupId, campaignContext?.campaignId]);

  const retryAdGroupLeadIds = useCallback(() => {
    if (!adGroupContext?.adGroupId || !campaignContext?.campaignId) return;
    setAdGroupLeadIdsLoading(true);
    setAdGroupLeadIdsError(null);
    fetchGoogleAdsAdGroupLeadIds({
      campaignId: campaignContext.campaignId,
      adGroupId: adGroupContext.adGroupId,
    }).then((result) => {
      if (result.ok) {
        setAdGroupLeadIds(new Set(result.data.leadIds));
      } else {
        setAdGroupLeadIds(null);
        setAdGroupLeadIdsError("Unable to load Ad Group leads right now.");
      }
      setAdGroupLeadIdsLoading(false);
    });
  }, [adGroupContext?.adGroupId, campaignContext?.campaignId]);

  // Ad Group is nested under Campaign (Step 17) — clears both. Never
  // leaves an orphaned Ad Group chip pointing at a campaign context that
  // no longer exists.
  const clearCampaignContext = useCallback(() => {
    setCampaignContext(null);
    setCampaignLeadIds(null);
    setAdGroupContext(null);
    setAdGroupLeadIds(null);
    setAdGroupLeadIdsError(null);
    navigate({ search: (prev) => ({ ...prev, campaignId: undefined, campaignName: undefined, adGroupId: undefined, adGroupName: undefined }), replace: true });
  }, [navigate]);

  // Clearing just the Ad Group chip (Step 16) keeps campaign context/source
  // intact — falls back to the campaign-filtered view.
  const clearAdGroupContext = useCallback(() => {
    setAdGroupContext(null);
    setAdGroupLeadIds(null);
    setAdGroupLeadIdsError(null);
    navigate({ search: (prev) => ({ ...prev, adGroupId: undefined, adGroupName: undefined }), replace: true });
  }, [navigate]);

  // Manual Source filter change (Step 11/19) — campaign AND ad group
  // context only ever make sense paired with the Google Ads source, so
  // switching away from it clears both rather than leaving a confusing,
  // invisible restriction in place. Switching source while staying on
  // Google Ads (or arriving at Google Ads by other means) leaves existing
  // context untouched.
  const handleSourceFilterChange = useCallback((value: string) => {
    setSourceFilter(value);
    if (value !== "google_ads" && (campaignContext || adGroupContext)) {
      setCampaignContext(null);
      setCampaignLeadIds(null);
      setAdGroupContext(null);
      setAdGroupLeadIds(null);
      setAdGroupLeadIdsError(null);
      navigate({
        search: (prev) => ({
          ...prev,
          source: value === "All sources" ? undefined : value,
          campaignId: undefined, campaignName: undefined,
          adGroupId: undefined, adGroupName: undefined,
        }),
        replace: true,
      });
    }
  }, [campaignContext, adGroupContext, navigate]);

  const ownerFilterOptions = useMemo(() => {
    const names = new Set<string>();
    for (const l of leads) names.add(resolveOwnerName(l, teamMembers));
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [leads, teamMembers]);

  // Lead Source Filter Enhancement — every filter EXCEPT source, computed
  // once and shared by both `filtered` (adds the source filter on top)
  // and `sourceCounts` below (Step 5's faceted-count decision: counts
  // reflect all OTHER active filters, but never the source filter itself
  // — so picking "Google Ads" doesn't zero out every other source's
  // count). A single pass here also avoids re-deriving the same 9 other
  // filter predicates twice (Step 14).
  const nonSourceFiltered = useMemo(() => {
    let list = leads;
    if (search) {
      // Normalized so a formatted or unformatted phone/email still matches
      // (Priority 8) — compares digits-only phone and lowercased/trimmed
      // email in addition to the plain substring match on every other
      // field, rather than relying on the raw string containing the query.
      const q = search.toLowerCase().trim();
      const qDigits = q.replace(/\D/g, "");
      const qEmail = normalizeEmail(q);
      list = list.filter((l) => {
        const ownerName = resolveOwnerName(l, teamMembers).toLowerCase();
        const phoneDigits = l.phone.replace(/\D/g, "");
        return (
          l.name.toLowerCase().includes(q) ||
          (qEmail && normalizeEmail(l.email).includes(qEmail)) ||
          l.email.toLowerCase().includes(q) ||
          (qDigits && phoneDigits.includes(qDigits)) ||
          l.phone.includes(q) ||
          l.address.toLowerCase().includes(q) ||
          leadSourceLabel(l.source).toLowerCase().includes(q) ||
          l.projectType.toLowerCase().includes(q) ||
          ownerName.includes(q)
        );
      });
    }
    if (statusFilter !== "All statuses") list = list.filter((l) => l.status === statusFilter);
    if (scoreFilter !== "All scores") list = list.filter((l) => l.score === scoreFilter);
    if (ownerFilter !== "All owners") list = list.filter((l) => resolveOwnerName(l, teamMembers) === ownerFilter);
    if (convertedFilter === "converted") list = list.filter((l) => l.status === "converted");
    if (convertedFilter === "unconverted") list = list.filter((l) => l.status !== "converted");
    if (dateFrom) {
      const from = new Date(dateFrom);
      list = list.filter((l) => new Date(l.createdAt) >= from);
    }
    if (dateTo) {
      const to = new Date(dateTo);
      to.setHours(23, 59, 59, 999);
      list = list.filter((l) => new Date(l.createdAt) <= to);
    }
    if (budgetMin.trim()) {
      const min = Number(budgetMin);
      if (Number.isFinite(min)) list = list.filter((l) => l.estimatedBudget >= min);
    }
    if (budgetMax.trim()) {
      const max = Number(budgetMax);
      if (Number.isFinite(max)) list = list.filter((l) => l.estimatedBudget <= max);
    }
    return list;
  }, [leads, search, statusFilter, scoreFilter, ownerFilter, convertedFilter, dateFrom, dateTo, budgetMin, budgetMax, teamMembers]);

  // Live per-source counts (Step 4) — always the full 9-canonical-source
  // catalog (initialized to 0 so a zero-lead source still gets an entry),
  // computed from normalized source values in a single pass over
  // nonSourceFiltered rather than filtering the array once per source
  // (Step 14). A legacy value (advertising/cold_call/referral/etc.)
  // normalizes to something outside the 9 canonical keys and is simply not
  // counted into any of them — it's still included in totalSourceCount
  // below (Step 6).
  const sourceCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const o of CANONICAL_LEAD_SOURCE_OPTIONS) counts[o.value] = 0;
    for (const l of nonSourceFiltered) {
      const canonical = normalizeLeadSource(l.source);
      if (canonical in counts) counts[canonical]++;
    }
    return counts;
  }, [nonSourceFiltered]);

  // "All Sources" count (Step 5/6) — the complete nonSourceFiltered total,
  // which includes historical legacy-source leads even though they don't
  // contribute to any of the 9 canonical buckets above.
  const totalSourceCount = nonSourceFiltered.length;

  const filtered = useMemo(() => {
    let list = nonSourceFiltered;
    // Filter value semantics (Step 10/11): sourceFilter now holds the
    // CANONICAL machine value ("google_ads", not "Google Ads"). l.source
    // is already normalized at read time (leads-store.ts's mapRow), so a
    // stale raw alias like "Google Ads" still compares equal here — but
    // normalizeLeadSource() is applied defensively rather than assumed.
    if (sourceFilter !== "All sources") {
      list = list.filter((l) => normalizeLeadSource(l.source) === sourceFilter);
    }
    // Ad Group context, when present, is the AUTHORITATIVE narrowest
    // restriction (Step 7) — never intersected with a separately fetched
    // campaign lead-ID set, even though campaign context/chip may still be
    // visible for display. Fails CLOSED (Step 22): while the fetch is
    // still loading, or if it failed, this forces zero visible rows
    // instead of silently falling back to the broader campaign/source
    // result — the compact banner near the Ad Group chip explains why.
    // Campaign context filter (Step 5) only applies when there is NO Ad
    // Group context — campaignLeadIds is the exact lead_id set resolved
    // server-side for this campaign (never a client-side re-derivation of
    // attribution); while it's still loading or absent, the campaign
    // restriction simply doesn't apply yet (fails OPEN, unchanged from the
    // Campaign deep-link phase).
    if (adGroupContext) {
      list = adGroupLeadIds ? list.filter((l) => adGroupLeadIds.has(l.id)) : [];
    } else if (campaignContext && campaignLeadIds) {
      list = list.filter((l) => campaignLeadIds.has(l.id));
    }
    return list;
  }, [nonSourceFiltered, sourceFilter, campaignContext, campaignLeadIds, adGroupContext, adGroupLeadIds]);

  // Stats
  const stats = useMemo(() => {
    const total = leads.length;
    const hot = leads.filter((l) => l.score === "hot" && l.status !== "converted" && l.status !== "lost").length;
    const newCount = leads.filter((l) => l.status === "new").length;
    const converted = leads.filter((l) => l.status === "converted").length;
    return { total, hot, newCount, converted };
  }, [leads]);

  const openLead = (lead: Lead) => {
    setSelected(lead);
    // Merges onto the existing search object (Google Ads Lead Navigation
    // Consistency pass) rather than replacing it outright — a literal
    // `search: { leadId }` object would silently wipe out an active
    // source/campaignId/campaignName context every time any lead row is
    // opened, which is exactly the bug this pass fixes.
    navigate({ search: (prev) => ({ ...prev, leadId: lead.id }), replace: true });
  };

  const handleStatusChange = async (id: string, newStatus: LeadStatus) => {
    try {
      await storeUpdateStatus(id, newStatus);
      toast.success(`Lead status updated to ${STATUS_LABELS[newStatus]}`);
    } catch (error) {
      console.error("[leads] status change failed:", error);
      toast.error("Failed to update the lead's status.");
    }
  };

  // Priority 4 — leads.score has no writable, honestly-mappable column for
  // this hot/warm/cold category (see report): the real `leads.score` int
  // column is a separate AI Center quality metric, always null today and
  // written by nothing. The UI's score is a client-computed classification
  // (classifyScore(), from budget + status) — there is no interactive
  // "change score" control anymore; see LeadDetailDrawer, which now shows
  // it read-only with an explanatory caption instead.

  const handleEditLead = (lead: Lead) => {
    setEditLead(lead);
    setEditForm({
      name: lead.name, email: lead.email, phone: lead.phone, address: lead.address,
      source: lead.source, projectType: lead.projectType,
      estimatedBudget: String(lead.estimatedBudget || ""),
      status: lead.status, assignedTo: lead.assignedTo ?? "",
      notes: lead.notes,
    });
    setEditOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!editLead) return;
    if (!editForm.name.trim()) { toast.error("Name is required"); return; }
    setEditSaving(true);
    try {
      await storeUpdateLead(editLead.id, {
        name: editForm.name.trim(),
        email: normalizeEmail(editForm.email),
        phone: editForm.phone.trim(),
        address: editForm.address.trim(),
        // storeUpdateLead() normalizes this to the canonical machine value —
        // editForm.source is already canonical if the user picked one of
        // the 9 built-ins, or the lead's own preserved legacy value if
        // they left the source selector untouched.
        source: editForm.source.trim() || "website_form",
        projectType: editForm.projectType.trim(),
        estimatedBudget: Number(editForm.estimatedBudget) || 0,
        notes: editForm.notes.trim(),
      });

      if (editForm.status !== editLead.status) {
        await storeUpdateStatus(editLead.id, editForm.status);
      }
      const currentAssignedTo = editLead.assignedTo ?? "";
      if (editForm.assignedTo !== currentAssignedTo) {
        await storeUpdateLeadOwner(editLead.id, editForm.assignedTo || null);
      }

      toast.success("Lead updated");
      setEditOpen(false);
      setEditLead(null);
    } catch (error) {
      console.error("[leads] edit save failed:", error);
      toast.error("Failed to save changes to this lead.");
    } finally {
      setEditSaving(false);
    }
  };

  const handleDeleteLead = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    const result = await storeDeleteLead(deleteTarget.id);
    setDeleteLoading(false);
    if (result.ok) {
      toast.success(`${deleteTarget.name} deleted`);
      setDeleteTarget(null);
      if (selected?.id === deleteTarget.id) navigate({ search: (prev) => ({ ...prev, leadId: undefined }), replace: true });
    } else {
      toast.error(result.error);
    }
  };

  const handleBulkStatusChange = async (status: LeadStatus) => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBulkActionLoading(true);
    const { failedIds } = await updateLeadsStatusBulk(ids, status);
    setBulkActionLoading(false);
    if (failedIds.length === 0) {
      toast.success(`${ids.length} lead${ids.length === 1 ? "" : "s"} updated to ${STATUS_LABELS[status]}`);
      setSelectedIds(new Set());
    } else if (failedIds.length < ids.length) {
      toast.warning(`${ids.length - failedIds.length} updated, ${failedIds.length} failed`);
      setSelectedIds(new Set(failedIds));
    } else {
      toast.error("Failed to update the selected leads.");
    }
  };

  const handleBulkOwnerAssign = async (memberId: string) => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBulkActionLoading(true);
    const { failedIds } = await updateLeadsOwnerBulk(ids, memberId || null);
    setBulkActionLoading(false);
    if (failedIds.length === 0) {
      toast.success(`Owner updated for ${ids.length} lead${ids.length === 1 ? "" : "s"}`);
      setSelectedIds(new Set());
    } else if (failedIds.length < ids.length) {
      toast.warning(`${ids.length - failedIds.length} updated, ${failedIds.length} failed`);
      setSelectedIds(new Set(failedIds));
    } else {
      toast.error("Failed to reassign the selected leads.");
    }
  };

  const handleBulkDelete = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;

    // Converted leads are never bulk-deleted — preserving deal history
    // takes priority. The store (deleteLeadsBulk) re-derives the
    // converted/eligible split itself as the actual enforcement point
    // (Priority 2 — not relying only on this UI-level check), so the full
    // selection is passed through rather than pre-filtered here.
    setBulkActionLoading(true);
    const { failedIds, skippedConvertedIds } = await deleteLeadsBulk(ids);
    setBulkActionLoading(false);
    setBulkDeleteConfirmOpen(false);

    const deletedCount = ids.length - failedIds.length - skippedConvertedIds.length;
    if (failedIds.length === 0 && skippedConvertedIds.length === 0) {
      toast.success(`${deletedCount} lead${deletedCount === 1 ? "" : "s"} deleted`);
      setSelectedIds(new Set());
    } else {
      const parts = [`${deletedCount} deleted`];
      if (skippedConvertedIds.length > 0) parts.push(`${skippedConvertedIds.length} skipped (converted)`);
      if (failedIds.length > 0) parts.push(`${failedIds.length} failed`);
      toast.warning(parts.join(" · "));
      // Skipped-converted and failed rows stay selected so the user can see
      // exactly which ones didn't delete and why; successfully deleted rows
      // are no longer in `leads` at all, so they drop out of the set
      // naturally on the next render regardless.
      setSelectedIds(new Set([...failedIds, ...skippedConvertedIds]));
    }
  };

  const handleConvertToDeal = (lead: Lead) => {
    if (lead.status === "converted" || lead.status === "lost") return;
    setConvertLead(lead);
    setConvertOpen(true);
  };

  const handleDealConverted = (deal: Deal) => {
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
      console.error("[leads] deal stage change failed:", error);
      toast.error("Failed to update the deal stage.");
    }
  };

  const handleDealMarkLost = async (dealId: string, reason: LostReason, notes: string) => {
    try {
      await storeUpdateDeal(dealId, { stage: "lost", status: "lost", lostReason: reason, notes: notes || undefined });
    } catch (error) {
      console.error("[leads] mark lost failed:", error);
      toast.error("Failed to mark the deal as lost.");
    }
  };

  const handleDealUpdate = async (dealId: string, patch: Partial<Deal>) => {
    try {
      await storeUpdateDeal(dealId, patch);
    } catch (error) {
      console.error("[leads] deal update failed:", error);
      toast.error("Failed to save the deal.");
      throw error;
    }
  };

  const handleDealDelete = async (dealId: string) => {
    try {
      await storeDeleteDeal(dealId);
      setDealDrawerId(null);
    } catch (error) {
      console.error("[leads] delete deal failed:", error);
      toast.error("Failed to delete the deal.");
      throw error;
    }
  };

  const handleAddLead = () => {
    if (!newLead.name.trim()) return;
    // Canonical owner (Priority 1, Phase 9.2 consistency pass): writes
    // assignedTo (a team member id, or null for unassigned) directly on
    // insert — never a forced default and never a display name. The
    // legacy `owner`/`ownerInitials` text fields are left at their
    // "unassigned" defaults; resolveOwnerName() resolves the display name
    // from assignedTo + the live team list wherever it's shown.
    storeAddLead({
      name: newLead.name.trim(),
      email: newLead.email.trim(),
      phone: newLead.phone.trim(),
      address: newLead.address.trim(),
      // storeAddLead() (leads-store.ts's addLead()) normalizes this to the
      // canonical machine value before writing — newLead.source is already
      // canonical here since it comes from ADD_LEAD_SOURCE_OPTIONS' values.
      source: newLead.source || "website",
      status: "new",
      score: (newLead.score || "warm") as LeadScore,
      projectType: newLead.projectType || "Kitchen Remodel",
      estimatedBudget: Number(newLead.estimatedBudget) || 0,
      notes: newLead.notes.trim(),
      owner: "—",
      ownerInitials: "",
      assignedTo: newLead.assignedTo || null,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    });
    setAddOpen(false);
    setNewLead({ name: "", email: "", phone: "", address: "", source: "", projectType: "", estimatedBudget: "", score: "", assignedTo: "", notes: "" });
    toast.success("Lead added");
  };

  const fileInputRef = useCallback((node: HTMLInputElement | null) => {
    if (node) node.value = "";
  }, []);

  // Exports the currently filtered/searched view (Stage 9.5 Priority 10 —
  // filtered/selected/all export variants), not always the full org dataset
  // regardless of active search/filters. Use "Export selected" for a
  // checkbox-picked subset instead.
  const handleExport = () => {
    const csv = leadsToCSV(filtered, (lead) => resolveOwnerName(lead, teamMembers));
    downloadCSV(csv, `leads-${new Date().toISOString().slice(0, 10)}.csv`);
    toast.success(`Exported ${filtered.length} lead${filtered.length === 1 ? "" : "s"}`);
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFilename(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const { headers, preview, totalRows } = parseCSVPreview(text);
      if (headers.length === 0 || totalRows === 0) {
        toast.error("Empty or invalid CSV file");
        return;
      }
      if (totalRows > CSV_MAX_SYNC_IMPORT_ROWS) {
        toast.error("File too large to import", {
          description: `This file has ${totalRows} rows. Imports are supported up to ${CSV_MAX_SYNC_IMPORT_ROWS} rows per file — split it into smaller files.`,
        });
        return;
      }
      if (totalRows > CSV_WARN_ROW_THRESHOLD) {
        toast.warning(`Large file: ${totalRows} rows`, { description: "This may take a little longer to check for duplicates." });
      }
      setCsvRaw(text);
      setCsvHeaders(headers);
      setCsvPreview(preview);
      setCsvTotalRows(totalRows);
      setColMapping(autoMapHeaders(headers, templateType));
      setMapOpen(true);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleConfirmImport = async () => {
    if (!colMapping) return;
    const { leads: parsedRaw, errors } = applyMappingToLeads(csvRaw, colMapping);
    if (parsedRaw.length === 0) {
      toast.error("No leads imported", { description: errors[0] || "Check your column mapping." });
      return;
    }

    // CSV owner column → assignedTo (Priority 5, Phase 9.2 consistency
    // pass): applyMappingToLeads only ever produces a free-text owner
    // name — never write that text into assigned_to. Resolve it against
    // the current, already org-scoped active team list by an EXACT
    // (case-insensitive, trimmed) name match only; a name matching more
    // than one active member is treated as ambiguous, same as no match.
    // Anything that doesn't resolve imports unassigned and is reported,
    // rather than guessed or left to write a legacy display name anywhere.
    const activeMembers = teamMembers.filter((m) => m.status === "active");
    const nameCounts = new Map<string, number>();
    for (const m of activeMembers) {
      const key = m.name.trim().toLowerCase();
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    }
    const ownerByName = new Map<string, string>();
    for (const m of activeMembers) {
      const key = m.name.trim().toLowerCase();
      if (nameCounts.get(key) === 1) ownerByName.set(key, m.id);
    }

    let unresolvedOwnerCount = 0;
    const parsed = parsedRaw.map((row) => {
      const ownerText = (row.owner ?? "").trim();
      if (!ownerText || ownerText === "Unassigned" || ownerText === "—") {
        return { ...row, assignedTo: null };
      }
      const matchId = ownerByName.get(ownerText.toLowerCase());
      if (matchId) return { ...row, assignedTo: matchId };
      unresolvedOwnerCount++;
      return { ...row, assignedTo: null };
    });

    setImportChecking(true);
    // Stage 9.5: replaces the old "skip duplicate checks silently above 200
    // rows" behavior. Prefetches this org's contact identities ONCE (bounded
    // — same set the Contacts page already loads), then checks every row
    // in-memory, so the check always runs regardless of file size (up to
    // the CSV_MAX_SYNC_IMPORT_ROWS cap enforced at file-select time) instead
    // of silently being skipped for larger files.
    const orgId = await getContactsOrgId();
    const identitySets = orgId ? await prefetchContactIdentitySets(orgId) : { emails: new Set<string>(), phones: new Set<string>() };

    let duplicateCount = 0;
    const toCreate: typeof parsed = [];
    const skippedDuplicateErrors: string[] = [];
    parsed.forEach((row, idx) => {
      const email = normalizeEmail(row.email);
      const phoneDigits = row.phone.replace(/\D/g, "");
      const isDup = (email && identitySets.emails.has(email)) || (phoneDigits && identitySets.phones.has(phoneDigits));
      if (isDup) {
        duplicateCount++;
        skippedDuplicateErrors.push(`Row ${idx + 2}: matched an existing contact by email/phone, skipped.`);
      } else {
        toCreate.push(row);
      }
    });
    setImportChecking(false);

    if (toCreate.length === 0) {
      toast.error("No leads imported", {
        description: duplicateCount > 0 ? `All ${duplicateCount} row(s) matched an existing contact.` : errors[0],
      });
      setMapOpen(false);
      return;
    }

    const jobId = await createImportJob("lead", importFilename, csvTotalRows);
    const { created, failedIndexes, byIndex } = await addLeadsBatch(toCreate);

    if (jobId) {
      const rowLogs = toCreate.map((_, i) => {
        const failed = failedIndexes.includes(i);
        return {
          source_row_number: i + 2,
          entity_id: byIndex[i]?.id ?? null,
          action: failed ? ("failed" as const) : ("created" as const),
          status: failed ? ("error" as const) : ("ok" as const),
        };
      });
      await logImportRows(jobId, rowLogs);
      await completeImportJob(jobId, { created: created.length, skipped: duplicateCount, failed: failedIndexes.length }, [...errors, ...skippedDuplicateErrors]);
    }

    const summaryParts = [`${created.length} created`];
    if (duplicateCount > 0) summaryParts.push(`${duplicateCount} skipped as duplicate`);
    if (errors.length > 0) summaryParts.push(`${errors.length} validation notice(s)`);
    if (failedIndexes.length > 0) summaryParts.push(`${failedIndexes.length} failed to save`);
    if (unresolvedOwnerCount > 0) summaryParts.push(`${unresolvedOwnerCount} owner name(s) unresolved, imported unassigned`);
    if (created.length < toCreate.length) {
      toast.warning("Import completed with some failures", { description: summaryParts.join(" · ") });
    } else {
      toast.success(`Import complete`, { description: summaryParts.join(" · ") });
    }
    setMapOpen(false);
  };

  const downloadErrorReport = () => {
    if (!importValidation?.errors.length) return;
    const lines = [
      "Import Error Report",
      `Generated: ${new Date().toLocaleString()}`,
      `File: ${csvTotalRows} total rows, ${importValidation.validCount} valid, ${importValidation.errors.length} skipped`,
      "",
      "Row,Error",
      ...importValidation.errors.map((err) => {
        const match = err.match(/^Row (\d+): (.+)$/);
        return match ? `${match[1]},${match[2]}` : `0,"${err}"`;
      }),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `import-errors-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Live validation of current mapping
  const importValidation = useMemo(() => {
    if (!colMapping || !csvRaw) return null;
    const { leads: parsed, errors } = applyMappingToLeads(csvRaw, colMapping);
    return { validCount: parsed.length, errors };
  }, [colMapping, csvRaw]);


  const moreFiltersActiveCount = [
    ownerFilter !== "All owners",
    convertedFilter !== "all",
    !!dateFrom,
    !!dateTo,
    !!budgetMin.trim(),
    !!budgetMax.trim(),
  ].filter(Boolean).length;

  const hasActiveFilters = search !== "" || sourceFilter !== "All sources" || statusFilter !== "All statuses" || scoreFilter !== "All scores" || moreFiltersActiveCount > 0 || !!campaignContext || !!adGroupContext;
  const allVisibleSelected = filtered.length > 0 && filtered.every((lead) => selectedIds.has(lead.id));

  const toggleLeadSelection = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) filtered.forEach((lead) => next.delete(lead.id));
      else filtered.forEach((lead) => next.add(lead.id));
      return next;
    });
  };

  const clearFilters = () => {
    setSearchInput("");
    setSearch("");
    setSourceFilter("All sources");
    setStatusFilter("All statuses");
    setScoreFilter("All scores");
    setOwnerFilter("All owners");
    setConvertedFilter("all");
    setDateFrom("");
    setDateTo("");
    setBudgetMin("");
    setBudgetMax("");
    // Step 10/18 — Clear filters also removes any route-applied source/
    // campaign/Ad Group context, both locally and from the URL, so no
    // hidden Google Ads attribution filtering silently remains active
    // after the UI appears cleared.
    setCampaignContext(null);
    setCampaignLeadIds(null);
    setAdGroupContext(null);
    setAdGroupLeadIds(null);
    setAdGroupLeadIdsError(null);
    navigate({
      search: (prev) => ({
        ...prev,
        source: undefined,
        campaignId: undefined, campaignName: undefined,
        adGroupId: undefined, adGroupName: undefined,
      }),
      replace: true,
    });
  };

  const exportSelected = () => {
    const selectedLeads = leads.filter((lead) => selectedIds.has(lead.id));
    if (!selectedLeads.length) return;
    downloadCSV(leadsToCSV(selectedLeads, (lead) => resolveOwnerName(lead, teamMembers)), `leads-selected-${new Date().toISOString().slice(0, 10)}.csv`);
    toast.success(`Exported ${selectedLeads.length} selected lead${selectedLeads.length === 1 ? "" : "s"}`);
  };

  const dailySeries = useMemo(() => {
    const today = new Date();
    return Array.from({ length: 30 }, (_, index) => {
      const day = new Date(today);
      day.setHours(0, 0, 0, 0);
      day.setDate(today.getDate() - (29 - index));
      const nextDay = new Date(day);
      nextDay.setDate(day.getDate() + 1);
      return leads.filter((lead) => {
        const created = new Date(lead.createdAt);
        return created >= day && created < nextDay;
      }).length;
    });
  }, [leads]);

  return (
    <>
      <PageHeader
        icon={Target}
        iconBg="bg-info-soft"
        iconColor="text-info"
        title="Leads"
        subtitle="Track, qualify, and convert every inbound opportunity"
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={handleExport}>
              <Download className="mr-1.5 h-3.5 w-3.5" /> Export
            </Button>
            <Button size="sm" variant="outline" className="relative" asChild>
              <label className="cursor-pointer">
                <Upload className="mr-1.5 h-3.5 w-3.5" /> Import
                <input type="file" accept=".csv" className="sr-only" onChange={handleImportFile} />
              </label>
            </Button>
            <Button size="sm" variant="outline" onClick={() => setHistoryOpen(true)}>
              <History className="mr-1.5 h-3.5 w-3.5" /> Import History
            </Button>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" /> Add Lead
            </Button>
          </div>
        }
      />
      <ImportHistoryDialog open={historyOpen} onOpenChange={setHistoryOpen} entityType="lead" />

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <LeadMetricCard label="Total Leads" value={stats.total} icon={Users} tone="blue" series={dailySeries} />
        <LeadMetricCard label="New Leads" value={stats.newCount} icon={Plus} tone="violet" series={dailySeries} />
        <LeadMetricCard label="Hot Leads" value={stats.hot} icon={Flame} tone="red" series={dailySeries} />
        <LeadMetricCard label="Converted" value={stats.converted} icon={CheckCircleIcon} tone="green" series={dailySeries} />
      </div>

      <Card className="overflow-hidden">
        <div className="flex min-h-[56px] flex-wrap items-center justify-between gap-3 border-b border-[#E5E7EB] bg-[#FAF3E4] px-4 py-3 sm:px-5">
          <div className="flex items-center gap-2.5">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-amber-500/10 text-amber-700">
              <Users className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">Leads ({filtered.length})</h2>
              <p className="text-[11px] text-muted-foreground">{filtered.length === leads.length ? "All active lead records" : `Filtered from ${leads.length} total leads`}</p>
            </div>
          </div>

          {selectedIds.size > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md border border-amber-200 bg-white/70 px-2.5 py-1.5 text-xs font-medium text-amber-900">
                {selectedIds.size} selected
              </span>
              <Select onValueChange={(v) => handleBulkStatusChange(v as LeadStatus)} disabled={bulkActionLoading}>
                <SelectTrigger className="h-8 w-auto min-w-[128px] text-xs"><SelectValue placeholder="Change status" /></SelectTrigger>
                <SelectContent>
                  {LEAD_STATUSES.map((s) => <SelectItem key={s} value={s} className="text-xs">{LEAD_STATUS_LABELS[s]}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select onValueChange={(v) => handleBulkOwnerAssign(v === "__unassigned__" ? "" : v)} disabled={bulkActionLoading}>
                <SelectTrigger className="h-8 w-auto min-w-[128px] text-xs"><SelectValue placeholder="Assign owner" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__unassigned__" className="text-xs">Unassigned</SelectItem>
                  {teamMembers.filter((m) => m.status === "active").map((m) => (
                    <SelectItem key={m.id} value={m.id} className="text-xs">{m.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" onClick={exportSelected} disabled={bulkActionLoading}>
                <Download className="mr-1.5 h-3.5 w-3.5" /> Export selected
              </Button>
              <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => setBulkDeleteConfirmOpen(true)} disabled={bulkActionLoading}>
                <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())} disabled={bulkActionLoading}>Clear</Button>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-[#E5E7EB] bg-white px-4 py-3 sm:px-5">
          <div className="relative min-w-[220px] flex-1 lg:max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by name, email, phone, address, source, project, or owner…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="h-9 pl-9 text-sm"
            />
          </div>
          <SourceFilterSelect
            value={sourceFilter}
            onChange={handleSourceFilterChange}
            counts={sourceCounts}
            totalCount={totalSourceCount}
          />
          <FilterSelect value={statusFilter} onChange={setStatusFilter} options={STATUS_FILTERS as unknown as string[]} />
          <FilterSelect value={scoreFilter} onChange={setScoreFilter} options={SCORE_FILTERS as unknown as string[]} />
          {campaignContext && (
            // Step 12 — a subtle active-filter indicator, so a user landing
            // here from a Campaign Detail Sheet understands why only a
            // subset of Google Ads leads are visible, rather than assuming
            // the Google Ads source count itself is wrong.
            <span className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 text-xs font-medium text-foreground">
              Campaign: {campaignContext.campaignName || campaignContext.campaignId}
              <button
                type="button"
                onClick={clearCampaignContext}
                aria-label="Clear campaign filter"
                className="rounded-sm text-muted-foreground hover:text-foreground"
              >
                <XIcon className="h-3.5 w-3.5" />
              </button>
            </span>
          )}
          {adGroupContext && (
            // Step 15 — compact Ad Group chip, same treatment as the
            // Campaign chip, rendered immediately after it. Prefers the
            // human-readable adGroupName (display only, Step 27/8) and
            // falls back to the raw ID only when no name is known.
            <span className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 text-xs font-medium text-foreground">
              Ad Group: {adGroupContext.adGroupName || adGroupContext.adGroupId}
              <button
                type="button"
                onClick={clearAdGroupContext}
                aria-label="Clear ad group filter"
                className="rounded-sm text-muted-foreground hover:text-foreground"
              >
                <XIcon className="h-3.5 w-3.5" />
              </button>
            </span>
          )}
          {adGroupLeadIdsError && (
            // Step 22 — compact, non-destructive load error. The table
            // itself already shows 0 rows (fail-closed, see `filtered`)
            // rather than silently falling back to unfiltered results.
            <span className="inline-flex h-9 items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 text-xs text-destructive">
              {adGroupLeadIdsError}
              <button
                type="button"
                onClick={retryAdGroupLeadIds}
                className="font-medium underline-offset-2 hover:underline"
              >
                Retry
              </button>
            </span>
          )}
          {hasActiveFilters && (
            <Button size="sm" variant="ghost" className="h-9 text-xs" onClick={clearFilters}>Clear filters</Button>
          )}
          <Popover open={moreFiltersOpen} onOpenChange={setMoreFiltersOpen}>
            <PopoverTrigger asChild>
              <Button size="icon" variant="outline" className="relative ml-auto h-9 w-9" aria-label="More filters">
                <SlidersHorizontal className="h-4 w-4" />
                {moreFiltersActiveCount > 0 && (
                  <span className="absolute -right-1 -top-1 grid h-4 w-4 place-items-center rounded-full bg-primary text-[9px] font-semibold text-primary-foreground">
                    {moreFiltersActiveCount}
                  </span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Owner</Label>
                <Select value={ownerFilter} onValueChange={setOwnerFilter}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="All owners" className="text-xs">All owners</SelectItem>
                    {ownerFilterOptions.map((o) => <SelectItem key={o} value={o} className="text-xs">{o}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Conversion status</Label>
                <Select value={convertedFilter} onValueChange={(v) => setConvertedFilter(v as typeof convertedFilter)}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all" className="text-xs">All leads</SelectItem>
                    <SelectItem value="converted" className="text-xs">Converted only</SelectItem>
                    <SelectItem value="unconverted" className="text-xs">Not yet converted</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">Created from</Label>
                  <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="h-8 text-xs" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Created to</Label>
                  <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="h-8 text-xs" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">Budget min</Label>
                  <Input type="number" min="0" value={budgetMin} onChange={(e) => setBudgetMin(e.target.value)} placeholder="0" className="h-8 text-xs" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Budget max</Label>
                  <Input type="number" min="0" value={budgetMax} onChange={(e) => setBudgetMax(e.target.value)} placeholder="No max" className="h-8 text-xs" />
                </div>
              </div>
              {moreFiltersActiveCount > 0 && (
                <Button
                  size="sm" variant="ghost" className="w-full text-xs"
                  onClick={() => { setOwnerFilter("All owners"); setConvertedFilter("all"); setDateFrom(""); setDateTo(""); setBudgetMin(""); setBudgetMax(""); }}
                >
                  Clear these filters
                </Button>
              )}
            </PopoverContent>
          </Popover>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1040px] text-sm">
            <thead>
              <tr className="border-b border-[#E5E7EB] bg-[#F8FAFC] text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                <th className="w-12 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                    aria-label="Select all visible leads"
                    className="h-4 w-4 rounded border-border accent-primary"
                  />
                </th>
                <th className="px-3 py-3">Lead</th>
                <th className="px-3 py-3">Project</th>
                <th className="px-3 py-3">Budget</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Score</th>
                <th className="px-3 py-3">Owner</th>
                <th className="px-3 py-3">Last activity</th>
                <th className="w-14 px-3 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((lead) => {
                const { Icon: ScoreIcon, className: scoreCls } = scoreIcon(lead.score);
                const isSelected = selectedIds.has(lead.id);
                return (
                  <tr
                    key={lead.id}
                    className={cn(
                      "border-b border-[#E5E7EB] transition-colors last:border-0 hover:bg-slate-50/80",
                      isSelected && "bg-blue-50/40",
                    )}
                  >
                    <td className="px-4 py-3.5">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleLeadSelection(lead.id)}
                        aria-label={`Select ${lead.name}`}
                        className="h-4 w-4 rounded border-border accent-primary"
                      />
                    </td>
                    <td className="cursor-pointer px-3 py-3.5" onClick={() => openLead(lead)}>
                      <div className="flex min-w-[210px] items-center gap-3">
                        {/* Live-test stabilization fix: was `lead.contactId
                            || lead.id` — falling back to the LEAD's own id
                            (not a Contact identity at all) when contactId is
                            unset, which seeds the generated fallback avatar
                            from the wrong identity. ContactAvatar already
                            falls back to seeding by `name` when `id` is
                            undefined (see contact-avatar.tsx), which is the
                            correct behavior for a lead with no linked
                            Contact yet — no need to substitute a non-Contact
                            id here. */}
                        <ContactAvatar id={lead.contactId ?? undefined} name={lead.name} avatarUrl={lead.contactAvatarUrl} avatarKey={lead.contactAvatarKey} size="sm" />
                        <div className="min-w-0">
                          <div className="truncate font-medium text-foreground">{lead.name || "Unknown"}</div>
                          <div className="truncate text-xs text-muted-foreground">{lead.email || "No email"}</div>
                          {lead.phone && <div className="truncate text-[11px] text-muted-foreground/80">{lead.phone}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3.5">
                      <div className="max-w-[190px] truncate text-xs font-medium">{lead.projectType || "Not specified"}</div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">{leadSourceLabel(lead.source)}</div>
                    </td>
                    <td className="px-3 py-3.5 text-xs font-medium tabular-nums">{formatMoney(lead.estimatedBudget)}</td>
                    <td className="px-3 py-3.5">
                      {/* Renders lead.rawStatus (the literal DB value) rather
                          than the coerced lead.status, so an unrecognized
                          legacy status (leads.status has no CHECK
                          constraint) still displays honestly instead of
                          silently showing as "New". */}
                      <Badge variant={leadStatusBadgeVariant(lead.rawStatus ?? lead.status)} className="text-[10px] font-medium">
                        {leadStatusLabel(lead.rawStatus ?? lead.status)}
                      </Badge>
                    </td>
                    <td className="px-3 py-3.5">
                      <span className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-white px-2 py-1 text-[11px] font-medium capitalize">
                        <ScoreIcon className={`h-3.5 w-3.5 ${scoreCls}`} />
                        {lead.score}
                      </span>
                    </td>
                    <td className="px-3 py-3.5">
                      <div className="flex min-w-[130px] items-center gap-2">
                        <ContactAvatar id={lead.assignedTo || lead.owner || "unassigned"} name={resolveOwnerName(lead, teamMembers)} size="xs" />
                        <span className="truncate text-xs">{resolveOwnerName(lead, teamMembers)}</span>
                      </div>
                    </td>
                    <td className="px-3 py-3.5 text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(lead.lastActivity), { addSuffix: true })}
                    </td>
                    <td className="px-3 py-3.5 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Actions for ${lead.name}`}>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          <DropdownMenuItem onClick={() => openLead(lead)}>View details</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleEditLead(lead)}>Edit lead</DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <Link to="/estimates" search={{ template: "open", clientName: lead.name }}>Create estimate</Link>
                          </DropdownMenuItem>
                          {lead.status !== "converted" && lead.status !== "lost" && (
                            <DropdownMenuItem onClick={() => handleConvertToDeal(lead)}>Convert to deal</DropdownMenuItem>
                          )}
                          <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setDeleteTarget(lead)}>
                            Delete lead
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-6 py-16 text-center">
                    <div className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-info-soft text-info">
                      <Search className="h-5 w-5" />
                    </div>
                    <div className="mt-3 text-sm font-medium">No leads found</div>
                    <div className="mt-1 text-xs text-muted-foreground">Try adjusting your search or filters.</div>
                    {hasActiveFilters && <Button size="sm" variant="outline" className="mt-4" onClick={clearFilters}>Clear filters</Button>}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#E5E7EB] bg-white px-4 py-3 text-xs text-muted-foreground sm:px-5">
          <span>Showing {filtered.length} of {leads.length} leads</span>
          <span>Click a lead to open the full record</span>
        </div>
      </Card>

      {/* Detail drawer */}
      <LeadDetailDrawer
        lead={selected ? leads.find((l) => l.id === selected.id) ?? selected : null}
        onOpenChange={(o) => { if (!o) navigate({ search: (prev) => ({ ...prev, leadId: undefined }), replace: true }); }}
        onStatusChange={handleStatusChange}
        onConvert={handleConvertToDeal}
        onOpenConvertedDeal={(dealId) => setDealDrawerId(dealId)}
        onEdit={handleEditLead}
        onDelete={(l) => setDeleteTarget(l)}
        teamMembers={teamMembers}
      />

      <ConvertLeadDialog
        lead={convertLead}
        open={convertOpen}
        onOpenChange={setConvertOpen}
        onConverted={handleDealConverted}
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

      {/* Edit lead dialog (Priority 2) — reuses the store's real updateLead()
          for name/email/phone/address/source/projectType/estimatedBudget/
          notes, plus the existing updateLeadStatus()/updateLeadOwner() for
          those two fields specifically (each already has its own dedicated,
          correctly-typed store method — reusing them rather than
          duplicating that logic here). */}
      <Dialog open={editOpen} onOpenChange={(o) => { if (!o) setEditOpen(false); }}>
        <DialogContent
          className="sm:max-w-lg"
          onInteractOutside={(e) => {
            const target = ((e as CustomEvent).detail?.originalEvent?.target ?? e.target) as HTMLElement | null;
            if (target?.closest?.(".pac-container")) e.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Edit Lead</DialogTitle>
            <DialogDescription>Update this lead's details.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Name *</Label>
              <Input value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} placeholder="Full name" />
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input value={editForm.email} onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))} placeholder="email@example.com" />
            </div>
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input value={editForm.phone} onChange={(e) => setEditForm((f) => ({ ...f, phone: formatPhone(e.target.value) }))} placeholder="(555) 123-4567" inputMode="tel" />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Address</Label>
              <AddressAutocomplete
                value={editForm.address}
                onChange={(value) => setEditForm((f) => ({ ...f, address: value }))}
                onSelect={(parts) =>
                  setEditForm((f) => ({
                    ...f,
                    address: [parts.street, parts.city, `${parts.state} ${parts.zip}`].filter(Boolean).join(", "),
                  }))
                }
                placeholder="123 Main St, City, ST"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Source</Label>
              {/* Same 9-value built-in catalog as Add Lead (Step 8 — no
                  separate catalog per form). If this lead's current source
                  is a historical/legacy value outside the 9 (e.g.
                  "advertising", "cold_call"), it's shown as an extra
                  selectable item labeled with its real display text rather
                  than being silently dropped or overwritten — leaving the
                  selector untouched and saving preserves it exactly. */}
              <Select value={editForm.source} onValueChange={(v) => setEditForm((f) => ({ ...f, source: v }))}>
                <SelectTrigger><SelectValue placeholder="Select source" /></SelectTrigger>
                <SelectContent>
                  {ADD_LEAD_SOURCE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                  {editForm.source && !ADD_LEAD_SOURCE_OPTIONS.some((o) => o.value === editForm.source) && (
                    <SelectItem value={editForm.source}>{leadSourceLabel(editForm.source)} (legacy)</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={editForm.status} onValueChange={(v) => setEditForm((f) => ({ ...f, status: v as LeadStatus }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{LEAD_STATUSES.map((s) => <SelectItem key={s} value={s}>{LEAD_STATUS_LABELS[s]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Project Type</Label>
              <Input value={editForm.projectType} onChange={(e) => setEditForm((f) => ({ ...f, projectType: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Estimated Budget</Label>
              <Input type="number" value={editForm.estimatedBudget} onChange={(e) => setEditForm((f) => ({ ...f, estimatedBudget: e.target.value }))} placeholder="50000" />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Owner</Label>
              <Select
                value={editForm.assignedTo || "__unassigned__"}
                onValueChange={(v) => setEditForm((f) => ({ ...f, assignedTo: v === "__unassigned__" ? "" : v }))}
              >
                <SelectTrigger><SelectValue placeholder="Assign owner" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__unassigned__">Unassigned</SelectItem>
                  {/* Active, org-scoped members only (useTeam() is already
                      org-scoped) — an invited/roster member has no real
                      profile id yet, so isn't a valid assigned_to target. */}
                  {teamMembers.filter((m) => m.status === "active").map((m) => (
                    <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Notes</Label>
              <Textarea value={editForm.notes} onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))} rows={3} className="resize-none" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)} disabled={editSaving}>Cancel</Button>
            <Button onClick={handleSaveEdit} disabled={editSaving || !editForm.name.trim()}>
              {editSaving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation (Priority 5 / Phase 9.2 consistency pass) — no
          archive column exists on `leads`; hard delete with confirmation is
          the only implemented option this pass. A converted lead is never
          deletable here — no "delete anyway" escape hatch — the destructive
          action is replaced entirely with an explanation and, when the
          linked deal is still resolvable locally, a direct link to it. */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent>
          {deleteTarget && isDeleteBlockedConverted(deleteTarget) ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Can't delete {deleteTarget.name}</AlertDialogTitle>
                <AlertDialogDescription>{CONVERTED_LEAD_DELETE_MESSAGE}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                {deleteTarget.convertedDealId && deals.some((d) => d.id === deleteTarget.convertedDealId) && (
                  <Button
                    variant="outline"
                    onClick={() => { setDealDrawerId(deleteTarget.convertedDealId!); setDeleteTarget(null); }}
                  >
                    <ExternalLink className="mr-1.5 h-3.5 w-3.5" /> Open deal
                  </Button>
                )}
                <AlertDialogCancel onClick={() => setDeleteTarget(null)}>Close</AlertDialogCancel>
              </AlertDialogFooter>
            </>
          ) : (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {deleteTarget?.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently removes the lead record. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deleteLoading}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  disabled={deleteLoading}
                  onClick={(e) => { e.preventDefault(); handleDeleteLead(); }}
                >
                  {deleteLoading && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk delete confirmation */}
      <AlertDialog open={bulkDeleteConfirmOpen} onOpenChange={setBulkDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedIds.size} lead{selectedIds.size === 1 ? "" : "s"}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the selected lead records. Any already-converted leads in this selection will be
              skipped automatically — their deals are never affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkActionLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={bulkActionLoading}
              onClick={(e) => { e.preventDefault(); handleBulkDelete(); }}
            >
              {bulkActionLoading && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Add lead dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent
          className="sm:max-w-lg"
          onInteractOutside={(e) => {
            const target = ((e as CustomEvent).detail?.originalEvent?.target ?? e.target) as HTMLElement | null;
            if (target?.closest?.(".pac-container")) e.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Add Lead</DialogTitle>
            <DialogDescription>Create a new lead and start qualifying.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Name *</Label>
              <Input value={newLead.name} onChange={(e) => setNewLead((p) => ({ ...p, name: e.target.value }))} placeholder="Full name" />
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input value={newLead.email} onChange={(e) => setNewLead((p) => ({ ...p, email: e.target.value }))} placeholder="email@example.com" />
            </div>
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input value={newLead.phone} onChange={(e) => setNewLead((p) => ({ ...p, phone: formatPhone(e.target.value) }))} placeholder="(555) 123-4567" inputMode="tel" />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Address</Label>
              <AddressAutocomplete
                value={newLead.address}
                onChange={(value) => setNewLead((p) => ({ ...p, address: value }))}
                onSelect={(parts) =>
                  setNewLead((p) => ({
                    ...p,
                    address: [parts.street, parts.city, `${parts.state} ${parts.zip}`]
                      .filter(Boolean)
                      .join(", "),
                  }))
                }
                placeholder="123 Main St, City, ST"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Source</Label>
              <Select value={newLead.source} onValueChange={(v) => setNewLead((p) => ({ ...p, source: v }))}>
                <SelectTrigger><SelectValue placeholder="Select source" /></SelectTrigger>
                <SelectContent>{ADD_LEAD_SOURCE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Score</Label>
              <Select value={newLead.score} onValueChange={(v) => setNewLead((p) => ({ ...p, score: v }))}>
                <SelectTrigger><SelectValue placeholder="Select score" /></SelectTrigger>
                <SelectContent>{ALL_SCORES.map((s) => <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Project Type</Label>
              <Select value={newLead.projectType} onValueChange={(v) => setNewLead((p) => ({ ...p, projectType: v }))}>
                <SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
                <SelectContent>{PROJECT_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Estimated Budget</Label>
              <Input type="number" value={newLead.estimatedBudget} onChange={(e) => setNewLead((p) => ({ ...p, estimatedBudget: e.target.value }))} placeholder="50000" />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Owner</Label>
              {/* Same active, org-scoped member list and id-based value as
                  Edit Lead / bulk owner assignment (Priority 1 / Priority 4
                  consistency). */}
              <Select
                value={newLead.assignedTo || "__unassigned__"}
                onValueChange={(v) => setNewLead((p) => ({ ...p, assignedTo: v === "__unassigned__" ? "" : v }))}
              >
                <SelectTrigger><SelectValue placeholder="Assign owner" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__unassigned__">Unassigned</SelectItem>
                  {teamMembers.filter((m) => m.status === "active").map((m) => (
                    <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Notes</Label>
              <Textarea value={newLead.notes} onChange={(e) => setNewLead((p) => ({ ...p, notes: e.target.value }))} placeholder="Initial notes…" rows={2} className="resize-none" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={handleAddLead} disabled={!newLead.name.trim()}>Add Lead</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Column mapping dialog */}
      <DialogErrorBoundary>
      <Dialog open={mapOpen} onOpenChange={setMapOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Map CSV Columns</DialogTitle>
            <DialogDescription>
              Match your CSV columns to lead fields. {csvTotalRows} row(s) detected.{" "}
              <span className="inline-flex items-center gap-1.5">
                <select
                  className="h-6 rounded border border-input bg-transparent px-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                  value={templateType}
                  onChange={(e) => {
                    const next = e.target.value as TemplateType;
                    setTemplateType(next);
                    if (csvHeaders.length > 0) {
                      setColMapping(autoMapHeaders(csvHeaders, next));
                    }
                  }}
                >
                  <option value="lead">Lead</option>
                  <option value="customer">Customer</option>
                  <option value="job">Job</option>
                </select>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-primary underline underline-offset-2 hover:opacity-80"
                  onClick={() => {
                    const sel = templateType;
                    const templates: Record<string, { headers: string; sample: string; filename: string }> = {
                      lead: {
                        headers: "Name,Email,Phone,Address,Source,Status,Score,Project Type,Est. Budget,Notes,Owner",
                        sample: "Jane Doe,jane@example.com,555-123-4567,123 Main St,Referral,new,warm,Kitchen Remodel,15000,Interested in quote,Alex",
                        filename: "leads-template.csv",
                      },
                      customer: {
                        headers: "Name,Email,Phone,Address,Company,Account Number,Notes",
                        sample: "John Smith,john@acme.com,555-987-6543,456 Oak Ave,Acme Corp,CUST-001,VIP client",
                        filename: "customers-template.csv",
                      },
                      job: {
                        headers: "Job Name,Client,Address,Start Date,End Date,Status,Budget,Notes",
                        sample: "Kitchen Reno,Jane Doe,123 Main St,2026-05-01,2026-06-15,scheduled,25000,Full gut renovation",
                        filename: "jobs-template.csv",
                      },
                    };
                    const t = templates[sel] ?? templates.lead;
                    downloadCSV(`${t.headers}\n${t.sample}`, t.filename);
                  }}
                >
                  <Download className="inline h-3 w-3" />
                  Download template
                </button>
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  <th className="px-3 py-2">Lead Field</th>
                  <th className="px-3 py-2">CSV Column</th>
                  <th className="hidden px-3 py-2 sm:table-cell">Preview</th>
                </tr>
              </thead>
              <tbody>
                {colMapping && LEAD_FIELDS.map((field) => {
                  const mapped = colMapping[field.key];
                  const previewVals = csvPreview.map((row) => mapped >= 0 ? (row[mapped] ?? "") : "").filter(Boolean).slice(0, 2);
                  return (
                    <tr key={field.key} className="border-b border-border last:border-0">
                      <td className="px-3 py-2.5">
                        <span className="font-medium">{field.label}</span>
                        {"required" in field && <span className="ml-1 text-destructive">*</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        <Select
                          value={String(mapped)}
                          onValueChange={(v) => setColMapping((prev) => prev ? { ...prev, [field.key]: Number(v) } : prev)}
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="-1" className="text-xs text-muted-foreground">— Skip —</SelectItem>
                            {csvHeaders.map((h, i) => (
                              <SelectItem key={i} value={String(i)} className="text-xs">{h}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="hidden px-3 py-2.5 sm:table-cell">
                        <span className="line-clamp-1 text-xs text-muted-foreground">
                          {previewVals.length ? previewVals.join(", ") : "—"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* Validation summary */}
          {importValidation && (
            <div className="space-y-2 border-t border-border pt-3">
              <div className="flex items-center gap-4 text-sm">
                <span className="flex items-center gap-1.5 text-emerald-600">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {importValidation.validCount} valid
                </span>
                {importValidation.errors.length > 0 && (
                  <span className="flex items-center gap-4">
                    <span className="flex items-center gap-1.5 text-amber-600">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      {importValidation.errors.length} will be skipped
                    </span>
                    <Button size="sm" variant="ghost" className="ml-auto h-7 text-xs" onClick={downloadErrorReport}>
                      <Download className="mr-1 h-3 w-3" /> Download error report
                    </Button>
                  </span>
                )}
              </div>
              {importValidation.errors.length > 0 && (
                <div className="max-h-32 overflow-y-auto rounded-md border border-border bg-muted/30 p-2">
                  {importValidation.errors.map((err, i) => (
                    <div key={i} className="flex items-start gap-1.5 py-0.5 text-xs text-muted-foreground">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />
                      {err}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setMapOpen(false)} disabled={importChecking}>Cancel</Button>
            <Button onClick={handleConfirmImport} disabled={!colMapping || colMapping.name < 0 || !importValidation?.validCount || importChecking}>
              {importChecking && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {importChecking ? "Checking for duplicates…" : `Import ${importValidation?.validCount ?? 0} Lead${(importValidation?.validCount ?? 0) !== 1 ? "s" : ""}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </DialogErrorBoundary>
    </>
   );
}

/* ---------- Sub-components ---------- */

class DialogErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[CSVMappingDialog] Render error caught:", error.message, "\nComponent stack:", info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          <p className="font-medium">CSV mapping dialog failed to render</p>
          <p className="mt-1 text-xs opacity-80">{this.state.error.message}</p>
          <button
            className="mt-2 text-xs underline"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

type LeadMetricTone = "blue" | "violet" | "red" | "green";

function LeadMetricCard({
  label, value, icon: Icon, tone, series,
}: {
  label: string; value: number; icon: React.ComponentType<{ className?: string }>; tone: LeadMetricTone; series: number[];
}) {
  const tones: Record<LeadMetricTone, { icon: string; tile: string; stroke: string; fill: string }> = {
    blue: { icon: "text-blue-600", tile: "bg-blue-50", stroke: "#3B82F6", fill: "rgba(59,130,246,.10)" },
    violet: { icon: "text-violet-600", tile: "bg-violet-50", stroke: "#8B5CF6", fill: "rgba(139,92,246,.10)" },
    red: { icon: "text-red-500", tile: "bg-red-50", stroke: "#EF4444", fill: "rgba(239,68,68,.08)" },
    green: { icon: "text-emerald-600", tile: "bg-emerald-50", stroke: "#10B981", fill: "rgba(16,185,129,.10)" },
  };
  const palette = tones[tone];
  const max = Math.max(...series, 1);
  const min = Math.min(...series, 0);
  const range = Math.max(max - min, 1);
  const points = series.map((point, index) => {
    const x = (index / Math.max(series.length - 1, 1)) * 100;
    const y = 28 - ((point - min) / range) * 22;
    return `${x},${y}`;
  }).join(" ");
  const area = `0,32 ${points} 100,32`;

  return (
    <div className="flex min-h-[132px] flex-col rounded-2xl border border-[#E2E8F0] bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
      <div className="flex items-center gap-3">
        <div className={cn("grid h-9 w-9 place-items-center rounded-xl", palette.tile)}>
          <Icon className={cn("h-4 w-4", palette.icon)} />
        </div>
        <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">{label}</span>
      </div>
      <div className="mt-3 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      <div className="mt-auto h-8 pt-2" aria-hidden="true">
        <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="h-full w-full overflow-visible">
          <polygon points={area} fill={palette.fill} />
          <polyline points={points} fill="none" stroke={palette.stroke} strokeWidth="1.7" vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
    </div>
  );
}

function FilterSelect({ value, onChange, options, labelFor }: { value: string; onChange: (v: string) => void; options: string[]; labelFor?: (o: string) => string }) {
  const defaultLabel = (o: string) => (o === "new" ? "New" : o === "contacted" ? "Contacted" : o === "qualified" ? "Qualified" : o === "converted" ? "Converted" : o === "lost" ? "Lost" : o);
  const getLabel = labelFor ?? defaultLabel;
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-9 w-auto min-w-[128px] text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o} value={o} className="capitalize text-xs">{getLabel(o)}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Lead Source Filter Enhancement — the source filter's own Select (not the
// generic FilterSelect above) because every row needs a right-aligned
// live count alongside its label, which FilterSelect's plain string
// options don't support. Always renders the complete 9-canonical-source
// catalog (CANONICAL_LEAD_SOURCE_OPTIONS, Paid then Owned — Step 3), never
// derived from which leads currently exist, so a source with 0 leads
// (e.g. Meta Ads before the first Meta lead) still appears and remains
// selectable (Step 9). SelectItem already reserves a pr-8 gutter for its
// built-in checkmark indicator (see components/ui/select.tsx), so the
// label+count flex row here never collides with it (Step 8).
//
// Count alignment fix: Radix's SelectItem renders its content inside
// ItemText — a plain, unstyled <span> with no className of its own (see
// @radix-ui/react-select's SelectItemText, which forwards nothing but the
// raw <Primitive.span>). Left alone, that span shrink-wraps to its own
// content, so a `w-full` on OUR row (nested one level inside it) only
// ever resolves against that shrink-wrapped width — the count ends up
// sitting right next to the label instead of at the dropdown's far
// right edge. `[&>span:last-child]:flex-1` targets ItemText specifically
// (it is always the LAST direct <span> child of SelectItem's own flex
// row — the checkmark indicator span is first, and is itself
// `position:absolute` so it never competes for flex space anyway) and
// makes it a real flex-1 item, so it actually stretches to fill the
// remaining row width after the pr-8 indicator gutter. Only then does
// `flex-1`/`shrink-0` inside our own row correctly push the count to
// that now-real far edge.
const SOURCE_FILTER_ITEM_CLASSNAME = "text-xs [&>span:last-child]:flex-1 [&>span:last-child]:min-w-0";

function SourceFilterOptionRow({ label, count }: { label: string; count: number }) {
  return (
    <span className="flex w-full items-center gap-3">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">{count}</span>
    </span>
  );
}

function SourceFilterSelect({ value, onChange, counts, totalCount }: {
  value: string; onChange: (v: string) => void; counts: Record<string, number>; totalCount: number;
}) {
  const currentLabel = value === "All sources" ? "All Sources" : leadSourceLabel(value);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-9 w-auto min-w-[140px] text-xs">
        <SelectValue>{currentLabel}</SelectValue>
      </SelectTrigger>
      {/* Wide enough that "Google Local Services Ads" (the longest label)
          and its count never collide (Step 7) — no horizontal scrolling. */}
      <SelectContent className="min-w-[300px]">
        <SelectItem value="All sources" className={SOURCE_FILTER_ITEM_CLASSNAME}>
          <SourceFilterOptionRow label="All Sources" count={totalCount} />
        </SelectItem>
        {CANONICAL_LEAD_SOURCE_OPTIONS.map((o, i) => (
          <React.Fragment key={o.value}>
            {/* Subtle Paid / Owned channels separator (Step 13, optional) —
                a non-interactive Radix separator, safe for keyboard nav. */}
            {i === 3 && <SelectSeparator />}
            <SelectItem value={o.value} className={SOURCE_FILTER_ITEM_CLASSNAME}>
              <SourceFilterOptionRow label={o.label} count={counts[o.value] ?? 0} />
            </SelectItem>
          </React.Fragment>
        ))}
      </SelectContent>
    </Select>
  );
}


/* ---------- Detail drawer ---------- */

function LeadDetailDrawer({
  lead,
  onOpenChange,
  onStatusChange,
  onConvert,
  onOpenConvertedDeal,
  onEdit,
  onDelete,
  teamMembers,
}: {
  lead: Lead | null;
  onOpenChange: (open: boolean) => void;
  onStatusChange: (id: string, status: LeadStatus) => void;
  onConvert: (lead: Lead) => void;
  onOpenConvertedDeal: (dealId: string) => void;
  onEdit: (lead: Lead) => void;
  onDelete: (lead: Lead) => void;
  teamMembers: TeamMember[];
}) {
  const allDeals = useDeals();

  if (!lead) return <Sheet open={false} onOpenChange={onOpenChange}><SheetContent className="hidden" /></Sheet>;

  const convertedDeal = lead.convertedDealId ? allDeals.find((d) => d.id === lead.convertedDealId) ?? null : null;
  const { Icon: ScoreIcon, className: scoreCls } = scoreIcon(lead.score);
  const ownerName = resolveOwnerName(lead, teamMembers);
  const nextStatuses: LeadStatus[] = (() => {
    switch (lead.status) {
      case "new": return ["contacted"];
      case "contacted": return ["qualified", "lost"];
      case "qualified": return ["lost"];
      default: return [];
    }
  })();

  return (
    <Sheet open={!!lead} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl [&>button.absolute]:hidden">
        <SheetHeader className="space-y-3 border-b border-border pb-4">
          <div className="flex items-start justify-between gap-3">
            {/* Lead avatar (Contact/Lead avatar consistency fix) — a Lead
                has no avatar of its own; this always resolves from the
                linked Contact (contactId/contactAvatarUrl/contactAvatarKey,
                see leads-store.ts), the same ContactAvatar precedence used
                in Conversations/Contacts/the Leads table row.
                Live-test stabilization fix: previously fell back to the
                LEAD's OWN id when unlinked — seeding the generated avatar
                from a non-Contact identity, forbidden by the avatar audit.
                ContactAvatar already seeds by `name` when `id` is
                undefined, which is the correct behavior here instead. */}
            <div className="flex min-w-0 flex-1 items-start gap-3 text-left">
              <ContactAvatar
                id={lead.contactId ?? undefined}
                name={lead.name}
                avatarUrl={lead.contactAvatarUrl}
                avatarKey={lead.contactAvatarKey}
                size="md"
                className="mt-0.5"
              />
              <div className="min-w-0 flex-1">
                <div className="mb-1.5 flex items-center gap-2">
                  <Badge variant={leadStatusBadgeVariant(lead.rawStatus ?? lead.status)} className="text-[10px]">
                    {leadStatusLabel(lead.rawStatus ?? lead.status)}
                  </Badge>
                  <div className="flex items-center gap-1" title="Automatically estimated from budget and status — not manually saved.">
                    <ScoreIcon className={`h-3.5 w-3.5 ${scoreCls}`} />
                    <span className="text-[11px] capitalize text-muted-foreground">{lead.score}</span>
                  </div>
                </div>
                <SheetTitle className="text-base leading-snug">{lead.name}</SheetTitle>
                <SheetDescription className="mt-0.5 text-xs">
                  {leadSourceLabel(lead.source)} · Owned by {ownerName}
                </SheetDescription>
              </div>
            </div>
            <div className="text-right">
              <div className="text-xl font-semibold tabular-nums">{formatMoney(lead.estimatedBudget)}</div>
              <div className="text-[11px] text-muted-foreground">Est. budget</div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap gap-2">
            {lead.status !== "converted" && lead.status !== "lost" && (
              <Button size="sm" className="flex-1" onClick={() => onConvert(lead)}>
                <ArrowRight className="mr-1.5 h-3.5 w-3.5" /> Convert to Deal
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => onEdit(lead)}>
              <PencilIcon className="mr-1.5 h-3.5 w-3.5" /> Edit
            </Button>
            {nextStatuses.map((ns) => (
              <Button key={ns} size="sm" variant="outline" className="flex-1" onClick={() => onStatusChange(lead.id, ns)}>
                {STATUS_LABELS[ns]}
              </Button>
            ))}
          </div>

          {/* Quick actions */}
          <Button asChild size="sm" variant="outline" className="w-full">
            <Link
              to="/estimates"
              search={{ template: "open", clientName: lead.name }}
            >
              <Sparkles className="mr-1.5 h-3.5 w-3.5 text-primary" />
              <FileText className="mr-1.5 h-3.5 w-3.5" />
              Create estimate from template
            </Link>
          </Button>
          <Button size="sm" variant="ghost" className="w-full text-destructive hover:text-destructive" onClick={() => onDelete(lead)}>
            <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete lead
          </Button>
        </SheetHeader>

        <div className="mt-4 space-y-5">
          {/* Contact info */}
          <section>
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Contact Info</div>
            <div className="space-y-2">
              {lead.email && (
                <div className="flex items-center gap-2 text-sm">
                  <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>{lead.email}</span>
                </div>
              )}
              {lead.phone && (
                <div className="flex items-center gap-2 text-sm">
                  <Phone className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>{lead.phone}</span>
                </div>
              )}
              {lead.address && (
                <div className="flex items-center gap-2 text-sm">
                  <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>{lead.address}</span>
                </div>
              )}
            </div>
          </section>

          {/* Facts */}
          <section className="grid grid-cols-2 gap-3">
            <FactCard icon={User} label="Owner" value={ownerName} />
            <FactCard icon={Target} label="Source" value={leadSourceLabel(lead.source)} />
            <FactCard icon={Building2} label="Project" value={lead.projectType} />
            <FactCard icon={Calendar} label="Created" value={formatDateShort(lead.createdAt)} />
          </section>

          <Separator />

          {/* Lead Score — read-only (Priority 4). This used to be an
              interactive 3-button selector, but clicking it never actually
              persisted anything: leads.score IS a real column, but it's a
              separate AI Center quality metric (always null today, written
              by nothing) — not this hot/warm/cold category. The category
              shown here is purely computed client-side from budget +
              status (classifyScore()) and is recomputed on every data
              refresh, so a manual "change" was silently reverted on the
              next reload. Presenting it as read-only is the honest
              behavior until real AI-driven scoring exists. */}
          <section>
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Lead Score</div>
            <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/30 px-3 py-2">
              <ScoreIcon className={`h-4 w-4 ${scoreCls}`} />
              <span className="text-sm font-medium capitalize">{lead.score}</span>
              <span className="ml-auto text-[10.5px] text-muted-foreground">Computed from budget &amp; status — not manually saved</span>
            </div>
          </section>

          {/* Linked tasks (Phase 10.1) — real tasks.entity_type="lead" rows, shared with the global Tasks page. */}
          <Separator />
          <EntityTasksPanel entityType="lead" entityId={lead.id} entityLabel="lead" />

          {/* Linked appointments (Phase 10.3) — real appointments.entity_type="lead" rows, shared with the global Calendar page. */}
          <Separator />
          <EntityAppointmentsPanel
            entityType="lead"
            entityId={lead.id}
            entityLabel="lead"
            contactName={lead.name}
            contactPhone={lead.phone}
            contactEmail={lead.email}
            address={lead.address}
          />

          {/* Internal Notes */}
          <Separator />
          <InternalNotes leadId={lead.id} />

          {lead.notes && (
            <>
              <Separator />
              <section>
                <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Notes</div>
                <p className="text-sm text-muted-foreground">{lead.notes}</p>
              </section>
            </>
          )}

          {lead.convertedDealId && (
            <>
              <Separator />
              <section>
                <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Converted Deal</div>
                {convertedDeal ? (
                  <button
                    type="button"
                    onClick={() => onOpenConvertedDeal(convertedDeal.id)}
                    className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-card p-3 text-left text-sm transition-colors hover:border-[#EADFC8] hover:bg-[#FAF3E4]/50"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{convertedDeal.name}</p>
                      <p className="text-xs text-muted-foreground">{convertedDeal.stageName} · {formatMoney(convertedDeal.value)}</p>
                    </div>
                    <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </button>
                ) : (
                  <div className="flex items-center gap-2 rounded-md border border-dashed border-border bg-card p-3 text-sm text-muted-foreground">
                    <ExternalLink className="h-3.5 w-3.5" />
                    <span>Linked deal is unavailable — it may have been deleted.</span>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function FactCard({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-card p-2.5">
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3 w-3" /> {label}
      </div>
      <div className="mt-1 truncate text-sm font-medium">{value}</div>
    </div>
  );
}

// Unified shape for display only — merges the pre-existing localStorage
// quick-notes (useLeadNotes/addLeadNote, untouched — still the only
// source the textarea below writes to) with real, org-scoped rows from
// the canonical `notes` table (entity_type: "lead"), which is where
// agent-created notes (e.g. create_follow_up_task's approved output) are
// actually written. Without this merge, an approved agent note would
// insert successfully but never appear here, since this tab previously
// only ever read the localStorage list.
type DisplayNote = { id: string; text: string; createdAt: string; source: "local" | "db" };

function InternalNotes({ leadId }: { leadId: string }) {
  const notes = useLeadNotes(leadId);
  const { notes: dbNotes, loading: dbNotesLoading } = useEntityNotes("lead", leadId);
  const [text, setText] = useState("");

  const handleAdd = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    addLeadNote(leadId, trimmed);
    setText("");
    toast.success("Note added");
  };

  const merged: DisplayNote[] = [
    ...notes.map((n): DisplayNote => ({ id: n.id, text: n.text, createdAt: n.createdAt, source: "local" })),
    ...dbNotes.map((n): DisplayNote => ({ id: n.id, text: n.content, createdAt: n.createdAt, source: "db" })),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const recent = merged.slice(0, 5);

  return (
    <section>
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <StickyNote className="h-3 w-3" /> Internal Notes
      </div>
      <div className="space-y-2">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a quick note…"
          rows={2}
          className="resize-none text-sm"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleAdd();
          }}
        />
        <Button size="sm" variant="outline" className="w-full" onClick={handleAdd} disabled={!text.trim()}>
          Add Note
        </Button>
      </div>
      {recent.length > 0 && (
        <div className="mt-3 max-h-48 space-y-2 overflow-y-auto scrollbar-thin">
          {recent.map((n) => (
            n.source === "local"
              ? <EditableNote key={n.id} note={{ id: n.id, text: n.text, createdAt: n.createdAt }} leadId={leadId} />
              : <ReadOnlyLeadNote key={n.id} text={n.text} createdAt={n.createdAt} />
          ))}
        </div>
      )}
      {dbNotesLoading && merged.length === 0 && (
        <div className="mt-2 text-[11px] text-muted-foreground">Loading notes…</div>
      )}
    </section>
  );
}

function EditableNote({ note, leadId }: { note: { id: string; text: string; createdAt: string }; leadId: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.text);

  const save = () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === note.text) { setEditing(false); return; }
    updateLeadNote(leadId, note.id, trimmed);
    setEditing(false);
    toast.success("Note updated");
  };

  const cancel = () => { setDraft(note.text); setEditing(false); };

  return (
    <div className="rounded-md border border-border bg-card p-2.5">
      {editing ? (
        <div className="space-y-1.5">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            className="resize-none text-sm"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
              if (e.key === "Escape") cancel();
            }}
          />
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" className="h-7 flex-1" onClick={cancel}>
              <XIcon className="mr-1 h-3 w-3" /> Cancel
            </Button>
            <Button size="sm" className="h-7 flex-1" onClick={save} disabled={!draft.trim()}>
              <Check className="mr-1 h-3 w-3" /> Save
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 flex-1 text-sm text-foreground">{note.text}</p>
            <button onClick={() => { setDraft(note.text); setEditing(true); }} className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label="Edit note">
              <Pencil className="h-3 w-3" />
            </button>
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground">
            {formatDistanceToNow(new Date(note.createdAt), { addSuffix: true })}
          </div>
        </>
      )}
    </div>
  );
}

// Read-only display for a real `notes`-table row (entity_type: "lead") —
// e.g. one created by an approved agent action. Not routed through
// EditableNote's edit/save flow, since that only knows how to update the
// separate localStorage note list.
function ReadOnlyLeadNote({ text, createdAt }: { text: string; createdAt: string }) {
  return (
    <div className="rounded-md border border-border bg-card p-2.5">
      <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm text-foreground">{text}</p>
      <div className="mt-1 text-[10px] text-muted-foreground">
        {formatDistanceToNow(new Date(createdAt), { addSuffix: true })}
      </div>
    </div>
  );
}