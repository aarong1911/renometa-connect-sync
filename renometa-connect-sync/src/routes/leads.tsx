import { createFileRoute, useNavigate, useSearch, Link } from "@tanstack/react-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ContactAvatar } from "@/components/ui/contact-avatar";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Plus, Search, Mail, Phone, MapPin, Target, Flame, Thermometer, Snowflake,
  ArrowRight, MoreHorizontal, DollarSign, Calendar, User, Building2,
  ExternalLink, SlidersHorizontal, FileText, Sparkles,
} from "lucide-react";
import { Download, Upload } from "lucide-react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { StickyNote, Pencil, Check, X as XIcon } from "lucide-react";
import { type Lead, type LeadSource, type LeadStatus, type LeadScore } from "@/lib/mock-data";
import { formatMoney, formatDateShort, formatPhone } from "@/lib/format";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { useTeam } from "@/lib/organization";
import {
  useLeads, addLead as storeAddLead, updateLeadStatus as storeUpdateStatus,
  updateLeadScore as storeUpdateScore, convertLead as storeConvertLead, importLeads,
} from "@/lib/leads-store";
import { useLeadNotes, addLeadNote } from "@/lib/leads-store";
import { updateLeadNote } from "@/lib/leads-store";
import { addDeal as storeAddDeal } from "@/lib/deals-store";
import { useActivePipelineId, usePipelines } from "@/lib/pipelines";
import {
  leadsToCSV, downloadCSV, parseCSVPreview, autoMapHeaders, applyMappingToLeads,
  LEAD_FIELDS, type ColumnMapping, type LeadFieldKey, type TemplateType,
} from "@/lib/leads-csv";

type LeadsSearch = { leadId?: string };

export const Route = createFileRoute("/leads")({
  validateSearch: (raw: Record<string, unknown>): LeadsSearch => ({
    leadId: typeof raw.leadId === "string" ? raw.leadId : undefined,
  }),
  component: LeadsPage,
});

const SOURCE_FILTERS = ["All sources", "Website", "Referral", "Angi", "Thumbtack", "Google Ads", "Walk-in", "Social Media"] as const;
const STATUS_FILTERS = ["All statuses", "new", "contacted", "qualified", "converted", "lost"] as const;
const SCORE_FILTERS = ["All scores", "hot", "warm", "cold"] as const;
const ALL_SOURCES: LeadSource[] = ["Website", "Referral", "Angi", "Thumbtack", "Google Ads", "Walk-in", "Social Media"];
const ALL_STATUSES: LeadStatus[] = ["new", "contacted", "qualified", "converted", "lost"];
const ALL_SCORES: LeadScore[] = ["hot", "warm", "cold"];
const PROJECT_TYPES = ["Kitchen Remodel", "Bath Remodel", "Whole Home Renovation", "Basement Finish", "Addition", "Outdoor Living", "Primary Suite"];

const STATUS_LABELS: Record<LeadStatus, string> = {
  new: "New", contacted: "Contacted", qualified: "Qualified", converted: "Converted", lost: "Lost",
};

function scoreIcon(score: LeadScore) {
  switch (score) {
    case "hot": return { Icon: Flame, className: "text-red-500" };
    case "warm": return { Icon: Thermometer, className: "text-amber-500" };
    case "cold": return { Icon: Snowflake, className: "text-sky-500" };
  }
}

function statusBadgeVariant(status: LeadStatus): "default" | "secondary" | "outline" | "destructive" {
  switch (status) {
    case "new": return "default";
    case "contacted": return "secondary";
    case "qualified": return "outline";
    case "converted": return "default";
    case "lost": return "destructive";
  }
}

function LeadsPage() {
  const { leadId } = useSearch({ from: "/leads" });
  const navigate = useNavigate({ from: "/leads" });
  const teamMembers = useTeam();
  const pipelines = usePipelines();
  const activePipelineId = useActivePipelineId();
  const activePipeline = useMemo(
    () => pipelines.find((p) => p.id === activePipelineId) ?? null,
    [pipelines, activePipelineId],
  );
  const leads = useLeads();
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>("All sources");
  const [statusFilter, setStatusFilter] = useState<string>("All statuses");
  const [scoreFilter, setScoreFilter] = useState<string>("All scores");
  const [selected, setSelected] = useState<Lead | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [csvRaw, setCsvRaw] = useState("");
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvPreview, setCsvPreview] = useState<string[][]>([]);
  const [csvTotalRows, setCsvTotalRows] = useState(0);
  const [colMapping, setColMapping] = useState<ColumnMapping | null>(null);
  const [templateType, setTemplateType] = useState<TemplateType>("lead");
  const [newLead, setNewLead] = useState({
    name: "", email: "", phone: "", address: "", source: "" as string,
    projectType: "", estimatedBudget: "", score: "" as string, owner: "", notes: "",
  });

  // Deep-link
  useEffect(() => {
    if (leadId) {
      const found = leads.find((l) => l.id === leadId);
      if (found && found.id !== selected?.id) setSelected(found);
    } else {
      setSelected(null);
    }
  }, [leadId, leads]);

  const filtered = useMemo(() => {
    let list = leads;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((l) =>
        l.name.toLowerCase().includes(q) || l.email.toLowerCase().includes(q) || l.phone.includes(q) || l.projectType.toLowerCase().includes(q),
      );
    }
    if (sourceFilter !== "All sources") list = list.filter((l) => l.source === sourceFilter);
    if (statusFilter !== "All statuses") list = list.filter((l) => l.status === statusFilter);
    if (scoreFilter !== "All scores") list = list.filter((l) => l.score === scoreFilter);
    return list;
  }, [leads, search, sourceFilter, statusFilter, scoreFilter]);

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
    navigate({ search: { leadId: lead.id }, replace: true });
  };

  const handleStatusChange = (id: string, newStatus: LeadStatus) => {
    storeUpdateStatus(id, newStatus);
    toast.success(`Lead status updated to ${STATUS_LABELS[newStatus]}`);
  };

  const handleScoreChange = (id: string, newScore: LeadScore) => {
    storeUpdateScore(id, newScore);
    toast.success(`Lead score updated to ${newScore}`);
  };

  const handleConvertToDeal = (lead: Lead) => {
    if (lead.status === "converted") {
      toast.error("Lead already converted");
      return;
    }
    storeConvertLead(lead.id);
    storeAddDeal({
      name: lead.name,
      contactName: lead.name,
      email: lead.email ?? "",
      phone: lead.phone ?? "",
      address: lead.address ?? "",
      value: lead.estimatedBudget ?? 0,
      stage: activePipeline?.stages[0]?.id ?? "new",
      ownerId: "",
      ownerName: lead.owner ?? "Unassigned",
    }).catch(() => {
      toast.error("Failed to create deal from lead.");
    });
    toast.success(`${lead.name} converted to deal`, { description: "A new deal has been created in the pipeline." });
    navigate({ search: { leadId: undefined }, replace: true });
  };

  const handleAddLead = () => {
    if (!newLead.name.trim()) return;
    const owner = newLead.owner || teamMembers[0]?.name || "Unassigned";
    const initials = owner.split(" ").map((p) => p[0]).join("");
    storeAddLead({
      name: newLead.name.trim(),
      email: newLead.email.trim(),
      phone: newLead.phone.trim(),
      address: newLead.address.trim(),
      source: (newLead.source || "Website") as LeadSource,
      status: "new",
      score: (newLead.score || "warm") as LeadScore,
      projectType: newLead.projectType || "Kitchen Remodel",
      estimatedBudget: Number(newLead.estimatedBudget) || 0,
      notes: newLead.notes.trim(),
      owner,
      ownerInitials: initials,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    });
    setAddOpen(false);
    setNewLead({ name: "", email: "", phone: "", address: "", source: "", projectType: "", estimatedBudget: "", score: "", owner: "", notes: "" });
    toast.success("Lead added");
  };

  const fileInputRef = useCallback((node: HTMLInputElement | null) => {
    if (node) node.value = "";
  }, []);

  const handleExport = () => {
    const csv = leadsToCSV(leads);
    downloadCSV(csv, `leads-export-${new Date().toISOString().slice(0, 10)}.csv`);
    toast.success(`Exported ${leads.length} leads`);
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const { headers, preview, totalRows } = parseCSVPreview(text);
      if (headers.length === 0 || totalRows === 0) {
        toast.error("Empty or invalid CSV file");
        return;
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

  const handleConfirmImport = () => {
    if (!colMapping) return;
    const { leads: parsed, errors } = applyMappingToLeads(csvRaw, colMapping);
    if (parsed.length === 0) {
      toast.error("No leads imported", { description: errors[0] || "Check your column mapping." });
      return;
    }
    const count = importLeads(parsed);
    toast.success(`Imported ${count} leads`, {
      description: errors.length ? `${errors.length} row(s) skipped.` : undefined,
    });
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

  return (
    <>
      <PageHeader
        icon={Target}
        iconBg="bg-info-soft"
        iconColor="text-info"
        title="Leads"
        subtitle="Track and qualify inbound leads"
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
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Add Lead
          </Button>
        </div>
      } />

      {/* KPIs */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Total Leads" value={String(stats.total)} icon={Target} tone="info" />
        <KpiCard label="New" value={String(stats.newCount)} icon={Plus} tone="violet" />
        <KpiCard label="Hot Leads" value={String(stats.hot)} icon={Flame} tone="destructive" />
        <KpiCard label="Converted" value={String(stats.converted)} icon={ArrowRight} tone="success" />
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 sm:max-w-xs">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search leads…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 pl-8 text-sm"
          />
        </div>
        <FilterSelect value={sourceFilter} onChange={setSourceFilter} options={SOURCE_FILTERS as unknown as string[]} />
        <FilterSelect value={statusFilter} onChange={setStatusFilter} options={STATUS_FILTERS as unknown as string[]} />
        <FilterSelect value={scoreFilter} onChange={setScoreFilter} options={SCORE_FILTERS as unknown as string[]} />
      </div>

      {/* Table */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2.5">Lead</th>
                <th className="px-4 py-2.5">Score</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="hidden px-4 py-2.5 md:table-cell">Source</th>
                <th className="hidden px-4 py-2.5 lg:table-cell">Project</th>
                <th className="hidden px-4 py-2.5 sm:table-cell">Budget</th>
                <th className="hidden px-4 py-2.5 lg:table-cell">Owner</th>
                <th className="px-4 py-2.5 text-right">Activity</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((lead) => {
                const { Icon: ScoreIcon, className: scoreCls } = scoreIcon(lead.score);
                return (
                  <tr
                    key={lead.id}
                    className="cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-muted/30"
                    onClick={() => openLead(lead)}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <ContactAvatar id={lead.id} name={lead.name} size="sm" />
                        <div className="min-w-0">
                          <div className="truncate font-medium">{lead.name}</div>
                          <div className="truncate text-[11px] text-muted-foreground">{lead.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <ScoreIcon className={`h-3.5 w-3.5 ${scoreCls}`} />
                        <span className="text-xs capitalize">{lead.score}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={statusBadgeVariant(lead.status)} className="text-[10px]">
                        {STATUS_LABELS[lead.status]}
                      </Badge>
                    </td>
                    <td className="hidden px-4 py-3 text-xs text-muted-foreground md:table-cell">{lead.source}</td>
                    <td className="hidden px-4 py-3 text-xs lg:table-cell">{lead.projectType}</td>
                    <td className="hidden px-4 py-3 text-xs tabular-nums sm:table-cell">{formatMoney(lead.estimatedBudget)}</td>
                    <td className="hidden px-4 py-3 lg:table-cell">
                      <div className="flex items-center gap-1.5">
                        <ContactAvatar id={lead.owner} name={lead.owner} size="xs" />
                        <span className="text-xs">{lead.owner}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-[11px] text-muted-foreground">
                      {formatDistanceToNow(new Date(lead.lastActivity), { addSuffix: true })}
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-sm text-muted-foreground">
                    No leads match your filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Detail drawer */}
      <LeadDetailDrawer
        lead={selected ? leads.find((l) => l.id === selected.id) ?? selected : null}
        onOpenChange={(o) => { if (!o) navigate({ search: { leadId: undefined }, replace: true }); }}
        onStatusChange={handleStatusChange}
        onScoreChange={handleScoreChange}
        onConvert={handleConvertToDeal}
        teamMembers={teamMembers.map((m) => ({ id: m.id, name: m.name }))}
      />

      {/* Add lead dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-lg">
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
              <Input value={newLead.address} onChange={(e) => setNewLead((p) => ({ ...p, address: e.target.value }))} placeholder="123 Main St" />
            </div>
            <div className="space-y-1.5">
              <Label>Source</Label>
              <Select value={newLead.source} onValueChange={(v) => setNewLead((p) => ({ ...p, source: v }))}>
                <SelectTrigger><SelectValue placeholder="Select source" /></SelectTrigger>
                <SelectContent>{ALL_SOURCES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
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
              <Select value={newLead.owner} onValueChange={(v) => setNewLead((p) => ({ ...p, owner: v }))}>
                <SelectTrigger><SelectValue placeholder="Assign owner" /></SelectTrigger>
                <SelectContent>{teamMembers.map((m) => <SelectItem key={m.id} value={m.name}>{m.name}</SelectItem>)}</SelectContent>
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
            <Button variant="outline" onClick={() => setMapOpen(false)}>Cancel</Button>
            <Button onClick={handleConfirmImport} disabled={!colMapping || colMapping.name < 0 || !importValidation?.validCount}>
              Import {importValidation?.validCount ?? 0} Lead{(importValidation?.validCount ?? 0) !== 1 ? "s" : ""}
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

function FilterSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 w-auto min-w-[120px] text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o} value={o} className="capitalize text-xs">{o === "new" ? "New" : o === "contacted" ? "Contacted" : o === "qualified" ? "Qualified" : o === "converted" ? "Converted" : o === "lost" ? "Lost" : o}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const KPI_TONE_CLASSES = {
  info: { badge: "bg-info-soft", icon: "text-info" },
  violet: { badge: "bg-violet-soft", icon: "text-violet" },
  destructive: { badge: "bg-destructive-soft", icon: "text-destructive" },
  success: { badge: "bg-success-soft", icon: "text-success" },
} as const;

function KpiCard({ label, value, icon: Icon, tone = "info" }: { label: string; value: string; icon: React.ComponentType<{ className?: string }>; tone?: keyof typeof KPI_TONE_CLASSES }) {
  return (
    <Card className="flex items-center gap-3 p-4">
      <div className={cn("flex h-9 w-9 items-center justify-center rounded-lg", KPI_TONE_CLASSES[tone].badge, KPI_TONE_CLASSES[tone].icon)}>
        <Icon className="h-4 w-4" />
      </div>
      <div>
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-lg font-semibold tabular-nums">{value}</div>
      </div>
    </Card>
  );
}

/* ---------- Detail drawer ---------- */

function LeadDetailDrawer({
  lead,
  onOpenChange,
  onStatusChange,
  onScoreChange,
  onConvert,
  teamMembers,
}: {
  lead: Lead | null;
  onOpenChange: (open: boolean) => void;
  onStatusChange: (id: string, status: LeadStatus) => void;
  onScoreChange: (id: string, score: LeadScore) => void;
  onConvert: (lead: Lead) => void;
  teamMembers: { id: string; name: string }[];
}) {
  if (!lead) return <Sheet open={false} onOpenChange={onOpenChange}><SheetContent className="hidden" /></Sheet>;

  const { Icon: ScoreIcon, className: scoreCls } = scoreIcon(lead.score);
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
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader className="space-y-3 border-b border-border pb-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1 text-left">
              <div className="mb-1.5 flex items-center gap-2">
                <Badge variant={statusBadgeVariant(lead.status)} className="text-[10px]">
                  {STATUS_LABELS[lead.status]}
                </Badge>
                <div className="flex items-center gap-1">
                  <ScoreIcon className={`h-3.5 w-3.5 ${scoreCls}`} />
                  <span className="text-[11px] capitalize text-muted-foreground">{lead.score}</span>
                </div>
              </div>
              <SheetTitle className="text-base leading-snug">{lead.name}</SheetTitle>
              <SheetDescription className="mt-0.5 text-xs">
                {lead.source} · Owned by {lead.owner}
              </SheetDescription>
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
            {nextStatuses.map((ns) => (
              <Button key={ns} size="sm" variant="outline" className="flex-1" onClick={() => onStatusChange(lead.id, ns)}>
                {STATUS_LABELS[ns]}
              </Button>
            ))}
          </div>

          {/* Quick actions */}
          <Button asChild size="sm" variant="outline" className="w-full">
            <Link
              to="/financials/estimates"
              search={{ template: "open", clientName: lead.name }}
            >
              <Sparkles className="mr-1.5 h-3.5 w-3.5 text-primary" />
              <FileText className="mr-1.5 h-3.5 w-3.5" />
              Create estimate from template
            </Link>
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
            <FactCard icon={User} label="Owner" value={lead.owner} />
            <FactCard icon={Target} label="Source" value={lead.source} />
            <FactCard icon={Building2} label="Project" value={lead.projectType} />
            <FactCard icon={Calendar} label="Created" value={formatDateShort(lead.createdAt)} />
          </section>

          <Separator />

          {/* Score selector */}
          <section>
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Lead Score</div>
            <div className="flex gap-2">
              {ALL_SCORES.map((s) => {
                const { Icon: SI, className: sc } = scoreIcon(s);
                return (
                  <button
                    key={s}
                    onClick={() => onScoreChange(lead.id, s)}
                    className={`flex flex-1 items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium capitalize transition-colors ${
                      lead.score === s
                        ? "border-primary/40 bg-primary-soft text-primary"
                        : "border-border bg-background text-foreground hover:bg-secondary/60"
                    }`}
                  >
                    <SI className={`h-3.5 w-3.5 ${sc}`} />
                    {s}
                  </button>
                );
              })}
            </div>
          </section>

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
                <div className="flex items-center gap-2 rounded-md border border-border bg-card p-3 text-sm">
                  <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground">Deal ID: {lead.convertedDealId}</span>
                </div>
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

function InternalNotes({ leadId }: { leadId: string }) {
  const notes = useLeadNotes(leadId);
  const [text, setText] = useState("");

  const handleAdd = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    addLeadNote(leadId, trimmed);
    setText("");
    toast.success("Note added");
  };

  const recent = notes.slice(0, 3);

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
            <EditableNote key={n.id} note={n} leadId={leadId} />
          ))}
        </div>
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