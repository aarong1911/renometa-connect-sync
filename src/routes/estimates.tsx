// src/routes/estimates.tsx
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ContactAvatar } from "@/components/ui/contact-avatar";
import { MetricCard } from "@/components/ui/metric-card";
import { StatusBadge, type BadgeTone } from "@/components/ui/status-badge";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectGroup, SelectLabel,
} from "@/components/ui/select";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  Search, MoreHorizontal, FileText, CheckCircle2, Clock, Send, Plus, Trash2, Loader2, Download,
  ChevronsUpDown, UserRound, Building2, X, AlertCircle, ArrowUp, ArrowDown, Heading,
  History, Activity as ActivityIcon, Handshake, FolderKanban, Receipt, Ban, RotateCcw, Archive,
  Copy as CopyIcon, ChevronRight, HardHat, Package, Wrench, Coins, Sparkles, MoreVertical, Save,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { AddressAutocomplete } from "@/components/ui/address-autocomplete";
import { useContacts } from "@/lib/contacts-store";
import { useCompanies, type Company } from "@/lib/companies-store";
import { useTeam } from "@/lib/organization";
import { createProject } from "@/lib/projects-store";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DecimalInput } from "@/components/ui/decimal-input";
import {
  ESTIMATE_STATUS_LABELS, normalizeEstimateStatus,
  ESTIMATE_ITEM_TYPE_ORDER, ESTIMATE_ITEM_TYPE_LABELS, ESTIMATE_ITEM_UNIT_LABELS,
  DISCOUNT_TYPE_LABELS, DEPOSIT_TYPE_LABELS,
  WORK_TYPE_ORDER, WORK_TYPE_LABELS, matchWorkTypeFromTitle,
  type EstimateStatus, type EstimateItemType, type EstimateItemUnit, type DiscountType, type DepositType, type WorkType,
} from "@/lib/estimate-status";
import { calculateEstimate, round2, type CalcLineItem } from "@/lib/estimate-calculations";
import {
  sharedPresetsForCategory, findSharedPreset, PROPOSAL_PRESET_CATEGORY_LABELS, type ProposalPresetCategory,
} from "@/lib/proposal-presets";
import {
  useOrgTemplates, saveOrgTemplate, deleteOrgTemplate, setDefaultTemplate, resolveDefaultContent,
  getScopeTemplates, resolveDefaultScopeContent, type OrgProposalTemplate, type TemplateCategory,
} from "@/lib/proposal-templates-store";
import { scopePresetsForWorkType, findScopePreset } from "@/lib/scope-of-work-presets";

// ── Route ─────────────────────────────────────────────────────────────────────

type EstimatesSearch = {
  openNew?: boolean;
  template?: string;
  clientName?: string;
  leadId?: string;
  contactId?: string;
  companyId?: string;
  dealId?: string;
  projectId?: string;
};

export const Route = createFileRoute("/estimates")({
  validateSearch: (raw: Record<string, unknown>): EstimatesSearch => ({
    openNew: raw.openNew === true || raw.openNew === "1" ? true : undefined,
    template: typeof raw.template === "string" ? raw.template : undefined,
    clientName: typeof raw.clientName === "string" ? raw.clientName : undefined,
    leadId: typeof raw.leadId === "string" ? raw.leadId : undefined,
    contactId: typeof raw.contactId === "string" ? raw.contactId : undefined,
    companyId: typeof raw.companyId === "string" ? raw.companyId : undefined,
    dealId: typeof raw.dealId === "string" ? raw.dealId : undefined,
    projectId: typeof raw.projectId === "string" ? raw.projectId : undefined,
  }),
  component: EstimatesPage,
});

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUS_TONE: Record<EstimateStatus, BadgeTone> = {
  draft: "muted",
  ready: "info",
  sent: "info",
  viewed: "violet",
  changes_requested: "warning",
  approved: "success",
  rejected: "danger",
  expired: "warning",
  converted: "success",
  cancelled: "muted",
  archived: "muted",
};

// ── Types ─────────────────────────────────────────────────────────────────────

type EstimateItem = {
  id: string;
  estimate_id: string;
  item_type: EstimateItemType;
  category: string;
  name: string;
  description: string | null;
  quantity: number;
  unit: string | null;
  unit_price: number;
  position: number;
  total: number;
  taxable: boolean;
  optional: boolean;
  is_heading: boolean;
};

type Estimate = {
  id: string;
  number: string | null;
  title: string;
  status: EstimateStatus;
  client_id: string | null;
  client_name: string;
  company_id: string | null;
  company_name: string | null;
  lead_id: string | null;
  deal_id: string | null;
  project_id: string | null;
  owner_id: string | null;
  owner_name: string | null;
  notes: string | null;
  scope: string | null;
  customer_note: string | null;
  terms: string | null;
  exclusions: string | null;
  assumptions: string | null;
  service_address: string | null;
  valid_until: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  viewed_at: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  expired_at: string | null;
  cancelled_at: string | null;
  changes_requested_at: string | null;
  public_token: string | null;
  version_number: number;
  currency: string;
  taxRate: number;
  discountType: DiscountType | null;
  discountValue: number;
  depositType: DepositType | null;
  depositValue: number;
  convertedDealId: string | null;
  convertedProjectId: string | null;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
  depositAmount: number;
  balanceDue: number;
  item_count: number;
  estimate_items: EstimateItem[];
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(s: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(`${s}T00:00:00`));
}
function fmtDateTime(s: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(s));
}
function formatMoney(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);
}
function daysUntil(dateStr: string): number {
  const d = new Date(`${dateStr}T00:00:00`);
  return Math.ceil((d.getTime() - Date.now()) / 86_400_000);
}
function plusDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Nullable FK columns must reach Supabase as `null`, never `""` or `undefined` inside a serialized payload — an empty string is a real (invalid) UUID value to Postgres, not "no value". */
function nullableUuid(value?: string | null): string | null {
  return value && value.trim() ? value : null;
}

/** Surfaces a Supabase/PostgREST error's real fields — code/message/details/hint/status — as a plain object, since the SDK's error is not always a plain enumerable Error and console.error("...", error) alone often renders as a collapsed, unhelpful `Object`. */
function serializeSupabaseError(error: unknown): { code: unknown; message: unknown; details: unknown; hint: unknown; status: unknown } {
  if (!error || typeof error !== "object") return { code: null, message: String(error), details: null, hint: null, status: null };
  const value = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown; status?: unknown; statusCode?: unknown };
  return {
    code: value.code ?? null,
    message: value.message ?? null,
    details: value.details ?? null,
    hint: value.hint ?? null,
    status: value.status ?? value.statusCode ?? null,
  };
}

async function getOrgId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: p } = await supabase.from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
  if (p?.organization_id) return p.organization_id;
  const { data: m } = await supabase.from("org_memberships").select("org_id").eq("member_id", user.id).maybeSingle();
  return m?.org_id ?? null;
}

function mapItems(raw: any[]): EstimateItem[] {
  return (raw ?? [])
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((row: any) => {
      const qty = Number(row.quantity ?? 0);
      const price = Number(row.unit_price ?? 0);
      return {
        id: row.id,
        estimate_id: row.estimate_id,
        item_type: (ESTIMATE_ITEM_TYPE_ORDER as string[]).includes(row.item_type) ? row.item_type : "custom",
        category: row.category ?? "Other",
        name: row.name ?? "",
        description: row.description ?? null,
        quantity: qty,
        unit: row.unit ?? null,
        unit_price: price,
        position: row.position ?? 0,
        total: Number(row.total ?? qty * price),
        taxable: row.taxable !== false,
        optional: !!row.optional,
        is_heading: !!row.is_heading,
      };
    });
}

/** Posts to estimate-send.ts: ensures a public_token, recalculates totals server-side, transitions draft/ready -> sent, and emails the client their proposal link. */
async function sendEstimateProposal(estimateId: string): Promise<{ ok: boolean; proposalUrl?: string; error?: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, error: "Not signed in" };
  const res = await fetch("/.netlify/functions/estimate-send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ estimateId }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || d.error) return { ok: false, error: d.error || "Failed to send proposal" };
  return { ok: true, proposalUrl: d.proposalUrl };
}

// ── Customer / Account picker (shared shape with New Project's picker) ────────

type CustomerOption = {
  kind: "contact" | "company";
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  companyName?: string | null;
  address?: string | null;
};

function companyAddressOf(c: Company): string | null {
  return [c.address, [c.city, c.state].filter(Boolean).join(", "), c.zip].filter(Boolean).join(", ") || null;
}

// ── Estimate Form Sheet (create + edit) ──────────────────────────────────────

type LineItem = {
  key: string;
  id?: string;
  itemType: EstimateItemType;
  name: string;
  description: string;
  quantity: string;
  unit: EstimateItemUnit;
  unitPrice: string;
  taxable: boolean;
  optional: boolean;
  isHeading: boolean;
};

function newLineItem(overrides: Partial<LineItem> = {}): LineItem {
  return {
    key: `n${Math.random().toString(36).slice(2)}`,
    itemType: "labor", name: "", description: "", quantity: "1", unit: "each",
    unitPrice: "", taxable: true, optional: false, isHeading: false,
    ...overrides,
  };
}

function itemToLine(i: EstimateItem): LineItem {
  return {
    key: i.id, id: i.id, itemType: i.item_type, name: i.name, description: i.description ?? "",
    quantity: String(i.quantity), unit: (i.unit as EstimateItemUnit) || "each", unitPrice: String(i.unit_price),
    taxable: i.taxable, optional: i.optional, isHeading: i.is_heading,
  };
}

function toCalcItem(li: LineItem): CalcLineItem {
  return {
    quantity: parseFloat(li.quantity) || 0,
    unitPrice: parseFloat(li.unitPrice) || 0,
    taxable: li.taxable,
    optional: li.optional,
    selectedByCustomer: true,
    isHeading: li.isHeading,
  };
}

// ── Proposal Content field: template selector + editable textarea ─────────
// Selecting a preset/template COPIES its text into local form state — never
// a live reference. Later edits to the preset or org template never touch
// an estimate that already copied from it (Part 4/9's core requirement).
function ProposalContentField({
  category, label, value, onChange, orgTemplates, onSaveAsTemplate, placeholder, rows = 2,
}: {
  category: ProposalPresetCategory;
  label: string;
  value: string;
  onChange: (v: string) => void;
  orgTemplates: OrgProposalTemplate[];
  onSaveAsTemplate: () => void;
  placeholder?: string;
  rows?: number;
}) {
  const shared = sharedPresetsForCategory(category);
  const orgOnes = orgTemplates.filter(t => t.category === category);

  const applyPreset = (selectValue: string) => {
    if (selectValue === "blank") {
      if (value.trim() && !window.confirm(`Clear the current ${label.toLowerCase()} text?`)) return;
      onChange("");
      return;
    }
    if (selectValue.startsWith("shared:")) {
      const preset = findSharedPreset(selectValue.slice(7));
      if (preset) onChange(preset.content);
      return;
    }
    if (selectValue.startsWith("org:")) {
      const tpl = orgOnes.find(t => t.id === selectValue.slice(4));
      if (tpl) onChange(tpl.content);
    }
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs">{label}</Label>
        <div className="flex items-center gap-1">
          <Select onValueChange={applyPreset}>
            <SelectTrigger className="h-6 w-44 text-[10.5px]" aria-label={`${label} template`}><SelectValue placeholder="Use a template…" /></SelectTrigger>
            <SelectContent>
              {shared.map(p => <SelectItem key={p.id} value={`shared:${p.id}`} className="text-xs">{p.name}</SelectItem>)}
              {orgOnes.map(t => <SelectItem key={t.id} value={`org:${t.id}`} className="text-xs">{t.name}{t.is_default ? " · Default" : ""}</SelectItem>)}
              <SelectItem value="blank" className="text-xs">Blank</SelectItem>
            </SelectContent>
          </Select>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="ghost" size="icon" className="h-6 w-6" onClick={onSaveAsTemplate} aria-label={`Save ${label} as organization template`}>
                <Save className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Save as organization template</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <Textarea rows={rows} placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} className="resize-none text-xs" />
    </div>
  );
}

/** Icon-only action button with a tooltip label — used for line-item move/duplicate/delete actions (Part 21: "action icons have tooltips"). */
function TooltipIconButton({
  label, onClick, disabled, children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="h-6 w-6" disabled={disabled} onClick={onClick} aria-label={label}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function EstimateFormSheet({
  open, onClose, orgId, onSaved, estimate, initialLead, initialContext,
}: {
  open: boolean;
  onClose: () => void;
  orgId: string;
  onSaved: () => void;
  estimate?: Estimate; // undefined = create mode
  initialLead?: { contactId: string; name: string; projectType: string; budget: number; notes: string; leadId: string } | null;
  initialContext?: { contactId?: string; companyId?: string; dealId?: string; projectId?: string } | null;
}) {
  const isEdit = !!estimate;
  const contacts = useContacts();
  const companies = useCompanies();
  const teamMembers = useTeam().filter(m => m.status === "active");
  const { templates: orgTemplates, refresh: refreshOrgTemplates } = useOrgTemplates();

  const [workType, setWorkType] = useState<WorkType>("kitchen_remodel");
  const [customWorkType, setCustomWorkType] = useState("");
  const customWorkTypeRef = useRef<HTMLInputElement | null>(null);
  const [saveTemplateFor, setSaveTemplateFor] = useState<{ category: ProposalPresetCategory; content: string } | null>(null);
  const [saveScopeTemplateOpen, setSaveScopeTemplateOpen] = useState(false);
  const [pendingWorkType, setPendingWorkType] = useState<WorkType | null>(null);
  const [title, setTitle] = useState("");
  const [customer, setCustomer] = useState<CustomerOption | null>(null);
  const [customerOpen, setCustomerOpen] = useState(false);
  const [customerQuery, setCustomerQuery] = useState("");
  const [ownerId, setOwnerId] = useState("unassigned");
  const [address, setAddress] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [scope, setScope] = useState("");
  const [internalNote, setInternalNote] = useState("");
  const [customerNote, setCustomerNote] = useState("");
  const [terms, setTerms] = useState("");
  const [exclusions, setExclusions] = useState("");
  const [assumptions, setAssumptions] = useState("");
  const [taxRate, setTaxRate] = useState("0");
  const [discountType, setDiscountType] = useState<"none" | DiscountType>("none");
  const [discountValue, setDiscountValue] = useState("0");
  const [depositType, setDepositType] = useState<"none" | DepositType>("none");
  const [depositValue, setDepositValue] = useState("0");
  const [items, setItems] = useState<LineItem[]>([newLineItem()]);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const contactOptions = useMemo<CustomerOption[]>(() => contacts.map(c => ({
    kind: "contact", id: c.id, name: c.name, email: c.email, phone: c.phone,
    companyName: c.companyName ?? (c.company || null), address: c.address || null,
  })), [contacts]);
  const companyOptions = useMemo<CustomerOption[]>(() => companies.map(co => ({
    kind: "company", id: co.id, name: co.name, email: co.email, phone: co.phone, address: companyAddressOf(co),
  })), [companies]);
  const customerOptions = useMemo(() => [...contactOptions, ...companyOptions], [contactOptions, companyOptions]);
  const filteredCustomers = useMemo(() => {
    const q = customerQuery.trim().toLowerCase();
    if (!q) return customerOptions.slice(0, 50);
    return customerOptions.filter(o =>
      o.name.toLowerCase().includes(q) || (o.email ?? "").toLowerCase().includes(q) ||
      (o.phone ?? "").toLowerCase().includes(q) || (o.companyName ?? "").toLowerCase().includes(q),
    ).slice(0, 50);
  }, [customerOptions, customerQuery]);

  /** estimates.client_id is NOT NULL, so any Account-only estimate still needs a real contact underneath it — resolved from the account's first linked contact, same fallback as New Project. */
  function resolveClientId(c: CustomerOption): string | null {
    if (c.kind === "contact") return c.id;
    const linked = contacts.find(x => x.company_id === c.id);
    return linked?.id ?? null;
  }

  // ── Scope of Work templates, filtered by the currently selected Work Type ──
  const builtinScopePresets = useMemo(() => scopePresetsForWorkType(workType), [workType]);
  const orgScopeTemplates = useMemo(() => getScopeTemplates(orgTemplates, workType), [orgTemplates, workType]);
  const [scopeTemplateSelectOpen, setScopeTemplateSelectOpen] = useState(false);

  const applyScopeTemplate = (selectValue: string) => {
    if (selectValue === "blank") {
      if (scope.trim() && !window.confirm("Clear the current Scope of Work text?")) return;
      setScope("");
      return;
    }
    if (selectValue.startsWith("builtin:")) {
      const preset = findScopePreset(selectValue.slice(8));
      if (preset) setScope(preset.content);
      return;
    }
    if (selectValue.startsWith("org:")) {
      const tpl = orgScopeTemplates.find(t => t.id === selectValue.slice(4));
      if (tpl) setScope(tpl.content);
    }
  };

  /** Applies a Work Type change immediately — used both directly (Scope blank) and from the confirmation dialog's "Keep"/"Choose New Template" actions. */
  function commitWorkTypeChange(wt: WorkType) {
    setWorkType(wt);
    if (wt === "other") {
      setTitle(customWorkType);
      requestAnimationFrame(() => customWorkTypeRef.current?.focus());
    } else {
      setTitle(WORK_TYPE_LABELS[wt]);
      setCustomWorkType("");
    }
  }

  /** Work Type picker's onValueChange — a non-empty Scope requires the confirmation dialog (Part 18) instead of silently overwriting; a blank Scope changes immediately and may prefill that Work Type's org default. */
  function handleWorkTypeSelect(v: string) {
    const wt = v as WorkType;
    if (wt === workType) return;
    if (scope.trim()) {
      setPendingWorkType(wt);
      return;
    }
    commitWorkTypeChange(wt);
    const def = resolveDefaultScopeContent(orgTemplates, wt);
    if (def) setScope(def);
  }

  useEffect(() => {
    if (!open) return;
    if (isEdit && estimate) {
      setTitle(estimate.title);
      const matched = matchWorkTypeFromTitle(estimate.title);
      setWorkType(matched);
      setCustomWorkType(matched === "other" ? estimate.title : "");
      if (estimate.company_id) {
        const co = companies.find(c => c.id === estimate.company_id);
        setCustomer(co ? { kind: "company", id: co.id, name: co.name, email: co.email, phone: co.phone, address: companyAddressOf(co) }
          : { kind: "company", id: estimate.company_id, name: estimate.company_name ?? "Account" });
      } else if (estimate.client_id) {
        const c = contacts.find(x => x.id === estimate.client_id);
        setCustomer(c ? { kind: "contact", id: c.id, name: c.name, email: c.email, phone: c.phone, companyName: c.companyName ?? c.company, address: c.address }
          : { kind: "contact", id: estimate.client_id, name: estimate.client_name });
      } else setCustomer(null);
      setOwnerId(estimate.owner_id ?? "unassigned");
      setAddress(estimate.service_address ?? "");
      setValidUntil(estimate.valid_until ?? "");
      setScope(estimate.scope ?? "");
      setInternalNote(estimate.notes ?? "");
      setCustomerNote(estimate.customer_note ?? "");
      setTerms(estimate.terms ?? "");
      setExclusions(estimate.exclusions ?? "");
      setAssumptions(estimate.assumptions ?? "");
      setTaxRate(String(estimate.taxRate ?? 0));
      setDiscountType(estimate.discountType ?? "none");
      setDiscountValue(String(estimate.discountValue ?? 0));
      setDepositType(estimate.depositType ?? "none");
      setDepositValue(String(estimate.depositValue ?? 0));
      setItems(estimate.estimate_items.length ? estimate.estimate_items.map(itemToLine) : [newLineItem()]);
    } else {
      const initialTitle = initialLead?.projectType ? `${initialLead.projectType} Estimate` : "";
      setTitle(initialTitle);
      const matched = matchWorkTypeFromTitle(initialTitle);
      const resolvedWorkType: WorkType = matched === "other" && !initialTitle ? "kitchen_remodel" : matched;
      setWorkType(resolvedWorkType);
      setCustomWorkType(matched === "other" ? initialTitle : "");
      if (matched === "other" && !initialTitle) setTitle(WORK_TYPE_LABELS.kitchen_remodel);
      // Prefill Proposal Content (and Scope of Work, keyed by the resolved
      // Work Type) from the org's default templates, once, for a brand-new
      // estimate only — never for edit mode, never again after the user
      // starts typing (this effect only re-runs when the sheet re-opens,
      // not on every keystroke). A Lead's own notes still win over a
      // default Scope template, matching the pre-existing initialLead
      // prefill behavior.
      setCustomerNote(resolveDefaultContent(orgTemplates, "customer_note"));
      setExclusions(resolveDefaultContent(orgTemplates, "exclusions"));
      setAssumptions(resolveDefaultContent(orgTemplates, "assumptions"));
      setTerms(resolveDefaultContent(orgTemplates, "terms"));
      if (initialLead?.contactId) {
        const c = contacts.find(x => x.id === initialLead.contactId);
        setCustomer(c ? { kind: "contact", id: c.id, name: c.name, email: c.email, phone: c.phone, address: c.address } : null);
      } else if (initialContext?.contactId) {
        const c = contacts.find(x => x.id === initialContext.contactId);
        setCustomer(c ? { kind: "contact", id: c.id, name: c.name, email: c.email, phone: c.phone, address: c.address } : null);
      } else if (initialContext?.companyId) {
        const co = companies.find(x => x.id === initialContext.companyId);
        setCustomer(co ? { kind: "company", id: co.id, name: co.name, email: co.email, phone: co.phone, address: companyAddressOf(co) } : null);
      } else {
        setCustomer(null);
      }
      setOwnerId("unassigned");
      setAddress("");
      setValidUntil(plusDays(30));
      setScope(initialLead?.notes || resolveDefaultScopeContent(orgTemplates, resolvedWorkType));
      setInternalNote("");
      setTaxRate("0");
      setDiscountType("none");
      setDiscountValue("0");
      setDepositType("none");
      setDepositValue("0");
      setItems(initialLead?.budget ? [newLineItem({
        itemType: "labor", name: initialLead.projectType || "Project estimate",
        description: `Estimate prepared for ${initialLead.name}`, unit: "fixed", unitPrice: String(initialLead.budget),
      })] : [newLineItem()]);
    }
    setErrors({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, estimate?.id, initialLead, initialContext]);

  const itemNameRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const setItem = (key: string, patch: Partial<LineItem>) =>
    setItems(prev => prev.map(it => (it.key === key ? { ...it, ...patch } : it)));
  const addItem = (overrides: Partial<LineItem> = {}) => setItems(prev => [...prev, newLineItem(overrides)]);
  /** Adds a row via a quick-add button and moves focus straight into its Item Name field (Part 21). */
  const addItemFocused = (overrides: Partial<LineItem> = {}) => {
    const line = newLineItem(overrides);
    setItems(prev => [...prev, line]);
    requestAnimationFrame(() => itemNameRefs.current[line.key]?.focus());
  };
  const removeItem = (key: string) => setItems(prev => prev.filter(it => it.key !== key));
  const moveItem = (key: string, dir: -1 | 1) => setItems(prev => {
    const idx = prev.findIndex(it => it.key === key);
    const swapWith = idx + dir;
    if (idx < 0 || swapWith < 0 || swapWith >= prev.length) return prev;
    const next = [...prev];
    [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
    return next;
  });
  const duplicateItem = (key: string) => setItems(prev => {
    const idx = prev.findIndex(it => it.key === key);
    if (idx < 0) return prev;
    const copy = { ...prev[idx], key: `n${Math.random().toString(36).slice(2)}`, id: undefined };
    return [...prev.slice(0, idx + 1), copy, ...prev.slice(idx + 1)];
  });

  const calc = useMemo(() => calculateEstimate({
    items: items.map(toCalcItem),
    discountType: discountType === "none" ? null : discountType,
    discountValue: parseFloat(discountValue) || 0,
    taxRate: parseFloat(taxRate) || 0,
    depositType: depositType === "none" ? null : depositType,
    depositValue: parseFloat(depositValue) || 0,
  }), [items, discountType, discountValue, taxRate, depositType, depositValue]);

  const discountExceedsSubtotal = discountType === "fixed" && (parseFloat(discountValue) || 0) > calc.subtotal;
  const depositExceedsTotal = depositType === "fixed" && (parseFloat(depositValue) || 0) > calc.total;

  const handleClose = () => onClose();

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (workType === "other" && !customWorkType.trim()) next.title = "Enter a custom work type.";
    else if (!title.trim()) next.title = "Work type is required.";
    if (!customer) next.customer = "Select a Customer / Account.";
    else if (!resolveClientId(customer)) next.customer = "This account has no contacts yet — add one first, or select a contact instead.";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function buildItemRows(estimateId: string) {
    return items
      .filter(it => it.name.trim())
      .map((it, idx) => {
        const qty = it.isHeading ? 0 : (parseFloat(it.quantity) || 1);
        const price = it.isHeading ? 0 : (parseFloat(it.unitPrice) || 0);
        return {
          estimate_id: estimateId,
          category: ESTIMATE_ITEM_TYPE_LABELS[it.itemType] ?? "Custom",
          item_type: it.itemType,
          name: it.name.trim(),
          description: it.description.trim() || null,
          quantity: qty,
          unit: it.isHeading ? null : (it.unit || "each"),
          unit_price: price,
          total: round2(qty * price),
          position: idx,
          taxable: it.taxable,
          optional: it.optional,
          is_heading: it.isHeading,
        };
      });
  }

  const save = async (sendAfter?: boolean) => {
    if (saving) return;
    if (!validate()) { toast.error("Fix the highlighted fields before saving."); return; }
    const resolvedClientId = resolveClientId(customer!);
    setSaving(true);
    let phase = "build payload";
    try {
      let estimateId: string;

      // Clamp tax/discount/deposit to the exact ranges the live check
      // constraints enforce (estimates_tax_rate_check: 0-100 always;
      // estimates_discount_value_check / estimates_deposit_value_check:
      // 0-100 only when the type is "percent", unbounded-but->=0 when
      // "fixed"). DecimalInput already clamps on blur, but a value typed
      // and saved without ever losing focus (e.g. Enter/click straight
      // from the field) would otherwise reach Supabase un-clamped and
      // 400 with a 23514 check-constraint violation — this is
      // independent, authoritative normalization, not a UI nicety.
      const clampPercent = (n: number) => Math.min(100, Math.max(0, n));
      const clampNonNegative = (n: number) => Math.max(0, n);
      const safeTaxRate = clampPercent(parseFloat(taxRate) || 0);
      const safeDiscountValue = discountType === "percent" ? clampPercent(parseFloat(discountValue) || 0) : clampNonNegative(parseFloat(discountValue) || 0);
      const safeDepositValue = depositType === "percent" ? clampPercent(parseFloat(depositValue) || 0) : clampNonNegative(parseFloat(depositValue) || 0);

      const header = {
        title: title.trim(),
        client_id: resolvedClientId,
        client_name: customer!.kind === "contact" ? customer!.name : null,
        company_id: nullableUuid(customer!.kind === "company" ? customer!.id : null),
        owner_id: nullableUuid(ownerId === "unassigned" ? null : ownerId),
        valid_until: validUntil || null,
        scope: scope.trim() || null,
        notes: internalNote.trim() || null,
        customer_note: customerNote.trim() || null,
        terms: terms.trim() || null,
        exclusions: exclusions.trim() || null,
        assumptions: assumptions.trim() || null,
        tax_rate: safeTaxRate,
        discount_type: discountType === "none" ? null : discountType,
        discount_value: discountType === "none" ? 0 : safeDiscountValue,
        deposit_type: depositType === "none" ? null : depositType,
        deposit_value: depositType === "none" ? 0 : safeDepositValue,
        subtotal: calc.subtotal,
        discount_total: calc.discountTotal,
        tax_total: calc.taxTotal,
        // `total` and `client_total` MUST be written together and equal.
        // A pre-existing (pre-Phase-10.4) trigger, trg_sync_total ->
        // sync_total_to_client_total(), runs BEFORE every insert/update and
        // unconditionally does `NEW.total := NEW.client_total`. Omitting
        // client_total from this payload let that trigger silently
        // overwrite our real, calculated `total` with whatever
        // client_total already happened to hold (0 on a fresh insert,
        // since its column default is 0) — every previous save was
        // actually persisting total=0 regardless of the real estimate
        // value. That's invisible when deposit_amount is also 0 (deposit
        // "None"), but the moment a deposit is set, deposit_amount (correctly
        // calculated against the real total) exceeds the trigger-zeroed
        // total and estimates_deposit_amount_check (deposit_amount <=
        // total) throws a 23514. Sending the same canonical value to both
        // columns makes the trigger a no-op instead of a silent corrupter.
        total: calc.total,
        client_total: calc.total,
        deposit_amount: calc.depositAmount,
        balance_due: Math.max(0, calc.balanceDue),
        metadata: { serviceAddress: address.trim() || null },
      };

      if (import.meta.env.DEV) {
        console.debug("[estimates] Save calculation", {
          subtotal: header.subtotal, discountTotal: header.discount_total, taxTotal: header.tax_total,
          total: header.total, clientTotal: header.client_total,
          depositType: header.deposit_type, depositValue: header.deposit_value,
          depositAmount: header.deposit_amount, balanceDue: header.balance_due,
        });
      }

      if (isEdit && estimate) {
        // Immutable/DB-owned fields are deliberately absent from this
        // payload: number, created_at, public_token, version_number, and
        // every lifecycle timestamp — none of them are touched here, so
        // Postgres leaves their current values exactly as they are.
        phase = "update estimate header";
        const { error: updErr } = await supabase.from("estimates").update({ ...header, updated_at: new Date().toISOString() }).eq("id", estimate.id).eq("org_id", orgId);
        if (updErr) throw updErr;
        phase = "delete existing line items";
        const { error: delErr } = await supabase.from("estimate_items").delete().eq("estimate_id", estimate.id);
        if (delErr) throw delErr;
        phase = "insert line items";
        const rows = buildItemRows(estimate.id);
        if (rows.length) {
          const { error: itemErr } = await supabase.from("estimate_items").insert(rows);
          if (itemErr) throw itemErr;
        }
        estimateId = estimate.id;
        if (!sendAfter) toast.success("Estimate updated");
      } else {
        // `number` is intentionally omitted — set_estimate_number() assigns
        // an org-scoped, concurrency-safe EST-000001 number server-side.
        phase = "create estimate header";
        const { data: est, error: estErr } = await supabase
          .from("estimates")
          .insert({
            org_id: orgId, status: "draft",
            lead_id: nullableUuid(initialLead?.leadId), deal_id: nullableUuid(initialContext?.dealId),
            project_id: nullableUuid(initialContext?.projectId),
            ...header,
          })
          .select("id").single();
        if (estErr) throw estErr;
        phase = "insert line items";
        const rows = buildItemRows(est.id);
        if (rows.length) {
          const { error: itemErr } = await supabase.from("estimate_items").insert(rows);
          if (itemErr) throw itemErr;
        }
        estimateId = est.id;
        if (!sendAfter) toast.success("Draft saved");
      }

      if (sendAfter) {
        phase = "send proposal";
        const result = await sendEstimateProposal(estimateId);
        if (!result.ok) toast.error(result.error ?? "Estimate saved, but sending failed");
        else toast.success("Proposal sent to client");
      }

      onSaved();
      handleClose();
    } catch (err: unknown) {
      // Full Supabase/PostgREST error detail, as literal fields (not a
      // collapsed console Object) — code/details/hint are what actually
      // identify a check-constraint (23514), FK (23503), or RLS (42501)
      // failure. The phase marker says which step failed without logging
      // any payload content (no tokens, signatures, or note/proposal text).
      console.error(`[estimates] Save failed at phase: ${phase}`, JSON.stringify(serializeSupabaseError(err), null, 2));
      const message = err && typeof err === "object" && "message" in err ? String((err as { message?: unknown }).message) : "Failed to save estimate";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const canSend = estimate ? (estimate.status === "draft" || estimate.status === "ready") : true;

  return (
    <Sheet open={open} onOpenChange={o => !o && handleClose()}>
      <SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:max-w-3xl" side="right">
        <SheetHeader className="border-b border-border px-5 py-4">
          <SheetTitle>{isEdit ? `Edit ${estimate?.number ?? "Estimate"}` : "New Estimate"}</SheetTitle>
          <SheetDescription>
            {isEdit ? "Update the estimate, line items, and proposal content." : "Create an estimate you can turn into a customer proposal."}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4 text-sm">
          {/* Work Type / Owner / Valid Until */}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="est-worktype">Work type <span className="text-destructive">*</span></Label>
              <Select value={workType} onValueChange={handleWorkTypeSelect}>
                <SelectTrigger id="est-worktype" aria-invalid={!!errors.title}><SelectValue /></SelectTrigger>
                <SelectContent>{WORK_TYPE_ORDER.map(w => <SelectItem key={w} value={w}>{WORK_TYPE_LABELS[w]}</SelectItem>)}</SelectContent>
              </Select>
              {workType === "other" && (
                <div className="pt-1.5">
                  <Label htmlFor="est-custom-worktype" className="text-xs">Custom work type <span className="text-destructive">*</span></Label>
                  <Input
                    id="est-custom-worktype" ref={customWorkTypeRef} maxLength={120}
                    placeholder="e.g. Deck Construction" value={customWorkType}
                    onChange={e => { setCustomWorkType(e.target.value); setTitle(e.target.value); }}
                    aria-invalid={!!errors.title}
                  />
                </div>
              )}
              {errors.title && <p className="text-xs text-destructive">{errors.title}</p>}
            </div>
            <div className="space-y-1">
              <Label htmlFor="est-valid">Valid until</Label>
              <Input id="est-valid" type="date" value={validUntil} onChange={e => setValidUntil(e.target.value)} />
            </div>
          </div>

          {/* Customer / Account */}
          <div className="space-y-1.5">
            <Label>Customer / Account <span className="text-destructive">*</span></Label>
            {customer ? (
              <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/30 px-3 py-2">
                {customer.kind === "contact" ? <UserRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{customer.name}</span>
                    <Badge variant="outline" className="h-4.5 shrink-0 rounded px-1.5 text-[9.5px]">{customer.kind === "contact" ? "Contact" : "Account"}</Badge>
                  </div>
                  {(customer.email || customer.phone) && (
                    <div className="truncate text-[11px] text-muted-foreground">{[customer.email, customer.phone].filter(Boolean).join(" · ")}</div>
                  )}
                </div>
                <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => setCustomer(null)} aria-label="Clear customer">
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : (
              <Popover open={customerOpen} onOpenChange={setCustomerOpen}>
                <PopoverTrigger asChild>
                  <Button type="button" variant="outline" className={cn("w-full justify-between font-normal text-muted-foreground", errors.customer && "border-destructive")}>
                    Search contacts or accounts…<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                  <Command shouldFilter={false}>
                    <CommandInput placeholder="Search by name, email, phone, or account…" value={customerQuery} onValueChange={setCustomerQuery} />
                    <CommandList className="max-h-[280px]">
                      <CommandEmpty>No matching contacts or accounts.</CommandEmpty>
                      <CommandGroup>
                        {filteredCustomers.map(o => (
                          <CommandItem
                            key={`${o.kind}-${o.id}`} value={`${o.kind}-${o.id}`}
                            className="items-start gap-2.5 py-2"
                            onSelect={() => { setCustomer(o); setCustomerOpen(false); setCustomerQuery(""); if (o.address && !address) setAddress(o.address); }}
                          >
                            {o.kind === "contact"
                              ? <ContactAvatar id={o.id} name={o.name} size="xs" />
                              : <div className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground"><Building2 className="h-3.5 w-3.5" /></div>}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate text-sm">{o.name}</span>
                                <Badge variant="outline" className="h-4 shrink-0 rounded px-1 text-[9px]">{o.kind === "contact" ? "Contact" : "Account"}</Badge>
                              </div>
                              <div className="truncate text-xs text-muted-foreground">
                                {[o.companyName, o.email, fmtPhone(o.phone)].filter(Boolean).join(" · ") || "No contact details on file"}
                              </div>
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            )}
            {errors.customer && <p className="text-xs text-destructive">{errors.customer}</p>}
          </div>

          {/* Owner + Address */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Owner</Label>
              <Select value={ownerId} onValueChange={setOwnerId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="unassigned">Unassigned</SelectItem>
                  {teamMembers.map(m => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Service / project address</Label>
              <AddressAutocomplete
                value={address}
                onChange={setAddress}
                onSelect={parts => setAddress([parts.street, parts.city, `${parts.state} ${parts.zip}`].filter(Boolean).join(", "))}
                placeholder="Start typing an address…"
              />
            </div>
          </div>

          {/* Scope of Work */}
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="est-scope">Scope of work</Label>
              <div className="flex items-center gap-1">
                <Select value="" onValueChange={applyScopeTemplate} open={scopeTemplateSelectOpen} onOpenChange={setScopeTemplateSelectOpen}>
                  <SelectTrigger className="h-6 w-52 text-[10.5px]" aria-label="Scope of Work template"><SelectValue placeholder="Use a template…" /></SelectTrigger>
                  <SelectContent>
                    {builtinScopePresets.length > 0 && (
                      <SelectGroup>
                        <SelectLabel>Built-in Templates</SelectLabel>
                        {builtinScopePresets.map(p => <SelectItem key={p.id} value={`builtin:${p.id}`} className="text-xs">{p.name}</SelectItem>)}
                      </SelectGroup>
                    )}
                    {orgScopeTemplates.length > 0 && (
                      <SelectGroup>
                        <SelectLabel>Organization Templates</SelectLabel>
                        {orgScopeTemplates.map(t => <SelectItem key={t.id} value={`org:${t.id}`} className="text-xs">{t.name}{t.is_default ? " · Default" : ""}</SelectItem>)}
                      </SelectGroup>
                    )}
                    <SelectItem value="blank" className="text-xs">Start Blank</SelectItem>
                  </SelectContent>
                </Select>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button type="button" variant="ghost" size="icon" className="h-6 w-6" onClick={() => setSaveScopeTemplateOpen(true)} aria-label="Save Scope of Work as organization template">
                      <Save className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Save as organization template</TooltipContent>
                </Tooltip>
              </div>
            </div>
            <Textarea id="est-scope" rows={4} placeholder="Describe the work to be performed, materials included, and any special conditions…" value={scope} onChange={e => setScope(e.target.value)} className="min-h-24 resize-y text-sm" />
            <p className="text-[10.5px] text-muted-foreground">Describe the work included in this estimate. Templates can be customized for each customer.</p>
          </div>

          {/* Proposal content — customer-facing */}
          <div className="space-y-3 rounded-md border border-border p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Proposal content <span className="normal-case font-normal">(shown to the customer)</span></p>
            <ProposalContentField
              category="customer_note" label="Customer note" value={customerNote} onChange={setCustomerNote}
              orgTemplates={orgTemplates} onSaveAsTemplate={() => setSaveTemplateFor({ category: "customer_note", content: customerNote })}
              placeholder="A short personal note shown at the top of the proposal…"
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <ProposalContentField
                category="exclusions" label="Exclusions" value={exclusions} onChange={setExclusions}
                orgTemplates={orgTemplates} onSaveAsTemplate={() => setSaveTemplateFor({ category: "exclusions", content: exclusions })}
              />
              <ProposalContentField
                category="assumptions" label="Assumptions" value={assumptions} onChange={setAssumptions}
                orgTemplates={orgTemplates} onSaveAsTemplate={() => setSaveTemplateFor({ category: "assumptions", content: assumptions })}
              />
            </div>
            <ProposalContentField
              category="terms" label="Terms" value={terms} onChange={setTerms}
              orgTemplates={orgTemplates} onSaveAsTemplate={() => setSaveTemplateFor({ category: "terms", content: terms })}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="est-internal" className="text-xs">Internal note <span className="text-muted-foreground font-normal">(never shown to the customer)</span></Label>
            <Textarea id="est-internal" rows={2} value={internalNote} onChange={e => setInternalNote(e.target.value)} className="resize-none text-xs" />
          </div>

          {/* Line items */}
          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">Line items</span>
              <div className="flex flex-wrap gap-1.5">
                <Button type="button" variant="outline" size="sm" className="h-8 gap-1 text-xs" onClick={() => addItemFocused({ itemType: "labor" })}><HardHat className="h-3.5 w-3.5" />Labor</Button>
                <Button type="button" variant="outline" size="sm" className="h-8 gap-1 text-xs" onClick={() => addItemFocused({ itemType: "material" })}><Package className="h-3.5 w-3.5" />Material</Button>
                <Button type="button" variant="outline" size="sm" className="h-8 gap-1 text-xs" onClick={() => addItemFocused({ itemType: "service" })}><Wrench className="h-3.5 w-3.5" />Service</Button>
                <Button type="button" variant="outline" size="sm" className="h-8 gap-1 text-xs" onClick={() => addItemFocused({ itemType: "allowance" })}><Coins className="h-3.5 w-3.5" />Allowance</Button>
                <Button type="button" variant="outline" size="sm" className="h-8 gap-1 text-xs" onClick={() => addItemFocused({ itemType: "custom" })}><Sparkles className="h-3.5 w-3.5" />Custom</Button>
                <Button type="button" variant="secondary" size="sm" className="h-8 gap-1 text-xs" onClick={() => addItem({ isHeading: true, name: "" })}>
                  <Heading className="h-3.5 w-3.5" />Section
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              {items.map((it, idx) => it.isHeading ? (
                <div key={it.key} className="flex items-center gap-2 rounded-md bg-secondary/60 px-2.5 py-2">
                  <Heading className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <Input value={it.name} onChange={e => setItem(it.key, { name: e.target.value })} placeholder="Section heading, e.g. Cabinets" className="h-7 flex-1 border-none bg-transparent text-xs font-semibold uppercase tracking-wide focus-visible:ring-1" />
                  <TooltipIconButton label="Move up" disabled={idx === 0} onClick={() => moveItem(it.key, -1)}><ArrowUp className="h-3 w-3" /></TooltipIconButton>
                  <TooltipIconButton label="Move down" disabled={idx === items.length - 1} onClick={() => moveItem(it.key, 1)}><ArrowDown className="h-3 w-3" /></TooltipIconButton>
                  <TooltipIconButton label="Delete section" onClick={() => removeItem(it.key)}><Trash2 className="h-3 w-3 text-destructive" /></TooltipIconButton>
                </div>
              ) : (
                <div key={it.key} className="rounded-md border border-border p-2.5">
                  {/* Top row — type, name, quantity, unit, unit price */}
                  <div className="flex flex-wrap items-end gap-1.5">
                    <div className="w-full sm:w-36">
                      <Select value={it.itemType} onValueChange={v => setItem(it.key, { itemType: v as EstimateItemType })}>
                        <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>{ESTIMATE_ITEM_TYPE_ORDER.filter(t => t !== "discount").map(t => <SelectItem key={t} value={t}>{ESTIMATE_ITEM_TYPE_LABELS[t]}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div className="min-w-[160px] flex-1">
                      <Input ref={el => { itemNameRefs.current[it.key] = el; }} placeholder="Item name" value={it.name} onChange={e => setItem(it.key, { name: e.target.value })} className="h-8 text-sm" aria-label="Item name" />
                    </div>
                    <div className="w-20">
                      <DecimalInput value={it.quantity} onChange={v => setItem(it.key, { quantity: v })} className="h-8 text-right text-sm" placeholder="Qty" aria-label="Quantity" />
                    </div>
                    <div className="w-24">
                      <Select value={it.unit} onValueChange={v => setItem(it.key, { unit: v as EstimateItemUnit })}>
                        <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>{Object.entries(ESTIMATE_ITEM_UNIT_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div className="w-28">
                      <div className="relative">
                        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>
                        <DecimalInput value={it.unitPrice} onChange={v => setItem(it.key, { unitPrice: v })} className="h-8 pl-4.5 text-right text-sm" placeholder="0.00" aria-label="Unit price" />
                      </div>
                    </div>
                  </div>
                  {/* Bottom row — description, taxable/optional, total, actions */}
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2">
                    <Input placeholder="Description (optional)" value={it.description} onChange={e => setItem(it.key, { description: e.target.value })} className="h-6 max-w-xs flex-1 border-none bg-transparent px-0 text-[11px] text-muted-foreground focus-visible:ring-0" />
                    <div className="flex shrink-0 items-center gap-3">
                      <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Switch checked={it.taxable} onCheckedChange={v => setItem(it.key, { taxable: v })} className="scale-75" />Taxable</label>
                      <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Switch checked={it.optional} onCheckedChange={v => setItem(it.key, { optional: v })} className="scale-75" />Optional</label>
                      <span className="w-20 text-right text-sm font-semibold tabular-nums">{formatMoney((parseFloat(it.quantity) || 0) * (parseFloat(it.unitPrice) || 0))}</span>
                      <div className="flex items-center gap-0.5">
                        <TooltipIconButton label="Move up" disabled={idx === 0} onClick={() => moveItem(it.key, -1)}><ArrowUp className="h-3 w-3" /></TooltipIconButton>
                        <TooltipIconButton label="Move down" disabled={idx === items.length - 1} onClick={() => moveItem(it.key, 1)}><ArrowDown className="h-3 w-3" /></TooltipIconButton>
                        <TooltipIconButton label="Duplicate" onClick={() => duplicateItem(it.key)}><CopyIcon className="h-3 w-3" /></TooltipIconButton>
                        <TooltipIconButton label="Delete" onClick={() => removeItem(it.key)}><Trash2 className="h-3 w-3 text-destructive" /></TooltipIconButton>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Discount / Tax / Deposit + totals */}
          <div className="grid gap-4 rounded-md border border-border p-3 sm:grid-cols-2">
            <div className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs">Discount</Label>
                <div className="flex gap-1.5">
                  <Select value={discountType} onValueChange={v => setDiscountType(v as any)}>
                    <SelectTrigger className="h-8 w-32 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="none">None</SelectItem><SelectItem value="percent">{DISCOUNT_TYPE_LABELS.percent}</SelectItem><SelectItem value="fixed">{DISCOUNT_TYPE_LABELS.fixed}</SelectItem></SelectContent>
                  </Select>
                  {discountType !== "none" && (
                    <div className="relative w-24">
                      {discountType === "fixed" && <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>}
                      <DecimalInput value={discountValue} onChange={setDiscountValue} max={discountType === "percent" ? 100 : undefined} className={cn("h-8 text-sm", discountType === "fixed" && "pl-4.5")} aria-label="Discount value" />
                      {discountType === "percent" && <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>}
                    </div>
                  )}
                </div>
                {discountExceedsSubtotal && <p className="text-[11px] text-amber-600">Capped at the subtotal — a fixed discount can't exceed it.</p>}
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Tax rate</Label>
                <div className="relative w-24">
                  <DecimalInput value={taxRate} onChange={setTaxRate} max={100} className="h-8 pr-6 text-sm" aria-label="Tax rate percentage" />
                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Deposit</Label>
                <div className="flex gap-1.5">
                  <Select value={depositType} onValueChange={v => setDepositType(v as any)}>
                    <SelectTrigger className="h-8 w-32 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="none">None</SelectItem><SelectItem value="percent">{DEPOSIT_TYPE_LABELS.percent}</SelectItem><SelectItem value="fixed">{DEPOSIT_TYPE_LABELS.fixed}</SelectItem></SelectContent>
                  </Select>
                  {depositType !== "none" && (
                    <div className="relative w-28">
                      {depositType === "fixed" && <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>}
                      <DecimalInput value={depositValue} onChange={setDepositValue} max={depositType === "percent" ? 100 : undefined} className={cn("h-8 text-sm", depositType === "fixed" && "pl-4.5")} aria-label="Deposit value" />
                      {depositType === "percent" && <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>}
                    </div>
                  )}
                </div>
                {depositExceedsTotal && <p className="text-[11px] text-amber-600">Capped at the total — a fixed deposit can't exceed it.</p>}
              </div>
            </div>
            <div className="space-y-1.5 self-start rounded-md bg-secondary/40 p-3 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="tabular-nums">{formatMoney(calc.subtotal)}</span></div>
              {calc.discountTotal > 0 && <div className="flex justify-between"><span className="text-muted-foreground">Discount</span><span className="tabular-nums">−{formatMoney(calc.discountTotal)}</span></div>}
              <div className="flex justify-between"><span className="text-muted-foreground">Tax</span><span className="tabular-nums">{formatMoney(calc.taxTotal)}</span></div>
              <div className="flex justify-between border-t border-border pt-1.5 font-semibold"><span>Total</span><span className="tabular-nums">{formatMoney(calc.total)}</span></div>
              {calc.depositAmount > 0 && <div className="flex justify-between text-xs"><span className="text-muted-foreground">Deposit due</span><span className="tabular-nums">{formatMoney(calc.depositAmount)}</span></div>}
              {calc.depositAmount > 0 && <div className="flex justify-between text-xs"><span className="text-muted-foreground">Balance remaining</span><span className="tabular-nums">{formatMoney(calc.balanceDue)}</span></div>}
            </div>
          </div>
        </div>

        {/* Sticky footer */}
        <div className="flex shrink-0 gap-2 border-t border-border bg-background p-4">
          <Button type="button" variant="outline" className="flex-1" onClick={handleClose} disabled={saving}>Cancel</Button>
          <Button type="button" variant="secondary" className="flex-1" onClick={() => save()} disabled={saving}>
            {saving ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Saving…</> : (isEdit ? "Save Changes" : "Save Draft")}
          </Button>
          {canSend && (
            <Button type="button" className="flex-1" onClick={() => save(true)} disabled={saving}>
              {saving ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Saving…</> : <><Send className="mr-1.5 h-3.5 w-3.5" />Save &amp; Send</>}
            </Button>
          )}
        </div>
      </SheetContent>

      <SaveTemplateDialog
        target={saveTemplateFor}
        onClose={() => setSaveTemplateFor(null)}
        onSaved={() => { refreshOrgTemplates(); setSaveTemplateFor(null); }}
      />

      <SaveScopeTemplateDialog
        open={saveScopeTemplateOpen}
        workType={workType}
        content={scope}
        onClose={() => setSaveScopeTemplateOpen(false)}
        onSaved={() => { refreshOrgTemplates(); setSaveScopeTemplateOpen(false); }}
      />

      {/* Work Type change confirmation (Part 18) — only shown when the
          current Scope of Work is non-empty, so switching trades never
          silently discards what the user already wrote. */}
      <AlertDialog open={!!pendingWorkType} onOpenChange={o => !o && setPendingWorkType(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change Work Type?</AlertDialogTitle>
            <AlertDialogDescription>
              The current Scope of Work already contains content. Would you like to replace it with a template for the newly selected Work Type?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel onClick={() => setPendingWorkType(null)}>Cancel</AlertDialogCancel>
            <Button
              type="button" variant="outline"
              onClick={() => { if (pendingWorkType) commitWorkTypeChange(pendingWorkType); setPendingWorkType(null); }}
            >
              Keep Current Scope
            </Button>
            <AlertDialogAction
              onClick={() => {
                if (pendingWorkType) commitWorkTypeChange(pendingWorkType);
                setPendingWorkType(null);
                setScopeTemplateSelectOpen(true);
              }}
            >
              Choose New Template
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}

// ── Save current Scope of Work as an organization template (Work-Type-scoped) ──
function SaveScopeTemplateDialog({
  open, workType, content, onClose, onSaved,
}: {
  open: boolean;
  workType: WorkType;
  content: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (open) setName(""); }, [open]);

  const submit = async (setAsDefault: boolean) => {
    if (saving) return;
    if (!name.trim()) { toast.error("Enter a template name"); return; }
    if (!content.trim()) { toast.error("Scope of Work is empty — nothing to save"); return; }
    setSaving(true);
    const result = await saveOrgTemplate({ category: "scope_of_work", workType, name, content, setAsDefault });
    setSaving(false);
    if (result.error) { toast.error(result.error); return; }
    toast.success(`Saved "${name.trim()}" as an organization Scope template`);
    onSaved();
  };

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Save as Organization Template</DialogTitle></DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="space-y-1">
            <Label htmlFor="scope-tpl-name">Template name</Label>
            <Input id="scope-tpl-name" autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Our Standard Kitchen Scope" maxLength={120} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Work type</Label>
            <p className="text-sm">{WORK_TYPE_LABELS[workType]}</p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Content preview</Label>
            <p className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-secondary/30 p-2 text-xs text-muted-foreground">
              {content.trim() || "(empty)"}
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="button" variant="secondary" onClick={() => submit(false)} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Save
          </Button>
          <Button type="button" onClick={() => submit(true)} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Save &amp; Set as Default
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Save current Proposal Content field as an organization template ───────
function SaveTemplateDialog({
  target, onClose, onSaved,
}: {
  target: { category: ProposalPresetCategory; content: string } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (target) setName(""); }, [target]);

  if (!target) return null;
  const categoryLabel = PROPOSAL_PRESET_CATEGORY_LABELS[target.category];

  const submit = async (setAsDefault: boolean) => {
    if (saving) return;
    if (!name.trim()) { toast.error("Enter a template name"); return; }
    setSaving(true);
    const result = await saveOrgTemplate({ category: target.category, name, content: target.content, setAsDefault });
    setSaving(false);
    if (result.error) { toast.error(result.error); return; }
    toast.success(`Saved "${name.trim()}" as an organization template`);
    onSaved();
  };

  return (
    <Dialog open={!!target} onOpenChange={o => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Save as Organization Template</DialogTitle></DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="space-y-1">
            <Label htmlFor="tpl-name">Template name</Label>
            <Input id="tpl-name" autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Our Standard Terms" maxLength={120} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Category</Label>
            <p className="text-sm">{categoryLabel}</p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Content preview</Label>
            <p className="max-h-24 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-secondary/30 p-2 text-xs text-muted-foreground">
              {target.content.trim() || "(empty)"}
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="button" variant="secondary" onClick={() => submit(false)} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Save
          </Button>
          <Button type="button" onClick={() => submit(true)} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Save &amp; Set as Default
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── PDF Print ─────────────────────────────────────────────────────────────────

type OrgInfo = { name: string; logo_url: string | null; email: string | null; phone: string | null; address: string | null };
type ContactInfo = { full_name: string | null; email: string | null; phone: string | null; address: string | null };

function fmtLong(s: string) {
  return new Date(s).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}
function fmtPhone(p: string | null | undefined): string {
  if (!p) return "";
  const d = p.replace(/\D/g, "");
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === "1") return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return p;
}
function moneyRaw(n: number) {
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);
}

/** Groups a flat item list into sections at each is_heading row — the print/view analogue of the editor's section headings. */
function groupBySection(items: EstimateItem[]): { heading: string | null; items: EstimateItem[] }[] {
  const groups: { heading: string | null; items: EstimateItem[] }[] = [];
  let current: { heading: string | null; items: EstimateItem[] } = { heading: null, items: [] };
  for (const it of items) {
    if (it.is_heading) {
      if (current.items.length || current.heading) groups.push(current);
      current = { heading: it.name, items: [] };
    } else {
      current.items.push(it);
    }
  }
  if (current.items.length || current.heading) groups.push(current);
  return groups.filter(g => g.items.length > 0 || g.heading);
}

async function openPrintWindow(estimate: Estimate, org: OrgInfo | null, contact: ContactInfo | null) {
  const w = window.open("", "_blank");
  if (!w) { toast.error("Allow popups to download PDF"); return; }

  const coName = org?.name ?? "Your Company";
  const coPhone = fmtPhone(org?.phone);
  const coAddress = org?.address ?? "";
  const logoHtml = org?.logo_url ? `<img src="${org.logo_url}" alt="${coName}" style="height:52px;max-width:180px;object-fit:contain;margin-right:12px;vertical-align:middle">` : ``;
  const coMetaLine = [coAddress, coPhone].filter(Boolean).join("<br>");
  const clientName = estimate.client_name !== "—" ? estimate.client_name : (contact?.full_name ?? "—");
  const clientLines = [clientName, estimate.service_address || contact?.address, [fmtPhone(contact?.phone), contact?.email].filter(Boolean).join(" · ")].filter(Boolean).join("\n");

  const groups = groupBySection(estimate.estimate_items);
  const itemRowsHtml = groups.map(g => `
    ${g.heading ? `<tr class="cat-row"><td colspan="4">${g.heading}</td></tr>` : ""}
    ${g.items.map(item => `
      <tr>
        <td>${item.name}${item.optional ? ` <span class="opt">(optional)</span>` : ""}${item.description ? `<br><span class="sub">${item.description}</span>` : ""}</td>
        <td class="r">${item.quantity}${item.unit ? ` ${item.unit}` : ""}</td>
        <td class="r">$${moneyRaw(item.unit_price)}</td>
        <td class="r">$${moneyRaw(item.total)}</td>
      </tr>`).join("")}
  `).join("");

  const scopeHtml = estimate.scope ? `<div class="section"><div class="section-title">Scope of Work</div><div class="scope-text">${estimate.scope.replace(/\n/g, "<br>")}</div></div><hr>` : "";
  const termsHtml = estimate.terms ? `<div class="section"><div class="section-title">Terms</div><div class="scope-text">${estimate.terms.replace(/\n/g, "<br>")}</div></div>` : "";
  const footerLeft = [coName, coPhone].filter(Boolean).join(" · ");

  w.document.write(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>${estimate.number ?? "Estimate"} · v${estimate.version_number}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#111;padding:48px;max-width:820px;margin:0 auto}
hr{border:none;border-top:1px solid #e5e7eb;margin:20px 0}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px}
.co-name{font-size:22px;font-weight:800;color:#111}
.co-meta{font-size:11px;color:#6b7280;margin-top:6px;line-height:1.8}
.est-right{text-align:right}
.est-label{font-size:32px;font-weight:800;letter-spacing:-1px;color:#111}
.est-meta{font-size:12px;color:#6b7280;margin-top:4px;line-height:1.8}
.prepared{margin:20px 0}
.prepared-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#9ca3af;margin-bottom:6px}
.prepared-name{font-size:15px;font-weight:700;color:#111}
.prepared-detail{font-size:12px;color:#6b7280;margin-top:3px;line-height:1.7}
.section{margin:20px 0}
.section-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#9ca3af;margin-bottom:6px}
.scope-text{font-size:13px;color:#374151;line-height:1.7;white-space:pre-wrap}
table{width:100%;border-collapse:collapse;margin:4px 0 12px}
thead th{background:#f3f4f6;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;padding:9px 12px;text-align:left;border-bottom:2px solid #e5e7eb}
thead th.r{text-align:right}
tbody td{padding:9px 12px;border-bottom:1px solid #f3f4f6;vertical-align:top;font-size:13px}
tbody td.r{text-align:right;white-space:nowrap}
.cat-row td{background:#f9fafb;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;padding:6px 12px;border-bottom:1px solid #e5e7eb}
.sub{font-size:11px;color:#9ca3af;display:block;margin-top:2px}
.opt{font-size:10px;color:#3b82f6}
.totals-wrap{display:flex;justify-content:flex-end;margin-top:4px}
.totals{width:260px}
.trow{display:flex;justify-content:space-between;padding:5px 0;font-size:13px}
.trow.grand{font-size:16px;font-weight:800;border-top:2px solid #111;padding-top:10px;margin-top:4px}
.muted{color:#6b7280}
.footer{margin-top:32px;padding-top:12px;border-top:1px solid #e5e7eb;display:flex;justify-content:space-between;font-size:11px;color:#9ca3af}
@media print{body{padding:24px}}
</style></head><body>

<div class="hdr">
  <div>
    <div style="display:flex;align-items:center;gap:12px">${logoHtml}<div class="co-name">${coName}</div></div>
    ${coMetaLine ? `<div class="co-meta">${coMetaLine}</div>` : ""}
  </div>
  <div class="est-right">
    <div class="est-label">ESTIMATE</div>
    <div class="est-meta">
      ${estimate.number ? `${estimate.number} · v${estimate.version_number}<br>` : ""}
      Date: ${fmtLong(estimate.created_at)}<br>
      ${estimate.valid_until ? `Valid Until: ${fmtLong(estimate.valid_until)}` : ""}
    </div>
  </div>
</div>
<hr>
<div class="prepared">
  <div class="prepared-label">Prepared For</div>
  <div class="prepared-name">${clientLines.split("\n")[0]}</div>
  ${clientLines.split("\n").slice(1).map(l => `<div class="prepared-detail">${l}</div>`).join("")}
</div>
<hr>
${scopeHtml}
<table>
  <thead><tr><th>Description</th><th class="r">Qty</th><th class="r">Unit Price</th><th class="r">Total</th></tr></thead>
  <tbody>${itemRowsHtml || '<tr><td colspan="4" style="text-align:center;color:#9ca3af;padding:20px">No line items</td></tr>'}</tbody>
</table>
<hr>
<div class="totals-wrap"><div class="totals">
  <div class="trow"><span class="muted">Subtotal</span><span>$${moneyRaw(estimate.subtotal)}</span></div>
  ${estimate.discountTotal > 0 ? `<div class="trow"><span class="muted">Discount</span><span>−$${moneyRaw(estimate.discountTotal)}</span></div>` : ""}
  <div class="trow"><span class="muted">Tax (${estimate.taxRate}%)</span><span>$${moneyRaw(estimate.taxTotal)}</span></div>
  <div class="trow grand"><span>Total</span><span>$${moneyRaw(estimate.total)}</span></div>
  ${estimate.depositAmount > 0 ? `<div class="trow"><span class="muted">Deposit due</span><span>$${moneyRaw(estimate.depositAmount)}</span></div>` : ""}
</div></div>
<hr>
${termsHtml}
<div class="footer"><span>${footerLeft}</span><span>${estimate.number ?? ""} · v${estimate.version_number}</span></div>
<script>window.onload=function(){window.print();}</script>
</body></html>`);
  w.document.close();
}

// ── Estimate View Dialog ───────────────────────────────────────────────────────

function EstimateViewDialog({ estimate, org, onClose }: { estimate: Estimate | null; org: OrgInfo | null; onClose: () => void }) {
  const [contact, setContact] = useState<ContactInfo | null>(null);

  useEffect(() => {
    if (!estimate?.client_id) { setContact(null); return; }
    supabase.from("contacts").select("full_name, email, phone, address").eq("id", estimate.client_id).maybeSingle()
      .then(({ data }) => setContact(data as ContactInfo | null));
  }, [estimate?.client_id]);

  if (!estimate) return null;
  const groups = groupBySection(estimate.estimate_items);

  return (
    <Dialog open={!!estimate} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader className="border-b border-border pb-4">
          <div className="flex items-start justify-between gap-3">
            <DialogTitle className="sr-only">Estimate {estimate.number}</DialogTitle>
            <div className="flex items-center gap-3">
              {org?.logo_url && <img src={org.logo_url} alt={org.name} className="h-12 max-w-40 object-contain shrink-0" />}
              <div>
                <div className="text-lg font-bold leading-tight">{org?.name ?? "Your Company"}</div>
                {(org?.phone || org?.address) && <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{[org?.address, fmtPhone(org?.phone)].filter(Boolean).join(" · ")}</div>}
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-2xl font-extrabold tracking-tight">ESTIMATE</div>
              {estimate.number && <div className="text-xs text-muted-foreground">{estimate.number} · v{estimate.version_number}</div>}
              <div className="mt-0.5 text-xs text-muted-foreground">{fmtLong(estimate.created_at)}{estimate.valid_until && <><br />Valid until {fmtLong(estimate.valid_until)}</>}</div>
              <StatusBadge tone={STATUS_TONE[estimate.status] ?? STATUS_TONE.draft} className="mt-1">{ESTIMATE_STATUS_LABELS[estimate.status] ?? estimate.status}</StatusBadge>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-5 py-2 text-sm">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Prepared For</div>
            <div className="text-base font-semibold">{estimate.client_name !== "—" ? estimate.client_name : (contact?.full_name ?? "—")}</div>
            {(estimate.service_address || contact?.address) && <div className="text-xs text-muted-foreground mt-0.5">{estimate.service_address || contact?.address}</div>}
            {(contact?.phone || contact?.email) && <div className="text-xs text-muted-foreground">{[fmtPhone(contact.phone), contact.email].filter(Boolean).join(" · ")}</div>}
          </div>

          {estimate.scope && (
            <div className="rounded-md border border-border bg-secondary/30 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Scope of Work</div>
              <p className="text-sm leading-relaxed whitespace-pre-wrap">{estimate.scope}</p>
            </div>
          )}

          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="bg-secondary/60 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <tr className="border-b border-border"><th className="py-2 pl-3 pr-2 text-left">Description</th><th className="py-2 pr-2 text-right">Qty</th><th className="py-2 pr-2 text-right">Unit Price</th><th className="py-2 pr-3 text-right">Total</th></tr>
              </thead>
              <tbody>
                {estimate.estimate_items.length === 0 ? (
                  <tr><td colSpan={4} className="py-6 text-center text-muted-foreground">No line items</td></tr>
                ) : groups.map((g, gi) => (
                  <>
                    {g.heading && <tr key={`h-${gi}`} className="border-b border-border bg-secondary/40"><td colSpan={4} className="py-1.5 pl-3 pr-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{g.heading}</td></tr>}
                    {g.items.map(item => (
                      <tr key={item.id} className="border-b border-border last:border-0">
                        <td className="py-2 pl-3 pr-2">
                          <div className="font-medium">{item.name}{item.optional && <Badge variant="outline" className="ml-1.5 h-4 rounded px-1 text-[9px] align-middle">optional</Badge>}</div>
                          {item.description && <div className="text-[11px] text-muted-foreground">{item.description}</div>}
                        </td>
                        <td className="py-2 pr-2 text-right tabular-nums">{item.quantity}{item.unit ? ` ${item.unit}` : ""}</td>
                        <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(item.unit_price)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums font-medium">{formatMoney(item.total)}</td>
                      </tr>
                    ))}
                  </>
                ))}
              </tbody>
            </table>
          </div>

          <div className="ml-auto w-60 space-y-1.5 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="tabular-nums">{formatMoney(estimate.subtotal)}</span></div>
            {estimate.discountTotal > 0 && <div className="flex justify-between"><span className="text-muted-foreground">Discount</span><span className="tabular-nums">−{formatMoney(estimate.discountTotal)}</span></div>}
            <div className="flex justify-between"><span className="text-muted-foreground">Tax ({estimate.taxRate}%)</span><span className="tabular-nums">{formatMoney(estimate.taxTotal)}</span></div>
            <div className="flex justify-between border-t border-border pt-2 text-base font-bold"><span>Total</span><span className="tabular-nums">{formatMoney(estimate.total)}</span></div>
            {estimate.depositAmount > 0 && <div className="flex justify-between text-xs"><span className="text-muted-foreground">Deposit due</span><span className="tabular-nums">{formatMoney(estimate.depositAmount)}</span></div>}
          </div>

          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Button variant="outline" onClick={onClose}>Close</Button>
            <Button onClick={() => openPrintWindow(estimate, org, contact)}><Download className="mr-1.5 h-3.5 w-3.5" />Print / Save PDF</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Estimate Detail Sheet ─────────────────────────────────────────────────────

type EstimateActivityRow = { id: string; activity_type: string; actor_type: string; title: string; description: string | null; created_at: string };
type EstimateVersionRow = { id: string; version_number: number; created_at: string };

function EstimateDetailSheet({
  estimate, onClose, onStatusChange, onEdit, onSend, onCopyLink, sending, onConvertDeal, onConvertProject,
  onCreateInvoice, onCreateDeposit, onCreateRevision, onOpenDeal, busyAction,
}: {
  estimate: Estimate | null;
  onClose: () => void;
  onStatusChange: (id: string, status: EstimateStatus) => void;
  onEdit: (e: Estimate) => void;
  onSend: (id: string) => void;
  onCopyLink: (e: Estimate) => void;
  sending: boolean;
  onConvertDeal: (e: Estimate) => void;
  onConvertProject: (e: Estimate) => void;
  onCreateInvoice: (e: Estimate, isDeposit: boolean) => void;
  onCreateRevision: (e: Estimate) => void;
  onCreateDeposit: (e: Estimate) => void;
  onOpenDeal: (dealId: string) => void;
  busyAction: string | null;
}) {
  const [activities, setActivities] = useState<EstimateActivityRow[]>([]);
  const [versions, setVersions] = useState<EstimateVersionRow[]>([]);

  useEffect(() => {
    if (!estimate) { setActivities([]); setVersions([]); return; }
    supabase.from("estimate_activities").select("id, activity_type, actor_type, title, description, created_at")
      .eq("estimate_id", estimate.id).order("created_at", { ascending: false }).limit(25)
      .then(({ data }) => setActivities((data ?? []) as EstimateActivityRow[]));
    supabase.from("estimate_versions").select("id, version_number, created_at")
      .eq("estimate_id", estimate.id).order("version_number", { ascending: false })
      .then(({ data }) => setVersions((data ?? []) as EstimateVersionRow[]));
  }, [estimate?.id, estimate?.status, estimate?.version_number]);

  if (!estimate) return null;
  const groups = groupBySection(estimate.estimate_items);
  const isBusy = (action: string) => busyAction === `${estimate.id}:${action}`;

  return (
    <Sheet open={!!estimate} onOpenChange={o => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader className="border-b border-border pb-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <SheetTitle className="text-base">{estimate.title}</SheetTitle>
              <SheetDescription className="text-xs">
                {estimate.client_name}{estimate.number ? ` · ${estimate.number}` : ""} · v{estimate.version_number}
              </SheetDescription>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <StatusBadge tone={STATUS_TONE[estimate.status] ?? STATUS_TONE.draft}>{ESTIMATE_STATUS_LABELS[estimate.status] ?? estimate.status}</StatusBadge>
              {estimate.status !== "archived" && (
                <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => onEdit(estimate)}>Edit</Button>
              )}
            </div>
          </div>
        </SheetHeader>

        <div className="mt-4 space-y-5 pb-20 text-sm">
          {/* Lifecycle actions — status-gated per the canonical transition map */}
          <div className="flex flex-wrap gap-2">
            {estimate.status === "draft" && (
              <>
                <Button size="sm" variant="outline" onClick={() => onStatusChange(estimate.id, "ready")}><CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />Mark Ready</Button>
                <Button size="sm" onClick={() => onSend(estimate.id)} disabled={sending}>{sending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}Send</Button>
                <Button size="sm" variant="outline" className="text-destructive" onClick={() => onStatusChange(estimate.id, "cancelled")}><Ban className="mr-1.5 h-3.5 w-3.5" />Cancel</Button>
              </>
            )}
            {estimate.status === "ready" && (
              <>
                <Button size="sm" onClick={() => onSend(estimate.id)} disabled={sending}>{sending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}Send</Button>
                <Button size="sm" variant="outline" onClick={() => onStatusChange(estimate.id, "draft")}>Return to Draft</Button>
                <Button size="sm" variant="outline" className="text-destructive" onClick={() => onStatusChange(estimate.id, "cancelled")}><Ban className="mr-1.5 h-3.5 w-3.5" />Cancel</Button>
              </>
            )}
            {["sent", "viewed"].includes(estimate.status) && (
              <>
                <Button size="sm" variant="outline" onClick={() => onSend(estimate.id)} disabled={sending}>{sending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}Resend</Button>
                <Button size="sm" variant="outline" onClick={() => onCopyLink(estimate)}>Copy Link</Button>
                <Button size="sm" variant="outline" onClick={() => onCreateRevision(estimate)} disabled={isBusy("revision")}>{isBusy("revision") ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <History className="mr-1.5 h-3.5 w-3.5" />}Create Revision</Button>
                {(estimate.convertedDealId || estimate.deal_id) ? (
                  <Button size="sm" variant="outline" onClick={() => onOpenDeal((estimate.deal_id || estimate.convertedDealId)!)}><Handshake className="mr-1.5 h-3.5 w-3.5" />Open Deal</Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => onConvertDeal(estimate)} disabled={isBusy("deal")}>{isBusy("deal") ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Handshake className="mr-1.5 h-3.5 w-3.5" />}Retry Deal Sync</Button>
                )}
                <Button size="sm" variant="outline" className="text-destructive" onClick={() => onStatusChange(estimate.id, "cancelled")}><Ban className="mr-1.5 h-3.5 w-3.5" />Cancel</Button>
              </>
            )}
            {estimate.status === "changes_requested" && (
              <>
                <Button size="sm" variant="outline" onClick={() => onCreateRevision(estimate)} disabled={isBusy("revision")}>{isBusy("revision") ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <History className="mr-1.5 h-3.5 w-3.5" />}Create Revision</Button>
                {(estimate.convertedDealId || estimate.deal_id) ? (
                  <Button size="sm" variant="outline" onClick={() => onOpenDeal((estimate.deal_id || estimate.convertedDealId)!)}><Handshake className="mr-1.5 h-3.5 w-3.5" />Open Deal</Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => onConvertDeal(estimate)} disabled={isBusy("deal")}>{isBusy("deal") ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Handshake className="mr-1.5 h-3.5 w-3.5" />}Retry Deal Sync</Button>
                )}
                <Button size="sm" variant="outline" className="text-destructive" onClick={() => onStatusChange(estimate.id, "cancelled")}><Ban className="mr-1.5 h-3.5 w-3.5" />Cancel</Button>
              </>
            )}
            {estimate.status === "approved" && (
              <>
                {(estimate.convertedDealId || estimate.deal_id) ? (
                  <Button size="sm" variant="outline" onClick={() => onOpenDeal((estimate.deal_id || estimate.convertedDealId)!)}>
                    <Handshake className="mr-1.5 h-3.5 w-3.5" />Open Deal
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => onConvertDeal(estimate)} disabled={isBusy("deal")}>
                    {isBusy("deal") ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Handshake className="mr-1.5 h-3.5 w-3.5" />}Convert to Deal
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => onConvertProject(estimate)} disabled={!!estimate.convertedProjectId || isBusy("project")}>
                  {isBusy("project") ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <FolderKanban className="mr-1.5 h-3.5 w-3.5" />}{estimate.convertedProjectId ? "Project Linked" : "Convert to Project"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => onCreateInvoice(estimate, false)} disabled={isBusy("invoice")}><Receipt className="mr-1.5 h-3.5 w-3.5" />Create Invoice</Button>
                {estimate.depositAmount > 0 && <Button size="sm" variant="outline" onClick={() => onCreateDeposit(estimate)} disabled={isBusy("deposit")}><Receipt className="mr-1.5 h-3.5 w-3.5" />Create Deposit Invoice</Button>}
                <Button size="sm" variant="outline" onClick={() => onStatusChange(estimate.id, "archived")}><Archive className="mr-1.5 h-3.5 w-3.5" />Archive</Button>
              </>
            )}
            {estimate.status === "rejected" && (
              <>
                <Button size="sm" variant="outline" onClick={() => onCreateRevision(estimate)} disabled={isBusy("revision")}><History className="mr-1.5 h-3.5 w-3.5" />Create Revision</Button>
                <Button size="sm" variant="outline" onClick={() => onStatusChange(estimate.id, "archived")}><Archive className="mr-1.5 h-3.5 w-3.5" />Archive</Button>
              </>
            )}
            {estimate.status === "expired" && (
              <>
                <Button size="sm" onClick={() => onSend(estimate.id)} disabled={sending}>{sending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}Extend &amp; Resend</Button>
                <Button size="sm" variant="outline" onClick={() => onCreateRevision(estimate)} disabled={isBusy("revision")}><History className="mr-1.5 h-3.5 w-3.5" />Create Revision</Button>
                <Button size="sm" variant="outline" onClick={() => onStatusChange(estimate.id, "archived")}><Archive className="mr-1.5 h-3.5 w-3.5" />Archive</Button>
              </>
            )}
            {estimate.status === "converted" && (
              <>
                <Button size="sm" variant="outline" onClick={() => onCreateInvoice(estimate, false)} disabled={isBusy("invoice")}><Receipt className="mr-1.5 h-3.5 w-3.5" />Create Invoice</Button>
                <Button size="sm" variant="outline" onClick={() => onStatusChange(estimate.id, "archived")}><Archive className="mr-1.5 h-3.5 w-3.5" />Archive</Button>
              </>
            )}
            {estimate.status === "cancelled" && (
              <>
                <Button size="sm" variant="outline" onClick={() => onStatusChange(estimate.id, "draft")}><RotateCcw className="mr-1.5 h-3.5 w-3.5" />Restore</Button>
                <Button size="sm" variant="outline" onClick={() => onStatusChange(estimate.id, "archived")}><Archive className="mr-1.5 h-3.5 w-3.5" />Archive</Button>
              </>
            )}
            {estimate.status === "archived" && <p className="text-xs text-muted-foreground">This estimate is archived and read-only.</p>}
          </div>

          {/* Meta row */}
          <div className="grid grid-cols-2 gap-3">
            {estimate.valid_until && <FactBox label="Valid Until" value={fmtDate(estimate.valid_until)} />}
            <FactBox label="Line Items" value={String(estimate.item_count)} />
            {estimate.owner_name && <FactBox label="Owner" value={estimate.owner_name} />}
            {estimate.service_address && <FactBox label="Address" value={estimate.service_address} />}
          </div>

          {/* Line items grouped by section */}
          {groups.length > 0 ? (
            <div className="space-y-4">
              {groups.map((g, gi) => (
                <div key={gi}>
                  {g.heading && <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{g.heading}</div>}
                  <div className="overflow-hidden rounded-md border border-border">
                    <table className="w-full text-xs">
                      <thead className="bg-secondary/40"><tr className="border-b border-border"><th className="py-1.5 pl-3 pr-2 text-left font-medium">Item</th><th className="py-1.5 pr-2 text-right font-medium">Qty</th><th className="py-1.5 pr-2 text-right font-medium">Unit Price</th><th className="py-1.5 pr-3 text-right font-medium">Total</th></tr></thead>
                      <tbody>
                        {g.items.map(item => (
                          <tr key={item.id} className="border-b border-border last:border-0">
                            <td className="py-1.5 pl-3 pr-2"><div className="font-medium">{item.name}{item.optional && <Badge variant="outline" className="ml-1.5 h-4 rounded px-1 text-[9px] align-middle">optional</Badge>}</div>{item.description && <div className="text-muted-foreground">{item.description}</div>}</td>
                            <td className="py-1.5 pr-2 text-right tabular-nums">{item.quantity}{item.unit ? ` ${item.unit}` : ""}</td>
                            <td className="py-1.5 pr-2 text-right tabular-nums">{formatMoney(item.unit_price)}</td>
                            <td className="py-1.5 pr-3 text-right tabular-nums font-medium">{formatMoney(item.total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          ) : <p className="text-xs text-muted-foreground">No line items on this estimate.</p>}

          <div className="space-y-1.5 border-t border-border pt-3">
            <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="tabular-nums">{formatMoney(estimate.subtotal)}</span></div>
            {estimate.discountTotal > 0 && <div className="flex justify-between"><span className="text-muted-foreground">Discount</span><span className="tabular-nums">−{formatMoney(estimate.discountTotal)}</span></div>}
            <div className="flex justify-between"><span className="text-muted-foreground">Tax ({estimate.taxRate}%)</span><span className="tabular-nums">{formatMoney(estimate.taxTotal)}</span></div>
            <div className="flex justify-between text-base font-semibold"><span>Total</span><span className="tabular-nums">{formatMoney(estimate.total)}</span></div>
            {estimate.depositAmount > 0 && <div className="flex justify-between text-xs"><span className="text-muted-foreground">Deposit due</span><span className="tabular-nums">{formatMoney(estimate.depositAmount)}</span></div>}
          </div>

          {/* Version history */}
          {versions.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"><History className="h-3 w-3" />Version history</div>
              <div className="space-y-1">
                {versions.map(v => (
                  <div key={v.id} className="flex items-center justify-between rounded-md border border-border px-2.5 py-1.5 text-xs">
                    <span className="font-medium">Version {v.version_number}{v.version_number === estimate.version_number && <Badge variant="outline" className="ml-1.5 h-4 rounded px-1 text-[9px] align-middle">current</Badge>}</span>
                    <span className="text-muted-foreground">{fmtDateTime(v.created_at)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Activity */}
          {activities.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"><ActivityIcon className="h-3 w-3" />Activity</div>
              <div className="space-y-2">
                {activities.map(a => (
                  <div key={a.id} className="flex items-start gap-2 text-xs">
                    <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5"><span className="font-medium">{a.title}</span><span className="text-[10px] text-muted-foreground">· {a.actor_type}</span></div>
                      {a.description && <div className="text-muted-foreground">{a.description}</div>}
                    </div>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{fmtDateTime(a.created_at)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

function EstimatesPage() {
  const { openNew, leadId, contactId, companyId, dealId, projectId } = useSearch({ from: "/estimates" });
  const navigate = useNavigate({ from: "/estimates" });
  const [estimates, setEstimates] = useState<Estimate[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selected, setSelected] = useState<Estimate | null>(null);
  const [viewTarget, setViewTarget] = useState<Estimate | null>(null);
  const [editTarget, setEditTarget] = useState<Estimate | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Estimate | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [orgInfo, setOrgInfo] = useState<OrgInfo | null>(null);
  const [initialLead, setInitialLead] = useState<{ contactId: string; name: string; projectType: string; budget: number; notes: string; leadId: string } | null>(null);
  const [initialContext, setInitialContext] = useState<{ contactId?: string; companyId?: string; dealId?: string; projectId?: string } | null>(null);

  useEffect(() => { getOrgId().then(setOrgId); }, []);

  // Deep-link support: CRM entry points and Command Center Quick Actions
  // navigate here with ?openNew=1 (+ optional entity ids) instead of
  // duplicating this form, so they all open the same sheet, pre-filled.
  useEffect(() => {
    if (!openNew || !orgId) return;

    const openForLead = async () => {
      if (leadId) {
        const { data: leadRow } = await supabase.from("leads").select("contact_id, estimated_value, notes, custom_fields").eq("id", leadId).maybeSingle();
        if (leadRow) {
          let name = "Lead";
          if (leadRow.contact_id) {
            const { data: contact } = await supabase.from("contacts").select("full_name").eq("id", leadRow.contact_id).maybeSingle();
            name = contact?.full_name ?? leadRow.custom_fields?.name ?? "Lead";
          }
          setInitialLead({ contactId: leadRow.contact_id ?? "", name, projectType: leadRow.custom_fields?.service ?? "", budget: Number(leadRow.estimated_value ?? 0), notes: leadRow.notes ?? "", leadId });
        }
        setInitialContext(null);
      } else if (contactId || companyId || dealId || projectId) {
        setInitialLead(null);
        setInitialContext({ contactId, companyId, dealId, projectId });
      } else {
        setInitialLead(null);
        setInitialContext(null);
      }

      setNewOpen(true);
      navigate({ search: (s) => ({ ...s, openNew: undefined, leadId: undefined, contactId: undefined, companyId: undefined, dealId: undefined, projectId: undefined }), replace: true });
    };

    void openForLead();
  }, [openNew, leadId, contactId, companyId, dealId, projectId, orgId, navigate]);

  useEffect(() => {
    if (!orgId) return;
    supabase.from("organizations").select("name, logo_url, email, phone, address").eq("id", orgId).maybeSingle()
      .then(({ data }) => { if (data) setOrgInfo(data as OrgInfo); });
  }, [orgId]);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);

    const { data: estData, error: estErr } = await supabase.from("estimates").select("*").eq("org_id", orgId).order("created_at", { ascending: false });
    if (estErr) { console.error("[estimates]", estErr); setLoading(false); return; }
    if (!estData?.length) { setEstimates([]); setLoading(false); return; }

    const estimateIds = estData.map((e: any) => e.id);
    const { data: itemsData } = await supabase.from("estimate_items").select("*").in("estimate_id", estimateIds);

    const clientIds = [...new Set(estData.map((e: any) => e.client_id).filter(Boolean))] as string[];
    const { data: contactsData } = clientIds.length ? await supabase.from("contacts").select("id, full_name").in("id", clientIds) : { data: [] };
    const contactMap = new Map((contactsData ?? []).map((c: any) => [c.id, c.full_name as string]));

    const companyIds = [...new Set(estData.map((e: any) => e.company_id).filter(Boolean))] as string[];
    const { data: companiesData } = companyIds.length ? await supabase.from("companies").select("id, name").in("id", companyIds) : { data: [] };
    const companyMap = new Map((companiesData ?? []).map((c: any) => [c.id, c.name as string]));

    const ownerIds = [...new Set(estData.map((e: any) => e.owner_id).filter(Boolean))] as string[];
    const { data: ownersData } = ownerIds.length ? await supabase.from("profiles").select("id, first_name, last_name").in("id", ownerIds) : { data: [] };
    const ownerMap = new Map((ownersData ?? []).map((o: any) => [o.id, [o.first_name, o.last_name].filter(Boolean).join(" ") || "Team member"]));

    const itemsByEstimate = new Map<string, any[]>();
    (itemsData ?? []).forEach((item: any) => {
      const list = itemsByEstimate.get(item.estimate_id) ?? [];
      list.push(item);
      itemsByEstimate.set(item.estimate_id, list);
    });

    setEstimates(estData.map((r: any) => {
      const items = mapItems(itemsByEstimate.get(r.id) ?? []);
      return {
        id: r.id,
        number: r.number ?? null,
        title: r.title ?? "Untitled",
        status: normalizeEstimateStatus(r.status),
        client_id: r.client_id ?? null,
        client_name: r.client_name ?? contactMap.get(r.client_id) ?? "—",
        company_id: r.company_id ?? null,
        company_name: r.company_id ? (companyMap.get(r.company_id) ?? null) : null,
        lead_id: r.lead_id ?? null,
        deal_id: r.deal_id ?? null,
        project_id: r.project_id ?? null,
        owner_id: r.owner_id ?? null,
        owner_name: r.owner_id ? (ownerMap.get(r.owner_id) ?? null) : null,
        notes: r.notes ?? null,
        scope: r.scope ?? null,
        customer_note: r.customer_note ?? null,
        terms: r.terms ?? null,
        exclusions: r.exclusions ?? null,
        assumptions: r.assumptions ?? null,
        service_address: r.metadata?.serviceAddress ?? null,
        valid_until: r.valid_until ?? null,
        created_at: r.created_at,
        updated_at: r.updated_at,
        sent_at: r.sent_at ?? null,
        viewed_at: r.viewed_at ?? null,
        approved_at: r.approved_at ?? null,
        rejected_at: r.rejected_at ?? null,
        expired_at: r.expired_at ?? null,
        cancelled_at: r.cancelled_at ?? null,
        changes_requested_at: r.changes_requested_at ?? null,
        public_token: r.public_token ?? null,
        version_number: r.version_number ?? 1,
        currency: r.currency ?? "USD",
        taxRate: Number(r.tax_rate ?? 0),
        discountType: r.discount_type ?? null,
        discountValue: Number(r.discount_value ?? 0),
        depositType: r.deposit_type ?? null,
        depositValue: Number(r.deposit_value ?? 0),
        convertedDealId: r.converted_deal_id ?? null,
        convertedProjectId: r.converted_project_id ?? null,
        subtotal: Number(r.subtotal ?? 0),
        discountTotal: Number(r.discount_total ?? 0),
        taxTotal: Number(r.tax_total ?? 0),
        total: Number(r.total ?? 0),
        depositAmount: Number(r.deposit_amount ?? 0),
        balanceDue: Number(r.balance_due ?? 0),
        item_count: items.length,
        estimate_items: items,
      };
    }));
    setLoading(false);
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return estimates.filter(e => {
      if (statusFilter !== "all" && e.status !== statusFilter) return false;
      if (!q) return true;
      return (
        e.title.toLowerCase().includes(q) || e.client_name.toLowerCase().includes(q) ||
        (e.number ?? "").toLowerCase().includes(q) || (e.company_name ?? "").toLowerCase().includes(q)
      );
    });
  }, [estimates, search, statusFilter]);

  const stats = useMemo(() => ({
    draft: estimates.filter(e => e.status === "draft").length,
    awaiting: estimates.filter(e => e.status === "sent" || e.status === "viewed").length,
    approved: estimates.filter(e => e.status === "approved").length,
    approvedValue: estimates.filter(e => e.status === "approved").reduce((sum, e) => sum + e.total, 0),
  }), [estimates]);

  // Manual override for approve/reject/cancel/etc — the primary approve/
  // reject path is the customer-facing proposal page (proposal-action.ts),
  // which also logs the activity and records a signature/snapshot. This is
  // a lighter internal fallback plus the non-customer-facing transitions
  // (ready/cancel/archive/restore) that only ever happen internally.
  const updateStatus = async (id: string, status: EstimateStatus) => {
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { status, updated_at: now };
    if (status === "approved") patch.approved_at = now;
    if (status === "rejected") patch.rejected_at = now;
    if (status === "cancelled") patch.cancelled_at = now;
    const { error } = await supabase.from("estimates").update(patch).eq("id", id);
    if (error) { toast.error("Failed to update status"); return; }
    const est = estimates.find(e => e.id === id);
    if (orgId && est) {
      const ACTIVITY_LOGGED: EstimateStatus[] = ["approved", "rejected"];
      if (ACTIVITY_LOGGED.includes(status)) {
        await supabase.from("estimate_activities").insert({
          org_id: orgId, estimate_id: id, version_number: est.version_number, activity_type: status,
          actor_type: "user", title: status === "approved" ? "Marked approved" : "Marked rejected",
          description: "Recorded manually by team member",
        });
      }
    }
    toast.success(`Estimate marked as ${ESTIMATE_STATUS_LABELS[status]}`);
    load();
    setSelected(s => (s?.id === id ? { ...s, status } : s));
  };

  const [sendingId, setSendingId] = useState<string | null>(null);
  const handleSend = async (id: string) => {
    setSendingId(id);
    const result = await sendEstimateProposal(id);
    if (!result.ok) toast.error(result.error ?? "Failed to send proposal");
    else {
      toast.success("Proposal sent to client");
      setSelected(s => (s?.id === id ? { ...s, status: "sent" } : s));
    }
    setSendingId(null);
    load();
  };

  const handleCopyLink = (e: Estimate) => {
    if (!e.public_token) { toast.error("Send the proposal first to generate a link"); return; }
    navigator.clipboard.writeText(`${window.location.origin}/proposal/${e.public_token}`);
    toast.success("Proposal link copied");
  };

  const [busyAction, setBusyAction] = useState<string | null>(null);

  // ── Create Revision — snapshots the current row + items into
  // estimate_versions, then bumps version_number and returns the estimate
  // to draft so it can be edited without silently mutating what the
  // customer already saw for the prior version.
  const handleCreateRevision = async (e: Estimate) => {
    if (!orgId) return;
    setBusyAction(`${e.id}:revision`);
    try {
      const { data: row } = await supabase.from("estimates").select("*").eq("id", e.id).single();
      const { data: items } = await supabase.from("estimate_items").select("*").eq("estimate_id", e.id);
      await supabase.from("estimate_versions").insert({
        org_id: orgId, estimate_id: e.id, version_number: e.version_number,
        snapshot: { estimate: row, items }, created_by: (await supabase.auth.getUser()).data.user?.id ?? null,
      });
      const nextVersion = e.version_number + 1;
      const { error } = await supabase.from("estimates").update({
        status: "draft", version_number: nextVersion, updated_at: new Date().toISOString(),
      }).eq("id", e.id);
      if (error) throw error;
      await supabase.from("estimate_activities").insert({
        org_id: orgId, estimate_id: e.id, version_number: nextVersion, activity_type: "revision_created",
        actor_type: "user", title: `Revision created — now v${nextVersion}`,
      });
      toast.success(`Revision created — now v${nextVersion}`);
      setSelected(s => (s?.id === e.id ? { ...s, status: "draft", version_number: nextVersion } : s));
      load();
    } catch (err: any) {
      toast.error(err.message ?? "Failed to create revision");
    } finally {
      setBusyAction(null);
    }
  };

  // ── Convert to Deal / Retry Deal Sync ─────────────────────────────────────
  // Both call the exact same server-side syncEstimateDeal() service that
  // estimate-send.ts / proposal-data.ts / proposal-action.ts call
  // automatically — this is a thin authenticated trigger, not a second
  // implementation (Part 16).
  const handleConvertDeal = async (e: Estimate) => {
    if (busyAction === `${e.id}:deal`) return; // duplicate-submit guard (double click / retry)
    setBusyAction(`${e.id}:deal`);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { toast.error("Not signed in"); return; }
      const res = await fetch("/.netlify/functions/estimate-convert-deal", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ estimateId: e.id }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok || result.error) throw new Error(result.error ?? "Failed to convert to Deal");
      if (result.skipped) {
        toast.error(result.reason ?? "This estimate is already converted to a Deal.");
      } else {
        toast.success(result.created ? "Deal created" : "Linked Deal synced");
        setSelected(s => (s?.id === e.id ? { ...s, deal_id: result.dealId, convertedDealId: result.dealId } : s));
      }
      load();
    } catch (err: any) {
      toast.error(err.message ?? "Failed to convert to Deal");
    } finally {
      setBusyAction(null);
    }
  };

  // ── Convert to Project ────────────────────────────────────────────────────
  const handleConvertProject = async (e: Estimate) => {
    if (e.convertedProjectId) { toast.error("Already converted to a Project"); return; }
    if (!e.client_id) { toast.error("This estimate has no linked contact to create a project for."); return; }
    setBusyAction(`${e.id}:project`);
    try {
      const { project, error } = await createProject({
        name: e.title, client_id: e.client_id, status: "planning",
        address: e.service_address ?? undefined, budget_total: e.total, description: e.scope ?? undefined,
        priority: "normal", ownerId: e.owner_id ?? null, dealId: e.deal_id || e.convertedDealId || undefined, estimateId: e.id,
      });
      if (error || !project) throw error ?? new Error("Project not created");
      await supabase.from("estimates").update({ converted_project_id: project.id }).eq("id", e.id);
      await supabase.from("estimate_activities").insert({
        org_id: orgId, estimate_id: e.id, version_number: e.version_number, activity_type: "converted_to_project",
        actor_type: "user", title: "Converted to Project", description: project.name,
      });
      toast.success(`Project "${project.name}" created`);
      setSelected(s => (s?.id === e.id ? { ...s, convertedProjectId: project.id } : s));
      load();
    } catch (err: any) {
      toast.error(err.message ?? "Failed to convert to Project");
    } finally {
      setBusyAction(null);
    }
  };

  function genInvoiceNumber(): string {
    const now = new Date();
    return `INV-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${Math.floor(Math.random() * 900 + 100)}`;
  }

  // ── Create Invoice / Deposit Invoice ──────────────────────────────────────
  const handleCreateInvoice = async (e: Estimate, isDeposit: boolean) => {
    const projectIdForInvoice = e.project_id || e.convertedProjectId;
    if (!projectIdForInvoice) { toast.error("Convert this estimate to a Project first — invoices require a linked project."); return; }
    if (!orgId) return;

    setBusyAction(`${e.id}:${isDeposit ? "deposit" : "invoice"}`);
    try {
      if (isDeposit) {
        const { data: existing } = await supabase.from("invoices").select("id").eq("estimate_id", e.id).eq("is_deposit", true).limit(1);
        if (existing && existing.length) { toast.error("A deposit invoice already exists for this estimate"); setBusyAction(null); return; }
      }
      const amount = isDeposit ? e.depositAmount : e.total;
      const { data: inv, error } = await supabase.from("invoices").insert({
        org_id: orgId, project_id: projectIdForInvoice, client_id: e.client_id, estimate_id: e.id,
        invoice_number: genInvoiceNumber(), issue_date: new Date().toISOString().slice(0, 10),
        due_date: plusDays(30), status: "draft", is_deposit: isDeposit,
        subtotal: amount, tax_amount: 0, total_amount: amount, amount_paid: 0,
        notes: isDeposit ? `Deposit for ${e.number ?? e.title}` : `Invoice for ${e.number ?? e.title}`,
      }).select("id, invoice_number").single();
      if (error) throw error;

      await supabase.from("estimate_activities").insert({
        org_id: orgId, estimate_id: e.id, version_number: e.version_number,
        activity_type: isDeposit ? "deposit_requested" : "invoice_created",
        actor_type: "user", title: isDeposit ? "Deposit invoice created" : "Invoice created", description: inv.invoice_number,
      });
      toast.success(`${isDeposit ? "Deposit invoice" : "Invoice"} ${inv.invoice_number} created`);
      load();
    } catch (err: any) {
      toast.error(err.message ?? "Failed to create invoice");
    } finally {
      setBusyAction(null);
    }
  };

  const handleDuplicate = async (e: Estimate) => {
    if (!orgId) return;
    try {
      const { data: est, error } = await supabase.from("estimates").insert({
        org_id: orgId, status: "draft", title: `${e.title} (Copy)`,
        client_id: e.client_id, client_name: e.client_name, company_id: e.company_id,
        owner_id: e.owner_id, valid_until: plusDays(30), scope: e.scope, notes: e.notes,
        customer_note: e.customer_note, terms: e.terms, exclusions: e.exclusions, assumptions: e.assumptions,
        tax_rate: e.taxRate, discount_type: e.discountType, discount_value: e.discountValue,
        deposit_type: e.depositType, deposit_value: e.depositValue, metadata: { serviceAddress: e.service_address },
        // total + client_total together (trg_sync_total forces
        // total := client_total on every write — see save()'s comment).
        subtotal: e.subtotal, discount_total: e.discountTotal, tax_total: e.taxTotal,
        total: e.total, client_total: e.total, deposit_amount: e.depositAmount, balance_due: e.balanceDue,
      }).select("id").single();
      if (error) throw error;
      const rows = e.estimate_items.map((it, idx) => ({
        estimate_id: est.id, category: it.category, item_type: it.item_type, name: it.name, description: it.description,
        quantity: it.quantity, unit: it.unit, unit_price: it.unit_price, total: it.total, position: idx,
        taxable: it.taxable, optional: it.optional, is_heading: it.is_heading,
      }));
      if (rows.length) await supabase.from("estimate_items").insert(rows);
      toast.success("Estimate duplicated");
      load();
    } catch (err: any) {
      toast.error(err.message ?? "Failed to duplicate estimate");
    }
  };

  const deleteEstimate = async (e: Estimate) => {
    await supabase.from("estimate_items").delete().eq("estimate_id", e.id);
    const { error } = await supabase.from("estimates").delete().eq("id", e.id);
    if (error) { toast.error("Failed to delete estimate"); return; }
    toast.success("Estimate deleted");
    setDeleteTarget(null);
    if (selected?.id === e.id) setSelected(null);
    load();
  };

  return (
    <>
      <PageHeader
        icon={FileText}
        iconBg="bg-gold-soft"
        iconColor="text-gold-hover"
        title="Estimates"
        subtitle="Create, send, track, and follow up on customer estimates."
        actions={
          <Button size="sm" onClick={() => { if (!orgId) { toast.error("Still loading…"); return; } setInitialLead(null); setInitialContext(null); setNewOpen(true); }}>
            <FileText className="mr-1.5 h-3.5 w-3.5" />New Estimate
          </Button>
        }
      />

      {/* KPIs */}
      <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Draft" value={stats.draft} icon={FileText} tone="muted" />
        <MetricCard label="Awaiting response" value={stats.awaiting} icon={Clock} tone="warning" />
        <MetricCard label="Approved" value={stats.approved} icon={CheckCircle2} tone="success" />
        <MetricCard label="Approved value" value={formatMoney(stats.approvedValue)} icon={Receipt} tone="success" />
      </div>

      {/* Filters */}
      <Card className="mb-3 p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-50 flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search by number, title, or customer…" value={search} onChange={e => setSearch(e.target.value)} className="h-8 pl-8 text-sm" />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-8 w-44 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {(Object.keys(STATUS_TONE) as EstimateStatus[]).map(s => <SelectItem key={s} value={s}>{ESTIMATE_STATUS_LABELS[s]}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </Card>

      {/* List table */}
      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary/60 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              <tr className="border-b border-border">
                <th className="py-2.5 pl-4 pr-3 text-left">Estimate</th>
                <th className="py-2.5 pr-4 text-left">Customer</th>
                <th className="py-2.5 pr-4 text-left">Title</th>
                <th className="py-2.5 pr-4 text-left">Status</th>
                <th className="py-2.5 pr-4 text-center">Ver.</th>
                <th className="py-2.5 pr-4 text-right">Items</th>
                <th className="py-2.5 pr-4 text-right">Amount</th>
                <th className="py-2.5 pr-4 text-left">Valid until</th>
                <th className="w-10 py-2.5 pr-3" />
              </tr>
            </thead>
            <tbody>
              {loading && Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="border-b border-border">
                  {Array.from({ length: 8 }).map((_, j) => <td key={j} className="py-3 pr-4"><Skeleton className="h-4 w-24" /></td>)}
                  <td />
                </tr>
              ))}

              {!loading && filtered.length === 0 && (
                <tr><td colSpan={9} className="py-12 text-center text-sm text-muted-foreground">No estimates found.</td></tr>
              )}

              {!loading && filtered.map(e => {
                const expiringSoon = e.valid_until && ["sent", "viewed"].includes(e.status) && daysUntil(e.valid_until) <= 3 && daysUntil(e.valid_until) >= 0;
                const isExpired = e.status === "expired";
                const isChangesRequested = e.status === "changes_requested";
                const isApproved = e.status === "approved";
                return (
                  <tr key={e.id} onClick={() => setSelected(e)}
                    className={cn(
                      "cursor-pointer border-b border-border hover:bg-secondary/30",
                      isExpired && "bg-orange-soft/40",
                      isChangesRequested && "bg-amber-50 dark:bg-amber-500/5",
                      isApproved && "bg-success-soft/30",
                    )}>
                    <td className="py-2.5 pl-4 pr-3"><div className="font-semibold tabular-nums">{e.number ?? "—"}</div></td>
                    <td className="py-2.5 pr-4">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <ContactAvatar id={e.client_id} name={e.company_name || e.client_name} size="xs" />
                        <div className="min-w-0">
                          <div className="truncate font-medium">{e.company_name || e.client_name}</div>
                          {e.company_name && <div className="truncate text-[10px] text-muted-foreground">{e.client_name}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="py-2.5 pr-4"><div className="truncate font-medium">{e.title}</div></td>
                    <td className="py-2.5 pr-4">
                      <StatusBadge tone={STATUS_TONE[e.status] ?? STATUS_TONE.draft}>{ESTIMATE_STATUS_LABELS[e.status] ?? e.status}</StatusBadge>
                      {expiringSoon && <Badge variant="outline" className="ml-1.5 h-4 rounded px-1 text-[9px] align-middle text-amber-600 border-amber-300">expiring</Badge>}
                    </td>
                    <td className="py-2.5 pr-4 text-center tabular-nums text-muted-foreground">V{e.version_number}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums text-muted-foreground">{e.item_count}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums font-medium">{formatMoney(e.total)}</td>
                    <td className="py-2.5 pr-4 text-[11px] text-muted-foreground">{e.valid_until ? fmtDate(e.valid_until) : "—"}</td>
                    <td className="py-2.5 pr-3" onClick={ev => ev.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7"><MoreHorizontal className="h-3.5 w-3.5" /></Button></DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setViewTarget(e)}>Preview Proposal</DropdownMenuItem>
                          {e.status !== "archived" && <DropdownMenuItem onClick={() => { setSelected(null); setEditTarget(e); }}>Edit</DropdownMenuItem>}
                          {(e.status === "draft" || e.status === "ready") && <DropdownMenuItem onClick={() => handleSend(e.id)}>Send Proposal</DropdownMenuItem>}
                          {["sent", "viewed", "changes_requested", "expired"].includes(e.status) && (
                            <>
                              <DropdownMenuItem onClick={() => handleSend(e.id)}>{e.status === "expired" ? "Extend & Resend" : "Resend Proposal"}</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleCopyLink(e)}>Copy Proposal Link</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleCreateRevision(e)}>Create Revision</DropdownMenuItem>
                            </>
                          )}
                          {["sent", "viewed"].includes(e.status) && (
                            <>
                              <DropdownMenuItem onClick={() => updateStatus(e.id, "approved")}>Mark as Approved</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => updateStatus(e.id, "rejected")} className="text-destructive">Mark as Rejected</DropdownMenuItem>
                            </>
                          )}
                          {e.status === "approved" && (
                            <>
                              {(e.convertedDealId || e.deal_id) ? (
                                <DropdownMenuItem onClick={() => navigate({ to: "/pipeline", search: { dealId: (e.deal_id || e.convertedDealId)! } })}>Open Deal</DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem onClick={() => handleConvertDeal(e)}>Convert to Deal</DropdownMenuItem>
                              )}
                              <DropdownMenuItem onClick={() => handleConvertProject(e)} disabled={!!e.convertedProjectId}>Convert to Project</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleCreateInvoice(e, false)}>Create Invoice</DropdownMenuItem>
                              {e.depositAmount > 0 && <DropdownMenuItem onClick={() => handleCreateInvoice(e, true)}>Create Deposit Invoice</DropdownMenuItem>}
                            </>
                          )}
                          {e.status === "converted" && <DropdownMenuItem onClick={() => handleCreateInvoice(e, false)}>Create Invoice</DropdownMenuItem>}
                          <DropdownMenuItem onClick={() => handleDuplicate(e)}>Duplicate</DropdownMenuItem>
                          {e.public_token && !["draft", "ready", "sent", "viewed", "changes_requested"].includes(e.status) && <DropdownMenuItem onClick={() => handleCopyLink(e)}>Copy Proposal Link</DropdownMenuItem>}
                          {e.status === "cancelled" && <DropdownMenuItem onClick={() => updateStatus(e.id, "draft")}>Restore</DropdownMenuItem>}
                          {!["cancelled", "archived", "converted"].includes(e.status) && <DropdownMenuItem onClick={() => updateStatus(e.id, "cancelled")} className="text-destructive">Cancel</DropdownMenuItem>}
                          {e.status !== "archived" && <DropdownMenuItem onClick={() => updateStatus(e.id, "archived")}>Archive</DropdownMenuItem>}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setDeleteTarget(e)}>Delete</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {orgId && (
        <EstimateFormSheet open={newOpen} onClose={() => setNewOpen(false)} orgId={orgId} onSaved={load} initialLead={initialLead} initialContext={initialContext} />
      )}

      {orgId && editTarget && (
        <EstimateFormSheet open={!!editTarget} onClose={() => setEditTarget(null)} orgId={orgId} onSaved={() => { load(); setEditTarget(null); }} estimate={editTarget} />
      )}

      <EstimateDetailSheet
        estimate={selected}
        onClose={() => setSelected(null)}
        onStatusChange={updateStatus}
        onEdit={e => { setSelected(null); setEditTarget(e); }}
        onSend={handleSend}
        onCopyLink={handleCopyLink}
        sending={!!selected && sendingId === selected.id}
        onConvertDeal={handleConvertDeal}
        onConvertProject={handleConvertProject}
        onCreateInvoice={handleCreateInvoice}
        onOpenDeal={dealId => navigate({ to: "/pipeline", search: { dealId } })}
        onCreateDeposit={e => handleCreateInvoice(e, true)}
        onCreateRevision={handleCreateRevision}
        busyAction={busyAction}
      />

      <EstimateViewDialog estimate={viewTarget} org={orgInfo} onClose={() => setViewTarget(null)} />

      <AlertDialog open={!!deleteTarget} onOpenChange={o => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete estimate?</AlertDialogTitle>
            <AlertDialogDescription>"{deleteTarget?.title}" and all its line items will be permanently removed. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive hover:bg-destructive/90 text-destructive-foreground" onClick={() => deleteTarget && deleteEstimate(deleteTarget)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ── Shared ────────────────────────────────────────────────────────────────────

function FactBox({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded-md border border-border bg-secondary/40 p-2.5">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 text-sm font-semibold tabular-nums", highlight && "text-base text-primary")}>{value}</div>
    </div>
  );
}
