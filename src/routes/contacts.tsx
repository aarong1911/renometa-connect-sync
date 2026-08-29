// src/routes/contacts.tsx

import { createFileRoute, useNavigate, useSearch, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ContactAvatar } from "@/components/ui/contact-avatar";
import { AvatarPicker } from "@/components/ui/avatar-picker";
import { MetricCard } from "@/components/ui/metric-card";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator,
  DropdownMenuCheckboxItem, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Plus, Search, SlidersHorizontal, Mail, Phone, MoreHorizontal, Download, Upload,
  Users, UserPlus, Star, Activity, CalendarClock, Loader2, Pencil, Trash2, Save, X,
  GitMerge, CheckCircle2, AlertTriangle, ArrowRight, Briefcase, FileText as FileTextIcon,
  Building2, ExternalLink, MessageCircle, CalendarPlus,
} from "lucide-react";
import {
  Mail as MailIcon, Phone as PhoneIcon, MessageSquare, FileText, StickyNote,
} from "lucide-react";
import { type Contact } from "@/lib/mock-data";
import {
  useContacts, updateContact, deleteContact, refreshContacts, getOrgId, addContact,
} from "@/lib/contacts-store";
import { NewContactDialog } from "@/components/contacts/new-contact-dialog";
import { ContactRelatedTab } from "@/components/contacts/contact-related-tab";
import { CommunicationTab } from "@/components/contacts/communication-tab";
import { CommunicationPreferencesSection } from "@/components/contacts/communication-preferences-section";
import { useContactNotes, type ContactNote } from "@/lib/contact-notes";
import {
  normalizeTags, buildCanonicalTagOptions, contactHasCanonicalTag,
  tagColorClasses, tagComparisonKey, assignTagColors, type TagColorClasses,
} from "@/lib/tag-utils";
import { TagPicker } from "@/components/contacts/tag-picker";
import { contactSourceLabel, contactSourceComparisonKey } from "@/lib/lead-source";
import { normalizeEmail, normalizePhoneForComparison, findDuplicateContactCandidates, type ContactDuplicateCandidate } from "@/lib/identity-normalization";
import { useCompanies } from "@/lib/companies-store";
import { refreshDeals } from "@/lib/deals-store";
import { AddressAutocomplete } from "@/components/ui/address-autocomplete";
import { formatPhone } from "@/lib/format";
import { useContactActivity } from "@/lib/contact-activity";
import { formatDistanceToNow } from "date-fns";
import { formatMoney, formatDateShort } from "@/lib/format";
import {
  contactsToCSV, downloadCSV, parseCSVPreview, autoMapHeaders, applyMappingToContacts,
  CONTACT_FIELDS, splitTags, detectTagDelimiter, detectTagDelimiterWithConfidence,
  type ContactColumnMapping, type ContactFieldKey, type ContactTemplateType, type TagDelimiter,
} from "@/lib/contacts-csv";
import { CSV_MAX_SYNC_IMPORT_ROWS, CSV_WARN_ROW_THRESHOLD } from "@/lib/csv-utils";
import { createImportJob, logImportRows, completeImportJob, prefetchContactIdentitySets } from "@/lib/import-jobs-store";
import { ImportHistoryDialog } from "@/components/crm/import-history-dialog";
import { AppointmentDialog } from "@/components/calendar/appointment-dialog";
import { History } from "lucide-react";
import { ensureCompanyContactAssociation } from "@/lib/companies-store";
import { toast } from "sonner";
import React from "react";

export type CompanyOption = { id: string; name: string; slug: string };

// ── Phone formatter ──────────────────────────────────────────────────────────
function displayPhone(raw: string): string {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits[0] === "1") return `${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  return raw;
}


// ── Outline-only tag colors ──────────────────────────────────────────────────
// Keep each tag's deterministic border/text color while removing every
// background-color utility, including hover/dark/state variants. This local
// adapter also affects TagPicker options because the page passes colorForTag
// into that shared component.
function outlineOnlyTagColors(colors: TagColorClasses): TagColorClasses {
  const withoutBackground = (className: string): string =>
    className
      .split(/\s+/)
      .filter((token) => token && !token.includes("bg-"))
      .join(" ");

  return {
    ...colors,
    chip: `${withoutBackground(colors.chip)} border bg-transparent`,
    selectedChip: `${withoutBackground(colors.selectedChip)} border bg-transparent ring-1 ring-inset`,
  };
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_CONTACT_TAGS = [
  "Architect",
  "Client",
  "Follow Up",
  "Homeowner",
  "Lead",
  "Needs Reply",
  "New Lead",
  "Past Client",
  "Prospect",
  "Vendor",
  "VIP",
] as const;


// Labels filter chips are now derived from real loaded contact data (see
// labelFilterOptions in ContactsPage) — Phase 9.3, replacing this
// previously-hardcoded fixed list per the "no hardcoded tag filter list"
// requirement.
type ContactsSearch = { contactId?: string };
const BLANK_FORM = { name: "", email: "", phone: "", address: "", company: "", companyId: "" as string | null, source: "" };

// ── Column visibility (Priority 2) — required columns (checkbox/name/row
// actions) are never in this map at all, so there's no way to hide them.
const OPTIONAL_COLUMNS = ["account", "email", "phone", "source", "tags", "owner", "created", "lastActivity"] as const;
type OptionalColumnKey = (typeof OPTIONAL_COLUMNS)[number];
type ContactColumnVisibility = Record<OptionalColumnKey, boolean>;

const DEFAULT_COLUMN_VISIBILITY: ContactColumnVisibility = {
  account: true, email: true, phone: true, source: false, tags: true, owner: true, created: false, lastActivity: true,
};

const CONTACTS_COLUMNS_STORAGE_KEY = "renometa.contacts.columns.v1";

function loadColumnPrefs(): ContactColumnVisibility {
  if (typeof window === "undefined") return DEFAULT_COLUMN_VISIBILITY;
  try {
    const raw = window.localStorage.getItem(CONTACTS_COLUMNS_STORAGE_KEY);
    if (!raw) return DEFAULT_COLUMN_VISIBILITY;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_COLUMN_VISIBILITY;
    // Merge over defaults rather than trusting stored shape outright — a
    // stale/partial/corrupted value falls back to sensible defaults per
    // key instead of breaking the whole table.
    const merged = { ...DEFAULT_COLUMN_VISIBILITY };
    for (const key of OPTIONAL_COLUMNS) {
      if (typeof parsed[key] === "boolean") merged[key] = parsed[key];
    }
    return merged;
  } catch {
    return DEFAULT_COLUMN_VISIBILITY;
  }
}

function saveColumnPrefs(prefs: ContactColumnVisibility): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CONTACTS_COLUMNS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Best-effort — a full/blocked localStorage never breaks the table.
  }
}

const COLUMN_LABELS: Record<OptionalColumnKey, string> = {
  account: "Account", email: "Email", phone: "Phone", source: "Source",
  tags: "Tags", owner: "Owner", created: "Created", lastActivity: "Last Activity",
};

// Linked-record check before allowing a contact delete (Priority 10) — a
// contact still referenced by real business records is never silently
// hard-deleted; the UI blocks the destructive action entirely rather than
// letting the delete fail with a raw FK error (or worse, partially cascade
// on tables that do allow it). Organization-scoped via each table's own
// org_id column, matching how every other query in this file is scoped.
export async function countLinkedRecords(contactId: string, orgId: string): Promise<{ label: string; count: number }[]> {
  const [deals, projects, estimates, appointments, invoices, leads] = await Promise.all([
    supabase.from("deals").select("id", { count: "exact", head: true }).eq("contact_id", contactId).eq("org_id", orgId),
    supabase.from("projects").select("id", { count: "exact", head: true }).eq("client_id", contactId).eq("org_id", orgId),
    supabase.from("estimates").select("id", { count: "exact", head: true }).eq("client_id", contactId).eq("org_id", orgId),
    supabase.from("appointments").select("id", { count: "exact", head: true }).eq("contact_id", contactId).eq("org_id", orgId),
    supabase.from("invoices").select("id", { count: "exact", head: true }).eq("client_id", contactId).eq("org_id", orgId),
    supabase.from("leads").select("id", { count: "exact", head: true }).eq("contact_id", contactId).eq("org_id", orgId),
  ]);
  return [
    { label: "deal", count: deals.count ?? 0 },
    { label: "project", count: projects.count ?? 0 },
    { label: "estimate", count: estimates.count ?? 0 },
    { label: "appointment", count: appointments.count ?? 0 },
    { label: "invoice", count: invoices.count ?? 0 },
    { label: "lead", count: leads.count ?? 0 },
  ].filter((r) => r.count > 0);
}

// ── Route ────────────────────────────────────────────────────────────────────
export const Route = createFileRoute("/contacts")({
  validateSearch: (raw: Record<string, unknown>): ContactsSearch => ({
    contactId: typeof raw.contactId === "string" ? raw.contactId : undefined,
  }),
  component: ContactsPage,
});

// ── Main page ────────────────────────────────────────────────────────────────
function ContactsPage() {
  const { contactId } = useSearch({ from: "/contacts" });
  const navigate = useNavigate({ from: "/contacts" });

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState<string>("All");
  const [selected, setSelected] = useState<Contact | null>(null);

  // "More filters" — account, source, created date range, has-email,
  // has-phone. Kept in a popover rather than the always-visible row so the
  // current filter-bar layout doesn't change.
  const [companyFilter, setCompanyFilter] = useState<string>("All accounts");
  const [sourceFilter, setSourceFilter] = useState<string>("All sources");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [hasEmailOnly, setHasEmailOnly] = useState(false);
  const [hasPhoneOnly, setHasPhoneOnly] = useState(false);
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);

  // Row selection + bulk actions (Priority 4 — restored, reusing the
  // Leads-page selectedIds/toolbar pattern rather than a second competing
  // selection system).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkActionLoading, setBulkActionLoading] = useState(false);
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);

  // Pagination (Priority 6) — client-side only, 10 per page.
  const CONTACTS_PAGE_SIZE = 10;
  const [currentPage, setCurrentPage] = useState(1);

  // Column visibility (Priority 2) — session + localStorage-persisted UI
  // preference, scoped specifically to the Contacts table. Never affects
  // database data, only which <td>s render.
  const [visibleColumns, setVisibleColumns] = useState<ContactColumnVisibility>(loadColumnPrefs);

  // new contact
  const [newOpen, setNewOpen] = useState(false);

  // delete
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteLinkedRecords, setDeleteLinkedRecords] = useState<{ label: string; count: number }[] | null>(null);
  const [deleteChecking, setDeleteChecking] = useState(false);

  // csv import
  const [mapOpen, setMapOpen] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [csvRaw, setCsvRaw] = useState("");
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvPreview, setCsvPreview] = useState<string[][]>([]);
  const [csvTotalRows, setCsvTotalRows] = useState(0);
  const [colMapping, setColMapping] = useState<ContactColumnMapping | null>(null);
  const [templateType, setTemplateType] = useState<ContactTemplateType>("contact");
  const [importFilename, setImportFilename] = useState("contacts.csv");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [tagDelimiter, setTagDelimiter] = useState<TagDelimiter>("auto");

  // find duplicates
  const [dupeOpen, setDupeOpen] = useState(false);

  // Companies (Priority 2, Phase 9.3) — now reads from the canonical
  // companies-store (Phase 9.4) instead of this page's own ad hoc fetch.
  const storeCompanies = useCompanies();
  const companies: CompanyOption[] = storeCompanies.map((c) => ({ id: c.id, name: c.name, slug: c.slug }));

  const contacts = useContacts();

  // Debounced search (Priority 11) — same 250ms interval used elsewhere in this app.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Persist column preferences (Priority 2) — UI preference only, scoped to
  // its own localStorage key; never touches contact data.
  useEffect(() => {
    saveColumnPrefs(visibleColumns);
  }, [visibleColumns]);

  // Reset to page 1 whenever search/filters change (Priority 6).
  useEffect(() => {
    setCurrentPage(1);
  }, [search, tagFilter, companyFilter, sourceFilter, dateFrom, dateTo, hasEmailOnly, hasPhoneOnly]);

  useEffect(() => {
    if (!contacts) return;

    if (!contactId) {
      setSelected(null);
      return;
    }

    // Keep the open drawer synchronized with the latest contact object from
    // the contacts store. Comparing only the id left the drawer holding a
    // stale object after tags or other fields changed on the same contact,
    // so the table updated while the drawer did not.
    const found = contacts.find((c) => c.id === contactId) ?? null;
    setSelected(found);
  }, [contactId, contacts]);

  const stats = useMemo(() => {
    if (!contacts) return { total: 0, newThisMonth: 0, vip: 0, activeWeek: 0 };
    const now = Date.now();
    const month = 30 * 86_400_000;
    const week = 7 * 86_400_000;
    return {
      total: contacts.length,
      newThisMonth: contacts.filter((c) => now - new Date(c.createdAt).getTime() < month).length,
      vip: contacts.filter((c) => c.tags.some((t) => /vip/i.test(t))).length,
      activeWeek: contacts.filter((c) => now - new Date(c.lastActivity).getTime() < week).length,
    };
  }, [contacts]);

  // Labels/company/source filter options derived from real loaded contact
  // data (Priority 4 / Priority 11) — no hardcoded category lists.
  //
  // Tag options are canonicalized (one chip per comparison key — see
  // tag-utils.ts) so case/separator variants like "lead"/"Lead" or
  // "vip"/"VIP" or "new_lead"/"New Lead" collapse into a single chip
  // instead of showing once per raw stored spelling.
  const labelFilterOptions = useMemo(() => {
    // Standard contact tags are always available, even when no current
    // contact uses them yet. Real/custom tags from loaded contacts are
    // merged in and canonicalized so variants such as "vip"/"VIP" or
    // "new_lead"/"New Lead" still appear only once.
    const seedContacts = DEFAULT_CONTACT_TAGS.map((tag, index) => ({
      id: `default-tag-${index}`,
      tags: [tag],
    })) as Pick<Contact, "id" | "tags">[];

    return buildCanonicalTagOptions([
      ...seedContacts,
      ...(contacts ?? []),
    ] as Contact[]);
  }, [contacts]);

  // One color assignment for the full canonical tag universe currently
  // loaded — computed once here and reused everywhere a tag renders
  // (filter chips, table cells, drawer, tag picker dropdowns, bulk tag
  // dropdowns) so the same canonical tag is always the same color on this
  // page, and colors are distributed by sorted position rather than raw
  // hash (tag-utils.ts's assignTagColors) to avoid look-alike neighbors.
  const tagColorMap = useMemo(
    () => assignTagColors(labelFilterOptions.map((t) => t.key)),
    [labelFilterOptions],
  );
  const colorForTag = (key: string): TagColorClasses =>
    outlineOnlyTagColors(tagColorMap.get(key) ?? tagColorClasses(key));

  const companyFilterOptions = useMemo(() => {
    if (!contacts) return [];
    const set = new Set<string>();
    for (const c of contacts) {
      const name = c.companyName || c.company;
      if (name) set.add(name);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [contacts]);

  // Source filter options (Priority 7) — deduplicated by readable label, not
  // raw stored value, so "advertising"/"marketing" or "cold_call"/
  // "cold-call" appear once each as "Marketing"/"Cold Call" instead of as
  // separate options. Selecting the resulting label matches every raw
  // variant that maps to it (see the filter predicate below).
  const sourceFilterOptions = useMemo(() => {
    if (!contacts) return [];
    const labels = new Map<string, string>(); // comparison key → display label
    for (const c of contacts) {
      if (!c.source) continue;
      const key = contactSourceComparisonKey(c.source);
      if (!labels.has(key)) labels.set(key, contactSourceLabel(c.source));
    }
    return [...labels.values()].sort((a, b) => a.localeCompare(b));
  }, [contacts]);

  const moreFiltersActiveCount = [
    companyFilter !== "All accounts",
    sourceFilter !== "All sources",
    !!dateFrom,
    !!dateTo,
    hasEmailOnly,
    hasPhoneOnly,
  ].filter(Boolean).length;

  const filtered = useMemo(() => {
    if (!contacts) return [];
    // Normalized so a formatted or unformatted phone/email still matches
    // (Priority 11), in addition to a plain substring match on every field.
    const q = search.toLowerCase().trim();
    const qEmail = normalizeEmail(q);
    const qDigits = normalizePhoneForComparison(q);
    return contacts.filter((c) => {
      if (tagFilter !== "All" && !contactHasCanonicalTag(c.tags, tagFilter)) return false;
      if (companyFilter !== "All accounts" && (c.companyName || c.company) !== companyFilter) return false;
      if (sourceFilter !== "All sources" && contactSourceLabel(c.source) !== sourceFilter) return false;
      if (hasEmailOnly && !c.email) return false;
      if (hasPhoneOnly && !c.phone) return false;
      if (dateFrom && new Date(c.createdAt) < new Date(dateFrom)) return false;
      if (dateTo) {
        const to = new Date(dateTo);
        to.setHours(23, 59, 59, 999);
        if (new Date(c.createdAt) > to) return false;
      }
      if (!q) return true;
      const phoneDigits = c.phone.replace(/\D/g, "");
      return (
        c.name.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q) ||
        (qEmail && normalizeEmail(c.email).includes(qEmail)) ||
        c.phone.includes(q) ||
        (qDigits && phoneDigits.includes(qDigits)) ||
        (c.address ?? "").toLowerCase().includes(q) ||
        (c.source ?? "").toLowerCase().includes(q) ||
        c.company.toLowerCase().includes(q) ||
        (c.companyName ?? "").toLowerCase().includes(q) ||
        c.tags.some((t) => t.toLowerCase().includes(q)) ||
        c.owner.toLowerCase().includes(q)
      );
    });
  }, [contacts, search, tagFilter, companyFilter, sourceFilter, dateFrom, dateTo, hasEmailOnly, hasPhoneOnly]);

  const clearFilters = () => {
    setSearchInput("");
    setSearch("");
    setTagFilter("All");
    setCompanyFilter("All accounts");
    setSourceFilter("All sources");
    setDateFrom("");
    setDateTo("");
    setHasEmailOnly(false);
    setHasPhoneOnly(false);
  };

  // Pagination (Priority 6) — applied after search/filters. Clamp so a
  // delete or a filter change that shrinks the result set never leaves the
  // page pointed past the end.
  const totalPages = Math.max(1, Math.ceil(filtered.length / CONTACTS_PAGE_SIZE));
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [totalPages, currentPage]);

  const paginated = useMemo(
    () => filtered.slice((currentPage - 1) * CONTACTS_PAGE_SIZE, currentPage * CONTACTS_PAGE_SIZE),
    [filtered, currentPage],
  );
  const rangeStart = filtered.length === 0 ? 0 : (currentPage - 1) * CONTACTS_PAGE_SIZE + 1;
  const rangeEnd = Math.min(currentPage * CONTACTS_PAGE_SIZE, filtered.length);

  // Row selection (Priority 4) — a Set keyed by id so selections survive a
  // page change (Set membership doesn't depend on which page is rendered).
  const toggleContactSelection = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const allPageSelected = paginated.length > 0 && paginated.every((c) => selectedIds.has(c.id));
  const toggleAllOnPage = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allPageSelected) paginated.forEach((c) => next.delete(c.id));
      else paginated.forEach((c) => next.add(c.id));
      return next;
    });
  };
  const selectedContacts = useMemo(
    () => (contacts ?? []).filter((c) => selectedIds.has(c.id)),
    [contacts, selectedIds],
  );

  // Canonical tags present anywhere in the current selection — used to
  // populate the bulk "Remove tag" dropdown so it only offers tags that
  // actually exist on at least one selected contact.
  const selectionTagOptions = useMemo(() => buildCanonicalTagOptions(selectedContacts), [selectedContacts]);

  // ── Delete contact (Priority 10 — never blindly hard-delete a contact
  // still referenced by real business records) ───────────────────────────
  useEffect(() => {
    if (!deleteTarget) { setDeleteLinkedRecords(null); return; }
    let cancelled = false;
    (async () => {
      setDeleteChecking(true);
      const orgId = await getOrgId();
      if (!orgId || cancelled) { setDeleteChecking(false); return; }
      const linked = await countLinkedRecords(deleteTarget.id, orgId);
      if (!cancelled) { setDeleteLinkedRecords(linked); setDeleteChecking(false); }
    })();
    return () => { cancelled = true; };
  }, [deleteTarget]);

  async function handleDeleteContact() {
    if (!deleteTarget) return;
    // Defense in depth — the confirmation dialog itself already hides the
    // destructive action when linked records exist (see below), but this
    // guards the handler independently rather than trusting the UI alone.
    if (deleteLinkedRecords && deleteLinkedRecords.length > 0) return;
    setDeleteLoading(true);
    await deleteContact(deleteTarget.id);
    setDeleteLoading(false);
    if (selected?.id === deleteTarget.id) {
      navigate({ search: { contactId: undefined }, replace: true });
    }
    setDeleteTarget(null);
    toast.success("Contact deleted");
  }

  // ── Export ────────────────────────────────────────────────────────────────
  // Exports the currently filtered/searched view (Stage 9.5 Priority 10 —
  // filtered/selected/all export variants), not always the full org
  // dataset regardless of active search/filters/tag chip.
  const handleExport = () => {
    if (!contacts) return;
    const csv = contactsToCSV(filtered);
    downloadCSV(csv, `contacts-${new Date().toISOString().slice(0, 10)}.csv`);
    toast.success(`Exported ${filtered.length} contact${filtered.length === 1 ? "" : "s"}`);
  };

  // ── Import: pick file ─────────────────────────────────────────────────────
  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
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
      setColMapping(autoMapHeaders(headers, templateType));
      setMapOpen(true);
    };
    reader.readAsText(file);
  };

  // ── Import: confirm (batched insert + import-job logging + company resolution) ──
  const handleConfirmImport = async () => {
    if (!colMapping) return;
    // Priority 13: pass the org-scoped company list so an exact same-org
    // name match resolves contacts.company_id instead of only ever
    // producing the legacy free-text company field.
    const { contacts: parsed, errors } = applyMappingToContacts(csvRaw, colMapping, tagDelimiter, companies);
    if (parsed.length === 0) {
      toast.error("No contacts to import", { description: errors[0] || "Check your column mapping." });
      return;
    }
    setImportLoading(true);
    try {
      const orgId = await getOrgId();
      if (!orgId) { toast.error("Not authenticated"); return; }

      // Bounded prefetch-based duplicate check (Stage 9.5) — replaces a
      // per-row query with one up-front fetch of this org's existing
      // email/phone identities, so the check runs the same way regardless
      // of file size (up to the CSV_MAX_SYNC_IMPORT_ROWS cap already
      // enforced at file-select time).
      const identitySets = await prefetchContactIdentitySets(orgId);
      const toInsert: typeof parsed = [];
      let skippedDupes = 0;
      for (const c of parsed) {
        const email = normalizeEmail(c.email);
        const phone = normalizePhoneForComparison(c.phone);
        const isDup = (email && identitySets.emails.has(email)) || (phone && identitySets.phones.has(phone));
        if (isDup) skippedDupes++; else toInsert.push(c);
      }

      let unresolvedCompanyCount = 0;
      for (const c of toInsert) {
        if (c.companyResolution === "none" || c.companyResolution === "ambiguous") unresolvedCompanyCount++;
      }

      if (toInsert.length === 0) {
        toast.warning("All contacts already exist in your database.");
        setMapOpen(false);
        return;
      }

      const jobId = await createImportJob("contact", importFilename, csvTotalRows);
      const createdIds: (string | null)[] = new Array(toInsert.length).fill(null);
      const BATCH = 75;
      let failedCount = 0;
      for (let i = 0; i < toInsert.length; i += BATCH) {
        const batch = toInsert.slice(i, i + BATCH);
        const rows = batch.map((c) => ({
          org_id: orgId,
          full_name: c.name,
          email: c.email || null,
          phone: c.phone || null,
          company_id: c.company_id || null,
          company: c.company_id ? null : (c.company || null),
          address: null,
          source: "import",
          labels: c.tags ?? [],
        }));
        const { data, error } = await supabase.from("contacts").insert(rows).select("id, company_id");
        if (error) {
          console.error("[contacts import] batch insert failed:", error);
          failedCount += batch.length;
          continue;
        }
        for (let j = 0; j < data.length; j++) {
          createdIds[i + j] = data[j].id;
          if (data[j].company_id) await ensureCompanyContactAssociation(orgId, data[j].company_id, data[j].id);
        }
      }

      const createdCount = createdIds.filter(Boolean).length;

      if (jobId) {
        const rowLogs = toInsert.map((_, i) => ({
          source_row_number: i + 2,
          entity_id: createdIds[i],
          action: createdIds[i] ? ("created" as const) : ("failed" as const),
          status: createdIds[i] ? ("ok" as const) : ("error" as const),
        }));
        await logImportRows(jobId, rowLogs);
        await completeImportJob(jobId, { created: createdCount, skipped: skippedDupes, failed: failedCount }, errors);
      }

      await refreshContacts();
      const totalSkipped = errors.length + skippedDupes;
      const parts = [`${createdCount} created`];
      if (skippedDupes > 0) parts.push(`${skippedDupes} skipped as duplicate`);
      if (failedCount > 0) parts.push(`${failedCount} failed to save`);
      if (unresolvedCompanyCount > 0) parts.push(`${unresolvedCompanyCount} company name(s) unresolved`);
      if (errors.length > 0) parts.push(`${errors.length} validation notice(s)`);
      void totalSkipped;
      toast.success(`Imported ${createdCount} contact${createdCount !== 1 ? "s" : ""}`, { description: parts.slice(1).join(" · ") || undefined });
      setMapOpen(false);
    } finally {
      setImportLoading(false);
    }
  };

  const importValidation = useMemo(() => {
    if (!colMapping || !csvRaw) return null;
    const { contacts: parsed, errors } = applyMappingToContacts(csvRaw, colMapping, tagDelimiter, companies);
    return { validCount: parsed.length, errors };
  }, [colMapping, csvRaw, tagDelimiter, companies]);

  const downloadErrorReport = () => {
    if (!importValidation) return;
    const lines = [
      "Contact Import Error Report",
      `Generated: ${new Date().toLocaleString()}`,
      `File: ${csvTotalRows} total rows, ${importValidation.validCount} valid, ${importValidation.errors.length} skipped`,
      "",
      "Row,Error",
      ...importValidation.errors.map((err) => {
        const match = err.match(/^Row (\d+): (.+)$/);
        return match ? `${match[1]},"${match[2]}"` : `,"${err}"`;
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

  // ── Bulk actions (Priority 4 — restored, reusing the Leads-page pattern:
  // one Promise.all per action across the current selection, organization
  // scoping already enforced inside updateContact/deleteContact/getOrgId,
  // never a second competing selection mechanism). ────────────────────────
  function handleExportSelected() {
    if (selectedContacts.length === 0) return;
    downloadCSV(contactsToCSV(selectedContacts), `contacts-selected-${new Date().toISOString().slice(0, 10)}.csv`);
    toast.success(`Exported ${selectedContacts.length} selected contact${selectedContacts.length === 1 ? "" : "s"}`);
  }

  async function handleBulkAddTag(rawLabel: string) {
    if (!rawLabel.trim() || selectedContacts.length === 0) return;
    setBulkActionLoading(true);
    await Promise.all(selectedContacts.map((c) =>
      updateContact(c.id, { tags: normalizeTags([...c.tags, rawLabel]) }),
    ));
    setBulkActionLoading(false);
    toast.success(`Tag added to ${selectedContacts.length} contact${selectedContacts.length === 1 ? "" : "s"}`);
  }

  async function handleBulkRemoveTag(tagKey: string) {
    if (selectedContacts.length === 0) return;
    setBulkActionLoading(true);
    await Promise.all(selectedContacts.map((c) =>
      updateContact(c.id, { tags: c.tags.filter((t) => tagComparisonKey(t) !== tagKey) }),
    ));
    setBulkActionLoading(false);
    toast.success(`Tag removed from ${selectedContacts.length} contact${selectedContacts.length === 1 ? "" : "s"}`);
  }

  async function handleBulkAssignAccount(companyId: string) {
    if (selectedContacts.length === 0) return;
    setBulkActionLoading(true);
    // updateContact already writes contacts.company_id (never legacy free
    // text) and ensures the company_contacts association per the existing
    // invariant (see contacts-store.ts) — reused as-is, not reimplemented.
    await Promise.all(selectedContacts.map((c) => updateContact(c.id, { company_id: companyId })));
    setBulkActionLoading(false);
    toast.success(`Account assigned to ${selectedContacts.length} contact${selectedContacts.length === 1 ? "" : "s"}`);
  }

  async function handleBulkClearAccount() {
    if (selectedContacts.length === 0) return;
    setBulkActionLoading(true);
    // Clears the canonical company_id only — company_contacts association
    // history rows are the full relationship log per the documented
    // invariant (companies-store.ts) and are intentionally not deleted here.
    await Promise.all(selectedContacts.map((c) => updateContact(c.id, { company_id: null })));
    setBulkActionLoading(false);
    toast.success(`Account cleared for ${selectedContacts.length} contact${selectedContacts.length === 1 ? "" : "s"}`);
  }

  async function handleBulkDelete() {
    if (selectedContacts.length === 0) return;
    setBulkActionLoading(true);
    const orgId = await getOrgId();
    let deleted = 0;
    let skipped = 0;
    let failed = 0;
    const stillSelected = new Set<string>();
    if (!orgId) {
      failed = selectedContacts.length;
      selectedContacts.forEach((c) => stillSelected.add(c.id));
    } else {
      for (const c of selectedContacts) {
        const linked = await countLinkedRecords(c.id, orgId);
        if (linked.length > 0) { skipped++; stillSelected.add(c.id); continue; }
        try {
          await deleteContact(c.id);
          deleted++;
        } catch {
          failed++;
          stillSelected.add(c.id);
        }
      }
    }
    setSelectedIds(stillSelected);
    setBulkActionLoading(false);
    setBulkDeleteConfirmOpen(false);
    const parts = [`${deleted} deleted`];
    if (skipped > 0) parts.push(`${skipped} skipped (linked to other records)`);
    if (failed > 0) parts.push(`${failed} failed`);
    toast.success("Bulk delete complete", { description: parts.join(" · ") });
  }

  return (
    <>
      <PageHeader
        icon={Users}
        iconBg="bg-info-soft"
        iconColor="text-info"
        title="Contacts"
        subtitle="People and homeowners across all your projects."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setDupeOpen(true)}>
              <GitMerge className="mr-1.5 h-3.5 w-3.5" /> Find Duplicates
            </Button>
            <Button variant="outline" size="sm" asChild>
              <label className="cursor-pointer">
                <Upload className="mr-1.5 h-3.5 w-3.5" /> Import
                <input type="file" accept=".csv" className="sr-only" onChange={handleImportFile} />
              </label>
            </Button>
            <Button variant="outline" size="sm" onClick={handleExport}>
              <Download className="mr-1.5 h-3.5 w-3.5" /> Export
            </Button>
            <Button variant="outline" size="sm" onClick={() => setHistoryOpen(true)}>
              <History className="mr-1.5 h-3.5 w-3.5" /> Import History
            </Button>
            <Button size="sm" onClick={() => setNewOpen(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" /> Add Contact
            </Button>
          </div>
        }
      />
      <ImportHistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        entityType="contact"
        contactLinkedRecordCheck={countLinkedRecords}
      />

      <div className="mb-2.5 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <MetricCard label="Total contacts" value={stats.total} sub="All-time records" icon={Users} tone="primary" />
        <MetricCard label="New this month" value={stats.newThisMonth} sub="Added in last 30 days" icon={UserPlus} tone="success" />
        <MetricCard label="VIP" value={stats.vip} sub="High-priority accounts" icon={Star} tone="warning" />
        <MetricCard label="Active this week" value={stats.activeWeek} sub="Touched in last 7 days" icon={Activity} tone="muted" />
      </div>

      <Card className="mb-2.5 p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[260px] flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by name, email, phone, address, account, source, or labels…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="h-8 pl-8 text-sm"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <FilterChip active={tagFilter === "All"} onClick={() => setTagFilter("All")}>All</FilterChip>
            {labelFilterOptions.map((t) => (
              <FilterChip key={t.key} active={tagFilter === t.key} onClick={() => setTagFilter(t.key)} colors={colorForTag(t.key)}>{t.label}</FilterChip>
            ))}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8">
                <SlidersHorizontal className="mr-1.5 h-3.5 w-3.5" /> Columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel className="text-xs">Show columns</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {OPTIONAL_COLUMNS.map((key) => (
                <DropdownMenuCheckboxItem
                  key={key}
                  checked={visibleColumns[key]}
                  onCheckedChange={(checked) => setVisibleColumns((v) => ({ ...v, [key]: checked }))}
                  onSelect={(e) => e.preventDefault()}
                >
                  {COLUMN_LABELS[key]}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Popover open={moreFiltersOpen} onOpenChange={setMoreFiltersOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="relative h-8">
                <SlidersHorizontal className="mr-1.5 h-3.5 w-3.5" /> More filters
                {moreFiltersActiveCount > 0 && (
                  <span className="absolute -right-1.5 -top-1.5 grid h-4 w-4 place-items-center rounded-full bg-primary text-[9px] font-semibold text-primary-foreground">
                    {moreFiltersActiveCount}
                  </span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 space-y-3 z-50">
              <div className="space-y-1.5">
                <Label className="text-xs">Account</Label>
                <Select value={companyFilter} onValueChange={setCompanyFilter}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="All accounts" className="text-xs">All accounts</SelectItem>
                    {companyFilterOptions.map((c) => <SelectItem key={c} value={c} className="text-xs">{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Source</Label>
                <Select value={sourceFilter} onValueChange={setSourceFilter}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="All sources" className="text-xs">All sources</SelectItem>
                    {sourceFilterOptions.map((s) => <SelectItem key={s} value={s} className="text-xs">{s}</SelectItem>)}
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
              <label className="flex items-center gap-2 py-0.5 text-xs">
                <input type="checkbox" className="h-3.5 w-3.5 accent-[color:var(--primary)]" checked={hasEmailOnly} onChange={(e) => setHasEmailOnly(e.target.checked)} />
                Has email
              </label>
              <label className="flex items-center gap-2 py-0.5 text-xs">
                <input type="checkbox" className="h-3.5 w-3.5 accent-[color:var(--primary)]" checked={hasPhoneOnly} onChange={(e) => setHasPhoneOnly(e.target.checked)} />
                Has phone
              </label>
              {moreFiltersActiveCount > 0 && (
                <Button size="sm" variant="ghost" className="w-full text-xs" onClick={clearFilters}>Clear all</Button>
              )}
            </PopoverContent>
          </Popover>
          <div className="ml-auto">
            {contacts && (
              <span className="text-xs text-muted-foreground">
                Showing {paginated.length} of {filtered.length}
              </span>
            )}
          </div>
        </div>

        {selectedIds.size > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
            <span className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
              {selectedIds.size} selected
            </span>
            <Button size="sm" variant="outline" className="h-8" onClick={handleExportSelected} disabled={bulkActionLoading}>
              <Download className="mr-1.5 h-3.5 w-3.5" /> Export selected
            </Button>
            <TagPicker
              options={labelFilterOptions}
              colorFor={colorForTag}
              onSelect={(sel) => handleBulkAddTag(sel.label)}
              placeholder="Add tag…"
              className="h-8"
              disabled={bulkActionLoading}
            />
            {selectionTagOptions.length > 0 && (
              <TagPicker
                options={selectionTagOptions}
                colorFor={colorForTag}
                onSelect={(sel) => handleBulkRemoveTag(sel.key)}
                placeholder="Remove tag…"
                allowCreate={false}
                className="h-8"
                disabled={bulkActionLoading}
              />
            )}
            <Select onValueChange={handleBulkAssignAccount} disabled={bulkActionLoading}>
              <SelectTrigger className="h-8 w-auto min-w-[140px] text-xs"><SelectValue placeholder="Assign account" /></SelectTrigger>
              <SelectContent>
                {companies.map((c) => <SelectItem key={c.id} value={c.id} className="text-xs">{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" className="h-8" onClick={handleBulkClearAccount} disabled={bulkActionLoading}>
              Clear account
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-destructive hover:text-destructive"
              onClick={() => setBulkDeleteConfirmOpen(true)}
              disabled={bulkActionLoading}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
            </Button>
            <Button size="sm" variant="ghost" className="h-8" onClick={() => setSelectedIds(new Set())} disabled={bulkActionLoading}>
              Clear selection
            </Button>
          </div>
        )}
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-secondary/60 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              <tr className="border-b border-border">
                <th className="w-8 py-2 pl-4 pr-2 text-left">
                  <input type="checkbox" className="h-3.5 w-3.5 accent-[color:var(--primary)]" checked={allPageSelected} onChange={toggleAllOnPage} />
                </th>
                <th className="py-2 pr-4 text-left">Name</th>
                {visibleColumns.account && <th className="py-2 pr-4 text-left">Account</th>}
                {visibleColumns.email && <th className="py-2 pr-4 text-left">Email</th>}
                {visibleColumns.phone && <th className="py-2 pr-4 text-left">Phone</th>}
                {visibleColumns.source && <th className="py-2 pr-4 text-left">Source</th>}
                {visibleColumns.tags && <th className="py-2 pr-4 text-left">Tags</th>}
                {visibleColumns.owner && <th className="py-2 pr-4 text-left">Owner</th>}
                {visibleColumns.created && <th className="py-2 pr-4 text-left">Created</th>}
                {visibleColumns.lastActivity && <th className="py-2 pr-4 text-left">Last activity</th>}
                <th className="w-10 py-2 pr-3"></th>
              </tr>
            </thead>
            <tbody>
              {paginated.length === 0 && (
                <tr>
                  <td colSpan={10} className="py-14 text-center">
                    <div className="mx-auto max-w-xs">
                      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-primary-soft text-primary">
                        <Search className="h-4 w-4" />
                      </div>
                      <div className="text-sm font-medium">No contacts found</div>
                      <div className="mt-1 text-xs text-muted-foreground">Try adjusting your search or filters.</div>
                      <Button size="sm" className="mt-4" onClick={() => setNewOpen(true)}>
                        <Plus className="mr-1.5 h-3.5 w-3.5" /> New Contact
                      </Button>
                    </div>
                  </td>
                </tr>
              )}

              {paginated.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => navigate({ search: { contactId: c.id }, replace: true })}
                  className="cursor-pointer border-b border-border transition-colors hover:bg-secondary/40"
                >
                  <td className="py-2 pl-4 pr-2" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" className="h-3.5 w-3.5 accent-[color:var(--primary)]" checked={selectedIds.has(c.id)} onChange={() => toggleContactSelection(c.id)} />
                  </td>
                  <td className="py-2 pr-4">
                    <div className="flex items-center gap-2.5">
                      <ContactAvatar id={c.id} name={c.name} avatarUrl={c.avatar_url} avatarKey={c.avatar_key} size="sm" className="h-7 w-7" />
                      <div className="font-medium">{c.name}</div>
                    </div>
                  </td>
                  {/* companyName (resolved from the canonical company_id)
                      wins when set; legacy free-text `company` is only a
                      fallback for rows with no linked company row. */}
                  {visibleColumns.account && <td className="py-2 pr-4 text-muted-foreground">{c.companyName || c.company || "—"}</td>}
                  {visibleColumns.email && <td className="py-2 pr-4 text-muted-foreground">{c.email}</td>}
                  {visibleColumns.phone && <td className="py-2 pr-4 text-muted-foreground tabular-nums">{displayPhone(c.phone)}</td>}
                  {visibleColumns.source && <td className="py-2 pr-4 text-muted-foreground">{contactSourceLabel(c.source)}</td>}
                  {visibleColumns.tags && (
                    <td className="py-2 pr-4">
                      <div className="flex flex-wrap gap-1">
                        {c.tags.slice(0, 2).map((t) => (
                          <span key={t} className={`inline-flex h-5 items-center rounded border bg-transparent px-1.5 text-[10px] font-medium ${colorForTag(tagComparisonKey(t)).chip}`}>{t}</span>
                        ))}
                        {c.tags.length > 2 && <span className="text-[10px] text-muted-foreground">+{c.tags.length - 2}</span>}
                      </div>
                    </td>
                  )}
                  {visibleColumns.owner && <td className="py-2 pr-4 text-muted-foreground">{c.owner}</td>}
                  {visibleColumns.created && (
                    <td className="py-2 pr-4 text-muted-foreground">{formatDateShort(c.createdAt)}</td>
                  )}
                  {visibleColumns.lastActivity && (
                    <td className="py-2 pr-4 text-muted-foreground">
                      {formatDistanceToNow(new Date(c.lastActivity), { addSuffix: true })}
                    </td>
                  )}
                  <td className="py-2 pr-3" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Row actions">
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => navigate({ search: { contactId: c.id }, replace: true })}>
                          View profile
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => c.email && window.open(`mailto:${c.email}`, "_blank")}
                          disabled={!c.email}
                        >
                          Send email
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => c.phone && window.open(`sms:${c.phone}`)}
                          disabled={!c.phone}
                        >
                          Send SMS
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => setDeleteTarget(c)}
                        >
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {filtered.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
            <span>Showing {rangeStart}–{rangeEnd} of {filtered.length}</span>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
              >
                Previous
              </Button>
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
                <Button
                  key={page}
                  size="sm"
                  variant={page === currentPage ? "default" : "outline"}
                  className="h-7 w-7 px-0 text-xs"
                  onClick={() => setCurrentPage(page)}
                >
                  {page}
                </Button>
              ))}
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Contact drawer */}
      <ContactDrawer
        contact={selected}
        companies={companies}
        tagOptions={labelFilterOptions}
        colorForTag={colorForTag}
        onOpenChange={(o) => { if (!o) navigate({ search: { contactId: undefined }, replace: true }); }}
        onDelete={(c) => setDeleteTarget(c)}
        onNewDeal={() => navigate({
          to: "/pipeline",
          search: {
            addDeal: "1",
            pName: selected?.name ?? "",
            pEmail: selected?.email ?? "",
            pPhone: selected?.phone ?? "",
            pAddress: selected?.address ?? "",
          },
        } as any)}
      />

      <NewContactDialog open={newOpen} onOpenChange={setNewOpen} companies={companies} />

      {/* Delete confirmation (Priority 10) — blocked entirely (no "delete
          anyway") when the contact still has real linked records; the
          destructive action only ever appears once the check confirms
          there's nothing to lose. */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent>
          {deleteChecking ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking linked records…
            </div>
          ) : deleteLinkedRecords && deleteLinkedRecords.length > 0 ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Can't delete {deleteTarget?.name}</AlertDialogTitle>
                <AlertDialogDescription>
                  This contact is still linked to {deleteLinkedRecords.map((r) => `${r.count} ${r.label}${r.count === 1 ? "" : "s"}`).join(", ")}.
                  Reassign or remove those records first, or merge this contact into another one instead of deleting it.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={() => setDeleteTarget(null)}>Close</AlertDialogCancel>
              </AlertDialogFooter>
            </>
          ) : (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {deleteTarget?.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete this contact and cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deleteLoading}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  disabled={deleteLoading}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={handleDeleteContact}
                >
                  {deleteLoading && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk delete confirmation (Priority 4) — the handler itself skips
          any contact that still has linked records (same safety rules as
          the single-delete flow), so this dialog is an informational
          confirm rather than a second guard. */}
      <AlertDialog open={bulkDeleteConfirmOpen} onOpenChange={setBulkDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedIds.size} contact{selectedIds.size === 1 ? "" : "s"}?</AlertDialogTitle>
            <AlertDialogDescription>
              Contacts still linked to deals, projects, estimates, appointments, invoices, or leads will be skipped automatically. This cannot be undone for the rest.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkActionLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={bulkActionLoading}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => { e.preventDefault(); handleBulkDelete(); }}
            >
              {bulkActionLoading && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* CSV import dialog */}
      <Dialog open={mapOpen} onOpenChange={setMapOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Map CSV Columns</DialogTitle>
            <DialogDescription>
              Match your CSV columns to contact fields. {csvTotalRows} row(s) detected.{" "}
              <span className="inline-flex items-center gap-1.5">
                <select
                  className="h-6 rounded border border-input bg-transparent px-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                  value={templateType}
                  onChange={(e) => {
                    const next = e.target.value as ContactTemplateType;
                    setTemplateType(next);
                    if (csvHeaders.length > 0) setColMapping(autoMapHeaders(csvHeaders, next));
                  }}
                >
                  <option value="contact">Contact</option>
                  <option value="customer">Customer</option>
                  <option value="vendor">Vendor</option>
                </select>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-primary underline underline-offset-2 hover:opacity-80"
                  onClick={() => {
                    const templates: Record<string, { headers: string; sample: string; filename: string }> = {
                      contact: { headers: "Name,Email,Phone,Account,Tags,Owner", sample: "Jane Doe,jane@example.com,555-123-4567,Acme Corp,Homeowner; VIP,Alex", filename: "contacts-template.csv" },
                      customer: { headers: "Customer Name,Email,Phone,Account,Tier,Account Manager", sample: "John Smith,john@acme.com,555-987-6543,Acme Corp,VIP,Sarah", filename: "customers-template.csv" },
                      vendor: { headers: "Vendor Name,Email,Phone,Account,Trade,Managed By", sample: "Bob Builder,bob@builds.com,555-222-3333,Builder Co,Plumbing,Mike", filename: "vendors-template.csv" },
                    };
                    const t = templates[templateType] ?? templates.contact;
                    downloadCSV(`${t.headers}\n${t.sample}`, t.filename);
                  }}
                >
                  <Download className="inline h-3 w-3" /> Download template
                </button>
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  <th className="px-3 py-2">Contact Field</th>
                  <th className="px-3 py-2">CSV Column</th>
                  <th className="hidden px-3 py-2 sm:table-cell">Preview</th>
                </tr>
              </thead>
              <tbody>
                {colMapping && CONTACT_FIELDS.map((field) => {
                  const mapped = colMapping[field.key];
                  const previewVals = csvPreview.map((row) => mapped >= 0 ? (row[mapped] ?? "") : "").filter(Boolean).slice(0, 2);
                  const isTagsField = field.key === "tags";
                  const tagDetection = isTagsField && tagDelimiter === "auto" && mapped >= 0
                    ? detectTagDelimiterWithConfidence(csvPreview.map((row) => row[mapped] ?? "").filter(Boolean))
                    : null;
                  const effectiveDelimiter = tagDetection
                    ? tagDetection.delimiter
                    : (isTagsField && tagDelimiter === "auto" ? detectTagDelimiter(previewVals) : tagDelimiter);
                  return (
                    <tr key={field.key} className="border-b border-border last:border-0">
                      <td className="px-3 py-2.5">
                        <span className="font-medium">{field.label}</span>
                        {"required" in field && <span className="ml-1 text-destructive">*</span>}
                        {isTagsField && mapped >= 0 && (
                          <div className="mt-1">
                            <select
                              className="h-6 rounded border border-input bg-transparent px-1.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
                              value={tagDelimiter}
                              onChange={(e) => setTagDelimiter(e.target.value as TagDelimiter)}
                            >
                              <option value="auto">Auto-detect</option>
                              <option value="both">Split on , and ;</option>
                              <option value="comma">Split on , only</option>
                              <option value="semicolon">Split on ; only</option>
                            </select>
                            {tagDetection && (
                              <div className="mt-1 flex items-center gap-1.5 text-[10px]">
                                <span className={`inline-block h-1.5 w-1.5 rounded-full ${tagDetection.confidence === "high" ? "bg-emerald-500" : tagDetection.confidence === "medium" ? "bg-amber-500" : "bg-muted-foreground/50"}`} />
                                <span className="text-muted-foreground">{tagDetection.reason}</span>
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <Select
                          value={String(mapped)}
                          onValueChange={(v) => setColMapping((prev) => prev ? { ...prev, [field.key]: Number(v) } : prev)}
                        >
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="-1" className="text-xs text-muted-foreground">— Skip —</SelectItem>
                            {csvHeaders.map((h, i) => (<SelectItem key={i} value={String(i)} className="text-xs">{h}</SelectItem>))}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="hidden px-3 py-2.5 sm:table-cell">
                        <span className="line-clamp-1 text-xs text-muted-foreground">
                          {isTagsField && previewVals.length
                            ? previewVals.map((v) => splitTags(v, effectiveDelimiter).map((t) => `[${t}]`).join(" ")).join(", ")
                            : previewVals.length ? previewVals.join(", ") : "—"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {importValidation && (
            <div className="space-y-2 border-t border-border pt-3">
              <div className="flex items-center gap-4 text-sm">
                <span className="flex items-center gap-1.5 text-emerald-600">
                  <CheckCircle2 className="h-3.5 w-3.5" />{importValidation.validCount} valid
                </span>
                {importValidation.errors.length > 0 && (
                  <span className="flex items-center gap-4">
                    <span className="flex items-center gap-1.5 text-amber-600">
                      <AlertTriangle className="h-3.5 w-3.5" />{importValidation.errors.length} will be skipped
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
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />{err}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setMapOpen(false)}>Cancel</Button>
            <Button
              onClick={handleConfirmImport}
              disabled={importLoading || !colMapping || colMapping.name < 0 || !importValidation?.validCount}
            >
              {importLoading && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Import {importValidation?.validCount ?? 0} Contact{(importValidation?.validCount ?? 0) !== 1 ? "s" : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Find duplicates dialog */}
      <FindDuplicatesDialog open={dupeOpen} onClose={() => setDupeOpen(false)} />
    </>
  );
}

// ── Helper UI components ─────────────────────────────────────────────────────

// `colors`, if given (from assignTagColors/colorForTag), renders the chip
// in its deterministic tag color instead of the plain neutral/primary look
// — used for tag filter chips specifically, not the "All" chip. Active
// state stays distinguishable via a stronger ring on top of the tag's own
// color rather than replacing it with a plain accent.
function FilterChip({ active, onClick, children, colors }: { active: boolean; onClick: () => void; children: React.ReactNode; colors?: TagColorClasses }) {
  if (colors) {
    return (
      <button
        onClick={onClick}
        className={`h-8 rounded-md border bg-transparent px-2.5 text-xs font-medium transition-colors ${active ? colors.selectedChip : colors.chip}`}
      >
        {children}
      </button>
    );
  }
  return (
    <button
      onClick={onClick}
      className={`h-8 rounded-md border px-2.5 text-xs font-medium transition-colors ${active ? "border-primary/30 bg-primary-soft text-primary" : "border-border bg-background text-muted-foreground hover:bg-secondary/60"}`}
    >
      {children}
    </button>
  );
}


function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-sm">{value || "—"}</div>
    </div>
  );
}

// ── Contact Drawer ────────────────────────────────────────────────────────────

// Exported (Phase 13.4 follow-up, Part 15) so Financials' Invoice Details
// can reuse the exact same Contact detail drawer other contextual views
// use, instead of a second Contact detail implementation — same principle
// already used for ProjectDetailSheet (projects.index.tsx).
export function ContactDrawer({
  contact,
  companies,
  tagOptions,
  colorForTag,
  onOpenChange,
  onDelete,
  onNewDeal,
}: {
  contact: Contact | null;
  companies: CompanyOption[];
  /** Full canonical tag universe across all loaded contacts, for the tag picker's suggestion list. */
  tagOptions: import("@/lib/tag-utils").CanonicalTagOption[];
  colorForTag: (key: string) => TagColorClasses;
  onOpenChange: (o: boolean) => void;
  onDelete: (c: Contact) => void;
  onNewDeal: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState(BLANK_FORM);
  const [saving, setSaving] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  // Duplicate check on save (Priority 1) — only re-runs when email/phone
  // actually changed from the contact's current stored values, excluding
  // the contact itself from candidates.
  const [duplicates, setDuplicates] = useState<ContactDuplicateCandidate[] | null>(null);
  const [duplicatesCheckedFor, setDuplicatesCheckedFor] = useState<string | null>(null);
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);

  useEffect(() => {
    if (!contact) return;
    setEditForm({
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      address: contact.address ?? "",
      company: contact.company,
      companyId: contact.company_id ?? "",
      source: contact.source ?? "",
    });
    setEditing(false);
    setDuplicates(null);
    setDuplicatesCheckedFor(null);
  }, [contact?.id]);

  function updateEditForm(patch: Partial<typeof BLANK_FORM>) {
    setEditForm((f) => ({ ...f, ...patch }));
    setDuplicates(null);
    setDuplicatesCheckedFor(null);
  }

  async function handleSave() {
    if (!contact) return;

    const checkKey = `${editForm.email.trim().toLowerCase()}|${editForm.phone.trim()}`;
    const emailOrPhoneChanged = editForm.email.trim() !== contact.email || editForm.phone.trim() !== contact.phone;
    const alreadyConfirmed = duplicates !== null && duplicatesCheckedFor === checkKey;

    if (emailOrPhoneChanged && !alreadyConfirmed && (editForm.email.trim() || editForm.phone.trim())) {
      setCheckingDuplicates(true);
      const orgId = await getOrgId();
      setCheckingDuplicates(false);
      if (orgId) {
        const matches = await findDuplicateContactCandidates(orgId, { email: editForm.email, phone: editForm.phone }, contact.id);
        if (matches.length > 0) {
          setDuplicates(matches);
          setDuplicatesCheckedFor(checkKey);
          return; // Block save — surfaced for manual review, never auto-merged.
        }
      }
      setDuplicates([]);
      setDuplicatesCheckedFor(checkKey);
    }

    setSaving(true);
    await updateContact(contact.id, {
      name: editForm.name,
      email: normalizeEmail(editForm.email) || editForm.email.trim(),
      phone: editForm.phone,
      address: editForm.address,
      // Canonical when a company was picked; otherwise fall back to the
      // legacy free-text field the user typed (contacts-store clears the
      // other side automatically — see updateContact's own comment).
      company_id: editForm.companyId || null,
      company: editForm.companyId ? "" : editForm.company,
      source: editForm.source,
    });
    // Refresh deals so deal cards show updated contact info
    refreshDeals().catch(() => {});
    setSaving(false);
    setEditing(false);
    toast.success("Contact saved");
  }

  async function handleAddTag(rawLabel: string) {
    if (!contact || !rawLabel.trim()) return;
    // normalizeTags collapses this against the contact's existing tags by
    // canonical key, so picking an existing option (already an exact match)
    // is a no-op merge, and typing/creating "vip" when "VIP" is already
    // present resolves to the single existing "VIP" entry rather than a
    // duplicate.
    const next = normalizeTags([...contact.tags, rawLabel]);
    await updateContact(contact.id, { tags: next });
  }

  async function handleRemoveTag(tag: string) {
    if (!contact) return;
    await updateContact(contact.id, { tags: contact.tags.filter((t) => t !== tag) });
  }

  const linkedCompany = contact?.company_id ? companies.find((c) => c.id === contact.company_id) : undefined;
  // A company_id can point at a company that's since been deleted — handled
  // safely rather than crashing or showing a broken link (Priority 2).
  const companyMissing = !!contact?.company_id && !linkedCompany;

  return (
    <Sheet open={!!contact} onOpenChange={(o) => {
      // Prevent sheet close when clicking Google Places pac-container
      const active = document.querySelector(".pac-container");
      if (!o && active && document.activeElement && active.contains(document.activeElement)) return;
      onOpenChange(o);
    }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl [&>button.absolute]:hidden">
        {contact && (
          <>
            <SheetHeader className="space-y-3 border-b border-border pb-4">
              <div className="flex items-start gap-3">
                <AvatarPicker
                  id={contact.id}
                  name={contact.name}
                  avatarKey={contact.avatar_key}
                  size="lg"
                  onSelect={(key) => {
                    void updateContact(contact.id, {
                      avatar_key: key || null,
                    });
                  }}
                />
                <div className="min-w-0 flex-1 text-left">
                  <SheetTitle className="truncate text-base">{contact.name}</SheetTitle>
                  <SheetDescription className="truncate text-xs">
                    {contact.companyName || contact.company || "No account"} · Owned by {contact.owner}
                  </SheetDescription>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    onClick={() => setEditing((e) => !e)}
                    title={editing ? "Cancel edit" : "Edit contact"}
                  >
                    {editing ? <X className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-destructive hover:text-destructive"
                    onClick={() => onDelete(contact)}
                    title="Delete contact"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1"
                  disabled={!contact.email}
                  onClick={() => window.open(`mailto:${contact.email}`, "_blank")}
                >
                  <Mail className="mr-1.5 h-3.5 w-3.5" />Email
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1"
                  disabled={!contact.phone}
                  onClick={() => window.open(`tel:${contact.phone}`)}
                >
                  <Phone className="mr-1.5 h-3.5 w-3.5" />Call
                </Button>
                <Button size="sm" className="flex-1" onClick={onNewDeal}>
                  + New Deal
                </Button>
              </div>
              <Button size="sm" variant="outline" className="w-full" onClick={() => setScheduleOpen(true)}>
                <CalendarPlus className="mr-1.5 h-3.5 w-3.5" /> Schedule Appointment
              </Button>
            </SheetHeader>

            <AppointmentDialog
              open={scheduleOpen}
              onOpenChange={setScheduleOpen}
              prefill={{
                entityType: "contact",
                entityId: contact.id,
                entityLabel: contact.name,
                contactName: contact.name,
                contactPhone: contact.phone,
                contactEmail: contact.email,
                address: contact.address || undefined,
                source: "contact",
              }}
              onSaved={() => toast.success("Appointment scheduled")}
            />

            <Tabs defaultValue="overview" className="mt-4">
              <TabsList className="h-auto w-full flex-wrap justify-start gap-2 bg-transparent p-0">
                {[
                  ["overview", "Overview"],
                  ["communication", "Communication"],
                  ["activity", "Timeline"],
                  ["related", "Deals & More"],
                  ["notes", "Notes"],
                ].map(([value, label]) => (
                  <TabsTrigger
                    key={value}
                    value={value}
                    className="h-8 rounded-md border border-border bg-white
                      px-3 py-1.5 text-xs shadow-sm
                      hover:bg-secondary/50
                      data-[state=active]:border-[#E3CA9A]
                      data-[state=active]:bg-[#FAF3E4]
                      data-[state=active]:text-foreground
                      data-[state=active]:shadow-sm"
                  >
                    {label}
                  </TabsTrigger>
                ))}
              </TabsList>

              <TabsContent value="overview" className="mt-4 space-y-4">
                {editing ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="col-span-2 grid gap-1.5">
                        <Label className="text-xs">Name</Label>
                        <Input
                          value={editForm.name}
                          onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label className="text-xs">Email</Label>
                        <Input
                          type="email"
                          value={editForm.email}
                          onChange={(e) => updateEditForm({ email: e.target.value })}
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label className="text-xs">Phone</Label>
                        <Input
                          type="tel"
                          inputMode="tel"
                          value={editForm.phone}
                          onChange={(e) => updateEditForm({ phone: formatPhone(e.target.value) })}
                          placeholder="(555) 123-4567"
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label className="text-xs">Account</Label>
                        <Select
                          value={editForm.companyId || "__none__"}
                          onValueChange={(v) => setEditForm((f) => ({ ...f, companyId: v === "__none__" ? "" : v }))}
                        >
                          <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="No account" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">No account</SelectItem>
                            {companies.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        {/* Legacy free-text fallback — only used when no
                            company_id is selected above, per Priority 2
                            (never write both; company_id wins). */}
                        {!editForm.companyId && (
                          <Input
                            className="mt-1"
                            value={editForm.company}
                            onChange={(e) => setEditForm((f) => ({ ...f, company: e.target.value }))}
                            placeholder="Or type an account name (no linked record)"
                          />
                        )}
                      </div>
                      <div className="grid gap-1.5">
                        <Label className="text-xs">Source</Label>
                        <Input
                          value={editForm.source}
                          onChange={(e) => setEditForm((f) => ({ ...f, source: e.target.value }))}
                          placeholder="manual"
                        />
                      </div>
                      <div className="col-span-2 grid gap-1.5">
                        <Label className="text-xs">Address</Label>
                        <AddressAutocomplete
                          value={editForm.address}
                          onChange={(v) => setEditForm((f) => ({ ...f, address: v }))}
                          onSelect={(parts) =>
                            setEditForm((f) => ({
                              ...f,
                              address: [parts.street, parts.city, `${parts.state} ${parts.zip}`].filter(Boolean).join(", "),
                            }))
                          }
                          placeholder="123 Main St, City, ST"
                        />
                      </div>
                      <div className="col-span-2 grid gap-1.5">
                        <Label className="text-xs">
                          Owner
                          <span className="ml-1 font-normal normal-case text-muted-foreground">(read-only — see note)</span>
                        </Label>
                        <Input value={contact.owner} disabled className="text-muted-foreground" />
                        <p className="text-[10.5px] text-muted-foreground">
                          contacts.owner is a legacy display-name field, not a real member reference yet — it can't be
                          safely edited here until a canonical owner column exists (see Phase 9 report).
                        </p>
                      </div>
                    </div>

                    {duplicates && duplicates.length > 0 && (
                      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/30">
                        <div className="flex items-center gap-1.5 font-medium text-amber-800 dark:text-amber-400">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          Possible duplicate {duplicates.length === 1 ? "contact" : "contacts"} found
                        </div>
                        <ul className="mt-1.5 space-y-1">
                          {duplicates.map((d) => (
                            <li key={d.id} className="text-xs text-amber-900 dark:text-amber-300">
                              {d.full_name} — matched by {d.matchedOn === "email" ? d.email : d.phone}
                            </li>
                          ))}
                        </ul>
                        <p className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-500">
                          Click "Save anyway" to keep this email/phone on this contact regardless.
                        </p>
                      </div>
                    )}

                    <div className="flex gap-2">
                      <Button size="sm" onClick={handleSave} disabled={saving || checkingDuplicates}>
                        {(saving || checkingDuplicates) ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}
                        {checkingDuplicates ? "Checking…" : duplicates && duplicates.length > 0 ? "Save anyway" : "Save"}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <Field label="Email" value={contact.email} />
                      <Field label="Phone" value={displayPhone(contact.phone)} />
                      <div>
                        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Account</div>
                        {contact.company_id ? (
                          companyMissing ? (
                            <div className="mt-0.5 truncate text-sm text-muted-foreground">Linked account was deleted</div>
                          ) : (
                            <Link
                              to="/accounts/$accountSlug"
                              params={{ accountSlug: linkedCompany!.slug }}
                              className="mt-0.5 flex items-center gap-1 truncate text-sm text-primary hover:underline"
                            >
                              <Building2 className="h-3.5 w-3.5 shrink-0" />
                              {linkedCompany!.name}
                              <ExternalLink className="h-3 w-3 shrink-0" />
                            </Link>
                          )
                        ) : (
                          <div className="mt-0.5 truncate text-sm">{contact.company || "—"}</div>
                        )}
                      </div>
                      <Field label="Owner" value={contact.owner} />
                      <Field label="Source" value={contact.source ? contactSourceLabel(contact.source) : "—"} />
                      {contact.address && <Field label="Address" value={contact.address} />}
                    </div>
                    <Separator />
                    <div>
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Tags</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {contact.tags.length > 0
                          ? contact.tags.map((t) => (
                            <span key={t} className={`inline-flex h-6 items-center gap-1 rounded border bg-transparent pl-2 pr-1 text-[11px] font-medium ${colorForTag(tagComparisonKey(t)).chip}`}>
                              {t}
                              <button
                                type="button"
                                onClick={() => handleRemoveTag(t)}
                                className="rounded-full p-0.5 hover:bg-black/10"
                                aria-label={`Remove ${t}`}
                              >
                                <X className="h-2.5 w-2.5" />
                              </button>
                            </span>
                          ))
                          : <span className="text-xs text-muted-foreground">No tags</span>
                        }
                      </div>
                      <div className="mt-2">
                        <TagPicker
                          options={tagOptions}
                          excludeKeys={contact.tags.map(tagComparisonKey)}
                          colorFor={colorForTag}
                          onSelect={(sel) => handleAddTag(sel.label)}
                          placeholder="Select or create a tag…"
                        />
                      </div>
                    </div>
                    <Separator />
                    <CommunicationPreferencesSection contactId={contact.id} />
                    <Separator />
                    <div className="rounded-md border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
                      Created {formatDistanceToNow(new Date(contact.createdAt), { addSuffix: true })} · Last activity {formatDistanceToNow(new Date(contact.lastActivity), { addSuffix: true })}.
                    </div>
                  </>
                )}
              </TabsContent>

              <TabsContent value="communication" className="mt-4">
                <CommunicationTab contactId={contact.id} />
              </TabsContent>

              <TabsContent value="activity" className="mt-4">
                <ActivityTab contact={contact} />
              </TabsContent>

              <TabsContent value="related" className="mt-4">
                <ContactRelatedTab
                  contactId={contact.id}
                  contactName={contact.name}
                  contactPhone={contact.phone}
                  contactEmail={contact.email}
                  contactAddress={contact.address}
                />
              </TabsContent>

              <TabsContent value="notes" className="mt-4">
                <NotesTab contactId={contact.id} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ── Notes tab (Priority 5) — real, persisted notes via the `notes` table ──

function NotesTab({ contactId }: { contactId: string }) {
  const { notes, loading, error, addNote, updateNote, deleteNote } = useContactNotes(contactId);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [deleteNoteTarget, setDeleteNoteTarget] = useState<ContactNote | null>(null);

  async function handleAdd() {
    if (!draft.trim()) return;
    setAdding(true);
    const ok = await addNote(draft);
    setAdding(false);
    if (ok) { setDraft(""); toast.success("Note added"); }
    else toast.error("Couldn't add this note. Please try again.");
  }

  async function handleSaveEdit(noteId: string) {
    const ok = await updateNote(noteId, editDraft);
    if (ok) { setEditingId(null); toast.success("Note updated"); }
    else toast.error("Couldn't save this note. Please try again.");
  }

  async function handleConfirmDelete() {
    if (!deleteNoteTarget) return;
    const ok = await deleteNote(deleteNoteTarget.id);
    setDeleteNoteTarget(null);
    if (ok) toast.success("Note deleted");
    else toast.error("Couldn't delete this note. Please try again.");
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a note about this contact…"
          rows={2}
          className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
        />
        <Button size="sm" onClick={handleAdd} disabled={adding || !draft.trim()}>
          {adding && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Add Note
        </Button>
      </div>

      {loading ? (
        <div className="py-6 text-center text-xs text-muted-foreground">Loading notes…</div>
      ) : error ? (
        <div className="py-6 text-center text-xs text-destructive">{error}</div>
      ) : notes.length === 0 ? (
        <div className="flex flex-col items-center py-8 text-center">
          <StickyNote className="mb-2 h-8 w-8 text-muted-foreground/30" />
          <div className="text-sm font-medium">No notes yet</div>
          <div className="mt-1 text-xs text-muted-foreground">Notes for this contact will appear here.</div>
        </div>
      ) : (
        <div className="space-y-2">
          {notes.map((note) => (
            <div key={note.id} className="rounded-md border border-border bg-card p-2.5">
              {editingId === note.id ? (
                <div className="space-y-1.5">
                  <textarea
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    rows={2}
                    className="w-full resize-none rounded-md border border-input bg-transparent px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                    autoFocus
                  />
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="outline" className="h-7 flex-1" onClick={() => setEditingId(null)}>Cancel</Button>
                    <Button size="sm" className="h-7 flex-1" onClick={() => handleSaveEdit(note.id)} disabled={!editDraft.trim()}>Save</Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm text-foreground">{note.content}</p>
                    {note.isOwn && (
                      <div className="flex shrink-0 gap-0.5">
                        <button
                          onClick={() => { setEditingId(note.id); setEditDraft(note.content); }}
                          className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                          aria-label="Edit note"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          onClick={() => setDeleteNoteTarget(note)}
                          className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                          aria-label="Delete note"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="mt-1 text-[10px] text-muted-foreground">
                    {note.authorName} · {formatDistanceToNow(new Date(note.createdAt), { addSuffix: true })}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <AlertDialog open={!!deleteNoteTarget} onOpenChange={(o) => { if (!o) setDeleteNoteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this note?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={handleConfirmDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Activity tab ──────────────────────────────────────────────────────────────

type ActivityKind = "email-out" | "email-in" | "sms-out" | "sms-in" | "call" | "note" | "deal" | "invoice" | "appointment" | "lead";

function activityIcon(kind: ActivityKind) {
  switch (kind) {
    case "email-out":
    case "email-in": return { Icon: MailIcon, tone: "bg-sky-500/10 text-sky-600 dark:text-sky-400" };
    case "sms-out":
    case "sms-in": return { Icon: MessageSquare, tone: "bg-violet-500/10 text-violet-600 dark:text-violet-400" };
    case "call": return { Icon: PhoneIcon, tone: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" };
    case "note": return { Icon: StickyNote, tone: "bg-amber-500/10 text-amber-600 dark:text-amber-400" };
    case "invoice": return { Icon: FileText, tone: "bg-primary-soft text-primary" };
    case "deal": return { Icon: CheckCircle2, tone: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" };
    case "appointment": return { Icon: CalendarClock, tone: "bg-success/10 text-success" };
    case "lead": return { Icon: UserPlus, tone: "bg-primary-soft text-primary" };
  }
}

function ActivityTab({ contact }: { contact: Contact }) {
  const { items, loading } = useContactActivity(contact.id);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (items.length === 0) {
    return <div className="py-8 text-center text-xs text-muted-foreground">No activity yet for this contact.</div>;
  }

  return (
    <div className="space-y-0">
      {items.map((item, i) => {
        const { Icon, tone } = activityIcon(item.kind as ActivityKind);
        const isLast = i === items.length - 1;
        return (
          <div key={item.id} className="relative flex gap-3 pb-4">
            {!isLast && <div className="absolute left-[15px] top-8 h-full w-px bg-border" />}
            <div className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-4 ring-background ${tone}`}>
              <Icon className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0 flex-1 pt-1">
              <div className="flex items-baseline justify-between gap-2">
                <div className="truncate text-sm font-medium">{item.title}</div>
                <div className="shrink-0 text-[11px] text-muted-foreground">
                  {formatDistanceToNow(new Date(item.at), { addSuffix: true })}
                </div>
              </div>
              <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.body}</div>
              <div className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">By {item.by}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Find Duplicates dialog ────────────────────────────────────────────────────

function FindDuplicatesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [loading, setLoading] = useState(false);
  const [groups, setGroups] = useState<any[][]>([]);
  const [selected, setSelected] = useState<Record<number, string>>({});
  const [merging, setMerging] = useState<number | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    detect();
  }, [open]);

  async function detect() {
    setLoading(true);
    setGroups([]);
    try {
      const org = await getOrgId();
      if (!org) return;
      setOrgId(org);

      const { data } = await supabase
        .from("contacts")
        .select("id, full_name, email, phone, address, created_at, company_id, labels, avatar_key")
        .eq("org_id", org)
        .order("created_at", { ascending: true });

      if (!data) return;

      const byEmail: Record<string, any[]> = {};
      const byPhone: Record<string, any[]> = {};

      for (const c of data) {
        const email = (c.email as string)?.toLowerCase().trim();
        if (email) {
          if (!byEmail[email]) byEmail[email] = [];
          byEmail[email].push(c);
        }
        const phone = (c.phone as string)?.replace(/\D/g, "");
        if (phone && phone.length >= 7) {
          if (!byPhone[phone]) byPhone[phone] = [];
          byPhone[phone].push(c);
        }
      }

      const seen = new Set<string>();
      const result: any[][] = [];

      for (const group of [...Object.values(byEmail), ...Object.values(byPhone)]) {
        if (group.length < 2) continue;
        const key = group.map((c: any) => c.id as string).sort().join(",");
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(group);
      }

      setGroups(result);
      const defaults: Record<number, string> = {};
      result.forEach((g, i) => { defaults[i] = g[0].id; });
      setSelected(defaults);
    } finally {
      setLoading(false);
    }
  }

  // Merge remains client-side and non-transactional (Priority 10) — each
  // step below is its own Supabase call, same character as the original
  // implementation. A failure partway through (e.g. after FK reassignment
  // but before the duplicate rows are deleted) would leave the duplicates
  // re-pointed but not yet removed — recoverable by re-running "Merge"
  // again (each step is idempotent: re-assigning an already-reassigned FK
  // or re-deleting an already-deleted row is a no-op), but not atomic. No
  // merge RPC exists in this schema to make it transactional, and building
  // one is out of this pass's scope — reported, not silently broadened.
  async function handleMerge(groupIdx: number) {
    const group = groups[groupIdx];
    const primaryId = selected[groupIdx];
    if (!primaryId || !orgId) return;

    setMerging(groupIdx);
    try {
      const primary = group.find((c: any) => c.id === primaryId);
      const duplicates = group.filter((c: any) => c.id !== primaryId);
      const dupIds = duplicates.map((d: any) => d.id as string);

      // Copy non-null fields from duplicates into primary — one
      // deliberately-chosen surviving value per field, primary's own
      // value always wins when it already has one.
      const patch: Record<string, any> = {};
      for (const dup of duplicates) {
        if (!primary.email && dup.email) patch.email = dup.email;
        if (!primary.phone && dup.phone) patch.phone = dup.phone;
        if (!primary.address && dup.address) patch.address = dup.address;
        if (!primary.company_id && dup.company_id) patch.company_id = dup.company_id;
        if (!primary.avatar_key && dup.avatar_key) patch.avatar_key = dup.avatar_key;
      }
      // Labels are unioned (normalized) rather than "first non-empty wins" —
      // losing a duplicate's tags silently would be a real data loss for a
      // field that's meant to accumulate, unlike a single-value field like
      // email/phone/company.
      const unionLabels = normalizeTags([...(primary.labels ?? []), ...duplicates.flatMap((d: any) => d.labels ?? [])]);
      if (unionLabels.length > (primary.labels?.length ?? 0)) patch.labels = unionLabels;

      if (Object.keys(patch).length > 0) {
        await supabase.from("contacts").update(patch).eq("id", primaryId);
      }

      // Reroute foreign keys to the kept record — real business records
      // first (never cascade-deleted, always reassigned).
      await Promise.all([
        supabase.from("projects").update({ client_id: primaryId }).in("client_id", dupIds),
        supabase.from("estimates").update({ client_id: primaryId }).in("client_id", dupIds),
        supabase.from("leads").update({ contact_id: primaryId }).in("contact_id", dupIds),
        supabase.from("deals").update({ contact_id: primaryId }).in("contact_id", dupIds),
        supabase.from("appointments").update({ contact_id: primaryId }).in("contact_id", dupIds),
        supabase.from("invoices").update({ client_id: primaryId }).in("client_id", dupIds),
        supabase.from("notes").update({ entity_id: primaryId }).eq("entity_type", "contact").in("entity_id", dupIds),
      ]);

      // conversation_states has a unique (org_id, contact_id, channel)
      // constraint — a single bulk reassignment would fail outright if the
      // primary already has its own row for the same channel a duplicate
      // also has one for. Handled per-row: reassign only when the primary
      // has no state for that channel yet; otherwise the primary's own
      // archive/star state is the deliberate survivor and the duplicate's
      // row is simply dropped.
      for (const dupId of dupIds) {
        const { data: dupStates } = await supabase
          .from("conversation_states")
          .select("id, channel")
          .eq("org_id", orgId)
          .eq("contact_id", dupId);
        for (const state of dupStates ?? []) {
          const { data: existing } = await supabase
            .from("conversation_states")
            .select("id")
            .eq("org_id", orgId)
            .eq("contact_id", primaryId)
            .eq("channel", state.channel)
            .maybeSingle();
          if (existing) {
            await supabase.from("conversation_states").delete().eq("id", state.id);
          } else {
            await supabase.from("conversation_states").update({ contact_id: primaryId }).eq("id", state.id);
          }
        }
      }

      await supabase.from("contacts").delete().in("id", dupIds);
      await refreshContacts();

      setGroups((prev) => prev.filter((_, i) => i !== groupIdx));
      setSelected((prev) => {
        const next = { ...prev };
        delete next[groupIdx];
        return next;
      });
      toast.success(`Merged ${group.length} contacts into 1`);
    } catch {
      toast.error("Merge failed");
    } finally {
      setMerging(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Find Duplicates</DialogTitle>
          <DialogDescription>
            Contacts with matching email or phone. Click a card to mark it as the one to keep, then merge.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {!loading && groups.length === 0 && (
          <div className="flex flex-col items-center py-10 text-center">
            <CheckCircle2 className="mb-2 h-8 w-8 text-emerald-500" />
            <div className="text-sm font-medium">No duplicates found</div>
            <div className="mt-1 text-xs text-muted-foreground">All contacts have unique emails and phone numbers.</div>
          </div>
        )}

        {!loading && groups.length > 0 && (
          <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
            {groups.map((group, gi) => (
              <div key={gi} className="rounded-md border border-border p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {group.length} matching contacts — click one to keep it
                  </span>
                  <Button
                    size="sm"
                    disabled={merging === gi || !selected[gi]}
                    onClick={() => handleMerge(gi)}
                  >
                    {merging === gi && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                    Merge
                  </Button>
                </div>
                <p className="mb-2 rounded bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground">
                  Merging moves deals, projects, estimates, appointments, invoices, and notes from the other{" "}
                  {group.length === 2 ? "contact" : "contacts"} onto the one you keep, unions their tags, and then
                  deletes the other record{group.length === 2 ? "" : "s"}. This can't be undone.
                </p>
                <div className={`grid gap-2 ${group.length === 2 ? "grid-cols-2" : "grid-cols-3"}`}>
                  {group.map((c: any) => {
                    const isPrimary = selected[gi] === c.id;
                    return (
                      <div
                        key={c.id}
                        onClick={() => setSelected((prev) => ({ ...prev, [gi]: c.id }))}
                        className={`cursor-pointer rounded border p-2.5 text-xs transition-colors ${
                          isPrimary
                            ? "border-primary bg-primary-soft"
                            : "border-border bg-card hover:bg-secondary/40"
                        }`}
                      >
                        <div className="font-medium truncate">{c.full_name}</div>
                        <div className="mt-0.5 text-muted-foreground truncate">{c.email || "—"}</div>
                        <div className="text-muted-foreground truncate">{displayPhone(c.phone) || "—"}</div>
                        <div className="mt-1 text-[10px] text-muted-foreground">
                          Added {formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}
                        </div>
                        {isPrimary && (
                          <div className="mt-1.5 font-semibold text-primary">✓ Keep this one</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
          {!loading && groups.length > 0 && (
            <Button
              variant="outline"
              onClick={detect}
              disabled={loading}
            >
              Refresh
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}