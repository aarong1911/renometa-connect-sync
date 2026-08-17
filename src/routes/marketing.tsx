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

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import {
  Megaphone, Mail, MessageSquare, Send, Calendar as CalendarIcon, Users, Eye,
  MoreHorizontal, Copy, Trash2, X, Clock, CheckCircle2, FileEdit, Plus,
  Sparkles, ChevronRight, ChevronLeft, AlertTriangle, LayoutGrid, Archive,
  Pause, Play, Loader2,
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

function MarketingPage() {
  const { tab, createCampaign: composerOpen, campaignId, editCampaignId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const campaigns = useMarketingCampaigns();
  const templates = useMarketingTemplates();
  const segments = useMarketingSegments();
  const contacts = useContacts();

  const kpis = useMemo(() => ({
    sent: campaigns.filter((c) => c.status === "completed").length,
    scheduled: campaigns.filter((c) => c.status === "scheduled" || c.status === "queued" || c.status === "sending").length,
    drafts: campaigns.filter((c) => c.status === "draft").length,
    contacts: contacts.length,
  }), [campaigns, contacts]);

  const selectedCampaign = campaigns.find((c) => c.id === campaignId);

  return (
    <>
      <PageHeader
        icon={Megaphone}
        iconBg="bg-info-soft"
        iconColor="text-info"
        title="Marketing"
        subtitle="Create campaigns, reach customers, and track engagement from one place."
        actions={
          <Button onClick={() => navigate({ search: (p) => ({ ...p, createCampaign: true }) })}>
            <Plus className="mr-1.5 h-4 w-4" /> Create Campaign
          </Button>
        }
      />

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
