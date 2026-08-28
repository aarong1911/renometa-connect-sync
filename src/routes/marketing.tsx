// src/routes/marketing.tsx
//
// Phase 14.1 — Campaigns & Messaging Foundation. Replaces the prior
// fully-mocked "Broadcasts" page (localStorage-only, no backend table, no
// real send pipeline — see the now-deleted src/lib/broadcasts-store.ts)
// with real, org-scoped Campaigns backed by the live `campaigns` /
// `campaign_recipients` / `marketing_templates` tables (reconciled, not
// duplicated) plus the new `marketing_segments` table (Supabase,
// RLS-protected — see
// supabase/migrations/20260829_marketing_campaigns_foundation.sql).
//
// User-facing term is "Campaigns" everywhere, never "Broadcasts".

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge, type BadgeTone } from "@/components/ui/status-badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectGroup, SelectLabel, SelectSeparator } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import googleAdsIconUrl from "@/assets/google-ads-icon.svg";
import metaIconUrl from "@/assets/meta-icon.svg";
import {
  Megaphone, Mail, MessageSquare, Send, Calendar as CalendarIcon, Users, Eye,
  MoreHorizontal, Copy, Trash2, X, Clock, CheckCircle2, FileEdit, Plus,
  Sparkles, ChevronRight, ChevronLeft, AlertTriangle, LayoutGrid, Archive,
  Pause, Play, Loader2, BarChart3, MousePointerClick, CircleDollarSign,
  Target, Plug, RefreshCw, AlertCircle, ArrowRight,
} from "lucide-react";
import {
  useMarketingCampaigns, useMarketingTemplates, useMarketingSegments,
  createCampaign, updateCampaignDraft, deleteDraftCampaign,
  duplicateCampaignAsDraft, upsertCampaignFromRow, refreshMarketingCampaigns,
  createTemplate, updateTemplate, deleteTemplate,
  createSegment, updateSegment, deleteSegment,
  type MarketingCampaign, type MarketingTemplate, type MarketingSegment,
  type CampaignChannel, type CampaignStatus,
} from "@/lib/marketing-campaigns-store";
import {
  type AudienceFilters, type AudienceCondition, type ContactCategory,
  CONTACT_CATEGORY_OPTIONS, LEAD_STATUS_OPTIONS,
} from "@/lib/marketing-audience";
import { previewAudience, sendCampaign, cancelCampaign, pauseCampaign, resumeCampaign, type AudiencePreviewResult } from "@/lib/marketing-campaign-client";
import { getBuiltInMarketingTemplates, isBuiltInMarketingTemplateId } from "@/lib/marketing-built-in-templates";
import { renderMergeTags } from "@/lib/marketing-merge-tags";
import { useContacts } from "@/lib/contacts-store";
import { useOrganization } from "@/lib/organization";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import {
  fetchGoogleAdsCampaignPerformance, type GoogleAdsCampaignPerformanceResult,
  fetchGoogleAdsLeadSyncStatus, triggerGoogleAdsLeadSync,
  injectGoogleAdsTestLead,
  fetchGoogleAdsConversionStatus, createGoogleAdsConversionEventTest,
  fetchGoogleAdsConversionActions, fetchGoogleAdsConversionMappings, saveGoogleAdsConversionMapping,
  fetchGoogleAdsConversionEvents, exportGoogleAdsConversionEvent,
  fetchGoogleAdsCampaignCrmOutcomes,
  fetchGoogleAdsCampaignAdGroups, fetchGoogleAdsAdGroupKeywords, fetchGoogleAdsAdGroupSearchTerms,
  fetchGoogleAdsAdGroupCrmOutcomes,
} from "@/lib/google-ads-client";
import {
  formatGoogleAdsCustomerId, formatGoogleAdsCount, formatGoogleAdsSpend, formatGoogleAdsCurrency, formatGoogleAdsCtr,
  formatPlainMoneyValue,
  type GoogleAdsCampaignPerformanceResponse, type GoogleAdsCampaignPerformanceRow,
  type GoogleAdsLeadSyncStatusResponse, type GoogleAdsLeadSyncResultResponse,
  type GoogleAdsTestLeadInjectResponse,
  type GoogleAdsConversionStatusResponse, type GoogleAdsConversionEventType,
  type GoogleAdsConversionAction, deriveSuggestedGoogleAdsConversionMapping,
  EXPECTED_GOOGLE_ADS_CONVERSION_ACTION_NAMES,
  type GoogleAdsConversionEventListRow,
  type GoogleAdsCampaignCrmOutcomesResponse,
  type GoogleAdsAdGroupPerformanceRow, type GoogleAdsKeywordPerformanceRow, type GoogleAdsSearchTermPerformanceRow,
  type GoogleAdsAdGroupCrmOutcomesResponse,
  humanizeGoogleAdsKeywordMatchType,
} from "@/lib/google-ads-format";
import {
  getMetaAdsAccountSummary, getMetaAdsCampaigns, getMetaAdsAdSets, getMetaAdsAds,
  type MetaAdsResult, type MetaAdsDateRangePreset,
  type MetaAdsAccountSummaryResponse, type MetaAdsCampaignsResponse, type MetaAdsAdSetsResponse, type MetaAdsAdsResponse,
  type MetaAdsCampaign, type MetaAdsAdSet, type MetaAdsAd,
} from "@/lib/meta-ads-client";
import { formatMetaAdsCurrency, formatMetaAdsCount, formatMetaAdsPercent, formatMetaAdsObjective, formatMetaAdsOptimizationGoal } from "@/lib/meta-ads-format";

type MarketingSearch = { tab: string; createCampaign: boolean; campaignId: string; editCampaignId: string };

export const Route = createFileRoute("/marketing")({
  validateSearch: (raw: Record<string, unknown>): MarketingSearch => ({
    tab: typeof raw.tab === "string" ? raw.tab : "campaigns",
    createCampaign: raw.createCampaign === true || raw.createCampaign === "true",
    campaignId: typeof raw.campaignId === "string" ? raw.campaignId : "",
    editCampaignId: typeof raw.editCampaignId === "string" ? raw.editCampaignId : "",
  }),
  component: MarketingPage,
});

const MERGE_TAGS = ["first_name", "last_name", "company_name"] as const;

// Sample RECIPIENT fields stay clearly fake — there is no real recipient
// until a campaign actually sends (see splitByChannelEligibility elsewhere
// for why the frontend never has real per-recipient data at compose time).
// company_name is deliberately NOT part of this constant — it comes from
// the actual signed-in organization (useOrganization().companyName) so
// every org sees its own name in the preview, never a hardcoded demo
// business. See MessagePreview below.
const SAMPLE_PERSON_CONTEXT = { first_name: "Sarah", last_name: "Johnson" };
const FALLBACK_COMPANY_NAME = "Your Company";

// Shared between Create Campaign Step 3 (Message) and Step 4 (Review) —
// one rendering implementation, reused rather than duplicated, so the
// Review step can never show a preview that disagrees with Step 3's. Also
// the same renderMergeTags() the real send worker uses (see
// src/lib/marketing-merge-tags.ts) — the preview can never diverge from
// what an actual send would substitute.
function MessagePreview({ channel, subject, body }: { channel: CampaignChannel; subject: string; body: string }) {
  const organization = useOrganization();
  const sampleContext = {
    ...SAMPLE_PERSON_CONTEXT,
    company_name: organization.companyName?.trim() || FALLBACK_COMPANY_NAME,
  };
  return (
    <div className="rounded-lg border bg-muted/20 p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Preview with sample data</div>
      {channel === "email" ? (
        <>
          <div className="text-[11px] text-muted-foreground mb-1">Subject</div>
          <div className="text-sm font-semibold">
            {subject.trim() ? renderMergeTags(subject, sampleContext) : <span className="font-normal text-muted-foreground">No subject yet</span>}
          </div>
          <div className="my-2 border-t" />
          <div className="text-[11px] text-muted-foreground mb-1">Message</div>
          {body.trim() ? (
            <div className="whitespace-pre-wrap text-sm">{renderMergeTags(body, sampleContext)}</div>
          ) : (
            <div className="text-sm text-muted-foreground">Your message preview will appear here.</div>
          )}
        </>
      ) : (
        <>
          <div className="text-[11px] text-muted-foreground mb-2">Sample recipient</div>
          {body.trim() ? (
            <div className="max-w-[85%] rounded-2xl border border-border bg-secondary/70 px-3 py-2 text-sm text-foreground whitespace-pre-wrap">
              {renderMergeTags(body, sampleContext)}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">Start typing to preview your message.</div>
          )}
        </>
      )}
    </div>
  );
}

// CRM Campaigns (Phase 14.1 — Email/SMS/Audiences/Templates) and Paid Ads
// (Google Ads, Meta Ads later) are different product concepts with
// different data sources, lifecycles, and metrics — kept as two top-level
// sections rather than one flat tab row so adding Meta Ads later doesn't
// further crowd a single TabsList. `section` is deliberately DERIVED from
// `tab` rather than tracked as its own search param: every existing
// bookmark/link (?tab=campaigns, ?tab=audiences, ?tab=templates,
// ?tab=google-ads) still lands in the correct section with zero migration.
const CRM_CAMPAIGN_TABS = new Set(["campaigns", "audiences", "templates"]);
type MarketingSection = "crm" | "ads";

function sectionForTab(tab: string): MarketingSection {
  return CRM_CAMPAIGN_TABS.has(tab) ? "crm" : "ads";
}

function MarketingPage() {
  const { tab, createCampaign: composerOpen, campaignId, editCampaignId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const campaigns = useMarketingCampaigns();
  const templates = useMarketingTemplates();
  const segments = useMarketingSegments();
  const contacts = useContacts();

  const section = sectionForTab(tab);
  // Paid Ads provider sub-tab — any value other than "meta-ads" (including
  // a stale/malformed bookmark) falls back to "google-ads" so the inner
  // Tabs can never end up with no matching TabsContent selected.
  const paidAdsProviderTab = tab === "meta-ads" ? "meta-ads" : "google-ads";

  const kpis = useMemo(() => ({
    sent: campaigns.filter((c) => c.status === "completed").length,
    scheduled: campaigns.filter((c) => c.status === "scheduled" || c.status === "queued" || c.status === "sending").length,
    drafts: campaigns.filter((c) => c.status === "draft").length,
    contacts: contacts.length,
  }), [campaigns, contacts]);

  const selectedCampaign = campaigns.find((c) => c.id === campaignId);

  function handleSectionChange(next: MarketingSection) {
    if (next === section) return;
    // Land on each section's natural default tab — never leaves `tab` set
    // to a value from the OTHER section after switching.
    navigate({ search: (p) => ({ ...p, tab: next === "crm" ? "campaigns" : "google-ads" }) });
  }

  return (
    <>
      <PageHeader
        icon={Megaphone}
        iconBg="bg-info-soft"
        iconColor="text-info"
        title="Marketing"
        subtitle="Create campaigns, reach customers, and track engagement from one place."
        actions={
          // "Create Campaign" is a CRM Campaigns action (Email/SMS) — it
          // has no meaning in Paid Ads, where campaigns are only ever
          // created/managed in Google Ads/Meta Ads itself (Step A3).
          section === "crm" ? (
            <Button onClick={() => navigate({ search: (p) => ({ ...p, createCampaign: true }) })}>
              <Plus className="mr-1.5 h-4 w-4" /> Create Campaign
            </Button>
          ) : undefined
        }
      />

      <Tabs value={section} onValueChange={(v) => handleSectionChange(v as MarketingSection)} className="mb-4">
        <TabsList>
          <TabsTrigger value="crm">CRM Campaigns</TabsTrigger>
          <TabsTrigger value="ads">Paid Ads</TabsTrigger>
        </TabsList>
      </Tabs>

      {section === "crm" && (
        <>
          {/* CRM Campaign metrics — never shown above Paid Ads reporting,
              where they'd misleadingly read as describing Google Ads
              (Step A4). Google Ads has its own metric cards inside
              GoogleAdsPerformanceTab. */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mb-6">
            <MetricTile icon={Send} iconBg="bg-success-soft" iconColor="text-success" label="Campaigns sent" value={String(kpis.sent)} sub="Completed sends" />
            <MetricTile icon={Clock} iconBg="bg-info-soft" iconColor="text-info" label="Scheduled campaigns" value={String(kpis.scheduled)} sub="Queued or scheduled" />
            <MetricTile icon={Users} iconBg="bg-cyan-soft" iconColor="text-cyan-soft-foreground" label="CRM contacts" value={kpis.contacts.toLocaleString()} sub="Total eligible audience" />
            <MetricTile icon={FileEdit} iconBg="bg-gold-soft" iconColor="text-gold-hover" label="Draft campaigns" value={String(kpis.drafts)} sub="Not yet sent" />
          </div>

          <Tabs value={tab} onValueChange={(v) => navigate({ search: (p) => ({ ...p, tab: v }) })} className="space-y-4">
            <TabsList>
              <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
              <TabsTrigger value="audiences">Audiences</TabsTrigger>
              <TabsTrigger value="templates">Templates</TabsTrigger>
            </TabsList>

            <TabsContent value="campaigns">
              <CampaignsTable
                campaigns={campaigns}
                segments={segments}
                onOpen={(id) => navigate({ search: (p) => ({ ...p, campaignId: id }) })}
                onEdit={(id) => navigate({ search: (p) => ({ ...p, editCampaignId: id }) })}
                onCompose={() => navigate({ search: (p) => ({ ...p, createCampaign: true }) })}
              />
            </TabsContent>

            <TabsContent value="audiences">
              <AudiencesTab segments={segments} />
            </TabsContent>

            <TabsContent value="templates">
              <TemplatesTab templates={templates} />
            </TabsContent>
          </Tabs>
        </>
      )}

      {section === "ads" && (
        // Provider tab is now URL-driven (?tab=google-ads|meta-ads), same
        // pattern as the CRM Campaigns/Audiences/Templates tabs above —
        // Meta Ads has a real reporting surface as of Phase 1A / Step 3, so
        // it's no longer hardcoded/disabled. Any other `tab` value (or a
        // stale ?tab=campaigns bookmark that somehow reached this section)
        // safely falls back to google-ads via the `paidAdsProviderTab` guard
        // below, so a malformed URL can never render neither tab.
        <Tabs value={paidAdsProviderTab} onValueChange={(v) => navigate({ search: (p) => ({ ...p, tab: v }) })} className="space-y-4">
          <TabsList>
            <TabsTrigger value="google-ads" className="gap-2">
              <img src={googleAdsIconUrl} alt="" aria-hidden="true" className="h-4 w-4 shrink-0" />
              Google Ads
            </TabsTrigger>
            <TabsTrigger value="meta-ads" className="gap-2">
              <img src={metaIconUrl} alt="" aria-hidden="true" className="h-4 w-4 shrink-0" />
              Meta Ads
            </TabsTrigger>
          </TabsList>

          <TabsContent value="google-ads">
            <GoogleAdsPerformanceTab />
          </TabsContent>

          <TabsContent value="meta-ads">
            <MetaAdsPerformanceTab />
          </TabsContent>
        </Tabs>
      )}

      <CreateCampaignSheet
        open={composerOpen || !!editCampaignId}
        editingCampaign={campaigns.find((c) => c.id === editCampaignId) ?? null}
        onClose={() => navigate({ search: (p) => ({ ...p, createCampaign: false, editCampaignId: "" }) })}
        onManageAudiences={() => navigate({ search: (p) => ({ ...p, createCampaign: false, editCampaignId: "", tab: "audiences" }) })}
        onManageTemplates={() => navigate({ search: (p) => ({ ...p, createCampaign: false, editCampaignId: "", tab: "templates" }) })}
        templates={templates}
        segments={segments}
      />
      <CampaignDetailSheet
        campaign={selectedCampaign}
        onEdit={() => navigate({ search: (p) => ({ ...p, campaignId: "", editCampaignId: selectedCampaign?.id ?? "" }) })}
        onClose={() => navigate({ search: (p) => ({ ...p, campaignId: "" }) })}
      />
    </>
  );
}

// ---------- Shared bits ----------

function MetricTile({ icon: Icon, iconBg, iconColor, label, value, sub }: {
  icon: React.ComponentType<{ className?: string }>; iconBg: string; iconColor: string; label: string; value: string; sub: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <div className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-md", iconBg, iconColor)}>
            <Icon className="h-4 w-4" />
          </div>
        </div>
        <p className="mt-1 text-xl font-semibold tabular-nums leading-tight text-foreground">{value}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>
      </CardContent>
    </Card>
  );
}

const CAMPAIGN_STATUS_META: Record<CampaignStatus, { label: string; tone: BadgeTone; icon: React.ComponentType<{ className?: string }> }> = {
  draft:     { label: "Draft",     tone: "muted",   icon: FileEdit },
  scheduled: { label: "Scheduled", tone: "primary", icon: Clock },
  queued:    { label: "Queued",    tone: "primary", icon: Clock },
  sending:   { label: "Sending",   tone: "primary", icon: Send },
  // "warning" — visually distinct from the active/primary states and from
  // the destructive/failed state, but not alarming (a pause is a
  // deliberate, reversible user action, not a problem).
  paused:    { label: "Paused",    tone: "warning", icon: Pause },
  completed: { label: "Completed", tone: "success", icon: CheckCircle2 },
  canceled:  { label: "Canceled",  tone: "muted",   icon: X },
  failed:    { label: "Failed",    tone: "danger",  icon: AlertTriangle },
};

function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  const cfg = CAMPAIGN_STATUS_META[status];
  return <StatusBadge tone={cfg.tone} icon={cfg.icon}>{cfg.label}</StatusBadge>;
}

// Single source of truth for which actions are valid for a given campaign
// status — used by BOTH the row `...` menu and the Campaign Details
// drawer footer, so the two can never disagree about what's allowed for
// the same campaign (Step 17 of the Phase 14.1 campaign-actions task).
// "Edit schedule" for a scheduled campaign is deliberately NOT included —
// there is no trusted backend endpoint that lets an authenticated client
// edit a scheduled campaign's content/audience today (the write-guard
// trigger blocks any client UPDATE once status is out of 'draft', full
// stop), so offering it in the menu would be a UI lie. Retry is
// deliberately not included either — out of scope for this task, needs
// its own idempotency design.
type CampaignAction = "view" | "edit" | "duplicate" | "pause" | "resume" | "cancel" | "delete";

function getCampaignAvailableActions(status: CampaignStatus): CampaignAction[] {
  switch (status) {
    case "draft":
      return ["view", "edit", "duplicate", "delete"];
    case "scheduled":
    case "queued":
      return ["view", "pause", "cancel", "duplicate"];
    case "sending":
      // Pause is allowed here (see marketing-campaign-pause.ts — it never
      // touches an already-claimed recipient, it only stops NEW ones from
      // being claimed). Cancel is deliberately NOT offered while sending —
      // a provider attempt may be in flight and the existing cancel
      // backend already refuses this status. No delete, ever, once a
      // campaign has left draft.
      return ["view", "pause", "duplicate"];
    case "paused":
      return ["view", "resume", "cancel", "duplicate"];
    case "completed":
    case "failed":
    case "canceled":
      return ["view", "duplicate"];
    default:
      return ["view", "duplicate"];
  }
}

function ChannelBadge({ channel }: { channel: CampaignChannel }) {
  const Icon = channel === "email" ? Mail : MessageSquare;
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
      <Icon className="h-3.5 w-3.5" /> {channel === "email" ? "Email" : "SMS"}
    </span>
  );
}

// ---------- Campaigns tab ----------

// Shared handlers so the row menu and the Campaign Details drawer footer
// call the exact same logic, not two independently-written copies that
// could drift (Step 17). `onClose` is optional — the drawer passes one to
// dismiss itself after a delete; the row menu doesn't need it.
async function handlePauseCampaign(c: MarketingCampaign, setBusy: (v: boolean) => void) {
  setBusy(true);
  try {
    const res = await pauseCampaign(c.id);
    upsertCampaignFromRow(res.campaign);
    toast.success("Campaign paused");
  } catch (err: any) {
    toast.error(err.message ?? "Failed to pause campaign");
  } finally {
    setBusy(false);
  }
}

async function handleResumeCampaign(c: MarketingCampaign, setBusy: (v: boolean) => void) {
  setBusy(true);
  try {
    const res = await resumeCampaign(c.id);
    upsertCampaignFromRow(res.campaign);
    toast.success("Campaign resumed");
  } catch (err: any) {
    toast.error(err.message ?? "Failed to resume campaign");
  } finally {
    setBusy(false);
  }
}

async function handleCancelCampaign(c: MarketingCampaign, setBusy: (v: boolean) => void) {
  setBusy(true);
  try {
    const res = await cancelCampaign(c.id);
    upsertCampaignFromRow(res.campaign);
    toast.success("Campaign canceled");
  } catch (err: any) {
    toast.error(err.message ?? "Failed to cancel campaign");
  } finally {
    setBusy(false);
  }
}

// Delete only ever targets a draft — if the row has moved on since the
// menu was opened (e.g. scheduled from another tab a moment earlier),
// deleteDraftCampaign's own status=draft guard matches zero rows and this
// refreshes the list + reports the conflict rather than pretending it
// worked (Step 3: never force-delete).
async function handleDeleteDraftCampaign(c: MarketingCampaign, onDone?: () => void) {
  const result = await deleteDraftCampaign(c.id);
  if (result.ok) {
    toast.success("Draft deleted");
    onDone?.();
    return;
  }
  if (result.notFoundOrNotDraft) {
    toast.error("This campaign is no longer a draft — refreshing");
    await refreshMarketingCampaigns();
  } else {
    toast.error("Failed to delete draft");
  }
}

function CampaignsTable({ campaigns, segments, onOpen, onEdit, onCompose }: {
  campaigns: MarketingCampaign[]; segments: MarketingSegment[]; onOpen: (id: string) => void; onEdit: (id: string) => void; onCompose: () => void;
}) {
  const segmentName = (id: string | null) => segments.find((s) => s.id === id)?.name ?? "Custom filters";
  const [deleteTarget, setDeleteTarget] = useState<MarketingCampaign | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (campaigns.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <Megaphone className="h-10 w-10 text-muted-foreground" />
          <div>
            <h3 className="text-sm font-semibold">No campaigns yet</h3>
            <p className="text-xs text-muted-foreground">Create an email or SMS campaign for your existing leads and customers.</p>
          </div>
          <Button onClick={onCompose}><Plus className="mr-1.5 h-4 w-4" /> Create Campaign</Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[28%]">Campaign</TableHead>
              <TableHead>Channel</TableHead>
              <TableHead>Audience</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Recipients</TableHead>
              <TableHead className="text-right">Sent</TableHead>
              <TableHead className="text-right">Failed</TableHead>
              <TableHead className="text-right">Excluded</TableHead>
              <TableHead className="w-[40px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {campaigns.map((c) => {
              const actions = getCampaignAvailableActions(c.status);
              const busy = busyId === c.id;
              return (
                <TableRow key={c.id} className="cursor-pointer" onClick={() => onOpen(c.id)}>
                  <TableCell>
                    <div className="font-medium text-sm line-clamp-1">{c.name}</div>
                  </TableCell>
                  <TableCell><ChannelBadge channel={c.channel} /></TableCell>
                  <TableCell className="text-xs text-muted-foreground">{c.segmentId ? segmentName(c.segmentId) : "Custom filters"}</TableCell>
                  <TableCell>
                    <CampaignStatusBadge status={c.status} />
                    {c.status === "scheduled" && c.scheduledAt && (
                      <div className="text-[11px] text-muted-foreground mt-1">{new Date(c.scheduledAt).toLocaleString()}</div>
                    )}
                    {c.status === "completed" && c.completedAt && (
                      <div className="text-[11px] text-muted-foreground mt-1">{new Date(c.completedAt).toLocaleDateString()}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{c.recipientsTotal || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{c.status === "draft" ? "—" : c.recipientsSent}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{c.status === "draft" ? "—" : c.recipientsFailed}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{c.status === "draft" ? "—" : c.recipientsExcluded}</TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7" disabled={busy}>
                          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => onOpen(c.id)}><Eye className="mr-2 h-4 w-4" /> View details</DropdownMenuItem>
                        {actions.includes("edit") && (
                          <DropdownMenuItem onClick={() => onEdit(c.id)}><FileEdit className="mr-2 h-4 w-4" /> Edit draft</DropdownMenuItem>
                        )}
                        {actions.includes("pause") && (
                          <DropdownMenuItem onClick={() => handlePauseCampaign(c, (v) => setBusyId(v ? c.id : null))}>
                            <Pause className="mr-2 h-4 w-4" /> Pause campaign
                          </DropdownMenuItem>
                        )}
                        {actions.includes("resume") && (
                          <DropdownMenuItem onClick={() => handleResumeCampaign(c, (v) => setBusyId(v ? c.id : null))}>
                            <Play className="mr-2 h-4 w-4" /> Resume campaign
                          </DropdownMenuItem>
                        )}
                        {actions.includes("cancel") && (
                          <DropdownMenuItem onClick={() => handleCancelCampaign(c, (v) => setBusyId(v ? c.id : null))}>
                            <X className="mr-2 h-4 w-4" /> Cancel campaign
                          </DropdownMenuItem>
                        )}
                        {actions.includes("duplicate") && (
                          <DropdownMenuItem onClick={async () => { const d = await duplicateCampaignAsDraft(c); if (d) toast.success("Duplicated as draft"); }}>
                            <Copy className="mr-2 h-4 w-4" /> Duplicate
                          </DropdownMenuItem>
                        )}
                        {actions.includes("delete") && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setDeleteTarget(c)}>
                              <Trash2 className="mr-2 h-4 w-4" /> Delete campaign
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete campaign?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes this draft campaign. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteTarget(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async (e) => {
                e.preventDefault();
                if (deleteTarget) await handleDeleteDraftCampaign(deleteTarget);
                setDeleteTarget(null);
              }}
            >
              Delete Campaign
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ---------- Audience filter form (shared by Audiences tab + Create Campaign step 2) ----------

function getCondition<T extends AudienceCondition["field"]>(conditions: AudienceCondition[], field: T) {
  return conditions.find((c) => c.field === field) as Extract<AudienceCondition, { field: T }> | undefined;
}

function setCondition(conditions: AudienceCondition[], next: AudienceCondition | null, field: AudienceCondition["field"]): AudienceCondition[] {
  const rest = conditions.filter((c) => c.field !== field);
  return next ? [...rest, next] : rest;
}

function AudienceFilterForm({ filters, onChange }: { filters: AudienceFilters; onChange: (f: AudienceFilters) => void }) {
  const conditions = filters.conditions;
  const category = getCondition(conditions, "contact_category");
  const leadStatus = getCondition(conditions, "lead_status");
  const tags = getCondition(conditions, "tags");
  const addressContains = getCondition(conditions, "address_contains");
  const createdAfter = getCondition(conditions, "created_after");

  const update = (next: AudienceCondition | null, field: AudienceCondition["field"]) =>
    onChange({ conditions: setCondition(conditions, next, field) });

  const toggleCategory = (value: ContactCategory) => {
    const current = category?.value ?? [];
    const nextValue = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    update(nextValue.length ? { field: "contact_category", operator: "in", value: nextValue } : null, "contact_category");
  };

  const toggleLeadStatus = (value: string) => {
    const current = leadStatus?.value ?? [];
    const nextValue = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    update(nextValue.length ? { field: "lead_status", operator: "in", value: nextValue } : null, "lead_status");
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <Label>Contact type</Label>
        <div className="flex flex-wrap gap-3">
          {CONTACT_CATEGORY_OPTIONS.map((opt) => (
            <label key={opt.value} className="flex items-center gap-1.5 text-sm">
              <Checkbox checked={(category?.value ?? []).includes(opt.value)} onCheckedChange={() => toggleCategory(opt.value)} />
              {opt.label}
            </label>
          ))}
        </div>
      </div>

      <div className="grid gap-2">
        <Label>Lead status</Label>
        <div className="flex flex-wrap gap-3">
          {LEAD_STATUS_OPTIONS.map((s) => (
            <label key={s} className="flex items-center gap-1.5 text-sm capitalize">
              <Checkbox checked={(leadStatus?.value ?? []).includes(s)} onCheckedChange={() => toggleLeadStatus(s)} />
              {s}
            </label>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-2">
          <Label>Tags (comma-separated)</Label>
          <Input
            defaultValue={(tags?.value ?? []).join(", ")}
            onBlur={(e) => {
              const value = e.target.value.split(",").map((t) => t.trim()).filter(Boolean);
              update(value.length ? { field: "tags", operator: "has_any", value } : null, "tags");
            }}
            placeholder="e.g. kitchen, vip"
          />
        </div>
        <div className="grid gap-2">
          <Label>Address contains</Label>
          <Input
            defaultValue={addressContains?.value ?? ""}
            onBlur={(e) => update(e.target.value.trim() ? { field: "address_contains", operator: "contains", value: e.target.value.trim() } : null, "address_contains")}
            placeholder="e.g. Austin"
          />
        </div>
      </div>

      <div className="grid gap-2">
        <Label>Created after</Label>
        <Input
          type="date"
          className="w-fit"
          defaultValue={createdAfter?.value ? createdAfter.value.slice(0, 10) : ""}
          onChange={(e) => update(e.target.value ? { field: "created_after", operator: "gte", value: new Date(e.target.value).toISOString() } : null, "created_after")}
        />
      </div>
    </div>
  );
}

function useAudiencePreview(filters: AudienceFilters, channel: CampaignChannel, segmentId?: string) {
  const [result, setResult] = useState<AudiencePreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    // Clear any previous channel/audience's resolved rows immediately —
    // otherwise a channel/audience switch would briefly show the PREVIOUS
    // selection's recipients underneath the loading indicator (Phase 14.1
    // Review-step review, item 7: never show stale recipient data from a
    // different channel/audience while resolving the new one).
    setResult(null);
    setError(false);
    setLoading(true);
    previewAudience({ channel, segmentId, filters: segmentId ? undefined : filters })
      .then((r) => { if (!cancelled) { setResult(r); setError(false); } })
      .catch(() => { if (!cancelled) { setResult(null); setError(true); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(filters), channel, segmentId, retryTick]);
  return { result, loading, error, retry: () => setRetryTick((t) => t + 1) };
}

// One row shape for both eligible and excluded rows — reason is null for
// an eligible row (rendered as "—"), never a frontend-invented label; it
// is always the exact canonical string marketing-audience-preview.ts
// returned (e.g. "Unsubscribed", "SMS opted out", "SMS eligibility not
// established" — never re-worded here).
type RecipientPreviewRow = { id: string; name: string; destination: string | null; eligible: boolean; reason: string | null };

function buildRecipientPreviewRows(preview: AudiencePreviewResult | null): RecipientPreviewRow[] {
  if (!preview) return [];
  return [
    ...preview.eligiblePreview.map((c): RecipientPreviewRow => ({ id: c.id, name: c.name, destination: c.destination, eligible: true, reason: null })),
    ...preview.excludedPreview.map((c): RecipientPreviewRow => ({ id: c.id, name: c.name, destination: c.destination, eligible: false, reason: c.reason })),
  ];
}

// Review-step resolved-recipient preview (Phase 14.1) — shows EXACTLY who
// the same server-side resolver (shared with marketing-campaign-send.ts,
// see marketing-audience-preview.ts's header) would use if submitted right
// now. Purely informational/safety UI, never itself the source of the
// recipient list actually sent — see handleSubmit, which only ever posts
// campaignId/mode/segmentId/filters, never a client-enumerated recipient
// list. Added after a real test campaign resolved to an unexpected
// contact because the saved-audience name alone wasn't proof of who it
// actually matched — this makes the true resolved set visible before the
// user can commit to Send/Schedule.
function RecipientPreviewSection({ preview, loading, error, onRetry }: {
  preview: AudiencePreviewResult | null; loading: boolean; error: boolean; onRetry: () => void;
}) {
  const rows = buildRecipientPreviewRows(preview);
  const shownCount = rows.length;
  const totalCount = (preview?.eligibleCount ?? 0) + (preview?.excludedCount ?? 0);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label>Recipients</Label>
        {!loading && !error && preview && (
          <span className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{preview.eligibleCount}</span> eligible ·{" "}
            <span className="font-medium text-foreground">{preview.excludedCount}</span> excluded ·{" "}
            <span className="font-medium text-foreground">{totalCount}</span> total
          </span>
        )}
      </div>

      {loading && (
        <div className="rounded-lg border p-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Resolving recipients…
        </div>
      )}

      {!loading && error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 space-y-2">
          <p className="text-sm text-destructive">Unable to resolve recipients.</p>
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>Retry</Button>
        </div>
      )}

      {!loading && !error && preview && (
        <>
          <div className="rounded-lg border max-h-64 overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Destination</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-xs text-muted-foreground py-6">
                      No contacts matched this audience.
                    </TableCell>
                  </TableRow>
                ) : rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-xs max-w-[140px] truncate" title={r.name}>{r.name}</TableCell>
                    <TableCell className="text-xs max-w-[180px] truncate" title={r.destination ?? undefined}>{r.destination ?? "—"}</TableCell>
                    <TableCell>
                      {/* icon + text label, not color alone, conveys status */}
                      <StatusBadge tone={r.eligible ? "success" : "muted"} icon={r.eligible ? CheckCircle2 : X}>
                        {r.eligible ? "Eligible" : "Excluded"}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.reason ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {shownCount < totalCount && (
            <p className="text-[11px] text-muted-foreground">Showing first {shownCount} of {totalCount} recipients</p>
          )}
        </>
      )}
    </div>
  );
}

// ---------- Audiences tab ----------

function AudiencesTab({ segments }: { segments: MarketingSegment[] }) {
  const [editing, setEditing] = useState<MarketingSegment | "new" | null>(null);

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button variant="outline" size="sm" onClick={() => setEditing("new")}><Plus className="mr-1.5 h-3.5 w-3.5" /> Create Audience</Button>
      </div>
      {segments.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <LayoutGrid className="h-10 w-10 text-muted-foreground" />
            <div>
              <h3 className="text-sm font-semibold">No saved audiences yet</h3>
              <p className="text-xs text-muted-foreground">Save a filtered set of contacts to reuse across campaigns.</p>
            </div>
            <Button onClick={() => setEditing("new")}><Plus className="mr-1.5 h-4 w-4" /> Create Audience</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {segments.map((s) => <AudienceCard key={s.id} segment={s} onEdit={() => setEditing(s)} />)}
        </div>
      )}
      <AudienceEditorSheet segment={editing === "new" ? null : editing} open={editing !== null} onClose={() => setEditing(null)} />
    </>
  );
}

function AudienceCard({ segment, onEdit }: { segment: MarketingSegment; onEdit: () => void }) {
  const { result, loading } = useAudiencePreview(segment.filters, "email");
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <CardTitle className="text-sm font-semibold">{segment.name}</CardTitle>
          <Badge variant="secondary" className="bg-primary-soft text-primary">
            {loading ? "…" : (result?.totalMatched ?? 0).toLocaleString()}
          </Badge>
        </div>
        <CardDescription className="text-xs">{segment.filters.conditions.length} filter{segment.filters.conditions.length === 1 ? "" : "s"} · updated {new Date(segment.updatedAt).toLocaleDateString()}</CardDescription>
      </CardHeader>
      <CardContent className="pt-0 flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onEdit}>Edit</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={async () => { await createSegment({ name: `${segment.name} (copy)`, filters: segment.filters }); toast.success("Audience duplicated"); }}>
              <Copy className="mr-2 h-4 w-4" /> Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={async () => { await deleteSegment(segment.id); toast.success("Audience deleted"); }}>
              <Trash2 className="mr-2 h-4 w-4" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardContent>
    </Card>
  );
}

function AudienceEditorSheet({ segment, open, onClose }: { segment: MarketingSegment | null; open: boolean; onClose: () => void }) {
  const [name, setName] = useState(segment?.name ?? "");
  const [filters, setFilters] = useState<AudienceFilters>(segment?.filters ?? { conditions: [] });
  useEffect(() => { setName(segment?.name ?? ""); setFilters(segment?.filters ?? { conditions: [] }); }, [segment, open]);
  const { result, loading } = useAudiencePreview(filters, "email");

  async function handleSave() {
    if (!name.trim()) { toast.error("Give this audience a name"); return; }
    if (segment) {
      await updateSegment(segment.id, { name, filters });
      toast.success("Audience updated");
    } else {
      await createSegment({ name, filters });
      toast.success("Audience created");
    }
    onClose();
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{segment ? "Edit audience" : "Create Audience"}</SheetTitle>
          <SheetDescription>Filter existing CRM contacts into a reusable audience.</SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-4">
          <div className="grid gap-2">
            <Label>Audience name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Past customers in Austin" />
          </div>
          <AudienceFilterForm filters={filters} onChange={setFilters} />
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs flex items-center gap-2">
            <Users className="h-3.5 w-3.5 text-primary" />
            <span><span className="font-medium text-foreground">{loading ? "…" : (result?.totalMatched ?? 0)}</span> matching contacts</span>
          </div>
        </div>
        <SheetFooter className="mt-6 flex !justify-between border-t pt-4">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave}>Save Audience</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// ---------- Templates tab ----------

function TemplatesTab({ templates }: { templates: MarketingTemplate[] }) {
  const [editing, setEditing] = useState<MarketingTemplate | "new" | null>(null);
  const active = templates.filter((t) => !t.isArchived);

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button variant="outline" size="sm" onClick={() => setEditing("new")}><Plus className="mr-1.5 h-3.5 w-3.5" /> Create Template</Button>
      </div>
      {active.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <Sparkles className="h-10 w-10 text-muted-foreground" />
            <div>
              <h3 className="text-sm font-semibold">No templates yet</h3>
              <p className="text-xs text-muted-foreground">Save a reusable Email or SMS message for future campaigns.</p>
            </div>
            <Button onClick={() => setEditing("new")}><Plus className="mr-1.5 h-4 w-4" /> Create Template</Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Template</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="w-[40px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {active.map((t) => (
                <TableRow key={t.id} className="cursor-pointer" onClick={() => setEditing(t)}>
                  <TableCell className="font-medium text-sm">{t.name}</TableCell>
                  <TableCell><ChannelBadge channel={t.channel} /></TableCell>
                  <TableCell className="text-xs text-muted-foreground">{t.emailSubject ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{new Date(t.updatedAt).toLocaleDateString()}</TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setEditing(t)}><FileEdit className="mr-2 h-4 w-4" /> Edit</DropdownMenuItem>
                        <DropdownMenuItem onClick={async () => { await createTemplate({ name: `${t.name} (copy)`, channel: t.channel, emailSubject: t.emailSubject ?? undefined, body: t.body }); toast.success("Template duplicated"); }}>
                          <Copy className="mr-2 h-4 w-4" /> Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={async () => { await updateTemplate(t.id, { isArchived: true }); toast.success("Template archived"); }}>
                          <Archive className="mr-2 h-4 w-4" /> Archive
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={async () => { await deleteTemplate(t.id); toast.success("Template deleted"); }}>
                          <Trash2 className="mr-2 h-4 w-4" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      <TemplateEditorSheet template={editing === "new" ? null : editing} open={editing !== null} onClose={() => setEditing(null)} />
    </>
  );
}

function TemplateEditorSheet({ template, open, onClose }: { template: MarketingTemplate | null; open: boolean; onClose: () => void }) {
  const [name, setName] = useState(template?.name ?? "");
  const [channel, setChannel] = useState<CampaignChannel>(template?.channel ?? "email");
  const [subject, setSubject] = useState(template?.emailSubject ?? "");
  const [body, setBody] = useState(template?.body ?? "");
  useEffect(() => {
    setName(template?.name ?? ""); setChannel(template?.channel ?? "email");
    setSubject(template?.emailSubject ?? ""); setBody(template?.body ?? "");
  }, [template, open]);

  async function handleSave() {
    if (!name.trim()) { toast.error("Give this template a name"); return; }
    if (channel === "email" && !subject.trim()) { toast.error("Email subject is required"); return; }
    if (!body.trim()) { toast.error("Message body cannot be empty"); return; }
    if (template) {
      await updateTemplate(template.id, { name, emailSubject: channel === "email" ? subject : null, body });
      toast.success("Template updated");
    } else {
      await createTemplate({ name, channel, emailSubject: subject, body });
      toast.success("Template created");
    }
    onClose();
  }

  const SMS_LIMIT = 160;

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{template ? "Edit template" : "Create Template"}</SheetTitle>
          <SheetDescription>Reusable Email or SMS message for Campaigns.</SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-4">
          <div className="grid gap-2">
            <Label>Template name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Review request" />
          </div>
          {!template && (
            <div className="grid gap-2">
              <Label>Channel</Label>
              <Select value={channel} onValueChange={(v) => setChannel(v as CampaignChannel)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="sms">SMS</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {channel === "email" && (
            <div className="grid gap-2">
              <Label>Subject</Label>
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject line — merge tags allowed" />
            </div>
          )}
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label>{channel === "email" ? "Email body" : "SMS message"}</Label>
              {channel === "sms" && <span className="text-xs text-muted-foreground">{body.length} / {SMS_LIMIT}</span>}
            </div>
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={channel === "email" ? 10 : 5} className="font-mono text-sm" />
            <div className="flex flex-wrap gap-1">
              {MERGE_TAGS.map((t) => (
                <button key={t} type="button" onClick={() => setBody((b) => `${b}{{${t}}}`)} className="rounded-md border border-dashed border-border px-1.5 py-0.5 text-[11px] font-mono text-muted-foreground hover:bg-secondary hover:text-foreground">
                  {`{{${t}}}`}
                </button>
              ))}
            </div>
          </div>
        </div>
        <SheetFooter className="mt-6 flex !justify-between border-t pt-4">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave}>Save Template</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// ---------- Google Ads tab (Phase 3, Step 5) ----------
//
// Read-only paid-media reporting from the live Google Ads API — entirely
// separate from CRM Email/SMS Campaigns above (Phase 14.1): different data
// source (Google Ads API vs. campaigns/campaign_recipients), different
// lifecycle (no pause/resume/duplicate/delete — Google Ads campaigns are
// only ever managed in Google Ads itself), and deliberately not merged
// into CampaignsTable's rows or actions. Uses the real
// google-ads-campaign-performance endpoint only — no fake/sample rows or
// metrics anywhere in this section.

function useGoogleAdsCampaignPerformance() {
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<GoogleAdsCampaignPerformanceResult | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // Clear any previously-loaded result immediately so a retry (or a
    // revisit of this tab) never shows the PREVIOUS fetch's connected
    // state/metrics underneath the loading skeleton (Step 9: never flash
    // fake zeros, fake connected state, or a previous account's metrics).
    setResult(null);
    setLoading(true);
    fetchGoogleAdsCampaignPerformance()
      .then((r) => { if (!cancelled) setResult(r); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [retryTick]);

  return { loading, result, retry: () => setRetryTick((t) => t + 1) };
}

function GoogleAdsEmptyStateCard({ icon: Icon, title, description, action }: {
  icon: React.ComponentType<{ className?: string }>; title: string; description: string; action?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
        <div className="grid h-12 w-12 place-items-center rounded-full bg-secondary">
          <Icon className="h-5 w-5 text-muted-foreground" />
        </div>
        <div>
          <div className="text-sm font-medium">{title}</div>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
        </div>
        {action}
      </CardContent>
    </Card>
  );
}

function GoogleAdsIntegrationsLinkButton({ children }: { children: React.ReactNode }) {
  return (
    <Button asChild size="sm" className="mt-2">
      <Link to="/settings/integrations">
        <Plug className="mr-1.5 h-3.5 w-3.5" /> {children}
      </Link>
    </Button>
  );
}

function GoogleAdsPerformanceSkeleton() {
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <Skeleton className="h-9 w-9 rounded-lg" />
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-48" />
          </div>
        </CardContent>
      </Card>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="p-4 space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-6 w-16" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardContent className="p-4">
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}

function GoogleAdsAccountHeader({ data }: { data: GoogleAdsCampaignPerformanceResponse }) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-3 p-4">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-secondary ring-1 ring-black/5">
          <BarChart3 className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">Google Ads</span>
            <StatusBadge tone="success" icon={CheckCircle2}>Connected</StatusBadge>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            Account {formatGoogleAdsCustomerId(data.customerId) || data.customerId} · Last 30 days
            {data.timeZone && <span className="text-muted-foreground/70"> · {data.timeZone}</span>}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// Shared section header for every Google Ads section below this point
// (Campaigns, Google Ads Leads, Conversion Feedback, Conversion Events,
// Offline Conversion Mapping) — one consistent title/subtitle treatment
// instead of each section carrying its own slightly different CardHeader
// className. Symmetric `py-4` (rather than the previous ad hoc `pb-2`,
// which left 24px of top padding against only 8px of bottom padding) is
// what makes the title/subtitle group read as centered inside the header
// band instead of pushed toward its bottom border. Pairs with each
// section's `<CardContent className="pt-4 ...">` so the header→content
// gap is even too. The same two-piece pattern (this header + a `pt-4`
// CardContent) is what a future Meta Ads tab would reuse — kept as a
// small local helper rather than a bigger shared abstraction, since this
// is the only piece that was genuinely duplicated five times.
function GoogleAdsSectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <CardHeader className="py-4">
      <CardTitle className="text-sm font-semibold leading-none">{title}</CardTitle>
      <CardDescription className="text-xs">{description}</CardDescription>
    </CardHeader>
  );
}

function GoogleAdsMetricCards({ summary, currencyCode }: {
  summary: GoogleAdsCampaignPerformanceResponse["summary"]; currencyCode: string | null;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <MetricTile icon={Eye} iconBg="bg-info-soft" iconColor="text-info" label="Impressions" value={formatGoogleAdsCount(summary.impressions)} sub="Last 30 days" />
      <MetricTile icon={MousePointerClick} iconBg="bg-cyan-soft" iconColor="text-cyan-soft-foreground" label="Clicks" value={formatGoogleAdsCount(summary.clicks)} sub="Last 30 days" />
      <MetricTile icon={CircleDollarSign} iconBg="bg-gold-soft" iconColor="text-gold-hover" label="Spend" value={formatGoogleAdsSpend(summary.costMicros, currencyCode)} sub="Last 30 days" />
      <MetricTile icon={Target} iconBg="bg-success-soft" iconColor="text-success" label="Conversions" value={summary.conversions.toLocaleString(undefined, { maximumFractionDigits: 2 })} sub="Last 30 days" />
      <MetricTile icon={Sparkles} iconBg="bg-violet-soft" iconColor="text-violet" label="Conversion value" value={formatGoogleAdsCurrency(summary.conversionValue, currencyCode)} sub="Last 30 days" />
    </div>
  );
}

// ── Campaign health (Step 17, product-facing) — deterministic, derived
// ONLY from metrics already returned by google-ads-campaign-performance.ts
// (impressions/clicks/conversions). No judgment calls like "wasting
// money" — just a factual read of whether a campaign is serving, getting
// clicks, or converting. `impressions`/`clicks` are base-10 digit strings
// (never coerced through Number() for equality — comparing against the
// literal "0" avoids any large-value precision concern, matching the same
// policy already used elsewhere for these fields).
type GoogleAdsCampaignHealth = "no_activity" | "traffic_no_conversions" | "converting";

function deriveGoogleAdsCampaignHealth(campaign: GoogleAdsCampaignPerformanceRow): GoogleAdsCampaignHealth {
  if (campaign.impressions === "0") return "no_activity";
  if (campaign.conversions > 0) return "converting";
  return "traffic_no_conversions";
}

const CAMPAIGN_HEALTH_META: Record<GoogleAdsCampaignHealth, { label: string; tone: BadgeTone }> = {
  no_activity: { label: "No activity", tone: "muted" },
  traffic_no_conversions: { label: "Traffic, no conversions", tone: "warning" },
  converting: { label: "Converting", tone: "success" },
};

// Google Ads campaign.status enum (ENABLED/PAUSED/REMOVED) — a plain,
// factual tone mapping, not a health judgment (that's CAMPAIGN_HEALTH_META
// above, a separate concept: a REMOVED campaign and a PAUSED campaign are
// both just... not enabled, regardless of any activity they once had).
const CAMPAIGN_STATUS_TONE: Record<string, BadgeTone> = {
  ENABLED: "success",
  PAUSED: "warning",
  REMOVED: "muted",
};

function GoogleAdsCampaignStatusBadge({ status }: { status: string | null }) {
  const tone = (status && CAMPAIGN_STATUS_TONE[status]) || "muted";
  return <StatusBadge tone={tone}>{status ?? "—"}</StatusBadge>;
}

function GoogleAdsCampaignTable({ campaigns, currencyCode, customerId, dateRange }: {
  campaigns: GoogleAdsCampaignPerformanceRow[]; currencyCode: string | null; customerId: string; dateRange: string;
}) {
  // Campaign row interaction (Step 2) — clicking a row (or its name
  // button/link, for keyboard access) opens the read-only detail Sheet for
  // that exact campaign. Never refetches campaign performance — the
  // selected row's data is already fully loaded from the table above.
  const [selectedCampaign, setSelectedCampaign] = useState<GoogleAdsCampaignPerformanceRow | null>(null);

  return (
    <Card>
      <GoogleAdsSectionHeader title="Campaigns" description="Performance for campaigns in the selected Google Ads account." />
      {campaigns.length === 0 ? (
        <CardContent className="flex flex-col items-center gap-2 pt-4 py-16 text-center">
          <BarChart3 className="h-10 w-10 text-muted-foreground" />
          <div>
            <h3 className="text-sm font-semibold">No campaigns found for this Google Ads account</h3>
            <p className="text-xs text-muted-foreground">Performance will appear here when this account has campaign activity.</p>
          </div>
        </CardContent>
      ) : (
        <CardContent className="pt-4">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[26%]">Campaign</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Activity</TableHead>
                  <TableHead className="text-right">Impressions</TableHead>
                  <TableHead className="text-right">Clicks</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                  <TableHead className="text-right">Conversions</TableHead>
                  <TableHead className="text-right">Conversion value</TableHead>
                  <TableHead className="w-[32px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.map((c) => {
                  const health = CAMPAIGN_HEALTH_META[deriveGoogleAdsCampaignHealth(c)];
                  return (
                    <TableRow
                      key={c.campaignId}
                      className="cursor-pointer"
                      onClick={() => setSelectedCampaign(c)}
                    >
                      <TableCell className="max-w-[220px] text-sm" title={c.name}>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setSelectedCampaign(c); }}
                          className="truncate text-left font-medium hover:underline focus:underline focus:outline-none"
                        >
                          {c.name}
                        </button>
                      </TableCell>
                      <TableCell><GoogleAdsCampaignStatusBadge status={c.status} /></TableCell>
                      <TableCell><StatusBadge tone={health.tone}>{health.label}</StatusBadge></TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{formatGoogleAdsCount(c.impressions)}</TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{formatGoogleAdsCount(c.clicks)}</TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{formatGoogleAdsSpend(c.costMicros, currencyCode)}</TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{c.conversions.toLocaleString(undefined, { maximumFractionDigits: 2 })}</TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{formatGoogleAdsCurrency(c.conversionValue, currencyCode)}</TableCell>
                      <TableCell className="text-right">
                        <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      )}

      <GoogleAdsCampaignDetailSheet
        campaign={selectedCampaign}
        customerId={customerId}
        dateRange={dateRange}
        currencyCode={currencyCode}
        open={selectedCampaign !== null}
        onClose={() => setSelectedCampaign(null)}
      />
    </Card>
  );
}

// ── Campaign Detail Sheet (Google Ads product phase) ────────────────────
// Read-only. No editor, no Save button, no mutation control of any kind —
// this is strictly a combined view of live Google Ads campaign performance
// (already loaded, never refetched here) plus a small async fetch of
// RenoMeta CRM outcomes attributed to this exact campaign.

function useGoogleAdsCampaignCrmOutcomes(campaign: GoogleAdsCampaignPerformanceRow | null) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<GoogleAdsCampaignCrmOutcomesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    if (!campaign) { setData(null); setError(null); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchGoogleAdsCampaignCrmOutcomes({ campaignId: campaign.campaignId, campaignName: campaign.name }).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setData(result.data);
      } else {
        setData(null);
        setError("Unable to load CRM outcomes right now.");
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign?.campaignId, campaign?.name, retryTick]);

  return { loading, data, error, retry: () => setRetryTick((t) => t + 1) };
}

function GoogleAdsSheetMetric({ label, value, caption }: { label: string; value: string; caption?: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-semibold tabular-nums text-foreground">{value}</p>
      {caption && <p className="mt-0.5 text-[10px] text-muted-foreground">{caption}</p>}
    </div>
  );
}

// Ad Group / Keyword / Search Term drill-down (Campaign Detail Sheet phase)
// — internal Sheet state only, never a route/second Sheet/second drawer
// (see the task's "why not a second drawer" rationale). Deliberately kept
// as one flat useState-per-field set inside the Sheet component itself
// rather than a reducer/store — the whole tree resets together every time
// the Sheet opens or the selected campaign changes (Step 28), and nothing
// here needs to survive the Sheet closing.
type GoogleAdsCampaignDetailTab = "overview" | "ad-groups";
type GoogleAdsAdGroupSubTab = "keywords" | "search-terms";

function GoogleAdsCampaignDetailSheet({ campaign, customerId, dateRange, currencyCode, open, onClose }: {
  campaign: GoogleAdsCampaignPerformanceRow | null;
  customerId: string;
  dateRange: string;
  currencyCode: string | null;
  open: boolean;
  onClose: () => void;
}) {
  // Only fetches while a campaign is actually selected+open — closing the
  // Sheet (campaign becomes null via onClose) tears the fetch state down,
  // so reopening on a DIFFERENT campaign never briefly shows the previous
  // campaign's stale outcomes (Step 15/Step 24E).
  const { loading, data, error, retry } = useGoogleAdsCampaignCrmOutcomes(open ? campaign : null);

  const [activeTab, setActiveTab] = useState<GoogleAdsCampaignDetailTab>("overview");

  const [adGroups, setAdGroups] = useState<GoogleAdsAdGroupPerformanceRow[] | null>(null);
  const [adGroupsLoading, setAdGroupsLoading] = useState(false);
  const [adGroupsError, setAdGroupsError] = useState<string | null>(null);

  const [selectedAdGroup, setSelectedAdGroup] = useState<GoogleAdsAdGroupPerformanceRow | null>(null);
  const [adGroupSubTab, setAdGroupSubTab] = useState<GoogleAdsAdGroupSubTab>("keywords");

  const [keywords, setKeywords] = useState<GoogleAdsKeywordPerformanceRow[] | null>(null);
  const [keywordsLoading, setKeywordsLoading] = useState(false);
  const [keywordsError, setKeywordsError] = useState<string | null>(null);

  const [searchTerms, setSearchTerms] = useState<GoogleAdsSearchTermPerformanceRow[] | null>(null);
  const [searchTermsLoading, setSearchTermsLoading] = useState(false);
  const [searchTermsError, setSearchTermsError] = useState<string | null>(null);

  // Ad Group-Level CRM Outcomes phase — separate loading/error/data state
  // from Keywords/Search Terms, exactly like Overview's own CRM outcomes
  // are separate from its Google Ads performance grid (Step 22: only this
  // section shows a loading skeleton, never Ad Group performance/Keywords/
  // Search Terms). A small in-session cache (keyed by adGroupId, cleared
  // by the same reset effect as everything else below) avoids refetching
  // when the user backs out of an ad group and reopens the SAME one
  // (Step 24) — not a global cache framework, just a plain Map scoped to
  // this Sheet instance's lifetime.
  const [adGroupCrmOutcomes, setAdGroupCrmOutcomes] = useState<GoogleAdsAdGroupCrmOutcomesResponse | null>(null);
  const [adGroupCrmOutcomesLoading, setAdGroupCrmOutcomesLoading] = useState(false);
  const [adGroupCrmOutcomesError, setAdGroupCrmOutcomesError] = useState<string | null>(null);
  const adGroupCrmOutcomesCacheRef = useRef<Map<string, GoogleAdsAdGroupCrmOutcomesResponse>>(new Map());

  // Campaign-switch / reopen reset (Step 28, Test H) — fires on every fresh
  // open (including reopening the SAME campaign) and on switching to a
  // DIFFERENT campaign while already open, so no Ad Group/Keyword/Search
  // Term state from a previous campaign (or a previous look at the same
  // one) ever bleeds into the next view. Overview's own CRM-outcomes fetch
  // is handled separately by useGoogleAdsCampaignCrmOutcomes above and is
  // NOT refetched by this reset (Step 17 — Overview must not be
  // rerequested just because the Ad Groups tab was touched).
  useEffect(() => {
    if (!open) return;
    setActiveTab("overview");
    setAdGroups(null); setAdGroupsLoading(false); setAdGroupsError(null);
    setSelectedAdGroup(null); setAdGroupSubTab("keywords");
    setKeywords(null); setKeywordsLoading(false); setKeywordsError(null);
    setSearchTerms(null); setSearchTermsLoading(false); setSearchTermsError(null);
    setAdGroupCrmOutcomes(null); setAdGroupCrmOutcomesLoading(false); setAdGroupCrmOutcomesError(null);
    adGroupCrmOutcomesCacheRef.current.clear();
  }, [campaign?.campaignId, open]);

  const loadAdGroups = useCallback(() => {
    if (!campaign) return;
    setAdGroupsLoading(true);
    setAdGroupsError(null);
    fetchGoogleAdsCampaignAdGroups({ campaignId: campaign.campaignId }).then((result) => {
      if (result.ok) {
        setAdGroups(result.data.adGroups);
      } else {
        setAdGroups(null);
        setAdGroupsError("Unable to load ad groups right now.");
      }
      setAdGroupsLoading(false);
    });
  }, [campaign?.campaignId]);

  const loadKeywords = useCallback((adGroup: GoogleAdsAdGroupPerformanceRow) => {
    if (!campaign) return;
    setKeywordsLoading(true);
    setKeywordsError(null);
    fetchGoogleAdsAdGroupKeywords({ campaignId: campaign.campaignId, adGroupId: adGroup.adGroupId }).then((result) => {
      if (result.ok) {
        setKeywords(result.data.keywords);
      } else {
        setKeywords(null);
        setKeywordsError("Unable to load keywords right now.");
      }
      setKeywordsLoading(false);
    });
  }, [campaign?.campaignId]);

  const loadSearchTerms = useCallback((adGroup: GoogleAdsAdGroupPerformanceRow) => {
    if (!campaign) return;
    setSearchTermsLoading(true);
    setSearchTermsError(null);
    fetchGoogleAdsAdGroupSearchTerms({ campaignId: campaign.campaignId, adGroupId: adGroup.adGroupId }).then((result) => {
      if (result.ok) {
        setSearchTerms(result.data.searchTerms);
      } else {
        setSearchTerms(null);
        setSearchTermsError("Unable to load search terms right now.");
      }
      setSearchTermsLoading(false);
    });
  }, [campaign?.campaignId]);

  // Ad Group-Level CRM Outcomes fetch — checks the in-session cache first
  // (Step 24); `force` bypasses it (used by the section's own Retry
  // button so a real retry never just re-serves a stale cached failure —
  // though a failure is never cached in the first place, see below).
  const loadAdGroupCrmOutcomes = useCallback((adGroup: GoogleAdsAdGroupPerformanceRow, opts?: { force?: boolean }) => {
    if (!campaign) return;
    const cached = !opts?.force ? adGroupCrmOutcomesCacheRef.current.get(adGroup.adGroupId) : undefined;
    if (cached) {
      setAdGroupCrmOutcomes(cached);
      setAdGroupCrmOutcomesError(null);
      setAdGroupCrmOutcomesLoading(false);
      return;
    }
    setAdGroupCrmOutcomesLoading(true);
    setAdGroupCrmOutcomesError(null);
    fetchGoogleAdsAdGroupCrmOutcomes({ campaignId: campaign.campaignId, adGroupId: adGroup.adGroupId }).then((result) => {
      if (result.ok) {
        adGroupCrmOutcomesCacheRef.current.set(adGroup.adGroupId, result.data);
        setAdGroupCrmOutcomes(result.data);
      } else {
        // A failure is deliberately never cached — so a Retry (or simply
        // reopening this ad group later) gets a genuine fresh attempt
        // instead of permanently re-serving the same error for the rest
        // of the Sheet session.
        setAdGroupCrmOutcomes(null);
        setAdGroupCrmOutcomesError("Unable to load CRM outcomes right now.");
      }
      setAdGroupCrmOutcomesLoading(false);
    });
  }, [campaign?.campaignId]);

  // Lazy loading (Step 27) — Ad Groups is only ever fetched the first time
  // the tab is actually clicked, never on Sheet open.
  const handleTabChange = (value: string) => {
    const tab = value as GoogleAdsCampaignDetailTab;
    setActiveTab(tab);
    if (tab === "ad-groups" && adGroups === null && !adGroupsLoading) {
      loadAdGroups();
    }
  };

  // Clicking an Ad Group row switches the SAME Sheet into an internal
  // detail view (Step 19) — no second Sheet/drawer, no navigation away.
  // Keywords and CRM outcomes both load immediately (Keywords is the
  // default sub-tab; CRM outcomes is its own always-visible section);
  // Search Terms stays lazy until that sub-tab is actually opened.
  const openAdGroup = (adGroup: GoogleAdsAdGroupPerformanceRow) => {
    setSelectedAdGroup(adGroup);
    setAdGroupSubTab("keywords");
    setKeywords(null); setKeywordsError(null);
    setSearchTerms(null); setSearchTermsError(null);
    setAdGroupCrmOutcomes(null); setAdGroupCrmOutcomesError(null);
    loadKeywords(adGroup);
    loadAdGroupCrmOutcomes(adGroup);
  };

  const handleAdGroupSubTabChange = (value: string) => {
    const tab = value as GoogleAdsAdGroupSubTab;
    setAdGroupSubTab(tab);
    if (tab === "search-terms" && searchTerms === null && !searchTermsLoading && selectedAdGroup) {
      loadSearchTerms(selectedAdGroup);
    }
  };

  if (!campaign) return null;
  const health = CAMPAIGN_HEALTH_META[deriveGoogleAdsCampaignHealth(campaign)];
  const dateRangeLabel = dateRange === "LAST_30_DAYS" ? "Last 30 days" : dateRange;

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      {/* Widened for the Ad Group Detail phase (Keywords/Search Terms
          tables need real room — the previous sm:max-w-lg (~512px) forced
          horizontal scrolling on the standard 8-column Keyword table at
          normal desktop widths). sm:max-w-2xl (672px) covers small/medium
          desktop; lg:max-w-[800px] is the actual target width on full
          desktop — still a drawer, never 100vw, so the page stays visible
          behind it. Below `sm`, w-full is unchanged (full-width, fully
          responsive on mobile). */}
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl lg:max-w-[800px]">
        {selectedAdGroup ? (
          <GoogleAdsAdGroupDetailView
            campaignId={campaign.campaignId}
            campaignName={campaign.name}
            adGroup={selectedAdGroup}
            currencyCode={currencyCode}
            dateRangeLabel={dateRangeLabel}
            subTab={adGroupSubTab}
            onSubTabChange={handleAdGroupSubTabChange}
            keywords={keywords}
            keywordsLoading={keywordsLoading}
            keywordsError={keywordsError}
            onRetryKeywords={() => loadKeywords(selectedAdGroup)}
            searchTerms={searchTerms}
            searchTermsLoading={searchTermsLoading}
            searchTermsError={searchTermsError}
            onRetrySearchTerms={() => loadSearchTerms(selectedAdGroup)}
            crmOutcomes={adGroupCrmOutcomes}
            crmOutcomesLoading={adGroupCrmOutcomesLoading}
            crmOutcomesError={adGroupCrmOutcomesError}
            onRetryCrmOutcomes={() => loadAdGroupCrmOutcomes(selectedAdGroup, { force: true })}
            onBack={() => setSelectedAdGroup(null)}
          />
        ) : (
          <>
            <SheetHeader>
              <SheetTitle className="pr-6">
                <span className="block truncate text-base">{campaign.name}</span>
              </SheetTitle>
              <div className="flex flex-wrap items-center gap-2">
                <GoogleAdsCampaignStatusBadge status={campaign.status} />
                <StatusBadge tone={health.tone}>{health.label}</StatusBadge>
              </div>
              <SheetDescription className="text-xs">
                Google Ads · Account {formatGoogleAdsCustomerId(customerId) || customerId} · {dateRangeLabel}
              </SheetDescription>
            </SheetHeader>

            <Tabs value={activeTab} onValueChange={handleTabChange} className="pt-3">
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="ad-groups">Ad Groups</TabsTrigger>
              </TabsList>

              <TabsContent value="overview" className="space-y-5 pt-4">
                <div>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Google Ads performance</h4>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <GoogleAdsSheetMetric label="Impressions" value={formatGoogleAdsCount(campaign.impressions)} />
                    <GoogleAdsSheetMetric label="Clicks" value={formatGoogleAdsCount(campaign.clicks)} />
                    <GoogleAdsSheetMetric label="CTR" value={formatGoogleAdsCtr(campaign.clicks, campaign.impressions)} />
                    <GoogleAdsSheetMetric label="Spend" value={formatGoogleAdsSpend(campaign.costMicros, currencyCode)} />
                    <GoogleAdsSheetMetric label="Conversions" value={campaign.conversions.toLocaleString(undefined, { maximumFractionDigits: 2 })} />
                    <GoogleAdsSheetMetric label="Conversion value" value={formatGoogleAdsCurrency(campaign.conversionValue, currencyCode)} />
                  </div>
                </div>

                <div>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">RenoMeta CRM outcomes</h4>
                  {loading ? (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
                    </div>
                  ) : error ? (
                    <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                      <span>{error}</span>
                      <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={retry}>Retry</Button>
                    </div>
                  ) : data ? (
                    <>
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                        <GoogleAdsSheetMetric label="Leads" value={String(data.outcomes.leads)} />
                        <GoogleAdsSheetMetric label="Qualified" value={String(data.outcomes.qualifiedLeads)} />
                        <GoogleAdsSheetMetric label="Appointments" value={String(data.outcomes.appointments)} />
                        <GoogleAdsSheetMetric label="Won deals" value={String(data.outcomes.wonDeals)} />
                        {/* "Won value", never "Revenue" — no confirmed
                            organization-wide canonical currency field exists yet
                            (see google-ads-campaign-crm-outcomes.ts). This
                            Google Ads account itself reports currencyCode "ILS"
                            — deliberately NEVER used to label a CRM deal value,
                            since it's an advertiser setting, not proof of what
                            currency deals.value is actually recorded in.
                            formatPlainMoneyValue() never prints a currency
                            symbol/code at all (unlike formatMoney(), which
                            hardcodes "$"/USD) — see lib/google-ads-format.ts. */}
                        <GoogleAdsSheetMetric
                          label="Won value"
                          value={data.outcomes.wonDeals > 0 ? formatPlainMoneyValue(data.outcomes.wonValue) : "—"}
                          caption={data.outcomes.wonDeals > 0 ? "Currency not configured" : undefined}
                        />
                      </div>
                      {data.outcomes.leads > 0 && (
                        // Deep-links into the Leads page with the Google Ads
                        // source preselected, plus this exact campaign's context
                        // (Google Ads Campaign -> CRM Leads Deep Link phase).
                        // Sends BOTH campaignId and campaignName whenever both
                        // are known — NOT campaignName-only-when-campaignId-
                        // absent. This does not make campaignName authoritative;
                        // campaign_id exact match still wins server-side (see
                        // google-ads-campaign-lead-ids.ts). It exists purely so
                        // local/legacy submission rows with campaign_id IS NULL
                        // (e.g. the Phase3 dev-fixture rows, which only ever
                        // recorded a campaign_name) can still be matched via the
                        // documented name-fallback path once the real campaign
                        // now has a live campaignId — omitting campaignName here
                        // would silently exclude those rows even though the
                        // existing fallback rule was designed to catch them.
                        // Never renders a nested lead list inside this Sheet —
                        // the Leads page remains the single canonical CRM lead
                        // workspace.
                        // RenoMeta Global UI Interaction System — "View CRM
                        // Leads" is a warm-neutral navigation CTA, not a
                        // plain outline button (see .claude/skills/
                        // ui-design-system/SKILL.md).
                        <Button asChild variant="neutral" size="sm" className="mt-4">
                          <Link
                            to="/leads"
                            search={{
                              source: "google_ads",
                              campaignId: campaign.campaignId || undefined,
                              campaignName: campaign.name || undefined,
                            }}
                          >
                            View CRM Leads
                            <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                          </Link>
                        </Button>
                      )}
                      {data.attributionMode === "campaign_name_fallback" && (
                        <p className="mt-2 text-[11px] text-muted-foreground">
                          Attributed by campaign name — these provider records have no campaign ID (expected for local dev/test fixtures only).
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">No CRM outcomes yet.</p>
                  )}
                </div>
              </TabsContent>

              <TabsContent value="ad-groups" className="pt-4">
                <GoogleAdsAdGroupsTabContent
                  adGroups={adGroups}
                  loading={adGroupsLoading}
                  error={adGroupsError}
                  currencyCode={currencyCode}
                  onRetry={loadAdGroups}
                  onSelect={openAdGroup}
                />
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// Compact status badge reused for Ad Group / Keyword criterion status —
// ENABLED/PAUSED/REMOVED share the exact same tone mapping already
// established for campaigns (CAMPAIGN_STATUS_TONE above).
function GoogleAdsEntityStatusBadge({ status }: { status: string | null }) {
  const tone = (status && CAMPAIGN_STATUS_TONE[status]) || "muted";
  return <StatusBadge tone={tone}>{status ?? "—"}</StatusBadge>;
}

function GoogleAdsAdGroupsTabContent({ adGroups, loading, error, currencyCode, onRetry, onSelect }: {
  adGroups: GoogleAdsAdGroupPerformanceRow[] | null;
  loading: boolean;
  error: string | null;
  currencyCode: string | null;
  onRetry: () => void;
  onSelect: (adGroup: GoogleAdsAdGroupPerformanceRow) => void;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
        <span>{error}</span>
        <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={onRetry}>Retry</Button>
      </div>
    );
  }
  if (!adGroups || adGroups.length === 0) {
    return <p className="text-xs text-muted-foreground">No ad groups found for this campaign.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-xs">Ad Group</TableHead>
            <TableHead className="text-xs">Status</TableHead>
            <TableHead className="text-right text-xs">Impressions</TableHead>
            <TableHead className="text-right text-xs">Clicks</TableHead>
            <TableHead className="text-right text-xs">CTR</TableHead>
            <TableHead className="text-right text-xs">Spend</TableHead>
            <TableHead className="text-right text-xs">Conversions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {adGroups.map((ag) => (
            <TableRow key={ag.adGroupId}>
              <TableCell className="text-xs font-medium">
                {/* Button, not a bare onClick row (Step 33) — real keyboard
                    focus + hover/focus-visible underline affordance. */}
                <button
                  type="button"
                  onClick={() => onSelect(ag)}
                  className="rounded-sm text-left text-foreground underline-offset-2 hover:text-primary hover:underline focus-visible:text-primary focus-visible:underline focus-visible:outline-none"
                >
                  {ag.name}
                </button>
              </TableCell>
              <TableCell><GoogleAdsEntityStatusBadge status={ag.status} /></TableCell>
              <TableCell className="text-right tabular-nums text-xs">{formatGoogleAdsCount(ag.impressions)}</TableCell>
              <TableCell className="text-right tabular-nums text-xs">{formatGoogleAdsCount(ag.clicks)}</TableCell>
              <TableCell className="text-right tabular-nums text-xs">{formatGoogleAdsCtr(ag.clicks, ag.impressions)}</TableCell>
              <TableCell className="text-right tabular-nums text-xs">{formatGoogleAdsSpend(ag.costMicros, currencyCode)}</TableCell>
              <TableCell className="text-right tabular-nums text-xs">{ag.conversions.toLocaleString(undefined, { maximumFractionDigits: 2 })}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function GoogleAdsAdGroupDetailView({
  campaignId, campaignName, adGroup, currencyCode, dateRangeLabel, subTab, onSubTabChange,
  keywords, keywordsLoading, keywordsError, onRetryKeywords,
  searchTerms, searchTermsLoading, searchTermsError, onRetrySearchTerms,
  crmOutcomes, crmOutcomesLoading, crmOutcomesError, onRetryCrmOutcomes,
  onBack,
}: {
  campaignId: string;
  campaignName: string;
  adGroup: GoogleAdsAdGroupPerformanceRow;
  currencyCode: string | null;
  dateRangeLabel: string;
  subTab: GoogleAdsAdGroupSubTab;
  onSubTabChange: (value: string) => void;
  keywords: GoogleAdsKeywordPerformanceRow[] | null;
  keywordsLoading: boolean;
  keywordsError: string | null;
  onRetryKeywords: () => void;
  searchTerms: GoogleAdsSearchTermPerformanceRow[] | null;
  searchTermsLoading: boolean;
  searchTermsError: string | null;
  onRetrySearchTerms: () => void;
  crmOutcomes: GoogleAdsAdGroupCrmOutcomesResponse | null;
  crmOutcomesLoading: boolean;
  crmOutcomesError: string | null;
  onRetryCrmOutcomes: () => void;
  onBack: () => void;
}) {
  return (
    <>
      <SheetHeader>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mb-1 h-7 w-fit px-2 text-xs text-muted-foreground hover:text-foreground"
          onClick={onBack}
        >
          <ChevronLeft className="mr-1 h-3.5 w-3.5" /> Back to Ad Groups
        </Button>
        <SheetTitle className="pr-6">
          <span className="block truncate text-base">{adGroup.name}</span>
        </SheetTitle>
        <div className="flex flex-wrap items-center gap-2">
          <GoogleAdsEntityStatusBadge status={adGroup.status} />
        </div>
        <SheetDescription className="text-xs">
          Campaign: {campaignName} · {dateRangeLabel}
        </SheetDescription>
      </SheetHeader>

      <div className="space-y-5 py-4">
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Google Ads performance</h4>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <GoogleAdsSheetMetric label="Impressions" value={formatGoogleAdsCount(adGroup.impressions)} />
            <GoogleAdsSheetMetric label="Clicks" value={formatGoogleAdsCount(adGroup.clicks)} />
            <GoogleAdsSheetMetric label="CTR" value={formatGoogleAdsCtr(adGroup.clicks, adGroup.impressions)} />
            <GoogleAdsSheetMetric label="Spend" value={formatGoogleAdsSpend(adGroup.costMicros, currencyCode)} />
            <GoogleAdsSheetMetric label="Conversions" value={adGroup.conversions.toLocaleString(undefined, { maximumFractionDigits: 2 })} />
            <GoogleAdsSheetMetric label="Conversion value" value={formatGoogleAdsCurrency(adGroup.conversionValue, currencyCode)} />
          </div>
        </div>

        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">RenoMeta CRM outcomes</h4>
          {crmOutcomesLoading ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : crmOutcomesError ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
              <span>{crmOutcomesError}</span>
              <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={onRetryCrmOutcomes}>Retry</Button>
            </div>
          ) : crmOutcomes ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <GoogleAdsSheetMetric label="Leads" value={String(crmOutcomes.outcomes.leads)} />
              <GoogleAdsSheetMetric label="Qualified" value={String(crmOutcomes.outcomes.qualifiedLeads)} />
              <GoogleAdsSheetMetric label="Appointments" value={String(crmOutcomes.outcomes.appointments)} />
              <GoogleAdsSheetMetric label="Won deals" value={String(crmOutcomes.outcomes.wonDeals)} />
              {/* Same currency-silent policy as Campaign Overview's Won
                  value — no canonical organization-wide CRM currency exists
                  yet, so this never prints a fabricated symbol/code. */}
              <GoogleAdsSheetMetric
                label="Won value"
                value={crmOutcomes.outcomes.wonDeals > 0 ? formatPlainMoneyValue(crmOutcomes.outcomes.wonValue) : "—"}
                caption={crmOutcomes.outcomes.wonDeals > 0 ? "Currency not configured" : undefined}
              />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No CRM outcomes yet.</p>
          )}
          {crmOutcomes && (
            // Ad Group -> CRM Leads Deep Link phase — visible whenever CRM
            // outcomes have successfully loaded, REGARDLESS of lead count
            // (Zero-Lead Ad Group CTA fix). A zero-lead Ad Group is still a
            // valid CRM filter context — the current Phase3 fixture has
            // ad_group_id = null, so an honest 0-lead result is exactly
            // what this deep link should surface, not something to hide.
            // Only gated on `crmOutcomes` being non-null (i.e. loading
            // finished without error) — never on `outcomes.leads > 0`.
            // adGroupName is display-only on the Leads page (Step 27
            // there) — this Link never sends anything that would be used
            // for server-side attribution beyond adGroupId itself.
            <Button asChild variant="neutral" size="sm" className="mt-4">
              <Link
                to="/leads"
                search={{
                  source: "google_ads",
                  campaignId: campaignId || undefined,
                  campaignName: campaignName || undefined,
                  adGroupId: adGroup.adGroupId || undefined,
                  adGroupName: adGroup.name || undefined,
                }}
              >
                View CRM Leads
                <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
              </Link>
            </Button>
          )}
        </div>

        <Tabs value={subTab} onValueChange={onSubTabChange}>
          <TabsList>
            <TabsTrigger value="keywords">Keywords</TabsTrigger>
            <TabsTrigger value="search-terms">Search Terms</TabsTrigger>
          </TabsList>

          <TabsContent value="keywords" className="pt-3">
            <GoogleAdsKeywordsTabContent
              keywords={keywords}
              loading={keywordsLoading}
              error={keywordsError}
              currencyCode={currencyCode}
              onRetry={onRetryKeywords}
            />
          </TabsContent>

          <TabsContent value="search-terms" className="pt-3">
            <p className="mb-2 text-[11px] text-muted-foreground">
              Actual searches that triggered ads during the selected date range.
            </p>
            <GoogleAdsSearchTermsTabContent
              searchTerms={searchTerms}
              loading={searchTermsLoading}
              error={searchTermsError}
              currencyCode={currencyCode}
              onRetry={onRetrySearchTerms}
            />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}

function GoogleAdsKeywordsTabContent({ keywords, loading, error, currencyCode, onRetry }: {
  keywords: GoogleAdsKeywordPerformanceRow[] | null;
  loading: boolean;
  error: string | null;
  currencyCode: string | null;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
        <span>{error}</span>
        <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={onRetry}>Retry</Button>
      </div>
    );
  }
  if (!keywords || keywords.length === 0) {
    return <p className="text-xs text-muted-foreground">No keywords found for this ad group.</p>;
  }
  return (
    // overflow-x-auto stays as a safety fallback for genuinely narrow
    // widths (Step 6) — at the Sheet's new width, the 8 columns below fit
    // without triggering it on a normal desktop viewport.
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-xs">Keyword</TableHead>
            <TableHead className="whitespace-nowrap text-xs">Match type</TableHead>
            <TableHead className="whitespace-nowrap text-xs">Status</TableHead>
            <TableHead className="whitespace-nowrap text-right text-xs">Impressions</TableHead>
            <TableHead className="whitespace-nowrap text-right text-xs">Clicks</TableHead>
            <TableHead className="whitespace-nowrap text-right text-xs">CTR</TableHead>
            <TableHead className="whitespace-nowrap text-right text-xs">Spend</TableHead>
            <TableHead className="whitespace-nowrap text-right text-xs">Conversions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {keywords.map((kw) => (
            <TableRow key={kw.criterionId}>
              {/* Keyword text is the one flexible column — allowed to wrap
                  onto 2 lines for a long phrase rather than forcing the
                  whole table wider (Step 5). */}
              <TableCell className="max-w-[240px] whitespace-normal break-words text-xs font-medium">{kw.text}</TableCell>
              <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{humanizeGoogleAdsKeywordMatchType(kw.matchType)}</TableCell>
              <TableCell className="whitespace-nowrap"><GoogleAdsEntityStatusBadge status={kw.status} /></TableCell>
              <TableCell className="whitespace-nowrap text-right tabular-nums text-xs">{formatGoogleAdsCount(kw.impressions)}</TableCell>
              <TableCell className="whitespace-nowrap text-right tabular-nums text-xs">{formatGoogleAdsCount(kw.clicks)}</TableCell>
              <TableCell className="whitespace-nowrap text-right tabular-nums text-xs">{formatGoogleAdsCtr(kw.clicks, kw.impressions)}</TableCell>
              <TableCell className="whitespace-nowrap text-right tabular-nums text-xs">{formatGoogleAdsSpend(kw.costMicros, currencyCode)}</TableCell>
              <TableCell className="whitespace-nowrap text-right tabular-nums text-xs">{kw.conversions.toLocaleString(undefined, { maximumFractionDigits: 2 })}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function GoogleAdsSearchTermsTabContent({ searchTerms, loading, error, currencyCode, onRetry }: {
  searchTerms: GoogleAdsSearchTermPerformanceRow[] | null;
  loading: boolean;
  error: string | null;
  currencyCode: string | null;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
        <span>{error}</span>
        <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={onRetry}>Retry</Button>
      </div>
    );
  }
  if (!searchTerms || searchTerms.length === 0) {
    // Legitimately empty for a low/zero-serving campaign (Step 24) — never
    // treated as an error.
    return <p className="text-xs text-muted-foreground">No search terms available for this date range.</p>;
  }
  return (
    // Same responsive-table strategy as Keywords — overflow-x-auto remains
    // a safety fallback for narrow widths only (Step 7).
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-xs">Search term</TableHead>
            <TableHead className="whitespace-nowrap text-right text-xs">Impressions</TableHead>
            <TableHead className="whitespace-nowrap text-right text-xs">Clicks</TableHead>
            <TableHead className="whitespace-nowrap text-right text-xs">CTR</TableHead>
            <TableHead className="whitespace-nowrap text-right text-xs">Spend</TableHead>
            <TableHead className="whitespace-nowrap text-right text-xs">Conversions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {searchTerms.map((st) => (
            <TableRow key={st.searchTerm}>
              <TableCell className="max-w-[280px] whitespace-normal break-words text-xs font-medium">{st.searchTerm}</TableCell>
              <TableCell className="whitespace-nowrap text-right tabular-nums text-xs">{formatGoogleAdsCount(st.impressions)}</TableCell>
              <TableCell className="whitespace-nowrap text-right tabular-nums text-xs">{formatGoogleAdsCount(st.clicks)}</TableCell>
              <TableCell className="whitespace-nowrap text-right tabular-nums text-xs">{formatGoogleAdsCtr(st.clicks, st.impressions)}</TableCell>
              <TableCell className="whitespace-nowrap text-right tabular-nums text-xs">{formatGoogleAdsSpend(st.costMicros, currencyCode)}</TableCell>
              <TableCell className="whitespace-nowrap text-right tabular-nums text-xs">{st.conversions.toLocaleString(undefined, { maximumFractionDigits: 2 })}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function GoogleAdsPerformanceTab() {
  const { loading, result, retry } = useGoogleAdsCampaignPerformance();

  if (loading || !result) {
    return <GoogleAdsPerformanceSkeleton />;
  }

  if (!result.ok) {
    switch (result.kind) {
      case "not_connected":
        return (
          <GoogleAdsEmptyStateCard
            icon={BarChart3}
            title="Google Ads is not connected"
            description="Connect your Google Ads account to see campaign performance here."
            action={<GoogleAdsIntegrationsLinkButton>Connect Google Ads</GoogleAdsIntegrationsLinkButton>}
          />
        );
      case "account_selection_required":
        return (
          <GoogleAdsEmptyStateCard
            icon={BarChart3}
            title="Select a Google Ads account"
            description="Google Ads is authorized, but an advertiser account still needs to be selected before performance can be shown."
            action={<GoogleAdsIntegrationsLinkButton>Select account</GoogleAdsIntegrationsLinkButton>}
          />
        );
      case "account_sync_required":
      case "reconnect_required":
        return (
          <GoogleAdsEmptyStateCard
            icon={AlertTriangle}
            title="Google Ads needs attention"
            description={
              result.kind === "reconnect_required"
                ? "Your Google Ads authorization has expired. Reconnect to keep seeing performance data."
                : "Google couldn't sync your account details. Retry the connection from Integrations."
            }
            action={<GoogleAdsIntegrationsLinkButton>{result.kind === "reconnect_required" ? "Reconnect Google Ads" : "Go to Integrations"}</GoogleAdsIntegrationsLinkButton>}
          />
        );
      case "unauthorized":
        // A frontend session/auth error — never treated as "Google Ads is
        // disconnected" (Step 11: don't auto-disconnect the integration
        // over a frontend auth error). Retrying re-reads the current
        // Supabase session, which resolves itself once the user is
        // properly signed in again.
        return (
          <GoogleAdsEmptyStateCard
            icon={AlertCircle}
            title="Session error"
            description="We couldn't verify your session. Please try again."
            action={<Button size="sm" className="mt-2" onClick={retry}><RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Retry</Button>}
          />
        );
      case "provider_error":
      case "network_error":
      default:
        // Distinguished deliberately from the zero-metrics loaded state —
        // this is a FAILED fetch, never rendered as if it were real zero
        // data (Step 12).
        return (
          <GoogleAdsEmptyStateCard
            icon={AlertCircle}
            title="Unable to load Google Ads performance"
            description="Something went wrong reaching Google Ads. This is usually temporary."
            action={<Button size="sm" className="mt-2" onClick={retry}><RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Retry</Button>}
          />
        );
    }
  }

  const { data } = result;
  return (
    <div className="space-y-5">
      <GoogleAdsAccountHeader data={data} />
      <GoogleAdsMetricCards summary={data.summary} currencyCode={data.currencyCode} />
      <GoogleAdsCampaignTable campaigns={data.campaigns} currencyCode={data.currencyCode} customerId={data.customerId} dateRange={data.dateRange} />
      <GoogleAdsLeadsCard />
      <GoogleAdsConversionFeedbackCard />
      <GoogleAdsConversionEventsTableCard />
      <GoogleAdsOfflineConversionMappingCard />
    </div>
  );
}

// ---------- Meta Ads tab (Phase 1A, Step 3) ─────────────────────────────
//
// Read-only paid-media reporting from the live Meta Marketing API, built
// entirely on the Step 1/2 backend (netlify/functions/meta-ads-*.ts) and
// the src/lib/meta-ads-client.ts fetch layer — no direct fetch() calls to
// any /.netlify/functions/meta-* endpoint happen anywhere below. Mirrors
// the Google Ads tab's architecture (skeleton -> connection-state empty
// states -> account header + KPI cards + table) but is a fully separate
// component tree: switching providers unmounts whichever tab was active
// (Radix Tabs.Content only renders the selected value), so Google/Meta
// state, loading, and errors can never bleed into each other.
//
// Strictly read-only, matching the write-only meta-create-ad-campaign.ts
// demo endpoint's isolation — no campaign/ad-set/ad create/edit/pause/
// resume/publish/delete control exists anywhere in this section, and that
// endpoint is never imported here.

const META_DATE_RANGE_OPTIONS: { value: MetaAdsDateRangePreset; label: string }[] = [
  { value: "TODAY", label: "Today" },
  { value: "YESTERDAY", label: "Yesterday" },
  { value: "LAST_7_DAYS", label: "Last 7 days" },
  { value: "LAST_14_DAYS", label: "Last 14 days" },
  { value: "LAST_30_DAYS", label: "Last 30 days" },
  { value: "THIS_MONTH", label: "This month" },
  { value: "LAST_MONTH", label: "Last month" },
];

type MetaAdsInnerTab = "overview" | "campaigns" | "adsets" | "ads";

// One shared fetch-state shape (loading/result/retry) for every Meta Ads
// list — deliberately not a single generic hook factory: each call site
// below has a slightly different enable condition (account summary always
// fetches, campaigns waits on a connected account, ad sets/ads are lazy
// until their tab is first visited), and spelling each out inline keeps
// those differences visible rather than hidden behind a config object.

function useMetaAdsAccountSummary(dateRange: MetaAdsDateRangePreset) {
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<MetaAdsResult<MetaAdsAccountSummaryResponse> | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // Clear the previous result immediately so a date-range change or
    // retry never shows the PREVIOUS window's account/KPI data underneath
    // the loading skeleton.
    setResult(null);
    setLoading(true);
    getMetaAdsAccountSummary({ dateRange })
      .then((r) => { if (!cancelled) setResult(r); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [dateRange, retryTick]);

  return { loading, result, retry: () => setRetryTick((t) => t + 1) };
}

function useMetaAdsCampaigns(dateRange: MetaAdsDateRangePreset, enabled: boolean) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<MetaAdsResult<MetaAdsCampaignsResponse> | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setResult(null);
    setLoading(true);
    getMetaAdsCampaigns({ dateRange })
      .then((r) => { if (!cancelled) setResult(r); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [dateRange, enabled, retryTick]);

  return { loading, result, retry: () => setRetryTick((t) => t + 1) };
}

function useMetaAdsAdSets(dateRange: MetaAdsDateRangePreset, enabled: boolean) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<MetaAdsResult<MetaAdsAdSetsResponse> | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setResult(null);
    setLoading(true);
    getMetaAdsAdSets({ dateRange })
      .then((r) => { if (!cancelled) setResult(r); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [dateRange, enabled, retryTick]);

  return { loading, result, retry: () => setRetryTick((t) => t + 1) };
}

function useMetaAdsAds(dateRange: MetaAdsDateRangePreset, enabled: boolean) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<MetaAdsResult<MetaAdsAdsResponse> | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setResult(null);
    setLoading(true);
    getMetaAdsAds({ dateRange })
      .then((r) => { if (!cancelled) setResult(r); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [dateRange, enabled, retryTick]);

  return { loading, result, retry: () => setRetryTick((t) => t + 1) };
}

// Every non-"ok" MetaAdsResult kind mapped to a specific, friendly empty
// state — never collapsed into one generic "Meta connection failed"
// message (Step 21), and never showing raw Graph API text/fbtrace_id/
// token errors (Step 24). Reuses GoogleAdsEmptyStateCard as-is — its
// implementation has no Google-specific content, just a generic
// icon/title/description/action card.
function metaAdsAccountManagementLink(label: string) {
  return (
    <Button asChild size="sm" className="mt-2">
      <Link to="/settings/integrations">
        <Plug className="mr-1.5 h-3.5 w-3.5" /> {label}
      </Link>
    </Button>
  );
}

function MetaAdsErrorState({ kind, retry }: { kind: Exclude<MetaAdsResult<unknown>, { ok: true }>["kind"]; retry: () => void }) {
  switch (kind) {
    case "unauthorized":
      return (
        <GoogleAdsEmptyStateCard
          icon={AlertCircle}
          title="Session error"
          description="We couldn't verify your session. Please try again."
          action={<Button size="sm" className="mt-2" onClick={retry}><RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Retry</Button>}
        />
      );
    case "not_connected":
      return (
        <GoogleAdsEmptyStateCard
          icon={BarChart3}
          title="Meta Ads is not connected"
          description="Connect your Meta Ads account to see campaign performance here."
          action={metaAdsAccountManagementLink("Connect Meta Ads")}
        />
      );
    case "no_ad_account_selected":
      return (
        <GoogleAdsEmptyStateCard
          icon={BarChart3}
          title="Select a Meta ad account"
          description="Meta Ads is authorized, but an ad account still needs to be selected before performance can be shown."
          action={metaAdsAccountManagementLink("Manage connection")}
        />
      );
    case "reconnect_required":
      return (
        <GoogleAdsEmptyStateCard
          icon={AlertTriangle}
          title="Meta Ads needs attention"
          description="Your Meta Ads authorization has expired. Reconnect to keep seeing performance data."
          action={metaAdsAccountManagementLink("Reconnect Meta Ads")}
        />
      );
    case "permission_required":
      return (
        <GoogleAdsEmptyStateCard
          icon={AlertTriangle}
          title="Meta Ads permissions need attention"
          description="This connection no longer has permission to read ad account data. Update permissions from Integrations."
          action={metaAdsAccountManagementLink("Go to Integrations")}
        />
      );
    case "account_unavailable":
      return (
        <GoogleAdsEmptyStateCard
          icon={AlertTriangle}
          title="Selected ad account unavailable"
          description="The selected Meta ad account is no longer accessible. Choose a different account to continue."
          action={metaAdsAccountManagementLink("Manage connection")}
        />
      );
    case "temporarily_unavailable":
      // Deliberately Retry, never Reconnect — a transient Meta-side issue
      // is not a token/permission problem (Step 21).
      return (
        <GoogleAdsEmptyStateCard
          icon={AlertCircle}
          title="Meta is temporarily unavailable"
          description="This is usually temporary — please try again shortly."
          action={<Button size="sm" className="mt-2" onClick={retry}><RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Retry</Button>}
        />
      );
    case "provider_error":
    case "network_error":
    default:
      return (
        <GoogleAdsEmptyStateCard
          icon={AlertCircle}
          title="Unable to load Meta Ads performance"
          description="Something went wrong reaching Meta. This is usually temporary."
          action={<Button size="sm" className="mt-2" onClick={retry}><RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Retry</Button>}
        />
      );
  }
}

function MetaAdsAccountHeader({
  adAccount, dateRange, onDateRangeChange, onRefresh,
}: {
  adAccount: MetaAdsAccountSummaryResponse["adAccount"];
  dateRange: MetaAdsDateRangePreset;
  onDateRangeChange: (v: MetaAdsDateRangePreset) => void;
  onRefresh: () => void;
}) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-3 p-4">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-secondary ring-1 ring-black/5">
          <img src={metaIconUrl} alt="" aria-hidden="true" className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">Meta Ads</span>
            <StatusBadge tone="success" icon={CheckCircle2}>Connected</StatusBadge>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {adAccount.name ?? "Ad account"}
            {adAccount.currency && <span> · {adAccount.currency}</span>}
            {adAccount.timezoneName && <span className="text-muted-foreground/70"> · {adAccount.timezoneName}</span>}
            {adAccount.businessName && <span> · Business: {adAccount.businessName}</span>}
          </p>
          {/* Numeric ad account ID — secondary detail only, never the
              primary label (Step 5: no prominent raw IDs). */}
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground/60">Account ID {adAccount.id}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Select value={dateRange} onValueChange={(v) => onDateRangeChange(v as MetaAdsDateRangePreset)}>
            <SelectTrigger className="h-8 w-[150px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {META_DATE_RANGE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} className="text-xs">{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onRefresh} title="Refresh">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function MetaAdsMetricCards({ summary, currencyCode }: { summary: MetaAdsAccountSummaryResponse["summary"]; currencyCode: string | null }) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile icon={CircleDollarSign} iconBg="bg-gold-soft" iconColor="text-gold-hover" label="Spend" value={formatMetaAdsCurrency(summary.spend, currencyCode)} sub="Selected range" />
        <MetricTile icon={Eye} iconBg="bg-info-soft" iconColor="text-info" label="Impressions" value={formatMetaAdsCount(summary.impressions)} sub="Selected range" />
        <MetricTile icon={MousePointerClick} iconBg="bg-cyan-soft" iconColor="text-cyan-soft-foreground" label="Clicks" value={formatMetaAdsCount(summary.clicks)} sub="Selected range" />
        <MetricTile icon={Target} iconBg="bg-success-soft" iconColor="text-success" label="Leads" value={formatMetaAdsCount(summary.leads)} sub="Selected range" />
      </div>
      {/* Secondary metrics — a single compact row rather than four more
          full-weight KPI cards, per Step 8's "do not overcrowd." */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 p-3">
          <MetaAdsInlineStat label="Reach" value={formatMetaAdsCount(summary.reach)} />
          <MetaAdsInlineStat label="CTR" value={formatMetaAdsPercent(summary.ctr)} />
          <MetaAdsInlineStat label="CPC" value={formatMetaAdsCurrency(summary.cpc, currencyCode)} />
          <MetaAdsInlineStat label="Cost per lead" value={formatMetaAdsCurrency(summary.costPerLead, currencyCode)} />
        </CardContent>
      </Card>
    </>
  );
}

function MetaAdsInlineStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  );
}

// Meta's effective_status vocabulary spans campaign/ad-set/ad objects with
// the same shared values — one tone map for all three, matching the plain
// factual (not health-judgment) tone convention already used for Google
// Ads' campaign.status.
const META_STATUS_TONE: Record<string, BadgeTone> = {
  ACTIVE: "success",
  PAUSED: "warning",
  CAMPAIGN_PAUSED: "warning",
  ADSET_PAUSED: "warning",
  IN_PROCESS: "info",
  PENDING_REVIEW: "info",
  PENDING_BILLING_INFO: "warning",
  DISAPPROVED: "danger",
  WITH_ISSUES: "danger",
  DELETED: "muted",
  ARCHIVED: "muted",
};

// Shows `effectiveStatus` as the primary badge (Step 13) — the actual
// operational state — with `status` (the configured state) surfaced only
// as a secondary tooltip detail when the two disagree (e.g. Configured:
// ACTIVE but Effective: CAMPAIGN_PAUSED because the parent campaign is
// paused). When they match, this renders identically to a plain status
// badge with no extra affordance.
function MetaAdsStatusBadge({ status, effectiveStatus }: { status: string; effectiveStatus: string | null }) {
  const display = effectiveStatus ?? status;
  const tone = META_STATUS_TONE[display] ?? "muted";
  const badge = <StatusBadge tone={tone}>{display}</StatusBadge>;

  if (!effectiveStatus || effectiveStatus === status) {
    return badge;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help">{badge}</span>
      </TooltipTrigger>
      <TooltipContent className="text-xs">
        <div>Configured: {status}</div>
        <div>Effective: {effectiveStatus}</div>
      </TooltipContent>
    </Tooltip>
  );
}

// Never renders a broken-image icon if thumbnailUrl is absent or fails to
// load (Step 18) — hides itself entirely on error rather than falling
// back to a placeholder that implies a creative exists when it doesn't.
function MetaAdsThumbnail({ src, alt }: { src: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return null;
  return <img src={src} alt={alt} className="h-8 w-8 shrink-0 rounded object-cover ring-1 ring-black/5" onError={() => setFailed(true)} />;
}

function MetaAdsPerformanceSkeleton() {
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <Skeleton className="h-9 w-9 rounded-lg" />
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-48" />
          </div>
        </CardContent>
      </Card>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="p-4 space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-6 w-16" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardContent className="p-4">
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}

function MetaAdsTableSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}

// ── Campaigns ────────────────────────────────────────────────────────────

function MetaAdsCampaignsTable({ campaigns, currencyCode }: { campaigns: MetaAdsCampaign[]; currencyCode: string | null }) {
  if (campaigns.length === 0) {
    return (
      <CardContent className="flex flex-col items-center gap-2 pt-4 py-16 text-center">
        <BarChart3 className="h-10 w-10 text-muted-foreground" />
        <div>
          <h3 className="text-sm font-semibold">No campaigns found for this Meta Ads account</h3>
          <p className="text-xs text-muted-foreground">Performance will appear here when this account has campaign activity.</p>
        </div>
      </CardContent>
    );
  }
  return (
    <CardContent className="pt-4">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Campaign</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Objective</TableHead>
              <TableHead className="text-right">Spend</TableHead>
              <TableHead className="text-right">Impressions</TableHead>
              <TableHead className="text-right">Clicks</TableHead>
              <TableHead className="text-right">Leads</TableHead>
              <TableHead className="text-right">CPL</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {campaigns.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-medium text-foreground">{c.name}</TableCell>
                <TableCell><MetaAdsStatusBadge status={c.status} effectiveStatus={c.effectiveStatus} /></TableCell>
                <TableCell className="text-muted-foreground">{formatMetaAdsObjective(c.objective)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMetaAdsCurrency(c.insights.spend, currencyCode)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMetaAdsCount(c.insights.impressions)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMetaAdsCount(c.insights.clicks)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMetaAdsCount(c.insights.leads)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMetaAdsCurrency(c.insights.costPerLead, currencyCode)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </CardContent>
  );
}

// Compact Overview snapshot — name/status/spend/leads only, capped at 5
// rows with a "View all" affordance into the full Campaigns tab, so
// Overview and Campaigns read as genuinely different views rather than
// the same table shown twice.
function MetaAdsCampaignSnapshot({ campaigns, currencyCode, onViewAll }: { campaigns: MetaAdsCampaign[]; currencyCode: string | null; onViewAll: () => void }) {
  if (campaigns.length === 0) {
    return (
      <CardContent className="flex flex-col items-center gap-2 pt-4 py-16 text-center">
        <BarChart3 className="h-10 w-10 text-muted-foreground" />
        <div>
          <h3 className="text-sm font-semibold">No campaigns found for this Meta Ads account</h3>
          <p className="text-xs text-muted-foreground">Performance will appear here when this account has campaign activity.</p>
        </div>
      </CardContent>
    );
  }
  const shown = campaigns.slice(0, 5);
  return (
    <CardContent className="pt-4">
      <div className="divide-y">
        {shown.map((c) => (
          <div key={c.id} className="flex items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-foreground">{c.name}</div>
              <div className="mt-0.5"><MetaAdsStatusBadge status={c.status} effectiveStatus={c.effectiveStatus} /></div>
            </div>
            <div className="flex shrink-0 items-center gap-4 text-right text-sm tabular-nums">
              <div>
                <div className="text-foreground">{formatMetaAdsCurrency(c.insights.spend, currencyCode)}</div>
                <div className="text-[11px] text-muted-foreground">Spend</div>
              </div>
              <div>
                <div className="text-foreground">{formatMetaAdsCount(c.insights.leads)}</div>
                <div className="text-[11px] text-muted-foreground">Leads</div>
              </div>
            </div>
          </div>
        ))}
      </div>
      {campaigns.length > 5 && (
        <Button variant="ghost" size="sm" className="mt-2" onClick={onViewAll}>
          View all {campaigns.length} campaigns <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
        </Button>
      )}
    </CardContent>
  );
}

// ── Ad Sets ──────────────────────────────────────────────────────────────

function MetaAdsAdSetsTable({
  adSets, campaignNameById, currencyCode,
}: {
  adSets: MetaAdsAdSet[]; campaignNameById: Map<string, string>; currencyCode: string | null;
}) {
  if (adSets.length === 0) {
    return (
      <CardContent className="flex flex-col items-center gap-2 pt-4 py-16 text-center">
        <BarChart3 className="h-10 w-10 text-muted-foreground" />
        <div>
          <h3 className="text-sm font-semibold">No ad sets found</h3>
          <p className="text-xs text-muted-foreground">Ad sets will appear here once this account has campaign activity.</p>
        </div>
      </CardContent>
    );
  }
  return (
    <CardContent className="pt-4">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ad Set</TableHead>
              <TableHead>Campaign</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Optimization Goal</TableHead>
              <TableHead className="text-right">Spend</TableHead>
              <TableHead className="text-right">Impressions</TableHead>
              <TableHead className="text-right">Clicks</TableHead>
              <TableHead className="text-right">Leads</TableHead>
              <TableHead className="text-right">CPL</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {adSets.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="font-medium text-foreground">{a.name}</TableCell>
                <TableCell className="text-muted-foreground">{(a.campaignId && campaignNameById.get(a.campaignId)) ?? "—"}</TableCell>
                <TableCell><MetaAdsStatusBadge status={a.status} effectiveStatus={a.effectiveStatus} /></TableCell>
                <TableCell className="text-muted-foreground">{formatMetaAdsOptimizationGoal(a.optimizationGoal)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMetaAdsCurrency(a.insights.spend, currencyCode)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMetaAdsCount(a.insights.impressions)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMetaAdsCount(a.insights.clicks)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMetaAdsCount(a.insights.leads)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMetaAdsCurrency(a.insights.costPerLead, currencyCode)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </CardContent>
  );
}

// ── Ads ──────────────────────────────────────────────────────────────────

function MetaAdsAdsTable({
  ads, campaignNameById, adSetNameById, currencyCode,
}: {
  ads: MetaAdsAd[]; campaignNameById: Map<string, string>; adSetNameById: Map<string, string>; currencyCode: string | null;
}) {
  if (ads.length === 0) {
    return (
      <CardContent className="flex flex-col items-center gap-2 pt-4 py-16 text-center">
        <BarChart3 className="h-10 w-10 text-muted-foreground" />
        <div>
          <h3 className="text-sm font-semibold">No ads found</h3>
          <p className="text-xs text-muted-foreground">Ads will appear here once this account has campaign activity.</p>
        </div>
      </CardContent>
    );
  }
  return (
    <CardContent className="pt-4">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ad</TableHead>
              <TableHead>Campaign</TableHead>
              <TableHead>Ad Set</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Spend</TableHead>
              <TableHead className="text-right">Impressions</TableHead>
              <TableHead className="text-right">Clicks</TableHead>
              <TableHead className="text-right">Leads</TableHead>
              <TableHead className="text-right">CPL</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ads.map((a) => (
              <TableRow key={a.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <MetaAdsThumbnail src={a.thumbnailUrl} alt="" />
                    <span className="font-medium text-foreground">{a.name}</span>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">{(a.campaignId && campaignNameById.get(a.campaignId)) ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{(a.adSetId && adSetNameById.get(a.adSetId)) ?? "—"}</TableCell>
                <TableCell><MetaAdsStatusBadge status={a.status} effectiveStatus={a.effectiveStatus} /></TableCell>
                <TableCell className="text-right tabular-nums">{formatMetaAdsCurrency(a.insights.spend, currencyCode)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMetaAdsCount(a.insights.impressions)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMetaAdsCount(a.insights.clicks)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMetaAdsCount(a.insights.leads)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMetaAdsCurrency(a.insights.costPerLead, currencyCode)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </CardContent>
  );
}

// ── Container ─────────────────────────────────────────────────────────────
//
// No Performance/Insights tab (Step 19) — Overview/Campaigns/Ad Sets/Ads
// already show spend/leads/etc. per entity at every level via the same
// merged Insights data; a bare account/campaign/adset/ad level picker
// would just re-show numbers already visible elsewhere, and Step 2's
// backend returns aggregate date-range totals only (no daily time series,
// per Step 20), so no trend chart is built anywhere in this tab either.
function MetaAdsPerformanceTab() {
  const [dateRange, setDateRange] = useState<MetaAdsDateRangePreset>("LAST_30_DAYS");
  const [innerTab, setInnerTab] = useState<MetaAdsInnerTab>("overview");
  const [visitedAdSets, setVisitedAdSets] = useState(false);
  const [visitedAds, setVisitedAds] = useState(false);

  useEffect(() => {
    if (innerTab === "adsets" || innerTab === "ads") setVisitedAdSets(true);
    if (innerTab === "ads") setVisitedAds(true);
  }, [innerTab]);

  const account = useMetaAdsAccountSummary(dateRange);
  const accountConnected = account.result?.ok === true;

  const campaigns = useMetaAdsCampaigns(dateRange, accountConnected);
  const adSets = useMetaAdsAdSets(dateRange, accountConnected && visitedAdSets);
  const ads = useMetaAdsAds(dateRange, accountConnected && visitedAds);

  function retryAll() {
    account.retry();
  }

  // Overview needs BOTH the account summary and campaigns loaded together
  // (one combined skeleton) — Ad Sets/Ads get their own lazy skeleton
  // inside their own tab content once this outer shell is already showing.
  if (account.loading || !account.result) {
    return <MetaAdsPerformanceSkeleton />;
  }
  if (!account.result.ok) {
    return <MetaAdsErrorState kind={account.result.kind} retry={retryAll} />;
  }

  const { adAccount, summary } = account.result.data;

  const campaignList: MetaAdsCampaign[] = campaigns.result?.ok ? campaigns.result.data.campaigns : [];
  const campaignNameById = new Map(campaignList.map((c) => [c.id, c.name]));
  const adSetList: MetaAdsAdSet[] = adSets.result?.ok ? adSets.result.data.adSets : [];
  const adSetNameById = new Map(adSetList.map((a) => [a.id, a.name]));

  return (
    <div className="space-y-5">
      <MetaAdsAccountHeader adAccount={adAccount} dateRange={dateRange} onDateRangeChange={setDateRange} onRefresh={retryAll} />
      <MetaAdsMetricCards summary={summary} currencyCode={adAccount.currency} />

      <Tabs value={innerTab} onValueChange={(v) => setInnerTab(v as MetaAdsInnerTab)} className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
          <TabsTrigger value="adsets">Ad Sets</TabsTrigger>
          <TabsTrigger value="ads">Ads</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <Card>
            <GoogleAdsSectionHeader title="Campaigns" description="Snapshot of campaigns in the selected Meta ad account." />
            {campaigns.loading && !campaigns.result ? (
              <MetaAdsTableSkeleton rows={3} />
            ) : campaigns.result && !campaigns.result.ok ? (
              <div className="p-4"><MetaAdsErrorState kind={campaigns.result.kind} retry={campaigns.retry} /></div>
            ) : (
              <MetaAdsCampaignSnapshot campaigns={campaignList} currencyCode={adAccount.currency} onViewAll={() => setInnerTab("campaigns")} />
            )}
          </Card>
        </TabsContent>

        <TabsContent value="campaigns">
          <Card>
            <GoogleAdsSectionHeader title="Campaigns" description="Performance for campaigns in the selected Meta ad account." />
            {campaigns.loading && !campaigns.result ? (
              <MetaAdsTableSkeleton rows={4} />
            ) : campaigns.result && !campaigns.result.ok ? (
              <div className="p-4"><MetaAdsErrorState kind={campaigns.result.kind} retry={campaigns.retry} /></div>
            ) : (
              <MetaAdsCampaignsTable campaigns={campaignList} currencyCode={adAccount.currency} />
            )}
          </Card>
        </TabsContent>

        <TabsContent value="adsets">
          <Card>
            <GoogleAdsSectionHeader title="Ad Sets" description="Performance for ad sets in the selected Meta ad account." />
            {adSets.loading && !adSets.result ? (
              <MetaAdsTableSkeleton rows={4} />
            ) : adSets.result && !adSets.result.ok ? (
              <div className="p-4"><MetaAdsErrorState kind={adSets.result.kind} retry={adSets.retry} /></div>
            ) : (
              <MetaAdsAdSetsTable adSets={adSetList} campaignNameById={campaignNameById} currencyCode={adAccount.currency} />
            )}
          </Card>
        </TabsContent>

        <TabsContent value="ads">
          <Card>
            <GoogleAdsSectionHeader title="Ads" description="Performance for ads in the selected Meta ad account." />
            {ads.loading && !ads.result ? (
              <MetaAdsTableSkeleton rows={4} />
            ) : ads.result && !ads.result.ok ? (
              <div className="p-4"><MetaAdsErrorState kind={ads.result.kind} retry={ads.retry} /></div>
            ) : (
              <MetaAdsAdsTable ads={ads.result?.ok ? ads.result.data.ads : []} campaignNameById={campaignNameById} adSetNameById={adSetNameById} currencyCode={adAccount.currency} />
            )}
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------- Google Ads Leads (Phase 3, Step 6, Part B) ─────────────────
//
// Compact lead-form-ingestion subsection inside Google Ads reporting —
// deliberately NOT a full lead-management page (Step B14): a status
// summary + a manual "Sync leads" action, with a link out to the real CRM
// Leads page for anything beyond that. Imported leads themselves live in
// the normal `leads`/`contacts` tables — this card never duplicates that
// table here.

function useGoogleAdsLeadSyncStatus() {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<GoogleAdsLeadSyncStatusResponse | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchGoogleAdsLeadSyncStatus().then((r) => {
      if (cancelled) return;
      setStatus(r.ok ? r.data : null);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [refreshTick]);

  return { loading, status, refresh: () => setRefreshTick((t) => t + 1) };
}

const GOOGLE_ADS_LEAD_SYNC_ERROR_MESSAGES: Record<string, string> = {
  not_connected: "Google Ads is not connected.",
  account_selection_required: "Select a Google Ads advertiser account first.",
  account_sync_required: "Google Ads needs attention — retry the connection from Integrations.",
  reconnect_required: "Google Ads authorization expired — reconnect to sync leads.",
  unauthorized: "Session error — please try again.",
};

// Dev-only synthetic-lead injection dialog (Phase 3, Step 6C.1) — feeds a
// controlled test submission through the EXACT SAME production ingestion
// pipeline (google-ads-lead-test-inject.ts calls the same
// insertGoogleAdsLeadSubmissions/ingestGoogleAdsSubmission helpers
// google-ads-lead-sync.ts does). This component is only ever mounted when
// import.meta.env.DEV is true (see GoogleAdsLeadsCard below) — but the
// REAL protection is the endpoint's own backend production guard, not
// this frontend gate (Step 11: never rely on one without the other).
function GoogleAdsTestLeadInjectSheet({ open, onClose, onIngested }: { open: boolean; onClose: () => void; onIngested: () => void }) {
  const [firstName, setFirstName] = useState("Phase3");
  const [lastName, setLastName] = useState("NewPerson");
  const [email, setEmail] = useState("phase3-newperson@example.com");
  const [phone, setPhone] = useState("3055550101");
  const [submissionId, setSubmissionId] = useState("phase3-browser-001");
  const [campaignName, setCampaignName] = useState("Leads-Search-1");
  const [gclid, setGclid] = useState("phase3-gclid-001");
  const [submitting, setSubmitting] = useState(false);
  const [lastResult, setLastResult] = useState<GoogleAdsTestLeadInjectResponse | null>(null);

  useEffect(() => {
    if (open) setLastResult(null);
  }, [open]);

  async function handleSubmit() {
    if (submitting) return; // guard against duplicate submission
    if (!submissionId.trim()) { toast.error("Submission ID is required"); return; }
    setSubmitting(true);
    try {
      const result = await injectGoogleAdsTestLead({ firstName, lastName, email, phone, submissionId, campaignName, gclid });
      if (!result.ok) {
        const message =
          result.kind === "not_available" ? "Test harness is not available in this environment" :
          result.kind === "unauthorized" ? "Session error — please try again" :
          result.kind === "provider_error" ? (result.message ?? "Failed to inject test lead") :
          "Network error — could not inject test lead";
        toast.error(message);
        return;
      }
      setLastResult(result.data);
      if (result.data.duplicate) {
        // Step 8: idempotent replay is a normal, expected outcome — never
        // shown as a failure.
        toast("Test submission already exists — no duplicate records created");
      } else if (result.data.ingestionStatus === "failed") {
        toast.error("Test Google lead failed to ingest");
      } else {
        toast.success(
          `Test Google lead ingested — ${result.data.contactCreated ? "Contact created" : "Contact matched"}, Lead created`,
        );
        // Refreshes the real lead-sync STATUS card (last-30-days count,
        // sync status) — never fabricates the real sync's "New leads
        // imported" counter, which specifically represents actual
        // google-ads-lead-sync.ts output (Step 10).
        onIngested();
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Inject Test Lead</SheetTitle>
          <SheetDescription>
            Dev-only. Feeds a synthetic submission through the real ingestion pipeline — never touches Google Ads.
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label className="text-xs">First name</Label>
              <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs">Last name</Label>
              <Input value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">Email</Label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">Phone</Label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">Submission ID</Label>
            <Input value={submissionId} onChange={(e) => setSubmissionId(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">Campaign name</Label>
            <Input value={campaignName} onChange={(e) => setCampaignName(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">GCLID</Label>
            <Input value={gclid} onChange={(e) => setGclid(e.target.value)} />
          </div>

          {lastResult && (
            <div className="rounded-md border bg-muted/40 p-2.5 text-xs space-y-0.5">
              <p><span className="font-medium">Result:</span> {lastResult.duplicate ? "Duplicate (idempotent — no new records)" : lastResult.ingestionStatus}</p>
              {!lastResult.duplicate && (
                <>
                  <p>Contact: {lastResult.contactCreated ? "created" : lastResult.contactMatched ? "matched" : "—"}</p>
                  <p>Lead: {lastResult.leadCreated ? "created" : "—"}</p>
                </>
              )}
            </div>
          )}
        </div>
        <SheetFooter className="mt-6 flex !justify-between border-t pt-4">
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            {submitting ? "Injecting…" : "Inject Test Lead"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function GoogleAdsLeadsCard() {
  const { loading, status, refresh } = useGoogleAdsLeadSyncStatus();
  const [syncing, setSyncing] = useState(false);
  const [lastResult, setLastResult] = useState<GoogleAdsLeadSyncResultResponse | null>(null);
  const [testInjectOpen, setTestInjectOpen] = useState(false);

  async function handleSync() {
    if (syncing) return; // guard against duplicate submission
    setSyncing(true);
    try {
      const result = await triggerGoogleAdsLeadSync();
      if (result.ok) {
        setLastResult(result.data);
        toast.success(
          result.data.newSubmissions > 0
            ? `Google Ads leads synced — ${result.data.newSubmissions} new`
            : "Google Ads leads synced — no new submissions",
        );
        refresh();
      } else {
        toast.error(GOOGLE_ADS_LEAD_SYNC_ERROR_MESSAGES[result.kind] ?? "Unable to sync Google Ads leads right now.");
      }
    } finally {
      setSyncing(false);
    }
  }

  const last30 = status?.last30DaysCount ?? 0;

  return (
    <Card>
      <GoogleAdsSectionHeader title="Google Ads Leads" description="Lead-form submissions imported from Google Ads." />
      <CardContent className="pt-4 space-y-3">
        {loading ? (
          <Skeleton className="h-14 w-full" />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <p className="text-[11px] text-muted-foreground">Last sync</p>
              <p className="text-sm font-medium text-foreground">{status?.lastSyncedAt ? new Date(status.lastSyncedAt).toLocaleString() : "Never"}</p>
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground">New leads imported</p>
              <p className="text-sm font-medium text-foreground">{lastResult ? lastResult.newSubmissions : "—"}</p>
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground">Last 30 days</p>
              <p className="text-sm font-medium text-foreground">{last30.toLocaleString()} lead{last30 === 1 ? "" : "s"}</p>
            </div>
            <div>
              <p className="mb-0.5 text-[11px] text-muted-foreground">Sync status</p>
              {status?.lastErrorCode ? (
                <StatusBadge tone="warning" icon={AlertTriangle}>Needs attention</StatusBadge>
              ) : (
                <StatusBadge tone="success" icon={CheckCircle2}>OK</StatusBadge>
              )}
            </div>
          </div>
        )}

        {!loading && last30 === 0 && (
          <p className="text-xs text-muted-foreground">No Google Ads lead-form submissions found</p>
        )}

        <div className="flex items-center gap-2">
          <Button size="sm" variant="neutral" onClick={handleSync} disabled={syncing}>
            {syncing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
            {syncing ? "Syncing…" : "Sync leads"}
          </Button>
          {last30 > 0 && (
            // RenoMeta Global UI Interaction System — same warm-neutral
            // navigation-CTA treatment as the Campaign/Ad Group Detail
            // Sheet's "View CRM Leads" buttons, deep-linking with the
            // Google Ads source preselected. Deliberately no campaign
            // context here — this card is the generic "all Google Ads
            // leads" entry point, not a specific campaign's.
            <Button asChild variant="neutral" size="sm">
              <Link to="/leads" search={{ source: "google_ads" }}>
                View in CRM Leads
                <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
              </Link>
            </Button>
          )}
          {/* Dev-only (Step 5/11) — the Vite dev-mode check is a UI
              convenience; the real protection is the endpoint's own
              backend production guard (see google-ads-lead-test-inject.ts).
              Never shown in a production build. */}
          {import.meta.env.DEV && (
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setTestInjectOpen(true)}>
              Inject Test Lead
            </Button>
          )}
        </div>
      </CardContent>

      {import.meta.env.DEV && (
        <GoogleAdsTestLeadInjectSheet
          open={testInjectOpen}
          onClose={() => setTestInjectOpen(false)}
          onIngested={refresh}
        />
      )}
    </Card>
  );
}

// ---------- Google Ads Conversion Feedback (Phase 3, Step 7A) ──────────
//
// Local-only foundation for future offline-conversion upload — shows how
// many CRM outcomes (qualified lead / appointment booked / deal won) are
// queued, and their export eligibility. Makes NO Google Ads API call —
// this only reads google_ads_conversion_events row counts via
// google-ads-conversion-status.ts. No Upload button exists yet (Step 7B).
// Deliberately compact — no per-event table, no gclid display (Part 14);
// "View conversion events" / "Refresh" are the only actions besides the
// dev-only controlled-test trigger below.

function useGoogleAdsConversionStatus() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<GoogleAdsConversionStatusResponse | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchGoogleAdsConversionStatus().then((r) => {
      if (cancelled) return;
      setData(r.ok ? r.data : null);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [refreshTick]);

  return { loading, data, refresh: () => setRefreshTick((t) => t + 1) };
}

const CONVERSION_EVENT_TYPE_OPTIONS: { value: GoogleAdsConversionEventType; label: string }[] = [
  { value: "qualified_lead", label: "Qualified Lead" },
  { value: "appointment_booked", label: "Appointment Booked" },
  { value: "deal_won", label: "Deal Won" },
];

// Dev-only controlled-verification trigger (Part 12) — creates a LOCAL
// conversion event for a real leadId via the trusted endpoint. Never
// exposed in production; mirrors the import.meta.env.DEV gating pattern
// already used by GoogleAdsTestLeadInjectSheet above. The gclid shown in
// the result here is intentionally the ONLY place in this UI it ever
// appears — used to manually confirm exact per-lead attribution resolved
// correctly (Parts 15/16), never rendered in the card itself.
function GoogleAdsConversionTestCreateSheet({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [leadId, setLeadId] = useState("");
  const [eventType, setEventType] = useState<GoogleAdsConversionEventType>("qualified_lead");
  const [submitting, setSubmitting] = useState(false);
  const [lastResult, setLastResult] = useState<{ ok: boolean; message: string; gclid?: string | null; exportStatus?: string } | null>(null);

  useEffect(() => {
    if (open) setLastResult(null);
  }, [open]);

  async function handleSubmit() {
    if (submitting || !leadId.trim()) return;
    setSubmitting(true);
    try {
      const result = await createGoogleAdsConversionEventTest({
        leadId: leadId.trim(),
        eventType,
        eventAt: new Date().toISOString(),
      });
      if (result.ok) {
        setLastResult({
          ok: true,
          message: result.data.created ? "Event created" : "Event already existed (idempotent)",
          gclid: result.data.gclid,
          exportStatus: result.data.exportStatus,
        });
        onCreated();
      } else if (result.kind === "not_available") {
        setLastResult({ ok: false, message: "Dev test endpoint is not available in this environment." });
      } else if (result.kind === "no_provider_attribution") {
        setLastResult({ ok: false, message: "No Google Ads provider submission found for this leadId." });
      } else {
        setLastResult({ ok: false, message: result.kind === "provider_error" ? (result.message ?? "Request failed.") : "Request failed." });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Create Test Conversion Event</SheetTitle>
          <SheetDescription>Dev-only bypass endpoint — skips CRM milestone validation (qualified/appointment/deal state) so synthetic fixtures without real CRM state can still be tested. Creates a LOCAL conversion event only; no Google Ads API call is ever made. The production endpoint requires real CRM milestone proof.</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-1.5">
            <Label>Lead ID</Label>
            <Input value={leadId} onChange={(e) => setLeadId(e.target.value)} placeholder="e.g. db3ca060-19b1-405d-aaa4-244f780c978d" />
          </div>
          <div className="space-y-1.5">
            <Label>Event type</Label>
            <Select value={eventType} onValueChange={(v) => setEventType(v as GoogleAdsConversionEventType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {CONVERSION_EVENT_TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {lastResult && (
            <div className={cn("rounded-md border p-3 text-xs", lastResult.ok ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-destructive/30 bg-destructive/5 text-destructive")}>
              <p className="font-medium">{lastResult.message}</p>
              {lastResult.ok && (
                <div className="mt-1 space-y-0.5 text-muted-foreground">
                  <p>Export status: {lastResult.exportStatus}</p>
                  <p>Resolved gclid: {lastResult.gclid ?? "(none)"}</p>
                </div>
              )}
            </div>
          )}
        </div>
        <SheetFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button onClick={handleSubmit} disabled={submitting || !leadId.trim()}>
            {submitting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            {submitting ? "Creating…" : "Create event"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function GoogleAdsConversionFeedbackCard() {
  const { loading, data, refresh } = useGoogleAdsConversionStatus();
  const [testCreateOpen, setTestCreateOpen] = useState(false);

  const counts = data?.counts;

  return (
    <Card>
      <GoogleAdsSectionHeader title="Conversion Feedback" description="CRM outcomes queued for a future Google Ads offline-conversion export. No data has been uploaded to Google." />
      <CardContent className="pt-4 space-y-3">
        {loading ? (
          <Skeleton className="h-14 w-full" />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <div>
              <p className="text-[11px] text-muted-foreground">Pending</p>
              <p className="text-sm font-medium text-foreground">{counts?.pending ?? 0}</p>
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground">Ready</p>
              <p className="text-sm font-medium text-foreground">{counts?.ready ?? 0}</p>
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground">Exported</p>
              <p className="text-sm font-medium text-foreground">{counts?.exported ?? 0}</p>
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground">Failed</p>
              <p className="text-sm font-medium text-foreground">{counts?.failed ?? 0}</p>
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground">Ineligible</p>
              <p className="text-sm font-medium text-foreground">{counts?.ineligible ?? 0}</p>
            </div>
          </div>
        )}

        {!loading && (data?.total ?? 0) === 0 && (
          <p className="text-xs text-muted-foreground">No conversion events recorded yet</p>
        )}

        <div className="flex items-center gap-2">
          <Button size="sm" variant="neutral" onClick={refresh}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Refresh
          </Button>
          {/* Dev-only (Part 12) — the Vite dev-mode check is a UI
              convenience; the real protection would be a backend guard if
              this endpoint were ever restricted. Not shown in production. */}
          {import.meta.env.DEV && (
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setTestCreateOpen(true)}>
              Create Test Event
            </Button>
          )}
        </div>
      </CardContent>

      {import.meta.env.DEV && (
        <GoogleAdsConversionTestCreateSheet
          open={testCreateOpen}
          onClose={() => setTestCreateOpen(false)}
          onCreated={refresh}
        />
      )}
    </Card>
  );
}

// ---------- Google Ads Offline Conversion Mapping (Phase 3, Step 7B.1) ──
//
// Discovery + mapping ONLY — no Upload button exists here, and nothing in
// this section calls a Google Ads conversion-upload endpoint. Lets the org
// see its live Google Ads conversion actions, get a non-persisted SUGGESTED
// default mapping by exact name match, and explicitly save a mapping into
// google_ads_conversion_mappings via the trusted save endpoint (which
// independently re-verifies the action against Google before writing —
// this UI's "suggestion" is a convenience, never the source of trust).

const CONVERSION_MAPPING_ROWS: { eventType: GoogleAdsConversionEventType; label: string }[] = [
  { eventType: "qualified_lead", label: "Qualified Lead" },
  { eventType: "appointment_booked", label: "Appointment Booked" },
  { eventType: "deal_won", label: "Deal Won" },
];

function conversionActionSelectLabel(action: GoogleAdsConversionAction): string {
  return `${action.name} — ID: ${action.id}`;
}

// ---------- Google Ads Conversion Events table (Phase 3, Step 7B.2) ────
//
// Per-event Upload/Retry — the first and only place in this UI that can
// trigger a real Google Ads conversion upload. Never constructs the
// upload payload itself; only tells google-ads-conversion-export.ts which
// eventId to export. A synthetic fixture row (phase3-browser-001/002 and
// any future __renometa_test_fixture-marked event) never shows an
// Upload/Retry action — the "Test fixture — never uploaded" label is
// shown instead, regardless of its export_status.

const EVENT_TYPE_LABELS: Record<GoogleAdsConversionEventType, string> = {
  qualified_lead: "Qualified Lead",
  appointment_booked: "Appointment Booked",
  deal_won: "Deal Won",
};

function conversionEventStatusBadge(row: GoogleAdsConversionEventListRow) {
  switch (row.exportStatus) {
    case "exported":
      return <StatusBadge tone="success" icon={CheckCircle2}>Exported</StatusBadge>;
    case "ready":
      return <StatusBadge tone="success" icon={CheckCircle2}>Ready</StatusBadge>;
    case "failed":
      return <StatusBadge tone="danger" icon={AlertCircle}>Failed</StatusBadge>;
    case "ineligible":
      return <StatusBadge tone="warning" icon={AlertTriangle}>Ineligible</StatusBadge>;
    case "pending":
    default:
      return <StatusBadge tone="muted" icon={Clock}>Pending</StatusBadge>;
  }
}

const EXPORT_REJECTION_MESSAGES: Record<string, string> = {
  event_not_found: "Event not found.",
  already_exported: "Already exported.",
  synthetic_fixture_ineligible: "Test fixtures are never uploaded to Google.",
  event_not_ready: "This event isn't ready yet.",
  missing_gclid: "No GCLID is attached to this event.",
  mapping_not_found: "No conversion action is mapped for this event type yet.",
  mapping_disabled: "The mapping for this event type is disabled.",
  conversion_action_not_found: "That conversion action was not found for this advertiser.",
  conversion_action_not_upload_clicks: "That conversion action's type doesn't support offline click uploads.",
  event_customer_mismatch: "The selected Google Ads advertiser has changed since this event was created.",
  google_ads_attribution_not_found: "Could not resolve this event's Google Ads attribution.",
  google_ads_partial_failure: "Google rejected this conversion (partial failure).",
  google_ads_upload_failed: "The upload to Google Ads failed.",
};

function GoogleAdsConversionEventsTableCard() {
  const [loading, setLoading] = useState(true);
  const [events, setEvents] = useState<GoogleAdsConversionEventListRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [exportingId, setExportingId] = useState<string | null>(null);

  async function loadEvents() {
    setLoading(true);
    setListError(null);
    const result = await fetchGoogleAdsConversionEvents();
    if (result.ok) {
      setEvents(result.data.events);
    } else {
      setEvents(null);
      setListError(
        result.kind === "reconnect_required" ? "Google Ads authorization expired — reconnect from Integrations."
        : result.kind === "account_sync_required" ? "Google Ads needs attention — retry the connection from Integrations."
        : "Unable to load conversion events right now.",
      );
    }
    setLoading(false);
  }

  useEffect(() => {
    loadEvents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleExport(row: GoogleAdsConversionEventListRow) {
    if (exportingId) return;
    setExportingId(row.id);
    try {
      const result = await exportGoogleAdsConversionEvent(row.id);
      if (result.ok) {
        toast.success(`${EVENT_TYPE_LABELS[row.eventType]} exported to Google Ads`);
        await loadEvents();
      } else if (result.kind === "rejected") {
        toast.error(EXPORT_REJECTION_MESSAGES[result.reason] ?? "Export failed.");
        await loadEvents();
      } else if (result.kind === "reconnect_required") {
        toast.error("Google Ads authorization expired — reconnect from Integrations.");
      } else {
        toast.error("Export failed — please try again.");
      }
    } finally {
      setExportingId(null);
    }
  }

  return (
    <Card>
      <GoogleAdsSectionHeader
        title="Conversion Events"
        description="Local conversion events for the selected advertiser. Uploading sends exactly this one event to Google — never a bulk upload."
      />
      <CardContent className="pt-4 space-y-3">
        {listError && <p className="text-xs text-destructive">{listError}</p>}

        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : !events || events.length === 0 ? (
          <p className="text-xs text-muted-foreground">No conversion events recorded yet</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Event</TableHead>
                  <TableHead className="text-xs">Lead</TableHead>
                  <TableHead className="text-xs">Event time</TableHead>
                  <TableHead className="text-xs">GCLID</TableHead>
                  <TableHead className="text-xs">Status</TableHead>
                  <TableHead className="text-xs">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="text-xs font-medium">{EVENT_TYPE_LABELS[row.eventType]}</TableCell>
                    <TableCell className="text-xs">
                      {row.leadId ? (
                        // Google Ads Lead Navigation Consistency pass — deep-
                        // links straight into the existing Leads workspace
                        // (source preselected + this exact lead's drawer
                        // auto-opened) rather than building a second lead-
                        // detail view inside Marketing. Short ID kept as-is —
                        // this endpoint doesn't return lead names, and
                        // fabricating one is out of scope here.
                        <Link
                          to="/leads"
                          search={{ source: "google_ads", leadId: row.leadId }}
                          className="rounded-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
                        >
                          {row.leadId.slice(0, 8)}…
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{new Date(row.eventAt).toLocaleString()}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.gclid ?? "—"}</TableCell>
                    <TableCell>{conversionEventStatusBadge(row)}</TableCell>
                    <TableCell className="text-xs">
                      {row.syntheticFixture ? (
                        <span className="text-muted-foreground">Test fixture — never uploaded</span>
                      ) : row.exportStatus === "exported" ? (
                        <span className="text-muted-foreground">{row.exportedAt ? new Date(row.exportedAt).toLocaleString() : "—"}</span>
                      ) : row.exportStatus === "ready" ? (
                        <Button size="sm" variant="outline" disabled={exportingId === row.id} onClick={() => handleExport(row)}>
                          {exportingId === row.id ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                          Upload
                        </Button>
                      ) : row.exportStatus === "failed" ? (
                        <Button size="sm" variant="outline" disabled={exportingId === row.id} onClick={() => handleExport(row)}>
                          {exportingId === row.id ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                          Retry
                        </Button>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <Button size="sm" variant="neutral" onClick={loadEvents} disabled={loading}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Refresh
        </Button>
      </CardContent>
    </Card>
  );
}

function GoogleAdsOfflineConversionMappingCard() {
  const [actionsLoading, setActionsLoading] = useState(false);
  const [actions, setActions] = useState<GoogleAdsConversionAction[] | null>(null);
  const [actionsError, setActionsError] = useState<string | null>(null);

  const [mappingsLoading, setMappingsLoading] = useState(true);
  // Saved mapping per event type, as last read from google_ads_conversion_mappings.
  const [savedMappings, setSavedMappings] = useState<Partial<Record<GoogleAdsConversionEventType, { conversionActionId: string; enabled: boolean }>>>({});
  // The user's current in-progress SELECTOR value per row — never written to
  // the DB until "Save Mappings" is clicked. Seeded from the saved mapping
  // (if any) once both actions and mappings have loaded, falling back to a
  // suggested exact-name match, falling back to empty (no selection).
  const [selection, setSelection] = useState<Partial<Record<GoogleAdsConversionEventType, string>>>({});
  const [seeded, setSeeded] = useState(false);
  const [saving, setSaving] = useState(false);

  async function loadActions() {
    setActionsLoading(true);
    setActionsError(null);
    const result = await fetchGoogleAdsConversionActions();
    if (result.ok) {
      setActions(result.data.actions);
    } else {
      setActions(null);
      setActionsError(
        result.kind === "reconnect_required" ? "Google Ads authorization expired — reconnect from Integrations."
        : result.kind === "account_sync_required" ? "Google Ads needs attention — retry the connection from Integrations."
        : "Unable to load Google Ads conversion actions right now.",
      );
    }
    setActionsLoading(false);
  }

  async function loadMappings() {
    setMappingsLoading(true);
    const result = await fetchGoogleAdsConversionMappings();
    if (result.ok) {
      const next: Partial<Record<GoogleAdsConversionEventType, { conversionActionId: string; enabled: boolean }>> = {};
      for (const m of result.data.mappings) {
        next[m.eventType] = { conversionActionId: m.conversionActionId, enabled: m.enabled };
      }
      setSavedMappings(next);
    }
    setMappingsLoading(false);
  }

  useEffect(() => {
    loadActions();
    loadMappings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Seed the selector values exactly once, after both actions and mappings
  // have loaded — never re-seeds on a later refresh (that would silently
  // discard an in-progress unsaved selection the user just picked).
  useEffect(() => {
    if (seeded || actionsLoading || mappingsLoading || !actions) return;
    const next: Partial<Record<GoogleAdsConversionEventType, string>> = {};
    for (const row of CONVERSION_MAPPING_ROWS) {
      const saved = savedMappings[row.eventType];
      if (saved) {
        next[row.eventType] = saved.conversionActionId;
        continue;
      }
      const suggestion = deriveSuggestedGoogleAdsConversionMapping(row.eventType, actions);
      if (suggestion.status === "suggested") {
        next[row.eventType] = suggestion.action.id;
      }
    }
    setSelection(next);
    setSeeded(true);
  }, [seeded, actionsLoading, mappingsLoading, actions, savedMappings]);

  async function handleSaveMappings() {
    if (saving) return;
    setSaving(true);
    try {
      let successCount = 0;
      let failureCount = 0;
      for (const row of CONVERSION_MAPPING_ROWS) {
        const conversionActionId = selection[row.eventType];
        if (!conversionActionId) continue; // nothing selected for this row — skip, don't save an empty mapping
        const result = await saveGoogleAdsConversionMapping({ eventType: row.eventType, conversionActionId, enabled: true });
        if (result.ok) {
          successCount++;
          if (result.data.typeCompatibilityWarning) {
            toast.warning(`${row.label}: mapped, but "${result.data.googleType ?? "this action's type"}" may not support offline click uploads.`);
          }
        } else {
          failureCount++;
          toast.error(
            result.kind === "conversion_action_not_found" ? `${row.label}: that conversion action wasn't found for this advertiser.`
            : `${row.label}: failed to save mapping.`,
          );
        }
      }
      if (successCount > 0) {
        toast.success(`Saved ${successCount} mapping${successCount === 1 ? "" : "s"}`);
        await loadMappings();
      }
      if (successCount === 0 && failureCount === 0) {
        toast.error("Select at least one conversion action before saving.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <GoogleAdsSectionHeader
        title="Offline Conversion Mapping"
        description="Map each RenoMeta milestone to a Google Ads conversion action. Discovery + mapping only — no conversions are uploaded to Google yet."
      />
      <CardContent className="pt-4 space-y-4">
        {actionsError && (
          <p className="text-xs text-destructive">{actionsError}</p>
        )}

        <div className="space-y-3">
          {CONVERSION_MAPPING_ROWS.map((row) => {
            const suggestion = actions ? deriveSuggestedGoogleAdsConversionMapping(row.eventType, actions) : null;
            const saved = savedMappings[row.eventType];
            const selected = selection[row.eventType] ?? "";

            return (
              <div key={row.eventType} className="grid grid-cols-1 gap-2 rounded-md border border-border p-3 sm:grid-cols-[140px_1fr_120px] sm:items-center sm:gap-3">
                <div className="text-sm font-medium text-foreground">{row.label}</div>

                <div className="min-w-0">
                  {actionsLoading || mappingsLoading ? (
                    <Skeleton className="h-9 w-full" />
                  ) : (
                    <Select
                      // Always a string ("" when unselected, never
                      // undefined/null) — `selected` above is already
                      // normalized via `selection[row.eventType] ?? ""`.
                      // Passing `undefined` here (even only for the
                      // unselected case) would flip this Select from
                      // controlled to uncontrolled on first mount, then
                      // back to controlled once a real action id lands in
                      // `selection` (from a suggestion, a saved mapping,
                      // or a manual pick) — exactly the React warning this
                      // fixes. No SelectItem below is ever given value=""
                      // — "" is only ever the Select's own unselected
                      // controlled value, matched against no item, so
                      // SelectValue's placeholder renders instead.
                      value={selected}
                      onValueChange={(v) => setSelection((prev) => ({ ...prev, [row.eventType]: v }))}
                    >
                      <SelectTrigger className="h-9 text-xs">
                        <SelectValue placeholder={`Expected: ${EXPECTED_GOOGLE_ADS_CONVERSION_ACTION_NAMES[row.eventType]}`} />
                      </SelectTrigger>
                      <SelectContent>
                        {(actions ?? []).map((a) => (
                          <SelectItem key={a.id} value={a.id} className="text-xs">
                            {conversionActionSelectLabel(a)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {!actionsLoading && !mappingsLoading && suggestion?.status === "ambiguous" && (
                    <p className="mt-1 text-[11px] text-amber-600">
                      {suggestion.actions.length} conversion actions named "{EXPECTED_GOOGLE_ADS_CONVERSION_ACTION_NAMES[row.eventType]}" — pick the correct one.
                    </p>
                  )}
                  {!actionsLoading && !mappingsLoading && !saved && suggestion?.status === "missing" && (
                    <p className="mt-1 text-[11px] text-muted-foreground">No matching conversion action found in Google Ads yet.</p>
                  )}
                </div>

                <div className="flex items-center justify-start sm:justify-end">
                  {mappingsLoading ? (
                    <Skeleton className="h-5 w-16" />
                  ) : saved ? (
                    <StatusBadge tone="success" icon={CheckCircle2}>Mapped</StatusBadge>
                  ) : suggestion?.status === "missing" ? (
                    <StatusBadge tone="warning" icon={AlertTriangle}>Missing</StatusBadge>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">Not saved</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" variant="neutral" onClick={loadActions} disabled={actionsLoading}>
            {actionsLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
            {actionsLoading ? "Refreshing…" : "Refresh Actions"}
          </Button>
          <Button size="sm" onClick={handleSaveMappings} disabled={saving || actionsLoading || !actions}>
            {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            {saving ? "Saving…" : "Save Mappings"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- Create Campaign — stepped flow ----------

type Step = 1 | 2 | 3 | 4;

function CreateCampaignSheet({ open, editingCampaign, onClose, onManageAudiences, onManageTemplates, templates, segments }: {
  open: boolean; editingCampaign?: MarketingCampaign | null; onClose: () => void; onManageAudiences: () => void; onManageTemplates: () => void; templates: MarketingTemplate[]; segments: MarketingSegment[];
}) {
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState("");
  const [channel, setChannel] = useState<CampaignChannel>("email");
  const [segmentId, setSegmentId] = useState<string | undefined>(undefined);
  const [filters, setFilters] = useState<AudienceFilters>({ conditions: [] });
  const [templateId, setTemplateId] = useState<string | undefined>(undefined);
  // Built-in starter templates are application-level presets, never rows
  // in marketing_templates — tracked separately from `templateId` (a real
  // FK-able DB uuid) so a built-in's stable string id
  // ("builtin-sms-...") can never end up written into
  // campaigns.template_id. Only one of templateId/builtInTemplateId is
  // ever set at a time.
  const [builtInTemplateId, setBuiltInTemplateId] = useState<string | undefined>(undefined);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  // Only meaningful value now is "later" (shows the schedule datetime
  // picker in Review) vs anything else (picker hidden) — "now" and
  // "draft" no longer gate which footer button/label appears (Review-step
  // review: Send now, Schedule, and Save draft are three independent
  // actions now, not a single toggle-then-submit flow), so this is a
  // two-state toggle in practice, kept as three values only to reuse the
  // existing "later" sentinel and the editing-campaign prefill below.
  const [scheduleKind, setScheduleKind] = useState<"now" | "later" | "draft">("draft");
  const [scheduledFor, setScheduledFor] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Overwrite-confirmation for template selection — only asked when the
  // user already has non-empty subject/body content that a newly-picked
  // template would silently replace (Phase 14.1 message-templates review).
  const [pendingTemplateId, setPendingTemplateId] = useState<string | null>(null);

  const channelTemplates = templates.filter((t) => t.channel === channel && !t.isArchived);
  const channelBuiltIns = getBuiltInMarketingTemplates(channel);
  const { result: preview, loading: previewLoading, error: previewError, retry: retryPreview } = useAudiencePreview(filters, channel, segmentId);

  function reset() {
    setStep(1); setName(""); setChannel("email"); setSegmentId(undefined); setFilters({ conditions: [] });
    setTemplateId(undefined); setBuiltInTemplateId(undefined); setSubject(""); setBody(""); setScheduleKind("draft"); setScheduledFor("");
    setPendingTemplateId(null);
  }

  // Prefill from an existing draft/scheduled campaign when opened for editing.
  useEffect(() => {
    if (open && editingCampaign) {
      setStep(1);
      setName(editingCampaign.name);
      setChannel(editingCampaign.channel);
      setSegmentId(editingCampaign.segmentId ?? undefined);
      setFilters(editingCampaign.audienceFilters ?? { conditions: [] });
      setTemplateId(editingCampaign.templateId ?? undefined);
      // Built-ins are never persisted, so an editing draft never has one —
      // explicitly clear any stale selection left over from an earlier
      // "create new" session in this same (persistently-mounted) sheet.
      setBuiltInTemplateId(undefined);
      setSubject(editingCampaign.emailSubject ?? "");
      setBody(editingCampaign.body);
      setScheduleKind(editingCampaign.status === "scheduled" ? "later" : "draft");
      setScheduledFor(editingCampaign.scheduledAt ? editingCampaign.scheduledAt.slice(0, 16) : "");
      // Regression guard (Phase 14.1 duplicate-flow audit): these two were
      // previously only cleared in reset() (the "new campaign" branch),
      // never here. A template-overwrite confirmation left open, or a
      // submit still in flight, from whatever campaign was being edited a
      // moment ago must never bleed into a DIFFERENT campaign this sheet
      // switches to editing next (e.g. rapidly opening one draft, then
      // another) — every other transient field on this line was already
      // reset per-campaign; these two were the gap.
      setPendingTemplateId(null);
      setSubmitting(false);
    } else if (open && !editingCampaign) {
      reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editingCampaign?.id]);

  // A template (built-in or saved) selected for one channel is meaningless
  // on the other — if the user switches channel, drop a now-incompatible
  // selection rather than silently keeping a stale reference (Phase 14.1
  // review). Only reacts to channel changes, so it never fights a
  // selection the user just made for the current channel, and it's a
  // no-op after the editing-campaign prefill (whose templateId always
  // already matches its own channel; built-ins are never persisted, so a
  // prefilled draft never carries a stale builtInTemplateId to begin with).
  useEffect(() => {
    if (templateId && !channelTemplates.some((t) => t.id === templateId)) {
      setTemplateId(undefined);
    }
    if (builtInTemplateId && !channelBuiltIns.some((t) => t.id === builtInTemplateId)) {
      setBuiltInTemplateId(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);

  // Template selection (built-in or saved) is a one-time "starting point"
  // copy into the draft — never a live binding. Editing the campaign
  // afterward never mutates the source template, and the source being
  // edited/deleted later never mutates an already-populated campaign
  // draft (Phase 14.1 review). Built-ins additionally never touch
  // `templateId` (a real FK into marketing_templates) — a built-in's
  // string id must never land in that UUID column.
  function applySavedTemplateNow(id: string) {
    const tpl = channelTemplates.find((t) => t.id === id);
    if (!tpl) return;
    setTemplateId(id);
    setBuiltInTemplateId(undefined);
    setSubject(tpl.emailSubject ?? "");
    setBody(tpl.body);
  }

  function applyBuiltInTemplateNow(id: string) {
    const tpl = channelBuiltIns.find((t) => t.id === id);
    if (!tpl) return;
    setBuiltInTemplateId(id);
    setTemplateId(undefined);
    if (channel === "email") setSubject(tpl.subject ?? "");
    setBody(tpl.body);
  }

  function applySelectionNow(value: string) {
    if (isBuiltInMarketingTemplateId(value)) applyBuiltInTemplateNow(value);
    else applySavedTemplateNow(value);
  }

  const SCRATCH_VALUE = "__scratch";

  function handleTemplateSelect(value: string) {
    if (value === SCRATCH_VALUE) {
      // Detaching from a template never clears already-entered content —
      // it's the campaign's own content now, independent of any template.
      setTemplateId(undefined);
      setBuiltInTemplateId(undefined);
      return;
    }
    const hasContent = body.trim().length > 0 || (channel === "email" && subject.trim().length > 0);
    if (hasContent) {
      setPendingTemplateId(value);
    } else {
      applySelectionNow(value);
    }
  }

  // Takes an explicit mode rather than reading `scheduleKind` from closure —
  // the Review step's "Save draft" is now a distinct, always-available
  // footer action independent of whatever Send now/Schedule toggle state
  // the content area happens to be in (Phase 14.1 Review-step review,
  // item 8: removes the old bug where "Save draft" effectively appeared
  // twice — once as a content-area toggle option, once as the footer
  // button's label whenever scheduleKind defaulted to "draft").
  async function handleSubmit(mode: "now" | "later" | "draft") {
    if (!name.trim()) { toast.error("Give your campaign a name"); return; }
    if (!body.trim() && mode !== "draft") { toast.error("Message body cannot be empty"); return; }
    // A non-blank subject is only required to actually schedule/send — the
    // database itself enforces this too (see the write-guard trigger's
    // scheduling-readiness check), so this is a friendlier early check,
    // not the only enforcement. Saving a draft before finishing the
    // Message step must remain possible (Phase 14.1 hardening review,
    // item 5).
    if (channel === "email" && !subject.trim() && mode !== "draft") { toast.error("Email subject is required to send/schedule"); return; }
    if (mode === "later" && !scheduledFor) { toast.error("Pick a date and time to schedule"); return; }
    // Client-side safety only — the server independently re-resolves the
    // audience on submission (marketing-campaign-send.ts reuses the exact
    // same resolver as this preview) and remains the sole authority on who
    // actually receives the campaign. This just stops a submit that the
    // Review step's own UI is currently showing as unsafe/unknown: no
    // eligible recipients, resolution still in flight, or resolution
    // failed outright (Phase 14.1 Review-step recipient preview, item 10).
    if (mode !== "draft" && (preview?.eligibleCount ?? 0) === 0) { toast.error("No eligible recipients to send to"); return; }
    if (mode !== "draft" && previewLoading) { toast.error("Still resolving recipients — try again in a moment"); return; }
    if (mode !== "draft" && previewError) { toast.error("Could not resolve recipients — retry before sending"); return; }

    setSubmitting(true);
    try {
      // Every client-authored insert/update can only ever land a campaign
      // as 'draft' — RLS and the database write-guard trigger both enforce
      // this now. Scheduling/sending is a separate, trusted-backend step
      // below (sendCampaign), never a status this store sets directly.
      const campaign = editingCampaign
        ? await updateCampaignDraft(editingCampaign.id, {
            name, channel, emailSubject: subject, body,
            templateId: templateId ?? null, segmentId: segmentId ?? null,
            audienceFilters: segmentId ? null : filters,
          })
        : await createCampaign({
            name, channel, emailSubject: subject, body,
            templateId: templateId ?? null, segmentId: segmentId ?? null,
            audienceFilters: segmentId ? null : filters,
          });
      if (!campaign) { toast.error("Failed to save campaign"); return; }

      if (mode === "now") {
        const res = await sendCampaign({ campaignId: campaign.id, mode: "now" });
        upsertCampaignFromRow(res.campaign);
        toast.success(`Queued for ${res.recipientsQueued} recipients`);
      } else if (mode === "later") {
        const res = await sendCampaign({ campaignId: campaign.id, mode: "schedule", scheduledAt: new Date(scheduledFor).toISOString() });
        upsertCampaignFromRow(res.campaign);
        toast.success(`Scheduled for ${new Date(scheduledFor).toLocaleString()}`);
      } else {
        toast.success("Saved as draft");
      }
      reset();
      onClose();
    } catch (err: any) {
      toast.error(err.message ?? "Failed to send campaign");
    } finally {
      setSubmitting(false);
    }
  }

  const SMS_LIMIT = 160;
  const overSms = channel === "sms" && body.length > SMS_LIMIT;

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) { reset(); onClose(); } }}>
      <SheetContent side="right" className="w-full sm:max-w-2xl flex flex-col p-0">
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle className="flex items-center gap-2"><Megaphone className="h-4 w-4" /> {editingCampaign ? "Edit Campaign" : "Create Campaign"}</SheetTitle>
          <SheetDescription>Step {step} of 4 — {["Campaign", "Audience", "Message", "Review"][step - 1]}</SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {step === 1 && (
            <>
              <div className="grid gap-2">
                <Label>Campaign name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Spring kitchen promo" />
              </div>
              <div className="grid gap-2">
                <Label>Channel</Label>
                <Select value={channel} onValueChange={(v) => setChannel(v as CampaignChannel)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="email"><Mail className="mr-2 inline h-3.5 w-3.5" />Email</SelectItem>
                    <SelectItem value="sms"><MessageSquare className="mr-2 inline h-3.5 w-3.5" />SMS</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="grid gap-2">
                <div className="flex items-center justify-between">
                  <Label>Audience</Label>
                  {segments.length === 0 && (
                    <button type="button" onClick={onManageAudiences} className="text-[11px] font-medium text-primary hover:underline">
                      Manage audiences
                    </button>
                  )}
                </div>
                <Select value={segmentId ?? "__custom"} onValueChange={(v) => setSegmentId(v === "__custom" ? undefined : v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__custom">Custom filters</SelectItem>
                    {segments.length > 0 && (
                      <>
                        <SelectSeparator />
                        <SelectGroup>
                          <SelectLabel>Saved audiences</SelectLabel>
                          {segments.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                        </SelectGroup>
                      </>
                    )}
                  </SelectContent>
                </Select>
              </div>
              {segmentId ? (
                <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs flex items-center gap-2">
                  <LayoutGrid className="h-3.5 w-3.5 text-primary shrink-0" />
                  <span className="truncate">
                    Using saved audience: <span className="font-medium text-foreground">{segments.find((s) => s.id === segmentId)?.name ?? "—"}</span>
                  </span>
                </div>
              ) : (
                <AudienceFilterForm filters={filters} onChange={setFilters} />
              )}
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs space-y-1">
                {previewLoading ? (
                  <span className="text-muted-foreground">Calculating…</span>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <Users className="h-3.5 w-3.5 text-primary" />
                      <span><span className="font-medium text-foreground">{preview?.eligibleCount ?? 0}</span> eligible · <span className="font-medium text-foreground">{preview?.excludedCount ?? 0}</span> excluded</span>
                    </div>
                    {preview && Object.entries(preview.exclusionBreakdown).map(([reason, count]) => (
                      <div key={reason} className="text-muted-foreground pl-5">{reason}: {count}</div>
                    ))}
                  </>
                )}
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="grid gap-2">
                <div className="flex items-center justify-between">
                  <Label className="flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5" /> Template</Label>
                  {channelTemplates.length === 0 && (
                    <button type="button" onClick={onManageTemplates} className="text-[11px] font-medium text-primary hover:underline">
                      Manage templates
                    </button>
                  )}
                </div>
                <Select value={templateId ?? builtInTemplateId ?? SCRATCH_VALUE} onValueChange={handleTemplateSelect}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SCRATCH_VALUE}>Start from scratch</SelectItem>
                    {channelBuiltIns.length > 0 && (
                      <>
                        <SelectSeparator />
                        <SelectGroup>
                          <SelectLabel>Built-in templates</SelectLabel>
                          {channelBuiltIns.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                        </SelectGroup>
                      </>
                    )}
                    {channelTemplates.length > 0 && (
                      <>
                        <SelectSeparator />
                        <SelectGroup>
                          <SelectLabel>Saved templates</SelectLabel>
                          {channelTemplates.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                        </SelectGroup>
                      </>
                    )}
                  </SelectContent>
                </Select>
              </div>
              {channel === "email" && (
                <div className="grid gap-2">
                  <Label>Subject</Label>
                  <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject line — merge tags allowed" />
                </div>
              )}
              <div className="grid gap-2">
                <div className="flex items-center justify-between">
                  <Label>{channel === "email" ? "Email body" : "SMS message"}</Label>
                  {channel === "sms" && <span className={cn("text-xs", overSms ? "text-destructive" : "text-muted-foreground")}>{body.length} / {SMS_LIMIT}</span>}
                </div>
                <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={channel === "email" ? 10 : 5} className="font-mono text-sm" placeholder={channel === "email" ? "Hi {{first_name}},\n\nWrite your message…" : "Hey {{first_name}}, …"} />
                <div className="flex flex-wrap gap-1">
                  {MERGE_TAGS.map((t) => (
                    <button key={t} type="button" onClick={() => setBody((b) => `${b}{{${t}}}`)} className="rounded-md border border-dashed border-border px-1.5 py-0.5 text-[11px] font-mono text-muted-foreground hover:bg-secondary hover:text-foreground">
                      {`{{${t}}}`}
                    </button>
                  ))}
                </div>
              </div>
              <MessagePreview channel={channel} subject={subject} body={body} />
            </>
          )}

          {step === 4 && (
            <div className="space-y-4">
              <div className="rounded-lg border p-4 space-y-2 text-sm">
                <div className="flex justify-between gap-3"><span className="text-muted-foreground shrink-0">Campaign</span><span className="font-medium truncate">{name || "(untitled)"}</span></div>
                <div className="flex justify-between gap-3"><span className="text-muted-foreground shrink-0">Channel</span><ChannelBadge channel={channel} /></div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground shrink-0">Audience</span>
                  <span className="font-medium truncate">
                    {segmentId ? (segments.find((s) => s.id === segmentId)?.name ?? "Saved audience") : "Custom filters"}
                  </span>
                </div>
                <div className="flex justify-between gap-3"><span className="text-muted-foreground shrink-0">Eligible recipients</span><span className="font-medium">{preview?.eligibleCount ?? 0}</span></div>
                <div className="flex justify-between gap-3"><span className="text-muted-foreground shrink-0">Excluded</span><span className="font-medium">{preview?.excludedCount ?? 0}</span></div>
              </div>

              <MessagePreview channel={channel} subject={subject} body={body} />

              <RecipientPreviewSection preview={preview} loading={previewLoading} error={previewError} onRetry={retryPreview} />

              {(preview?.eligibleCount ?? 0) === 0 && !previewLoading && !previewError && (
                <p className="text-xs text-destructive">No eligible recipients in this audience — Send now and Schedule are disabled until this campaign has at least one eligible recipient.</p>
              )}

              <div className="grid gap-2">
                <Label>Send</Label>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={submitting || previewLoading || previewError || (preview?.eligibleCount ?? 0) === 0}
                    onClick={() => handleSubmit("now")}
                  >
                    <Send className="mr-1.5 h-3.5 w-3.5" /> Send now
                  </Button>
                  <Button
                    type="button"
                    variant={scheduleKind === "later" ? "default" : "outline"}
                    size="sm"
                    disabled={submitting || previewLoading || previewError || (preview?.eligibleCount ?? 0) === 0}
                    onClick={() => setScheduleKind((k) => (k === "later" ? "draft" : "later"))}
                  >
                    <CalendarIcon className="mr-1.5 h-3.5 w-3.5" /> Schedule
                  </Button>
                </div>
                {scheduleKind === "later" && (
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <Input type="datetime-local" value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} className="w-fit" />
                    <Button type="button" size="sm" variant="outline" disabled={submitting || !scheduledFor || previewLoading || previewError || (preview?.eligibleCount ?? 0) === 0} onClick={() => handleSubmit("later")}>
                      Confirm schedule
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <SheetFooter className="border-t px-6 py-3 flex !justify-between">
          <div>
            {step > 1 && <Button variant="ghost" onClick={() => setStep((s) => (s - 1) as Step)}><ChevronLeft className="mr-1 h-4 w-4" /> Back</Button>}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
            {step < 4 ? (
              <Button onClick={() => setStep((s) => (s + 1) as Step)}>Next <ChevronRight className="ml-1 h-4 w-4" /></Button>
            ) : (
              <Button variant="outline" onClick={() => handleSubmit("draft")} disabled={submitting}>
                <FileEdit className="mr-1.5 h-4 w-4" /> Save draft
              </Button>
            )}
          </div>
        </SheetFooter>
      </SheetContent>

      <AlertDialog open={pendingTemplateId !== null} onOpenChange={(o) => { if (!o) setPendingTemplateId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Use this template?</AlertDialogTitle>
            <AlertDialogDescription>
              This will replace the current campaign message with the selected template. You can edit it afterward.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingTemplateId(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingTemplateId) applySelectionNow(pendingTemplateId);
                setPendingTemplateId(null);
              }}
            >
              Use Template
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}

// ---------- Campaign detail / results ----------

type RecipientRow = { id: string; contact_id: string; destination: string; status: string; sent_at: string | null; failed_at: string | null; failure_reason: string | null; excluded_reason: string | null };

function CampaignDetailSheet({ campaign, onEdit, onClose }: { campaign: MarketingCampaign | undefined; onEdit: () => void; onClose: () => void }) {
  const [recipients, setRecipients] = useState<RecipientRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  useEffect(() => {
    if (!campaign) { setRecipients([]); return; }
    setLoading(true);
    supabase
      .from("campaign_recipients")
      .select("id, contact_id, destination, status, sent_at, failed_at, failure_reason, excluded_reason")
      .eq("campaign_id", campaign.id)
      .order("created_at", { ascending: true })
      .limit(200)
      .then(({ data, error }) => {
        if (error) console.error("[marketing] recipients fetch failed:", error);
        setRecipients(data ?? []);
        setLoading(false);
      });
  }, [campaign?.id]);

  const open = Boolean(campaign);
  if (!campaign) return <Sheet open={open} onOpenChange={(o) => !o && onClose()}><SheetContent /></Sheet>;

  const actions = getCampaignAvailableActions(campaign.status);

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <div className="flex items-center gap-2">
            <ChannelBadge channel={campaign.channel} />
            <CampaignStatusBadge status={campaign.status} />
          </div>
          <SheetTitle className="text-xl">{campaign.name}</SheetTitle>
          <SheetDescription>
            {campaign.scheduledAt && <>Scheduled for {new Date(campaign.scheduledAt).toLocaleString()}</>}
            {campaign.completedAt && <>Completed {new Date(campaign.completedAt).toLocaleString()}</>}
            {!campaign.scheduledAt && !campaign.completedAt && "Not yet scheduled or sent"}
          </SheetDescription>
        </SheetHeader>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-5">
          <StatPill label="Recipients" value={campaign.recipientsTotal} />
          <StatPill label="Sent" value={campaign.recipientsSent} />
          <StatPill label="Failed" value={campaign.recipientsFailed} />
          <StatPill label="Excluded" value={campaign.recipientsExcluded} />
        </div>

        <div className="mt-6 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Message</h3>
          <div className="rounded-lg border bg-background p-4">
            {campaign.channel === "email" && campaign.emailSubject && (
              <>
                <div className="text-[11px] text-muted-foreground">Subject</div>
                <div className="text-sm font-semibold mb-3">{campaign.emailSubject}</div>
              </>
            )}
            <div className="whitespace-pre-wrap text-sm leading-relaxed">{campaign.body}</div>
          </div>
        </div>

        {recipients.length > 0 && (
          <div className="mt-6 space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recipients</h3>
            <div className="rounded-lg border max-h-80 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Destination</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recipients.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-xs">{r.destination || "—"}</TableCell>
                      <TableCell className="text-xs capitalize">{r.status}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{r.failure_reason ?? r.excluded_reason ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
        {loading && <p className="mt-4 text-xs text-muted-foreground">Loading recipients…</p>}

        <SheetFooter className="mt-6 flex !justify-between border-t pt-4">
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <div className="flex items-center gap-2">
            {actions.includes("edit") && (
              <Button variant="outline" onClick={onEdit}><FileEdit className="mr-1.5 h-4 w-4" /> Edit draft</Button>
            )}
            {actions.includes("pause") && (
              <Button variant="outline" disabled={busy} onClick={() => handlePauseCampaign(campaign, setBusy)}>
                {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Pause className="mr-1.5 h-4 w-4" />} Pause
              </Button>
            )}
            {actions.includes("resume") && (
              <Button variant="outline" disabled={busy} onClick={() => handleResumeCampaign(campaign, setBusy)}>
                {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />} Resume
              </Button>
            )}
            {actions.includes("cancel") && (
              <Button variant="outline" disabled={busy} onClick={() => handleCancelCampaign(campaign, setBusy)}>
                {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <X className="mr-1.5 h-4 w-4" />} Cancel
              </Button>
            )}
            {actions.includes("delete") && (
              <Button variant="destructive" onClick={() => setDeleteConfirmOpen(true)}>
                <Trash2 className="mr-1.5 h-4 w-4" /> Delete campaign
              </Button>
            )}
          </div>
        </SheetFooter>
      </SheetContent>

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete campaign?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes this draft campaign. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteConfirmOpen(false)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async (e) => {
                e.preventDefault();
                setDeleteConfirmOpen(false);
                await handleDeleteDraftCampaign(campaign, onClose);
              }}
            >
              Delete Campaign
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}

function StatPill({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
