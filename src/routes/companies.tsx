// src/routes/companies.tsx
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { formatDistanceToNow } from "date-fns";
import {
  Building2,
  Camera,
  Check,
  ChevronDown,
  Globe,
  Mail,
  MapPin,
  MoreHorizontal,
  Pencil,
  Phone,
  Plus,
  Search,
  Trash2,
  Upload,
  Download,
  History,
  UserPlus,
  Users,
  X,
  CalendarPlus,
} from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/layout/app-shell";
import { AddressAutocomplete } from "@/components/ui/address-autocomplete";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MetricCard } from "@/components/ui/metric-card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/lib/supabase";
import { AppointmentDialog } from "@/components/calendar/appointment-dialog";
import {
  useCompanies, useCompaniesLoading, refreshCompanies, deleteCompany as storeDeleteCompany,
  countCompanyLinkedRecords, findCompanyDuplicateCandidates, getOrgId as getCompaniesOrgId,
  createUniqueCompanySlug, upsertCompanyLocal, addCompany as storeAddCompany,
  updateCompany as storeUpdateCompany,
  type CompanyDuplicateCandidate, type Company as StoreCompany,
} from "@/lib/companies-store";
import { useDeals } from "@/lib/deals-store";
import { useContacts } from "@/lib/contacts-store";
import { formatMoney } from "@/lib/format";
import {
  companiesToCSV, downloadCSV, parseCSVPreview, autoMapHeaders as autoMapCompanyHeaders,
  applyMappingToCompanies, COMPANY_FIELDS, type CompanyColumnMapping,
} from "@/lib/companies-csv";
import { CSV_MAX_SYNC_IMPORT_ROWS, CSV_WARN_ROW_THRESHOLD } from "@/lib/csv-utils";
import { createImportJob, logImportRows, completeImportJob } from "@/lib/import-jobs-store";
import { ImportHistoryDialog } from "@/components/crm/import-history-dialog";

export const Route = createFileRoute("/companies")({
  component: AccountsPage,
});

const ACCOUNT_TYPES = [
  "Customer",
  "Prospect",
  "Vendor",
  "Partner",
  "Builder",
  "Property Manager",
  "Architect",
  "Designer",
  "Supplier",
  "Subcontractor",
  "Other",
] as const;

const ACCOUNT_STATUSES = ["Active", "Inactive", "Archived"] as const;

const INDUSTRIES = [
  "Construction",
  "General Contractor",
  "Remodeling",
  "Home Builder",
  "Property Management",
  "Architecture",
  "Interior Design",
  "Engineering",
  "Roofing",
  "HVAC",
  "Electrical",
  "Plumbing",
  "Painting",
  "Flooring",
  "Landscaping",
  "Concrete",
  "Cabinets",
  "Windows & Doors",
  "Supplier",
  "Manufacturer",
  "Distributor",
  "Real Estate",
  "Commercial",
  "Residential",
  "Other",
] as const;

const DEFAULT_TAGS = [
  "Commercial",
  "Residential",
  "High Value",
  "VIP",
  "Referral Partner",
  "Builder",
  "Property Manager",
  "Vendor",
  "Supplier",
  "Active Customer",
  "Prospect",
  "Remodeling",
  "HOA",
  "Government",
] as const;

type AccountType = (typeof ACCOUNT_TYPES)[number];
type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

type Company = {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  account_type: AccountType;
  status: AccountStatus;
  industry: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string;
  owner_name: string | null;
  logo_url: string | null;
  tags: string[];
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type TeamMember = {
  id: string;
  name: string;
  email: string | null;
};

type ContactOption = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
};

type PrimaryContactMode = "none" | "existing" | "new";

type CompanyForm = {
  name: string;
  account_type: AccountType;
  status: AccountStatus;
  industry: string;
  owner_name: string;
  email: string;
  phone: string;
  website: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  tags: string[];
  notes: string;
  logo_url: string;
  primary_contact_mode: PrimaryContactMode;
  existing_contact_id: string;
  contact_name: string;
  contact_title: string;
  contact_email: string;
  contact_phone: string;
};

const EMPTY_FORM: CompanyForm = {
  name: "",
  account_type: "Prospect",
  status: "Active",
  industry: "",
  owner_name: "",
  email: "",
  phone: "",
  website: "",
  address: "",
  city: "",
  state: "",
  zip: "",
  country: "United States",
  tags: [],
  notes: "",
  logo_url: "",
  primary_contact_mode: "none",
  existing_contact_id: "",
  contact_name: "",
  contact_title: "",
  contact_email: "",
  contact_phone: "",
};

async function getOrgId(): Promise<string | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

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

function formatPhoneInput(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 10);
  if (!digits) return "";
  if (digits.length < 4) return `(${digits}`;
  if (digits.length < 7) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function ensureHttpsWhileTyping(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed.replace(/^\/+/, "")}`;
}

// Slug generation (Priority 4) \u2014 now canonical in companies-store.ts;
// this page previously had its own copy of the exact same logic. Kept as
// local aliases so every call site below didn't need renaming.
const createUniqueAccountSlug = createUniqueCompanySlug;

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function accountTypeClass(type: AccountType): string {
  const classes: Record<AccountType, string> = {
    Customer: "border-emerald-200 bg-emerald-50 text-emerald-700",
    Prospect: "border-blue-200 bg-blue-50 text-blue-700",
    Vendor: "border-amber-200 bg-amber-50 text-amber-700",
    Partner: "border-violet-200 bg-violet-50 text-violet-700",
    Builder: "border-orange-200 bg-orange-50 text-orange-700",
    "Property Manager": "border-cyan-200 bg-cyan-50 text-cyan-700",
    Architect: "border-indigo-200 bg-indigo-50 text-indigo-700",
    Designer: "border-pink-200 bg-pink-50 text-pink-700",
    Supplier: "border-yellow-200 bg-yellow-50 text-yellow-700",
    Subcontractor: "border-slate-200 bg-slate-100 text-slate-700",
    Other: "border-gray-200 bg-gray-50 text-gray-700",
  };
  return classes[type];
}

function companyToForm(company: Company): CompanyForm {
  return {
    ...EMPTY_FORM,
    name: company.name,
    account_type: company.account_type,
    status: company.status,
    industry: company.industry ?? "",
    owner_name: company.owner_name ?? "",
    email: company.email ?? "",
    phone: formatPhoneInput(company.phone ?? ""),
    website: company.website ?? "",
    address: company.address ?? "",
    city: company.city ?? "",
    state: company.state ?? "",
    zip: company.zip ?? "",
    country: company.country || "United States",
    tags: company.tags ?? [],
    notes: company.notes ?? "",
    logo_url: company.logo_url ?? "",
  };
}

function companyPayload(form: CompanyForm) {
  return {
    name: form.name.trim(),
    account_type: form.account_type,
    status: form.status,
    industry: form.industry || null,
    owner_name: form.owner_name || null,
    email: form.email.trim() || null,
    phone: form.phone.replace(/\D/g, "") || null,
    website: form.website.trim() || null,
    address: form.address.trim() || null,
    city: form.city.trim() || null,
    state: form.state.trim() || null,
    zip: form.zip.trim() || null,
    country: form.country.trim() || "United States",
    tags: form.tags,
    notes: form.notes.trim() || null,
    logo_url: form.logo_url || null,
  };
}

function AccountsPage() {
  // Phase 9.4 — reads now come from the canonical companies-store instead
  // of this page's own ad hoc fetch. account_type/status are widened to
  // plain `string` in the store (they're free-text columns, not real
  // enums — same reasoning already applied to leads.source/leads.status in
  // earlier Phase 9 stages), so the store's rows are cast to this page's
  // existing narrower `Company` type at the boundary rather than loosening
  // every usage below (Select options / badge-color lookups still assume
  // one of the fixed lists, which is what every real row currently has).
  const storeCompanies = useCompanies();
  const companies = storeCompanies as unknown as Company[];
  const storeLoading = useCompaniesLoading();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState("Active");
  // csv import (Stage 9.5, Priority 12 — new capability, Companies had none)
  const [mapOpen, setMapOpen] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [csvRaw, setCsvRaw] = useState("");
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvPreview, setCsvPreview] = useState<string[][]>([]);
  const [csvTotalRows, setCsvTotalRows] = useState(0);
  const [colMapping, setColMapping] = useState<CompanyColumnMapping | null>(null);
  const [importFilename, setImportFilename] = useState("companies.csv");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selected, setSelected] = useState<Company | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Company | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Company | null>(null);
  const [deleteLinkedRecords, setDeleteLinkedRecords] = useState<{ label: string; count: number; blocking: boolean }[] | null>(null);
  const [deleteChecking, setDeleteChecking] = useState(false);
  const allDeals = useDeals();
  const allContacts = useContacts();

  // storeLoading only reflects "has the store fetched at least once" — once
  // true, subsequent refreshes (e.g. after create/edit/delete) don't flip
  // the list back to a loading skeleton, matching the previous UX.
  const loading = storeLoading && companies.length === 0;

  const loadCompanies = useCallback(async () => {
    await refreshCompanies();
  }, []);

  // Debounced search (matches the pattern already used on Leads/Contacts).
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Real per-company counts (Priority 13) — derived from already-loaded
  // reactive stores (useDeals()/useContacts()), not a query per company.
  const openDealCountByCompany = useMemo(() => {
    const map = new Map<string, { count: number; value: number }>();
    for (const d of allDeals) {
      if (!d.companyId || d.status !== "open") continue;
      const entry = map.get(d.companyId) ?? { count: 0, value: 0 };
      entry.count += 1;
      entry.value += Number(d.value ?? 0);
      map.set(d.companyId, entry);
    }
    return map;
  }, [allDeals]);

  const contactCountByCompany = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of allContacts) {
      if (!c.company_id) continue;
      map.set(c.company_id, (map.get(c.company_id) ?? 0) + 1);
    }
    return map;
  }, [allContacts]);

  const ownerFilterOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of companies) if (c.owner_name) set.add(c.owner_name);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [companies]);

  const stateFilterOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of companies) if (c.state) set.add(c.state);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [companies]);

  const tagFilterOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of companies) for (const t of c.tags ?? []) set.add(t);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [companies]);

  const [ownerFilter, setOwnerFilter] = useState("All owners");
  const [stateFilter, setStateFilter] = useState("All states");
  const [tagFilter2, setTagFilter2] = useState("All tags");
  const [hasContactsOnly, setHasContactsOnly] = useState(false);
  const [hasOpenDealsOnly, setHasOpenDealsOnly] = useState(false);
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);

  const moreFiltersActiveCount = [
    ownerFilter !== "All owners",
    stateFilter !== "All states",
    tagFilter2 !== "All tags",
    hasContactsOnly,
    hasOpenDealsOnly,
  ].filter(Boolean).length;

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return companies.filter((company) => {
      const matchesSearch =
        !query ||
        company.name.toLowerCase().includes(query) ||
        (company.industry ?? "").toLowerCase().includes(query) ||
        (company.city ?? "").toLowerCase().includes(query) ||
        (company.email ?? "").toLowerCase().includes(query) ||
        (company.phone ?? "").toLowerCase().includes(query) ||
        (company.website ?? "").toLowerCase().includes(query) ||
        (company.address ?? "").toLowerCase().includes(query) ||
        (company.tags ?? []).some((tag) => tag.toLowerCase().includes(query));

      if (ownerFilter !== "All owners" && company.owner_name !== ownerFilter) return false;
      if (stateFilter !== "All states" && company.state !== stateFilter) return false;
      if (tagFilter2 !== "All tags" && !(company.tags ?? []).includes(tagFilter2)) return false;
      if (hasContactsOnly && !(contactCountByCompany.get(company.id) ?? 0)) return false;
      if (hasOpenDealsOnly && !(openDealCountByCompany.get(company.id)?.count ?? 0)) return false;

      return (
        matchesSearch &&
        (typeFilter === "All" || company.account_type === typeFilter) &&
        (statusFilter === "All" || company.status === statusFilter)
      );
    });
  }, [companies, search, typeFilter, statusFilter, ownerFilter, stateFilter, tagFilter2, hasContactsOnly, hasOpenDealsOnly, contactCountByCompany, openDealCountByCompany]);

  const clearMoreFilters = () => {
    setOwnerFilter("All owners");
    setStateFilter("All states");
    setTagFilter2("All tags");
    setHasContactsOnly(false);
    setHasOpenDealsOnly(false);
  };

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (company: Company) => {
    setEditing(company);
    setFormOpen(true);
  };

  // Safe delete (Priority 12) — checks linked records before showing the
  // destructive action at all; the store's own deleteCompany() re-checks
  // independently (defense in depth, not UI-only).
  useEffect(() => {
    if (!deleteTarget) { setDeleteLinkedRecords(null); return; }
    let cancelled = false;
    (async () => {
      setDeleteChecking(true);
      const orgId = await getCompaniesOrgId();
      if (!orgId || cancelled) { setDeleteChecking(false); return; }
      const linked = await countCompanyLinkedRecords(deleteTarget.id, orgId);
      if (!cancelled) { setDeleteLinkedRecords(linked); setDeleteChecking(false); }
    })();
    return () => { cancelled = true; };
  }, [deleteTarget]);

  const deleteBlockingRecords = (deleteLinkedRecords ?? []).filter((r) => r.blocking);

  const deleteCompany = async () => {
    if (!deleteTarget) return;
    if (deleteBlockingRecords.length > 0) return;

    const result = await storeDeleteCompany(deleteTarget.id);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }

    toast.success(`${deleteTarget.name} deleted.`);
    if (selected?.id === deleteTarget.id) setSelected(null);
    setDeleteTarget(null);
  };

  // ── Export (Priority 10) ──────────────────────────────────────────────
  // Exports the currently filtered/searched view, not always the full org
  // dataset regardless of active search/filters (QA pass fix — this
  // previously always exported storeCompanies unfiltered).
  const handleExport = () => {
    const csv = companiesToCSV(filtered as unknown as StoreCompany[]);
    downloadCSV(csv, `companies-${new Date().toISOString().slice(0, 10)}.csv`);
    toast.success(`Exported ${filtered.length} account${filtered.length === 1 ? "" : "s"}`);
  };

  // ── Import: pick file (Priority 12 — new capability) ──────────────────
  const handleImportFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFilename(file.name);
    e.target.value = "";
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const { headers, preview, totalRows } = parseCSVPreview(text);
      if (headers.length === 0 || totalRows === 0) { toast.error("Empty or invalid CSV file"); return; }
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
      setColMapping(autoMapCompanyHeaders(headers));
      setMapOpen(true);
    };
    reader.readAsText(file);
  };

  const importValidation = useMemo(() => {
    if (!colMapping || !csvRaw) return null;
    const { companies: parsed, errors } = applyMappingToCompanies(csvRaw, colMapping);
    return { validCount: parsed.length, errors };
  }, [colMapping, csvRaw]);

  // ── Import: confirm — duplicate checks via findCompanyDuplicateCandidates
  // (exact normalized name / website domain only, never fuzzy), slug via
  // companies-store's own createUniqueCompanySlug, no implicit contact/
  // company_contacts creation (Priority 12/13). ──────────────────────────
  const handleConfirmImport = async () => {
    if (!colMapping) return;
    const { companies: parsed, errors } = applyMappingToCompanies(csvRaw, colMapping);
    if (parsed.length === 0) {
      toast.error("No accounts to import", { description: errors[0] || "Check your column mapping." });
      return;
    }

    setImportLoading(true);
    try {
      const jobId = await createImportJob("company", importFilename, csvTotalRows);
      let created = 0;
      let skippedDupes = 0;
      let failed = 0;
      const rowLogs: { source_row_number: number; entity_id: string | null; action: "created" | "skipped_duplicate" | "failed"; status: "ok" | "error" }[] = [];

      for (let i = 0; i < parsed.length; i++) {
        const row = parsed[i];
        const rowNum = i + 2;
        const dupes = findCompanyDuplicateCandidates(row.name, row.website || undefined);
        if (dupes.length > 0) {
          skippedDupes++;
          rowLogs.push({ source_row_number: rowNum, entity_id: null, action: "skipped_duplicate", status: "ok" });
          continue;
        }
        const result = await storeAddCompany({
          name: row.name,
          email: row.email || null,
          phone: row.phone || null,
          website: row.website || null,
          industry: row.industry || null,
          address: row.address || null,
          city: row.city || null,
          state: row.state || null,
          zip: row.zip || null,
          country: row.country || "United States",
          account_type: row.account_type,
          status: row.status,
          owner_name: row.owner_name || null,
          tags: row.tags,
          notes: row.notes || null,
        });
        if (result) {
          created++;
          rowLogs.push({ source_row_number: rowNum, entity_id: result.id, action: "created", status: "ok" });
        } else {
          failed++;
          rowLogs.push({ source_row_number: rowNum, entity_id: null, action: "failed", status: "error" });
        }
      }

      if (jobId) {
        await logImportRows(jobId, rowLogs);
        await completeImportJob(jobId, { created, skipped: skippedDupes, failed }, errors);
      }

      const parts = [`${created} created`];
      if (skippedDupes > 0) parts.push(`${skippedDupes} skipped as duplicate`);
      if (failed > 0) parts.push(`${failed} failed to save`);
      if (errors.length > 0) parts.push(`${errors.length} validation notice(s)`);
      toast.success(`Imported ${created} account${created !== 1 ? "s" : ""}`, { description: parts.slice(1).join(" · ") || undefined });
      setMapOpen(false);
    } finally {
      setImportLoading(false);
    }
  };

  const customers = companies.filter(
    (c) => c.account_type === "Customer",
  ).length;
  const prospects = companies.filter(
    (c) => c.account_type === "Prospect",
  ).length;
  const partners = companies.filter((c) =>
    ["Vendor", "Partner", "Supplier", "Subcontractor"].includes(c.account_type),
  ).length;

  return (
    <>
      <PageHeader
        icon={Building2}
        iconBg="bg-gold-soft"
        iconColor="text-gold-hover"
        title="Accounts"
        subtitle="Manage commercial customers, prospects, vendors, partners, and trade relationships."
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" asChild>
              <label className="cursor-pointer">
                <Upload className="mr-1.5 h-3.5 w-3.5" /> Import
                <input type="file" accept=".csv" className="sr-only" onChange={handleImportFile} />
              </label>
            </Button>
            <Button size="sm" variant="outline" onClick={handleExport}>
              <Download className="mr-1.5 h-3.5 w-3.5" /> Export
            </Button>
            <Button size="sm" variant="outline" onClick={() => setHistoryOpen(true)}>
              <History className="mr-1.5 h-3.5 w-3.5" /> Import History
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add Account
            </Button>
          </div>
        }
      />
      <ImportHistoryDialog open={historyOpen} onOpenChange={setHistoryOpen} entityType="company" />

      <Dialog open={mapOpen} onOpenChange={setMapOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Import Accounts</DialogTitle>
            <DialogDescription>
              Map your CSV columns to account fields. {csvTotalRows} row{csvTotalRows !== 1 ? "s" : ""} detected.
            </DialogDescription>
          </DialogHeader>

          {colMapping && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 max-h-64 overflow-y-auto pr-1">
                {COMPANY_FIELDS.map((field) => (
                  <div key={field.key} className="grid gap-1">
                    <Label className="text-xs">
                      {field.label}{"required" in field && field.required && <span className="text-destructive"> *</span>}
                    </Label>
                    <Select
                      value={String(colMapping[field.key])}
                      onValueChange={(v) => setColMapping((m) => m && { ...m, [field.key]: Number(v) })}
                    >
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="-1">— Skip —</SelectItem>
                        {csvHeaders.map((h, idx) => (
                          <SelectItem key={idx} value={String(idx)}>{h}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>

              {csvPreview.length > 0 && (
                <div className="rounded-md border overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        {csvHeaders.map((h, i) => <th key={i} className="p-1.5 text-left font-medium">{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {csvPreview.map((row, i) => (
                        <tr key={i} className="border-b last:border-0">
                          {row.map((cell, j) => <td key={j} className="p-1.5 truncate max-w-[10rem]">{cell}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {importValidation && (
                <div className="text-xs text-muted-foreground">
                  {importValidation.validCount} of {csvTotalRows} row(s) valid to import.
                  {importValidation.errors.length > 0 && ` ${importValidation.errors.length} validation notice(s).`}
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setMapOpen(false)} disabled={importLoading}>Cancel</Button>
            <Button
              onClick={handleConfirmImport}
              disabled={!colMapping || colMapping.name < 0 || !importValidation?.validCount || importLoading}
            >
              {importLoading && <span className="mr-1.5 inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
              {importLoading ? "Importing…" : `Import ${importValidation?.validCount ?? 0} Account${(importValidation?.validCount ?? 0) !== 1 ? "s" : ""}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label="Total accounts"
          value={companies.length}
          icon={Building2}
          tone="info"
        />
        <MetricCard
          label="Customers"
          value={customers}
          icon={Users}
          tone="success"
        />
        <MetricCard
          label="Prospects"
          value={prospects}
          icon={UserPlus}
          tone="violet"
        />
        <MetricCard
          label="Partners & vendors"
          value={partners}
          icon={Globe}
          tone="gold"
        />
      </div>

      <Card className="mb-3 p-3">
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search accounts, industries, cities, email, phone, website, address, or tags…"
              className="h-9 pl-9"
            />
          </div>

          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="h-9 w-full md:w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="All">All account types</SelectItem>
              {ACCOUNT_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-9 w-full md:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="All">All statuses</SelectItem>
              {ACCOUNT_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {status}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Popover open={moreFiltersOpen} onOpenChange={setMoreFiltersOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="relative h-9">
                More filters
                {moreFiltersActiveCount > 0 && (
                  <span className="absolute -right-1.5 -top-1.5 grid h-4 w-4 place-items-center rounded-full bg-primary text-[9px] font-semibold text-primary-foreground">
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
                <Label className="text-xs">State</Label>
                <Select value={stateFilter} onValueChange={setStateFilter}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="All states" className="text-xs">All states</SelectItem>
                    {stateFilterOptions.map((s) => <SelectItem key={s} value={s} className="text-xs">{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Tag</Label>
                <Select value={tagFilter2} onValueChange={setTagFilter2}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="All tags" className="text-xs">All tags</SelectItem>
                    {tagFilterOptions.map((t) => <SelectItem key={t} value={t} className="text-xs">{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={hasContactsOnly} onChange={(e) => setHasContactsOnly(e.target.checked)} />
                Has contacts
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={hasOpenDealsOnly} onChange={(e) => setHasOpenDealsOnly(e.target.checked)} />
                Has open deals
              </label>
              {moreFiltersActiveCount > 0 && (
                <Button size="sm" variant="ghost" className="w-full text-xs" onClick={clearMoreFilters}>Clear all</Button>
              )}
            </PopoverContent>
          </Popover>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] text-sm">
            <thead className="bg-secondary/60 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              <tr className="border-b border-border">
                <th className="py-2.5 pl-4 pr-3 text-left">Account</th>
                <th className="py-2.5 pr-4 text-left">Type</th>
                <th className="py-2.5 pr-4 text-left">Industry</th>
                <th className="py-2.5 pr-4 text-left">Location</th>
                <th className="py-2.5 pr-4 text-left">Owner</th>
                <th className="py-2.5 pr-4 text-left">Contacts</th>
                <th className="py-2.5 pr-4 text-left">Open Deals</th>
                <th className="py-2.5 pr-4 text-left">Status</th>
                <th className="py-2.5 pr-4 text-left">Updated</th>
                <th className="w-10 py-2.5 pr-3" />
              </tr>
            </thead>
            <tbody>
              {loading &&
                Array.from({ length: 5 }).map((_, index) => (
                  <tr key={index} className="border-b border-border">
                    {Array.from({ length: 9 }).map((__, column) => (
                      <td key={column} className="py-3 pr-4">
                        <Skeleton className="h-4 w-24" />
                      </td>
                    ))}
                    <td />
                  </tr>
                ))}

              {!loading && filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={10}
                    className="py-14 text-center text-muted-foreground"
                  >
                    No accounts match the current filters.
                  </td>
                </tr>
              )}

              {!loading &&
                filtered.map((company) => (
                  <tr
                    key={company.id}
                    onClick={() => setSelected(company)}
                    className="cursor-pointer border-b border-border transition-colors hover:bg-secondary/30"
                  >
                    <td className="py-2.5 pl-4 pr-3">
                      <div className="flex items-center gap-2.5">
                        <Avatar className="h-9 w-9">
                          <AvatarImage
                            src={company.logo_url || undefined}
                            alt=""
                          />
                          <AvatarFallback className="bg-primary-soft text-xs font-semibold text-primary">
                            {initials(company.name)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {company.name}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {company.email ||
                              company.website ||
                              "No contact details"}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge
                        variant="outline"
                        className={accountTypeClass(company.account_type)}
                      >
                        {company.account_type}
                      </Badge>
                    </td>
                    <td className="py-2.5 pr-4 text-muted-foreground">
                      {company.industry || "—"}
                    </td>
                    <td className="py-2.5 pr-4 text-muted-foreground">
                      {[company.city, company.state]
                        .filter(Boolean)
                        .join(", ") || "—"}
                    </td>
                    <td className="py-2.5 pr-4 text-muted-foreground">
                      {company.owner_name || "Unassigned"}
                    </td>
                    <td className="py-2.5 pr-4 text-muted-foreground tabular-nums">
                      {contactCountByCompany.get(company.id) ?? 0}
                    </td>
                    <td className="py-2.5 pr-4 text-muted-foreground tabular-nums">
                      {(() => {
                        const deal = openDealCountByCompany.get(company.id);
                        return deal ? `${deal.count} · ${formatMoney(deal.value)}` : "—";
                      })()}
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge variant="outline">{company.status}</Badge>
                    </td>
                    <td className="py-2.5 pr-4 text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(company.updated_at), {
                        addSuffix: true,
                      })}
                    </td>
                    <td
                      className="py-2.5 pr-3"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openEdit(company)}>
                            <Pencil className="mr-2 h-4 w-4" /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => setDeleteTarget(company)}
                          >
                            <Trash2 className="mr-2 h-4 w-4" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Sheet
        open={Boolean(selected)}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          {selected && (
            <>
              <SheetHeader className="border-b border-border pb-4">
                <div className="flex items-start gap-3 pr-8">
                  <Avatar className="h-12 w-12">
                    <AvatarImage src={selected.logo_url || undefined} alt="" />
                    <AvatarFallback>{initials(selected.name)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <SheetTitle>{selected.name}</SheetTitle>
                    <div className="mt-1 flex gap-1.5">
                      <Badge
                        variant="outline"
                        className={accountTypeClass(selected.account_type)}
                      >
                        {selected.account_type}
                      </Badge>
                      <Badge variant="outline">{selected.status}</Badge>
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openEdit(selected)}
                  >
                    <Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit
                  </Button>
                  <Button asChild size="sm">
                    <Link
                      to="/accounts/$accountSlug"
                      params={{ accountSlug: selected.slug }}
                      onClick={() => setSelected(null)}
                    >
                      View Full Account
                    </Link>
                  </Button>
                </div>
                <Button variant="outline" size="sm" className="w-full" onClick={() => setScheduleOpen(true)}>
                  <CalendarPlus className="mr-1.5 h-3.5 w-3.5" /> Schedule Appointment
                </Button>
              </SheetHeader>

              <AppointmentDialog
                open={scheduleOpen}
                onOpenChange={setScheduleOpen}
                prefill={{
                  entityType: "company",
                  entityId: selected.id,
                  entityLabel: selected.name,
                  contactName: selected.name,
                  contactPhone: selected.phone || undefined,
                  contactEmail: selected.email || undefined,
                  address: [selected.address, selected.city, selected.state, selected.zip].filter(Boolean).join(", ") || undefined,
                  source: "company",
                }}
                onSaved={() => toast.success("Appointment scheduled")}
              />

              <div className="space-y-5 py-5 text-sm">
                <div className="grid grid-cols-2 gap-4 rounded-lg border p-4">
                  <Detail label="Account type" value={selected.account_type} />
                  <Detail
                    label="Owner"
                    value={selected.owner_name || "Unassigned"}
                  />
                  <Detail
                    label="Industry"
                    value={selected.industry || "Not set"}
                  />
                  <Detail label="Status" value={selected.status} />
                </div>

                {selected.email && (
                  <LinkRow
                    icon={Mail}
                    href={`mailto:${selected.email}`}
                    text={selected.email}
                  />
                )}
                {selected.phone && (
                  <LinkRow
                    icon={Phone}
                    href={`tel:${selected.phone}`}
                    text={formatPhoneInput(selected.phone)}
                  />
                )}
                {selected.website && (
                  <LinkRow
                    icon={Globe}
                    href={selected.website}
                    text={selected.website}
                    external
                  />
                )}

                {(selected.address || selected.city) && (
                  <LinkRow
                    icon={MapPin}
                    href={`https://maps.google.com/?q=${encodeURIComponent(
                      [
                        selected.address,
                        selected.city,
                        selected.state,
                        selected.zip,
                        selected.country,
                      ]
                        .filter(Boolean)
                        .join(", "),
                    )}`}
                    text={[
                      selected.address,
                      selected.city,
                      selected.state,
                      selected.zip,
                    ]
                      .filter(Boolean)
                      .join(", ")}
                    external
                  />
                )}

                {selected.tags?.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {selected.tags.map((tag) => (
                      <Badge key={tag} variant="secondary">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                )}

                {selected.notes && (
                  <p className="whitespace-pre-wrap rounded-lg border bg-secondary/20 p-3 text-muted-foreground">
                    {selected.notes}
                  </p>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <AccountFormDialog
        open={formOpen}
        company={editing}
        onClose={() => setFormOpen(false)}
        onLogoSaved={async (saved) => {
          setEditing(saved);
          setSelected((current) =>
            current?.id === saved.id ? saved : current,
          );
          await loadCompanies();
        }}
        onSaved={async (saved) => {
          setFormOpen(false);
          setSelected(saved);
          await loadCompanies();
        }}
      />

      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent>
          {deleteChecking ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              Checking linked records…
            </div>
          ) : deleteBlockingRecords.length > 0 ? (
            <>
              <DialogHeader>
                <DialogTitle>Can't delete {deleteTarget?.name}</DialogTitle>
                <DialogDescription>
                  This account is still linked to {deleteBlockingRecords.map((r) => `${r.count} ${r.label}${r.count === 1 ? "" : "s"}`).join(", ")}.
                  Reassign or remove those records first — deleting an account never removes its linked contacts,
                  deals, projects, estimates, or invoices, so this is blocked rather than allowed to fail partway.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDeleteTarget(null)}>Close</Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Delete account?</DialogTitle>
                <DialogDescription>
                  This deletes {deleteTarget?.name}. Linked contacts remain in
                  Contacts.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDeleteTarget(null)}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={() => void deleteCompany()}>
                  Delete Account
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function AccountFormDialog({
  open,
  company,
  onClose,
  onLogoSaved,
  onSaved,
}: {
  open: boolean;
  company: Company | null;
  onClose: () => void;
  onLogoSaved: (company: Company) => void | Promise<void>;
  onSaved: (company: Company) => void;
}) {
  const [form, setForm] = useState<CompanyForm>(EMPTY_FORM);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [selectedLogoFile, setSelectedLogoFile] = useState<File | null>(null);
  const [logoPreviewUrl, setLogoPreviewUrl] = useState("");
  const [newTag, setNewTag] = useState("");
  const [duplicates, setDuplicates] = useState<CompanyDuplicateCandidate[] | null>(null);
  const [duplicatesCheckedFor, setDuplicatesCheckedFor] = useState<string | null>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const update = <K extends keyof CompanyForm>(
    key: K,
    value: CompanyForm[K],
  ) => {
    setForm((current) => ({ ...current, [key]: value }));
    // Any edit invalidates a previous duplicate warning — a stale
    // acknowledgment can't silently apply to different name/website values.
    setDuplicates(null);
    setDuplicatesCheckedFor(null);
  };

  useEffect(() => {
    setForm(company ? companyToForm(company) : EMPTY_FORM);
    setSelectedLogoFile(null);
    setLogoPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return "";
    });
    setNewTag("");
    setDuplicates(null);
    setDuplicatesCheckedFor(null);
  }, [company, open]);

  useEffect(() => {
    return () => {
      if (logoPreviewUrl) URL.revokeObjectURL(logoPreviewUrl);
    };
  }, [logoPreviewUrl]);

  useEffect(() => {
    if (!open) return;

    void (async () => {
      const orgId = await getOrgId();
      if (!orgId) return;

      const [{ data: profiles }, { data: contactRows }] = await Promise.all([
        supabase
          .from("profiles")
          .select("id, first_name, last_name, email")
          .eq("organization_id", orgId)
          .order("first_name"),
        supabase
          .from("contacts")
          .select("id, full_name, email, phone")
          .eq("org_id", orgId)
          .order("full_name"),
      ]);

      setTeamMembers(
        (profiles ?? []).map((profile: any) => ({
          id: profile.id,
          name:
            [profile.first_name, profile.last_name].filter(Boolean).join(" ") ||
            profile.email ||
            "Unnamed user",
          email: profile.email ?? null,
        })),
      );

      setContacts((contactRows ?? []) as ContactOption[]);
    })();
  }, [open]);

  const toggleTag = (tag: string) => {
    update(
      "tags",
      form.tags.includes(tag)
        ? form.tags.filter((existing) => existing !== tag)
        : [...form.tags, tag],
    );
  };

  const addCustomTag = () => {
    const value = newTag.trim();
    if (!value) return;
    if (!form.tags.includes(value)) update("tags", [...form.tags, value]);
    setNewTag("");
  };

  const handleLogoUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast.error("Choose an image file.");
      return;
    }

    if (file.size > 3 * 1024 * 1024) {
      toast.error("Logo must be smaller than 3 MB.");
      return;
    }

    const previewUrl = URL.createObjectURL(file);
    setLogoPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return previewUrl;
    });

    // A new account does not have a company ID yet, so keep the file until
    // Create Account is clicked. Existing accounts can save immediately.
    if (!company) {
      setSelectedLogoFile(file);
      toast.success("Logo selected. Create the account to save it.");
      return;
    }

    try {
      const orgId = await getOrgId();
      if (!orgId) throw new Error("Could not determine workspace.");

      const updatedCompany = await uploadAndPersistCompanyLogo({
        orgId,
        companyId: company.id,
        file,
      });

      setSelectedLogoFile(null);
      setForm((current) => ({
        ...current,
        logo_url: updatedCompany.logo_url ?? "",
      }));
      setLogoPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return "";
      });

      await onLogoSaved(updatedCompany);
      toast.success("Logo uploaded and saved.");
    } catch (error) {
      console.error("[account-logo]", error);
      setLogoPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return "";
      });
      toast.error(
        error instanceof Error ? error.message : "Could not save the logo.",
      );
    }
  };

  const uploadAndPersistCompanyLogo = async ({
    orgId,
    companyId,
    file,
  }: {
    orgId: string;
    companyId: string;
    file: File;
  }): Promise<Company> => {
    setUploadingLogo(true);

    const extension =
      file.name
        .split(".")
        .pop()
        ?.toLowerCase()
        .replace(/[^a-z0-9]/g, "") ||
      file.type.split("/").pop()?.toLowerCase() ||
      "png";
    const storagePath = `${orgId}/${companyId}/logo-${Date.now()}-${crypto.randomUUID()}.${extension}`;

    try {
      const { error: uploadError } = await supabase.storage
        .from("account-logos")
        .upload(storagePath, file, {
          cacheControl: "3600",
          contentType: file.type,
          upsert: false,
        });

      if (uploadError) throw uploadError;

      const { data: publicUrlData } = supabase.storage
        .from("account-logos")
        .getPublicUrl(storagePath);

      const publicUrl = publicUrlData.publicUrl;
      if (!publicUrl) {
        await supabase.storage.from("account-logos").remove([storagePath]);
        throw new Error("Supabase did not return a public logo URL.");
      }

      const { data: updatedCompany, error: updateError } = await supabase
        .from("companies")
        .update({
          logo_url: publicUrl,
          updated_at: new Date().toISOString(),
        })
        .eq("id", companyId)
        .eq("org_id", orgId)
        .select("*")
        .single();

      if (updateError) {
        await supabase.storage.from("account-logos").remove([storagePath]);
        throw updateError;
      }

      if (!updatedCompany?.logo_url) {
        await supabase.storage.from("account-logos").remove([storagePath]);
        throw new Error(
          "The logo uploaded, but companies.logo_url was not updated.",
        );
      }

      // Store consolidation (Phase 9.4 consistency pass) — this upload
      // flow is left as its own direct query (it's coupled to a storage
      // upload + rollback-on-failure, not plain CRUD duplication, so
      // routing it through updateCompany() wouldn't simplify anything),
      // but the reactive cache is still kept in sync immediately rather
      // than waiting on the caller's full loadCompanies() refetch.
      upsertCompanyLocal(updatedCompany as unknown as StoreCompany);
      return updatedCompany as Company;
    } finally {
      setUploadingLogo(false);
    }
  };

  const createOrLinkPrimaryContact = async (
    orgId: string,
    companyId: string,
  ): Promise<void> => {
    if (form.primary_contact_mode === "none") return;

    let contactId = form.existing_contact_id;

    if (form.primary_contact_mode === "new") {
      if (!form.contact_name.trim()) {
        throw new Error("Primary contact name is required.");
      }

      const { data: createdContact, error: contactError } = await supabase
        .from("contacts")
        .insert({
          org_id: orgId,
          full_name: form.contact_name.trim(),
          email: form.contact_email.trim() || null,
          phone: form.contact_phone.replace(/\D/g, "") || null,
          company: form.name.trim(),
          source: "account",
          labels: [],
        })
        .select("id")
        .single();

      if (contactError) throw contactError;
      contactId = createdContact.id;
    }

    if (!contactId) return;

    await supabase
      .from("company_contacts")
      .update({ is_primary: false })
      .eq("company_id", companyId)
      .eq("org_id", orgId);

    const { error: linkError } = await supabase.from("company_contacts").upsert(
      {
        org_id: orgId,
        company_id: companyId,
        contact_id: contactId,
        relationship_title: form.contact_title.trim() || null,
        is_primary: true,
      },
      { onConflict: "company_id,contact_id" },
    );

    if (linkError) throw linkError;
  };

  const save = async () => {
    if (!form.name.trim()) {
      toast.error("Account name is required.");
      return;
    }

    // Duplicate-company warning (Priority 18 / Phase 9.4 consistency pass)
    // — exact normalized-name or website-domain match only, organization-
    // scoped, on BOTH create and edit. On edit, the company itself is
    // excluded from candidates, so keeping its own existing name/domain
    // never warns — only editing INTO another company's values does. Never
    // blocks outright — proceeds once acknowledged by clicking Save again.
    {
      const checkKey = `${form.name.trim().toLowerCase()}|${form.website.trim().toLowerCase()}`;
      if (!(duplicates && duplicates.length > 0 && duplicatesCheckedFor === checkKey)) {
        const candidates = findCompanyDuplicateCandidates(form.name, form.website, company?.id);
        if (candidates.length > 0) {
          setDuplicates(candidates);
          setDuplicatesCheckedFor(checkKey);
          return;
        }
        setDuplicates([]);
        setDuplicatesCheckedFor(checkKey);
      }
    }

    setSaving(true);
    try {
      const orgId = await getOrgId();
      if (!orgId) throw new Error("Could not determine workspace.");

      let savedCompany: Company;

      // Routed through the canonical companies-store (addCompany/
      // updateCompany) rather than a second, independent
      // supabase.from("companies") write path — QA pass fix (Phase 9.4's
      // store was intended as the single source of truth for writes, but
      // this dialog had its own raw insert/update since before the store
      // existed and was never migrated over).
      if (company) {
        const updatePayload: Partial<StoreCompany> = {
          ...companyPayload(form),
          // Backfill a slug for a legacy row that predates the slug
          // column being required — new rows always already have one.
          ...(!company.slug
            ? { slug: await createUniqueAccountSlug(orgId, form.name.trim()) }
            : {}),
        };

        const updated = await storeUpdateCompany(company.id, updatePayload);
        if (!updated) throw new Error("Could not save the account.");
        savedCompany = updated as unknown as Company;
      } else {
        const created = await storeAddCompany(companyPayload(form));
        if (!created) throw new Error("Could not save the account.");
        savedCompany = created as unknown as Company;
      }

      if (selectedLogoFile) {
        savedCompany = await uploadAndPersistCompanyLogo({
          orgId,
          companyId: savedCompany.id,
          file: selectedLogoFile,
        });
      }

      await createOrLinkPrimaryContact(orgId, savedCompany.id);

      setSelectedLogoFile(null);
      setLogoPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return "";
      });

      toast.success(company ? "Account updated." : "Account created.");
      onSaved(savedCompany);
    } catch (error) {
      console.error("[account-save]", error);
      toast.error(
        error instanceof Error ? error.message : "Could not save the account.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{company ? "Edit Account" : "Add Account"}</DialogTitle>
          <DialogDescription>
            Accounts are commercial customers, prospects, vendors, partners,
            builders, and other organizations.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-2">
          <section className="flex flex-col gap-4 rounded-lg border p-4 sm:flex-row sm:items-center">
            <Avatar className="h-20 w-20 rounded-xl">
              <AvatarImage
                src={logoPreviewUrl || form.logo_url || undefined}
                alt=""
                className="object-cover"
              />
              <AvatarFallback className="rounded-xl text-lg">
                {form.name ? (
                  initials(form.name)
                ) : (
                  <Building2 className="h-7 w-7" />
                )}
              </AvatarFallback>
            </Avatar>

            <div className="flex-1">
              <h3 className="font-medium">Account logo</h3>
              <p className="mb-3 text-xs text-muted-foreground">
                PNG, JPG, or WebP. Maximum 3 MB.
              </p>
              <div className="flex flex-wrap gap-2">
                <input
                  ref={logoInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(event) => void handleLogoUpload(event)}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={uploadingLogo}
                  onClick={() => logoInputRef.current?.click()}
                >
                  {uploadingLogo ? (
                    "Uploading…"
                  ) : (
                    <>
                      <Upload className="mr-1.5 h-3.5 w-3.5" /> Upload Logo
                    </>
                  )}
                </Button>
                {(logoPreviewUrl || form.logo_url) && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSelectedLogoFile(null);
                      setLogoPreviewUrl((current) => {
                        if (current) URL.revokeObjectURL(current);
                        return "";
                      });
                      update("logo_url", "");
                    }}
                  >
                    <X className="mr-1.5 h-3.5 w-3.5" /> Remove
                  </Button>
                )}
              </div>
            </div>
          </section>

          <section>
            <SectionTitle>Account information</SectionTitle>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Account name *" className="md:col-span-2">
                <Input
                  value={form.name}
                  onChange={(event) => update("name", event.target.value)}
                  placeholder="ABC Property Management"
                />
              </Field>

              <Field label="Account type">
                <Select
                  value={form.account_type}
                  onValueChange={(value) =>
                    update("account_type", value as AccountType)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACCOUNT_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Status">
                <Select
                  value={form.status}
                  onValueChange={(value) =>
                    update("status", value as AccountStatus)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACCOUNT_STATUSES.map((status) => (
                      <SelectItem key={status} value={status}>
                        {status}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Industry">
                <Select
                  value={form.industry || undefined}
                  onValueChange={(value) => update("industry", value)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select industry" />
                  </SelectTrigger>
                  <SelectContent>
                    {INDUSTRIES.map((industry) => (
                      <SelectItem key={industry} value={industry}>
                        {industry}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Owner">
                <Select
                  value={form.owner_name || "__unassigned__"}
                  onValueChange={(value) =>
                    update(
                      "owner_name",
                      value === "__unassigned__" ? "" : value,
                    )
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__unassigned__">Unassigned</SelectItem>
                    {teamMembers.map((member) => (
                      <SelectItem key={member.id} value={member.name}>
                        {member.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Email">
                <Input
                  type="email"
                  value={form.email}
                  onChange={(event) => update("email", event.target.value)}
                  placeholder="info@company.com"
                />
              </Field>

              <Field label="Phone">
                <Input
                  inputMode="tel"
                  value={form.phone}
                  onChange={(event) =>
                    update("phone", formatPhoneInput(event.target.value))
                  }
                  placeholder="(555) 123-4567"
                />
              </Field>

              <Field label="Website" className="md:col-span-2">
                <Input
                  value={form.website}
                  onChange={(event) =>
                    update(
                      "website",
                      ensureHttpsWhileTyping(event.target.value),
                    )
                  }
                  placeholder="https://company.com"
                />
              </Field>
            </div>
          </section>

          <section>
            <SectionTitle>Address</SectionTitle>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Street address" className="md:col-span-2">
                <AddressAutocomplete
                  value={form.address}
                  onChange={(value) => update("address", value)}
                  onSelect={(parts) =>
                    setForm((current) => ({
                      ...current,
                      address: parts.street,
                      city: parts.city,
                      state: parts.state,
                      zip: parts.zip,
                      country: "United States",
                    }))
                  }
                  placeholder="Start typing an address"
                />
              </Field>

              <Field label="City">
                <Input
                  value={form.city}
                  onChange={(event) => update("city", event.target.value)}
                />
              </Field>
              <Field label="State">
                <Input
                  value={form.state}
                  onChange={(event) => update("state", event.target.value)}
                />
              </Field>
              <Field label="ZIP">
                <Input
                  value={form.zip}
                  onChange={(event) => update("zip", event.target.value)}
                />
              </Field>
              <Field label="Country">
                <Input
                  value={form.country}
                  onChange={(event) => update("country", event.target.value)}
                />
              </Field>
            </div>
          </section>

          <section>
            <SectionTitle>Tags</SectionTitle>
            <div className="space-y-3">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full justify-between"
                  >
                    <span>
                      {form.tags.length
                        ? `${form.tags.length} tag${form.tags.length === 1 ? "" : "s"} selected`
                        : "Select tags"}
                    </span>
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-[var(--radix-dropdown-menu-trigger-width)]">
                  <DropdownMenuLabel>Account tags</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {DEFAULT_TAGS.map((tag) => (
                    <DropdownMenuCheckboxItem
                      key={tag}
                      checked={form.tags.includes(tag)}
                      onCheckedChange={() => toggleTag(tag)}
                      onSelect={(event) => event.preventDefault()}
                    >
                      {tag}
                    </DropdownMenuCheckboxItem>
                  ))}
                  <DropdownMenuSeparator />
                  <div className="flex gap-2 p-2">
                    <Input
                      value={newTag}
                      onChange={(event) => setNewTag(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addCustomTag();
                        }
                      }}
                      placeholder="Create tag"
                      className="h-8"
                    />
                    <Button
                      type="button"
                      size="sm"
                      className="h-8"
                      onClick={addCustomTag}
                    >
                      Add
                    </Button>
                  </div>
                </DropdownMenuContent>
              </DropdownMenu>

              {form.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {form.tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="gap-1">
                      {tag}
                      <button
                        type="button"
                        onClick={() => toggleTag(tag)}
                        aria-label={`Remove ${tag}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section>
            <SectionTitle>Primary contact</SectionTitle>
            <div className="space-y-4 rounded-lg border p-4">
              <Select
                value={form.primary_contact_mode}
                onValueChange={(value) =>
                  update("primary_contact_mode", value as PrimaryContactMode)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No primary contact</SelectItem>
                  <SelectItem value="existing">
                    Select an existing contact
                  </SelectItem>
                  <SelectItem value="new">Create a new contact</SelectItem>
                </SelectContent>
              </Select>

              {form.primary_contact_mode === "existing" && (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Field label="Contact">
                    <Select
                      value={form.existing_contact_id || undefined}
                      onValueChange={(value) =>
                        update("existing_contact_id", value)
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select contact" />
                      </SelectTrigger>
                      <SelectContent>
                        {contacts.map((contact) => (
                          <SelectItem key={contact.id} value={contact.id}>
                            {contact.full_name}
                            {contact.email ? ` — ${contact.email}` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Title / relationship">
                    <Input
                      value={form.contact_title}
                      onChange={(event) =>
                        update("contact_title", event.target.value)
                      }
                      placeholder="Property Manager"
                    />
                  </Field>
                </div>
              )}

              {form.primary_contact_mode === "new" && (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Field label="Contact name *" className="md:col-span-2">
                    <Input
                      value={form.contact_name}
                      onChange={(event) =>
                        update("contact_name", event.target.value)
                      }
                      placeholder="John Smith"
                    />
                  </Field>
                  <Field label="Title">
                    <Input
                      value={form.contact_title}
                      onChange={(event) =>
                        update("contact_title", event.target.value)
                      }
                      placeholder="Property Manager"
                    />
                  </Field>
                  <Field label="Email">
                    <Input
                      type="email"
                      value={form.contact_email}
                      onChange={(event) =>
                        update("contact_email", event.target.value)
                      }
                      placeholder="john@company.com"
                    />
                  </Field>
                  <Field label="Phone">
                    <Input
                      inputMode="tel"
                      value={form.contact_phone}
                      onChange={(event) =>
                        update(
                          "contact_phone",
                          formatPhoneInput(event.target.value),
                        )
                      }
                      placeholder="(555) 123-4567"
                    />
                  </Field>
                </div>
              )}
            </div>
          </section>

          <section>
            <SectionTitle>Notes</SectionTitle>
            <Textarea
              value={form.notes}
              onChange={(event) => update("notes", event.target.value)}
              rows={4}
              placeholder="Internal account notes…"
            />
          </section>

          {duplicates && duplicates.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/30">
              <div className="flex items-center gap-1.5 font-medium text-amber-800 dark:text-amber-400">
                Possible duplicate account{duplicates.length === 1 ? "" : "s"} found
              </div>
              <ul className="mt-1.5 space-y-1">
                {duplicates.map((d) => (
                  <li key={d.id} className="text-xs text-amber-900 dark:text-amber-300">
                    {d.name} — matched by {d.matchedOn === "name" ? "name" : "website"}
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-500">
                {company
                  ? 'Click "Save anyway" to keep these values regardless.'
                  : 'Click "Create anyway" to create this as a new, separate account.'}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() => void save()}
            disabled={saving || uploadingLogo}
          >
            {saving
              ? "Saving…"
              : duplicates && duplicates.length > 0
                ? company ? "Save anyway" : "Create anyway"
                : company ? "Save Changes" : "Create Account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  );
}

function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`space-y-1.5 ${className}`}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div>{value}</div>
    </div>
  );
}

function LinkRow({
  icon: Icon,
  href,
  text,
  external = false,
}: {
  icon: typeof Mail;
  href: string;
  text: string;
  external?: boolean;
}) {
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      className="flex items-start gap-2 text-muted-foreground hover:text-foreground"
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="break-all">{text}</span>
    </a>
  );
}