// src/routes/contacts.tsx

import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ContactAvatar } from "@/components/ui/contact-avatar";
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
import {
  Plus, Search, SlidersHorizontal, Mail, Phone, MoreHorizontal, Download, Upload,
  Users, UserPlus, Star, Activity, CalendarClock, Loader2, Pencil, Trash2, Save, X,
  GitMerge, CheckCircle2, AlertTriangle, ArrowRight, Briefcase, FileText as FileTextIcon,
} from "lucide-react";
import {
  Mail as MailIcon, Phone as PhoneIcon, MessageSquare, FileText, StickyNote,
} from "lucide-react";
import { type Contact } from "@/lib/mock-data";
import {
  useContacts, addContact, updateContact, deleteContact, refreshContacts, getOrgId,
} from "@/lib/contacts-store";
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
import { toast } from "sonner";
import React from "react";

// ── Phone formatter ──────────────────────────────────────────────────────────
function displayPhone(raw: string): string {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits[0] === "1") return `${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  return raw;
}

// ── Constants ────────────────────────────────────────────────────────────────
const TAG_FILTERS = ["All", "Homeowner", "Lead", "VIP", "Past Client", "Architect", "New Lead"] as const;
type TagFilter = (typeof TAG_FILTERS)[number];
type ContactsSearch = { contactId?: string };
const BLANK_FORM = { name: "", email: "", phone: "", address: "", company: "" };

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

  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState<TagFilter>("All");
  const [selected, setSelected] = useState<Contact | null>(null);

  // new contact
  const [newOpen, setNewOpen] = useState(false);
  const [newForm, setNewForm] = useState(BLANK_FORM);
  const [newSaving, setNewSaving] = useState(false);

  // delete
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // csv import
  const [mapOpen, setMapOpen] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [csvRaw, setCsvRaw] = useState("");
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvPreview, setCsvPreview] = useState<string[][]>([]);
  const [csvTotalRows, setCsvTotalRows] = useState(0);
  const [colMapping, setColMapping] = useState<ContactColumnMapping | null>(null);
  const [templateType, setTemplateType] = useState<ContactTemplateType>("contact");
  const [tagDelimiter, setTagDelimiter] = useState<TagDelimiter>("auto");

  // find duplicates
  const [dupeOpen, setDupeOpen] = useState(false);

  const contacts = useContacts();

  useEffect(() => {
    if (!contacts) return;
    if (contactId) {
      const found = contacts.find((c) => c.id === contactId);
      if (found && found.id !== selected?.id) setSelected(found);
    } else if (selected) {
      setSelected(null);
    }
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

  const filtered = useMemo(() => {
    if (!contacts) return [];
    const q = search.toLowerCase().trim();
    return contacts.filter((c) => {
      if (tagFilter !== "All" && !c.tags.some((t) => t.toLowerCase() === tagFilter.toLowerCase())) return false;
      if (!q) return true;
      return c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q) || c.company.toLowerCase().includes(q);
    });
  }, [contacts, search, tagFilter]);

  // ── Create contact ────────────────────────────────────────────────────────
  async function handleCreateContact() {
    if (!newForm.name.trim()) { toast.error("Name is required"); return; }
    setNewSaving(true);
    const rawTags = ((newForm as any).tags as string | undefined) ?? "";
    const tags = rawTags ? rawTags.split(/[,;]+/).map((t: string) => t.trim()).filter(Boolean) : [];
    const result = await addContact({
      name: newForm.name.trim(),
      email: newForm.email.trim(),
      phone: newForm.phone.trim(),
      company: newForm.company.trim(),
      address: newForm.address.trim(),
      tags,
      owner: "—",
      lastActivity: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    setNewSaving(false);
    if (result) {
      toast.success("Contact created");
      setNewOpen(false);
      setNewForm(BLANK_FORM);
    } else {
      toast.error("Failed to create contact");
    }
  }

  // ── Delete contact ────────────────────────────────────────────────────────
  async function handleDeleteContact() {
    if (!deleteTarget) return;
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
  const handleExport = () => {
    if (!contacts) return;
    const csv = contactsToCSV(contacts);
    downloadCSV(csv, `contacts-export-${new Date().toISOString().slice(0, 10)}.csv`);
    toast.success(`Exported ${contacts.length} contacts`);
  };

  // ── Import: pick file ─────────────────────────────────────────────────────
  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const { headers, preview, totalRows } = parseCSVPreview(text);
      if (headers.length === 0 || totalRows === 0) { toast.error("Empty or invalid CSV file"); return; }
      setCsvRaw(text);
      setCsvHeaders(headers);
      setCsvPreview(preview);
      setCsvTotalRows(totalRows);
      setColMapping(autoMapHeaders(headers, templateType));
      setMapOpen(true);
    };
    reader.readAsText(file);
  };

  // ── Import: confirm (now actually saves to Supabase) ──────────────────────
  const handleConfirmImport = async () => {
    if (!colMapping) return;
    const { contacts: parsed, errors } = applyMappingToContacts(csvRaw, colMapping, tagDelimiter);
    if (parsed.length === 0) {
      toast.error("No contacts to import", { description: errors[0] || "Check your column mapping." });
      return;
    }
    setImportLoading(true);
    try {
      const orgId = await getOrgId();
      if (!orgId) { toast.error("Not authenticated"); return; }

      // Skip contacts whose email already exists in this org
      const emails = parsed.map((c) => c.email).filter(Boolean) as string[];
      let existingEmails = new Set<string>();
      if (emails.length > 0) {
        const { data: existing } = await supabase
          .from("contacts").select("email").eq("org_id", orgId).in("email", emails);
        existingEmails = new Set((existing ?? []).map((r: any) => (r.email as string)?.toLowerCase()));
      }

      const toInsert = parsed.filter((c) => !c.email || !existingEmails.has(c.email.toLowerCase()));
      const skippedDupes = parsed.length - toInsert.length;

      if (toInsert.length === 0) {
        toast.warning("All contacts already exist in your database.");
        return;
      }

      const rows = toInsert.map((c) => ({
        org_id: orgId,
        full_name: c.name,
        email: c.email || null,
        phone: c.phone || null,
        company: c.company || null,
        address: null,
        source: "import",
        labels: c.tags ?? [],
      }));

      const { error } = await supabase.from("contacts").insert(rows);
      if (error) { toast.error("Import failed", { description: error.message }); return; }

      await refreshContacts();
      const totalSkipped = errors.length + skippedDupes;
      toast.success(
        `Imported ${toInsert.length} contact${toInsert.length !== 1 ? "s" : ""}`,
        {
          description: totalSkipped > 0
            ? `${totalSkipped} skipped (${errors.length} invalid, ${skippedDupes} duplicate${skippedDupes !== 1 ? "s" : ""})`
            : undefined,
        },
      );
      setMapOpen(false);
    } finally {
      setImportLoading(false);
    }
  };

  const importValidation = useMemo(() => {
    if (!colMapping || !csvRaw) return null;
    const { contacts: parsed, errors } = applyMappingToContacts(csvRaw, colMapping, tagDelimiter);
    return { validCount: parsed.length, errors };
  }, [colMapping, csvRaw, tagDelimiter]);

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

  return (
    <>
      <PageHeader
        icon={Users}
        iconBg="bg-info-soft"
        iconColor="text-info"
        title="Contacts"
        subtitle="People and homeowners across all your projects."
        breadcrumb={["CRM", "Contacts"]}
        actions={
          <>
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
            <Button size="sm" onClick={() => setNewOpen(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" /> New Contact
            </Button>
          </>
        }
      />

      <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Total contacts" value={stats.total.toString()} sub="All-time records" icon={Users} tone="primary" />
        <Kpi label="New this month" value={stats.newThisMonth.toString()} sub="Added in last 30 days" icon={UserPlus} tone="success" />
        <Kpi label="VIP" value={stats.vip.toString()} sub="High-priority accounts" icon={Star} tone="warning" />
        <Kpi label="Active this week" value={stats.activeWeek.toString()} sub="Touched in last 7 days" icon={Activity} tone="muted" />
      </div>

      <Card className="mb-3 p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[260px] flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by name, email, or company…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-8 text-sm"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {TAG_FILTERS.map((t) => (
              <FilterChip key={t} active={tagFilter === t} onClick={() => setTagFilter(t)}>{t}</FilterChip>
            ))}
          </div>
          <Button variant="outline" size="sm" className="h-8">
            <SlidersHorizontal className="mr-1.5 h-3.5 w-3.5" /> Columns
          </Button>
          <div className="ml-auto text-xs text-muted-foreground">
            {contacts && (
              <>Showing <span className="font-medium text-foreground">{filtered.length}</span> of {contacts.length}</>
            )}
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-secondary/60 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              <tr className="border-b border-border">
                <th className="w-8 py-2.5 pl-4 pr-2 text-left">
                  <input type="checkbox" className="h-3.5 w-3.5 accent-[color:var(--primary)]" />
                </th>
                <th className="py-2.5 pr-4 text-left">Name</th>
                <th className="py-2.5 pr-4 text-left">Company</th>
                <th className="py-2.5 pr-4 text-left">Email</th>
                <th className="py-2.5 pr-4 text-left">Phone</th>
                <th className="py-2.5 pr-4 text-left">Tags</th>
                <th className="py-2.5 pr-4 text-left">Owner</th>
                <th className="py-2.5 pr-4 text-left">Last activity</th>
                <th className="w-10 py-2.5 pr-3"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-16 text-center">
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

              {filtered.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => navigate({ search: { contactId: c.id }, replace: true })}
                  className="cursor-pointer border-b border-border transition-colors hover:bg-secondary/40"
                >
                  <td className="py-2.5 pl-4 pr-2" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" className="h-3.5 w-3.5 accent-[color:var(--primary)]" />
                  </td>
                  <td className="py-2.5 pr-4">
                    <div className="flex items-center gap-2.5">
                      <ContactAvatar id={c.id} name={c.name} size="sm" className="h-7 w-7" />
                      <div className="font-medium">{c.name}</div>
                    </div>
                  </td>
                  <td className="py-2.5 pr-4 text-muted-foreground">{c.company}</td>
                  <td className="py-2.5 pr-4 text-muted-foreground">{c.email}</td>
                  <td className="py-2.5 pr-4 text-muted-foreground tabular-nums">{displayPhone(c.phone)}</td>
                  <td className="py-2.5 pr-4">
                    <div className="flex flex-wrap gap-1">
                      {c.tags.slice(0, 2).map((t) => (
                        <Badge key={t} variant="secondary" className="h-5 rounded px-1.5 text-[10px] font-medium">{t}</Badge>
                      ))}
                    </div>
                  </td>
                  <td className="py-2.5 pr-4 text-muted-foreground">{c.owner}</td>
                  <td className="py-2.5 pr-4 text-muted-foreground">
                    {formatDistanceToNow(new Date(c.lastActivity), { addSuffix: true })}
                  </td>
                  <td className="py-2.5 pr-3" onClick={(e) => e.stopPropagation()}>
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
      </Card>

      {/* Contact drawer */}
      <ContactDrawer
        contact={selected}
        onOpenChange={(o) => { if (!o) navigate({ search: { contactId: undefined }, replace: true }); }}
        onDelete={(c) => setDeleteTarget(c)}
        onNewDeal={() => navigate({
          to: "/sales/pipeline",
          search: {
            addDeal: "1",
            pName: selected?.name ?? "",
            pEmail: selected?.email ?? "",
            pPhone: selected?.phone ?? "",
            pAddress: selected?.address ?? "",
          },
        } as any)}
      />

      {/* New contact dialog */}
      <Dialog open={newOpen} onOpenChange={(o) => { setNewOpen(o); if (!o) setNewForm(BLANK_FORM); }}>
        <DialogContent
          className="sm:max-w-md"
          onInteractOutside={(e) => {
            const target = ((e as CustomEvent).detail?.originalEvent?.target ?? e.target) as HTMLElement | null;
            if (target?.closest?.(".pac-container")) e.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>New Contact</DialogTitle>
            <DialogDescription>Add a new contact to your CRM.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 grid gap-1.5">
                <Label htmlFor="nc-name">Name <span className="text-destructive">*</span></Label>
                <Input
                  id="nc-name"
                  value={newForm.name}
                  onChange={(e) => setNewForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Full name"
                  onKeyDown={(e) => e.key === "Enter" && handleCreateContact()}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="nc-email">Email</Label>
                <Input
                  id="nc-email"
                  type="email"
                  value={newForm.email}
                  onChange={(e) => setNewForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="email@example.com"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="nc-phone">Phone</Label>
                <Input
                  id="nc-phone"
                  type="tel"
                  inputMode="tel"
                  value={newForm.phone}
                  onChange={(e) => setNewForm((f) => ({ ...f, phone: formatPhone(e.target.value) }))}
                  placeholder="(555) 123-4567"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="nc-company">Company</Label>
                <Input
                  id="nc-company"
                  value={newForm.company}
                  onChange={(e) => setNewForm((f) => ({ ...f, company: e.target.value }))}
                  placeholder="Company name"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="nc-tags">Tags</Label>
                <Input
                  id="nc-tags"
                  value={(newForm as any).tags ?? ""}
                  onChange={(e) => setNewForm((f) => ({ ...f, tags: e.target.value } as any))}
                  placeholder="Homeowner, VIP…"
                />
              </div>
              <div className="col-span-2 grid gap-1.5">
                <Label>Address</Label>
                <AddressAutocomplete
                  value={newForm.address}
                  onChange={(v) => setNewForm((f) => ({ ...f, address: v }))}
                  onSelect={(parts) =>
                    setNewForm((f) => ({
                      ...f,
                      address: [parts.street, parts.city, `${parts.state} ${parts.zip}`].filter(Boolean).join(", "),
                    }))
                  }
                  placeholder="123 Main St, City, ST"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setNewOpen(false); setNewForm(BLANK_FORM); }}>
              Cancel
            </Button>
            <Button onClick={handleCreateContact} disabled={newSaving}>
              {newSaving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Create Contact
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent>
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
                      contact: { headers: "Name,Email,Phone,Company,Tags,Owner", sample: "Jane Doe,jane@example.com,555-123-4567,Acme Corp,Homeowner; VIP,Alex", filename: "contacts-template.csv" },
                      customer: { headers: "Customer Name,Email,Phone,Account,Tier,Account Manager", sample: "John Smith,john@acme.com,555-987-6543,Acme Corp,VIP,Sarah", filename: "customers-template.csv" },
                      vendor: { headers: "Vendor Name,Email,Phone,Company,Trade,Managed By", sample: "Bob Builder,bob@builds.com,555-222-3333,Builder Co,Plumbing,Mike", filename: "vendors-template.csv" },
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

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`h-8 rounded-md border px-2.5 text-xs font-medium transition-colors ${active ? "border-primary/30 bg-primary-soft text-primary" : "border-border bg-background text-muted-foreground hover:bg-secondary/60"}`}
    >
      {children}
    </button>
  );
}

function Kpi({ label, value, sub, icon: Icon, tone }: { label: string; value: string; sub: string; icon: React.ComponentType<{ className?: string }>; tone: "primary" | "success" | "warning" | "muted" }) {
  const toneClass = {
    primary: "bg-primary-soft text-primary",
    success: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    warning: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    muted: "bg-secondary text-muted-foreground",
  }[tone];
  return (
    <Card className="p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
          <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>
        </div>
        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${toneClass}`}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
    </Card>
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

function ContactDrawer({
  contact,
  onOpenChange,
  onDelete,
  onNewDeal,
}: {
  contact: Contact | null;
  onOpenChange: (o: boolean) => void;
  onDelete: (c: Contact) => void;
  onNewDeal: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState(BLANK_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!contact) return;
    setEditForm({
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      address: contact.address ?? "",
      company: contact.company,
    });
    setEditing(false);
  }, [contact?.id]);

  async function handleSave() {
    if (!contact) return;
    setSaving(true);
    await updateContact(contact.id, {
      name: editForm.name,
      email: editForm.email,
      phone: editForm.phone,
      address: editForm.address,
      company: editForm.company,
    });
    // Refresh deals so deal cards show updated contact info
    refreshDeals().catch(() => {});
    setSaving(false);
    setEditing(false);
    toast.success("Contact saved");
  }

  return (
    <Sheet open={!!contact} onOpenChange={(o) => {
      // Prevent sheet close when clicking Google Places pac-container
      const active = document.querySelector(".pac-container");
      if (!o && active && document.activeElement && active.contains(document.activeElement)) return;
      onOpenChange(o);
    }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {contact && (
          <>
            <SheetHeader className="space-y-3 border-b border-border pb-4">
              <div className="flex items-start gap-3">
                <ContactAvatar id={contact.id} name={contact.name} size="lg" className="mt-0.5" />
                <div className="min-w-0 flex-1 text-left">
                  <SheetTitle className="truncate text-base">{contact.name}</SheetTitle>
                  <SheetDescription className="truncate text-xs">
                    {contact.company || "No company"} · Owned by {contact.owner}
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
            </SheetHeader>

            <Tabs defaultValue="overview" className="mt-4">
              <TabsList className="w-full justify-start gap-1 bg-transparent p-0">
                {["overview", "activity", "related", "notes"].map((t) => (
                  <TabsTrigger
                    key={t}
                    value={t}
                    className="rounded-md px-3 py-1.5 text-xs capitalize data-[state=active]:bg-secondary data-[state=active]:shadow-none"
                  >
                    {t}
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
                          onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label className="text-xs">Phone</Label>
                        <Input
                          type="tel"
                          inputMode="tel"
                          value={editForm.phone}
                          onChange={(e) => setEditForm((f) => ({ ...f, phone: formatPhone(e.target.value) }))}
                          placeholder="(555) 123-4567"
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label className="text-xs">Company</Label>
                        <Input
                          value={editForm.company}
                          onChange={(e) => setEditForm((f) => ({ ...f, company: e.target.value }))}
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
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={handleSave} disabled={saving}>
                        {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}
                        Save
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <Field label="Email" value={contact.email} />
                      <Field label="Phone" value={displayPhone(contact.phone)} />
                      <Field label="Company" value={contact.company} />
                      <Field label="Owner" value={contact.owner} />
                      {contact.address && <Field label="Address" value={contact.address} />}
                    </div>
                    <Separator />
                    <div>
                      <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Tags</div>
                      <div className="flex flex-wrap gap-1.5">
                        {contact.tags.length > 0
                          ? contact.tags.map((t) => (
                            <Badge key={t} variant="secondary" className="h-6 rounded text-[11px]">{t}</Badge>
                          ))
                          : <span className="text-xs text-muted-foreground">No tags</span>
                        }
                      </div>
                    </div>
                    <Separator />
                    <div className="rounded-md border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
                      Created {formatDistanceToNow(new Date(contact.createdAt), { addSuffix: true })} · Last activity {formatDistanceToNow(new Date(contact.lastActivity), { addSuffix: true })}.
                    </div>
                  </>
                )}
              </TabsContent>

              <TabsContent value="activity" className="mt-4">
                <ActivityTab contact={contact} />
              </TabsContent>

              <TabsContent value="related" className="mt-4">
                <RelatedTab contactId={contact.id} />
              </TabsContent>

              <TabsContent value="notes" className="mt-4">
                <div className="flex flex-col items-center py-8 text-center">
                  <StickyNote className="mb-2 h-8 w-8 text-muted-foreground/30" />
                  <div className="text-sm font-medium">No notes yet</div>
                  <div className="mt-1 text-xs text-muted-foreground">Notes for this contact will appear here.</div>
                </div>
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
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

// ── Related tab (real Supabase data) ─────────────────────────────────────────

type RelatedProject = { id: string; name: string; status: string; completion_percentage: number | null };
type RelatedEstimate = { id: string; title: string | null; number: string | null; status: string | null; total: number | null; created_at: string };

function RelatedTab({ contactId }: { contactId: string }) {
  const [projects, setProjects] = useState<RelatedProject[]>([]);
  const [estimates, setEstimates] = useState<RelatedEstimate[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const orgId = await getOrgId();
      if (!orgId || cancelled) { setLoading(false); return; }

      const [{ data: proj }, { data: est }] = await Promise.all([
        supabase
          .from("projects")
          .select("id, name, status, completion_percentage")
          .eq("client_id", contactId)
          .eq("org_id", orgId)
          .order("created_at", { ascending: false }),
        supabase
          .from("estimates")
          .select("id, title, number, status, total, created_at")
          .eq("client_id", contactId)
          .eq("org_id", orgId)
          .order("created_at", { ascending: false }),
      ]);

      if (!cancelled) {
        setProjects((proj as RelatedProject[]) ?? []);
        setEstimates((est as RelatedEstimate[]) ?? []);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [contactId]);

  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  const hasAny = projects.length > 0 || estimates.length > 0;

  if (!hasAny) {
    return (
      <div className="flex flex-col items-center py-8 text-center">
        <Briefcase className="mb-2 h-8 w-8 text-muted-foreground/30" />
        <div className="text-sm font-medium">No linked projects or estimates</div>
        <div className="mt-1 text-xs text-muted-foreground">Projects and estimates linked to this contact will appear here.</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {projects.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Projects ({projects.length})
          </div>
          <div className="space-y-2">
            {projects.map((p) => (
              <div key={p.id} className="flex items-center gap-3 rounded-md border border-border bg-card p-3">
                <Briefcase className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{p.name}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground capitalize">
                    {p.status?.replace(/_/g, " ")}
                    {p.completion_percentage != null ? ` · ${p.completion_percentage}% complete` : ""}
                  </div>
                </div>
                <Badge variant="secondary" className="h-5 shrink-0 rounded px-1.5 text-[10px] capitalize">
                  {p.status?.replace(/_/g, " ")}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      {estimates.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Estimates ({estimates.length})
          </div>
          <div className="space-y-2">
            {estimates.map((e) => (
              <div key={e.id} className="flex items-center gap-3 rounded-md border border-border bg-card p-3">
                <FileTextIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {e.title || e.number || "Estimate"}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {formatDistanceToNow(new Date(e.created_at), { addSuffix: true })}
                    {e.total != null ? ` · ${formatMoney(e.total)}` : ""}
                  </div>
                </div>
                <Badge
                  variant="secondary"
                  className={`h-5 shrink-0 rounded px-1.5 text-[10px] capitalize ${
                    e.status === "approved" ? "bg-emerald-500/10 text-emerald-600" :
                    e.status === "sent" ? "bg-sky-500/10 text-sky-600" :
                    e.status === "draft" ? "bg-secondary text-muted-foreground" : ""
                  }`}
                >
                  {e.status || "draft"}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Find Duplicates dialog ────────────────────────────────────────────────────

function FindDuplicatesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [loading, setLoading] = useState(false);
  const [groups, setGroups] = useState<any[][]>([]);
  const [selected, setSelected] = useState<Record<number, string>>({});
  const [merging, setMerging] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    detect();
  }, [open]);

  async function detect() {
    setLoading(true);
    setGroups([]);
    try {
      const orgId = await getOrgId();
      if (!orgId) return;

      const { data } = await supabase
        .from("contacts")
        .select("id, full_name, email, phone, address, created_at")
        .eq("org_id", orgId)
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

  async function handleMerge(groupIdx: number) {
    const group = groups[groupIdx];
    const primaryId = selected[groupIdx];
    if (!primaryId) return;

    setMerging(groupIdx);
    try {
      const primary = group.find((c: any) => c.id === primaryId);
      const duplicates = group.filter((c: any) => c.id !== primaryId);

      // Copy non-null fields from duplicates into primary
      const patch: Record<string, any> = {};
      for (const dup of duplicates) {
        if (!primary.email && dup.email) patch.email = dup.email;
        if (!primary.phone && dup.phone) patch.phone = dup.phone;
        if (!primary.address && dup.address) patch.address = dup.address;
      }

      if (Object.keys(patch).length > 0) {
        await supabase.from("contacts").update(patch).eq("id", primaryId);
      }

      const dupIds = duplicates.map((d: any) => d.id as string);

      // Reroute foreign keys to kept record
      await Promise.all([
        supabase.from("projects").update({ client_id: primaryId }).in("client_id", dupIds),
        supabase.from("estimates").update({ client_id: primaryId }).in("client_id", dupIds),
        supabase.from("leads").update({ contact_id: primaryId }).in("contact_id", dupIds),
      ]);

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
