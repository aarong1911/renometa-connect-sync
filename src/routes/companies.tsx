// src/routes/companies.tsx
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Plus, Search, Globe, Phone, Mail, MapPin, MoreHorizontal, Loader2, Pencil, Trash2, Building2, Users,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { formatDistanceToNow } from "date-fns";
import { useTopbarAction } from "@/lib/topbar-action";

export const Route = createFileRoute("/companies")({ component: CompaniesPage });

type Company = {
  id: string;
  org_id: string;
  name: string;
  industry: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

// ── Phone formatter ──
function fmtPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 10);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0,3)}-${digits.slice(3)}`;
  return `${digits.slice(0,3)}-${digits.slice(3,6)}-${digits.slice(6)}`;
}

async function getOrgId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: p } = await supabase.from("profiles").select("organization_id").eq("id", user.id).maybeSingle();
  if (p?.organization_id) return p.organization_id;
  const { data: m } = await supabase.from("org_memberships").select("org_id").eq("member_id", user.id).maybeSingle();
  return m?.org_id ?? null;
}

function CompaniesPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Company | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const load = useCallback(async () => {
    const orgId = await getOrgId();
    if (!orgId) { setLoading(false); return; }
    const { data, error } = await supabase
      .from("companies").select("*").eq("org_id", orgId).order("name");
    if (error) { console.error("[companies]", error); setLoading(false); return; }
    setCompanies(data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return companies;
    return companies.filter(c =>
      c.name.toLowerCase().includes(q) ||
      (c.industry ?? "").toLowerCase().includes(q) ||
      (c.city ?? "").toLowerCase().includes(q)
    );
  }, [companies, search]);

  const handleDelete = async (id: string, name: string) => {
    const { error } = await supabase.from("companies").delete().eq("id", id);
    if (error) { toast.error("Failed to delete"); return; }
    toast.success(`${name} deleted`);
    setSelected(null);
    load();
  };

  // Refresh selected company after edit
  const handleEdited = async (updated: Company) => {
    setSelected(updated);
    await load();
    setEditOpen(false);
  };

  useTopbarAction(
    <Button size="sm" onClick={() => setAddOpen(true)}>
      <Plus className="mr-1.5 h-3.5 w-3.5" /> Add Company
    </Button>,
  );

  return (
    <>
      <PageHeader
        icon={Building2}
        iconBg="bg-gold-soft"
        iconColor="text-gold-hover"
        title="Companies"
        subtitle="Manage contractor accounts and client organizations."
        breadcrumb={["CRM", "Companies"]}
      />

      {/* Stats */}
      <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Total companies" value={companies.length} icon={Building2} tone="info" />
        <MetricCard label="With website" value={companies.filter(c => c.website).length} icon={Globe} tone="violet" />
        <MetricCard label="With email" value={companies.filter(c => c.email).length} icon={Mail} tone="success" />
        <MetricCard label="With phone" value={companies.filter(c => c.phone).length} icon={Phone} tone="gold" />
      </div>

      {/* Search */}
      <Card className="mb-3 p-2.5">
        <div className="relative max-w-sm">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search companies…" value={search} onChange={e => setSearch(e.target.value)} className="h-8 pl-8 text-sm" />
        </div>
      </Card>

      {/* Table */}
      <Card className="overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-secondary/60 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            <tr className="border-b border-border">
              <th className="py-2.5 pl-4 pr-3 text-left">Company</th>
              <th className="py-2.5 pr-4 text-left">Industry</th>
              <th className="py-2.5 pr-4 text-left">Location</th>
              <th className="py-2.5 pr-4 text-left">Contact</th>
              <th className="py-2.5 pr-4 text-left">Added</th>
              <th className="w-10 py-2.5 pr-3" />
            </tr>
          </thead>
          <tbody>
            {loading && Array.from({ length: 5 }).map((_, i) => (
              <tr key={i} className="border-b border-border">
                {Array.from({ length: 5 }).map((_, j) => <td key={j} className="py-3 pr-4"><Skeleton className="h-4 w-28" /></td>)}
                <td />
              </tr>
            ))}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={6} className="py-12 text-center text-sm text-muted-foreground">
                {search ? "No companies match your search." : "No companies yet — add one to get started."}
              </td></tr>
            )}
            {!loading && filtered.map(c => (
              <tr key={c.id} onClick={() => setSelected(c)} className="cursor-pointer border-b border-border hover:bg-secondary/30">
                <td className="py-2.5 pl-4 pr-3">
                  <div className="flex items-center gap-2.5">
                    <Avatar className="h-8 w-8">
                      <AvatarFallback className="bg-primary-soft text-[11px] font-semibold text-primary">{c.name.slice(0, 2).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <span className="font-medium">{c.name}</span>
                  </div>
                </td>
                <td className="py-2.5 pr-4 text-muted-foreground">{c.industry || "—"}</td>
                <td className="py-2.5 pr-4 text-muted-foreground">{[c.city, c.state].filter(Boolean).join(", ") || "—"}</td>
                <td className="py-2.5 pr-4">
                  <div className="flex items-center gap-2">
                    {c.email && <a href={`mailto:${c.email}`} className="text-muted-foreground hover:text-foreground" onClick={e => e.stopPropagation()}><Mail className="h-3.5 w-3.5" /></a>}
                    {c.phone && <a href={`tel:${c.phone}`} className="text-muted-foreground hover:text-foreground" onClick={e => e.stopPropagation()}><Phone className="h-3.5 w-3.5" /></a>}
                    {c.website && <a href={c.website} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground" onClick={e => e.stopPropagation()}><Globe className="h-3.5 w-3.5" /></a>}
                    {!c.email && !c.phone && !c.website && <span className="text-[11px] text-muted-foreground">—</span>}
                  </div>
                </td>
                <td className="py-2.5 pr-4 text-[11px] text-muted-foreground">{formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}</td>
                <td className="py-2.5 pr-3" onClick={e => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7"><MoreHorizontal className="h-3.5 w-3.5" /></Button></DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => { setSelected(c); setEditOpen(true); }}><Pencil className="mr-2 h-3.5 w-3.5" />Edit</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive" onClick={() => handleDelete(c.id, c.name)}><Trash2 className="mr-2 h-3.5 w-3.5" />Delete</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/* Detail drawer */}
      <Sheet open={!!selected} onOpenChange={o => !o && setSelected(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          {selected && (
            <>
              <SheetHeader className="border-b border-border pb-4">
                <div className="flex items-center gap-3">
                  <Avatar className="h-12 w-12">
                    <AvatarFallback className="bg-primary-soft text-sm font-semibold text-primary">{selected.name.slice(0,2).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <SheetTitle className="text-base">{selected.name}</SheetTitle>
                    <SheetDescription className="text-xs">{selected.industry || "No industry set"}</SheetDescription>
                  </div>
                </div>
                <div className="flex gap-2 pt-2">
                  <Button size="sm" variant="outline" className="flex-1 h-8" onClick={() => setEditOpen(true)}>
                    <Pencil className="h-3.5 w-3.5 mr-1.5" />Edit
                  </Button>
                  {selected.email && <a href={`mailto:${selected.email}`} className="flex-1"><Button size="sm" variant="outline" className="w-full h-8"><Mail className="h-3.5 w-3.5 mr-1.5" />Email</Button></a>}
                  {selected.phone && <a href={`tel:${selected.phone}`} className="flex-1"><Button size="sm" variant="outline" className="w-full h-8"><Phone className="h-3.5 w-3.5 mr-1.5" />Call</Button></a>}
                </div>
              </SheetHeader>
              <div className="mt-4 space-y-4 text-sm">
                {selected.phone && (
                  <div><div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Phone</div>
                    <a href={`tel:${selected.phone}`} className="flex items-center gap-1.5 text-foreground hover:text-primary"><Phone className="h-3.5 w-3.5 text-muted-foreground" />{selected.phone}</a>
                  </div>
                )}
                {selected.email && (
                  <div><div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Email</div>
                    <a href={`mailto:${selected.email}`} className="flex items-center gap-1.5 text-foreground hover:text-primary"><Mail className="h-3.5 w-3.5 text-muted-foreground" />{selected.email}</a>
                  </div>
                )}
                {selected.website && (
                  <div><div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Website</div>
                    <a href={selected.website} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-primary hover:underline"><Globe className="h-3.5 w-3.5" />{selected.website}</a>
                  </div>
                )}
                {(selected.address || selected.city) && (
                  <div><div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Address</div>
                    <a href={`https://maps.google.com/?q=${encodeURIComponent([selected.address, selected.city, selected.state, selected.zip].filter(Boolean).join(", "))}`} target="_blank" rel="noopener noreferrer" className="flex items-start gap-1.5 text-muted-foreground hover:text-foreground">
                      <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>{[selected.address, selected.city, selected.state, selected.zip].filter(Boolean).join(", ")}</span>
                    </a>
                  </div>
                )}
                {selected.notes && (
                  <div><div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Notes</div>
                    <p className="text-muted-foreground whitespace-pre-wrap">{selected.notes}</p>
                  </div>
                )}
                <Separator />
                <div className="rounded-md border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
                  Added {formatDistanceToNow(new Date(selected.created_at), { addSuffix: true })} · Updated {formatDistanceToNow(new Date(selected.updated_at), { addSuffix: true })}
                </div>
                <Button variant="destructive" size="sm" className="w-full" onClick={() => handleDelete(selected.id, selected.name)}>
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete Company
                </Button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <AddCompanyDialog open={addOpen} onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); load(); }} />
      {selected && (
        <EditCompanyDialog open={editOpen} company={selected} onClose={() => setEditOpen(false)} onSaved={handleEdited} />
      )}
    </>
  );
}

// ── Nominatim address autocomplete ───────────────────────────────────────────

type NominatimResult = {
  place_id: number;
  display_name: string;
  address: {
    house_number?: string;
    road?: string;
    city?: string;
    town?: string;
    village?: string;
    state?: string;
    postcode?: string;
  };
};

const STATE_ABBR: Record<string, string> = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA",
  Colorado: "CO", Connecticut: "CT", Delaware: "DE", Florida: "FL", Georgia: "GA",
  Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA",
  Kansas: "KS", Kentucky: "KY", Louisiana: "LA", Maine: "ME", Maryland: "MD",
  Massachusetts: "MA", Michigan: "MI", Minnesota: "MN", Mississippi: "MS",
  Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV",
  "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY",
  "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK",
  Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI", "South Carolina": "SC",
  "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT",
  Vermont: "VT", Virginia: "VA", Washington: "WA", "West Virginia": "WV",
  Wisconsin: "WI", Wyoming: "WY",
};

type AddressFields = { address: string; city: string; state: string; zip: string };

function CompanyAddressInput({
  value,
  onChange,
  onSelect,
}: {
  value: string;
  onChange: (v: string) => void;
  onSelect: (fields: AddressFields) => void;
}) {
  const [suggestions, setSuggestions] = useState<NominatimResult[]>([]);
  const [open, setOpen] = useState(false);
  const [fetching, setFetching] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const search = useCallback(async (q: string) => {
    if (q.length < 4) { setSuggestions([]); setOpen(false); return; }
    setFetching(true);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&addressdetails=1&countrycodes=us&limit=5`,
        { headers: { "Accept-Language": "en" } },
      );
      if (!res.ok) throw new Error("Network error");
      const data: NominatimResult[] = await res.json();
      setSuggestions(data);
      setOpen(data.length > 0);
    } catch {
      setSuggestions([]);
      setOpen(false);
    } finally {
      setFetching(false);
    }
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    onChange(val);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => search(val), 400);
  };

  const handleSelect = (r: NominatimResult) => {
    const a = r.address;
    const street = [a.house_number ?? "", a.road ?? ""].filter(Boolean).join(" ");
    const city = a.city ?? a.town ?? a.village ?? "";
    const state = a.state ? (STATE_ABBR[a.state] ?? a.state) : "";
    const zip = a.postcode ?? "";
    onSelect({ address: street, city, state, zip });
    setSuggestions([]);
    setOpen(false);
  };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <MapPin className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <Input
          value={value}
          onChange={handleChange}
          placeholder="123 Main St"
          className="pl-8"
          autoComplete="off"
        />
        {fetching && (
          <Loader2 className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
      </div>
      {open && suggestions.length > 0 && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-popover shadow-lg">
          <ul className="py-1 text-sm">
            {suggestions.map((r) => (
              <li
                key={r.place_id}
                className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-accent hover:text-accent-foreground"
                onMouseDown={(e) => { e.preventDefault(); handleSelect(r); }}
              >
                <MapPin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{r.display_name}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Shared form fields ────────────────────────────────────────────────────────

type CompanyForm = {
  name: string; industry: string; website: string; phone: string; email: string;
  address: string; city: string; state: string; zip: string; notes: string;
  contact_name: string; contact_email: string; contact_phone: string;
};

function blankForm(): CompanyForm {
  return { name: "", industry: "", website: "", phone: "", email: "", address: "", city: "", state: "", zip: "", notes: "", contact_name: "", contact_email: "", contact_phone: "" };
}

function formFromCompany(c: Company): CompanyForm {
  return { name: c.name, industry: c.industry ?? "", website: c.website ?? "", phone: c.phone ?? "", email: c.email ?? "", address: c.address ?? "", city: c.city ?? "", state: c.state ?? "", zip: c.zip ?? "", notes: c.notes ?? "", contact_name: "", contact_email: "", contact_phone: "" };
}

function CompanyFormFields({ form, setForm }: { form: CompanyForm; setForm: (f: CompanyForm) => void }) {
  const set = (k: keyof CompanyForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [k]: e.target.value });

  const handlePhone = (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, phone: fmtPhone(e.target.value) });

  const handleContactPhone = (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, contact_phone: fmtPhone(e.target.value) });

  return (
    <div className="space-y-4">
      {/* Company info */}
      <div>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Company Info</div>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1"><Label className="text-xs">Company name *</Label><Input value={form.name} onChange={set("name")} placeholder="Acme Contractors" /></div>
          <div className="space-y-1"><Label className="text-xs">Industry</Label><Input value={form.industry} onChange={set("industry")} placeholder="General Contracting" /></div>
          <div className="space-y-1"><Label className="text-xs">Website</Label><Input value={form.website} onChange={set("website")} placeholder="https://acme.com" /></div>
          <div className="space-y-1"><Label className="text-xs">Phone</Label>
            <Input value={form.phone} onChange={handlePhone} placeholder="555-123-4567" inputMode="tel" />
          </div>
          <div className="space-y-1"><Label className="text-xs">Email</Label><Input value={form.email} onChange={set("email")} placeholder="info@acme.com" type="email" /></div>
        </div>
      </div>

      {/* Address with native autocomplete */}
      <div>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Address</div>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1">
            <Label className="text-xs">Street address</Label>
            <CompanyAddressInput
              value={form.address}
              onChange={(v) => setForm({ ...form, address: v })}
              onSelect={(fields) => setForm({ ...form, ...fields })}
            />
          </div>
          <div className="space-y-1"><Label className="text-xs">City</Label><Input value={form.city} onChange={set("city")} placeholder="Miami" autoComplete="address-level2" /></div>
          <div className="space-y-1"><Label className="text-xs">State</Label><Input value={form.state} onChange={set("state")} placeholder="FL" autoComplete="address-level1" /></div>
          <div className="space-y-1"><Label className="text-xs">ZIP</Label><Input value={form.zip} onChange={set("zip")} placeholder="33101" autoComplete="postal-code" /></div>
        </div>
      </div>

      {/* Primary contact */}
      <div>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Primary Contact</div>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1"><Label className="text-xs">Contact name</Label><Input value={form.contact_name} onChange={set("contact_name")} placeholder="John Smith" autoComplete="name" /></div>
          <div className="space-y-1"><Label className="text-xs">Contact email</Label><Input value={form.contact_email} onChange={set("contact_email")} placeholder="john@acme.com" type="email" /></div>
          <div className="space-y-1"><Label className="text-xs">Contact phone</Label>
            <Input value={form.contact_phone} onChange={handleContactPhone} placeholder="555-123-4567" inputMode="tel" />
          </div>
        </div>
      </div>

      {/* Notes */}
      <div className="space-y-1"><Label className="text-xs">Notes</Label><Textarea value={form.notes} onChange={set("notes")} rows={2} placeholder="Internal notes…" /></div>
    </div>
  );
}

// ── Add dialog ────────────────────────────────────────────────────────────────

function AddCompanyDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<CompanyForm>(blankForm());

  const handleSave = async () => {
    if (!form.name.trim()) { toast.error("Company name is required"); return; }
    setSaving(true);
    const orgId = await getOrgId();
    if (!orgId) { toast.error("Could not determine organization"); setSaving(false); return; }

    const { data: company, error } = await supabase.from("companies").insert({
      org_id: orgId,
      name: form.name.trim(),
      industry: form.industry || null,
      website: form.website || null,
      phone: form.phone || null,
      email: form.email || null,
      address: form.address || null,
      city: form.city || null,
      state: form.state || null,
      zip: form.zip || null,
      notes: form.notes || null,
    }).select("id").single();

    // If contact name provided, create a contact linked to the company
    if (!error && company && form.contact_name.trim()) {
      await supabase.from("contacts").insert({
        org_id: orgId,
        full_name: form.contact_name.trim(),
        email: form.contact_email || null,
        phone: form.contact_phone || null,
        labels: ["Company Contact"],
      });
    }

    setSaving(false);
    if (error) { toast.error("Failed to save: " + error.message); return; }
    toast.success("Company added");
    setForm(blankForm());
    onSaved();
  };

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>New Company</DialogTitle><DialogDescription>Add a contractor or client company.</DialogDescription></DialogHeader>
        <CompanyFormFields form={form} setForm={setForm} />
        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save Company"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit dialog ───────────────────────────────────────────────────────────────

function EditCompanyDialog({ open, company, onClose, onSaved }: { open: boolean; company: Company; onClose: () => void; onSaved: (c: Company) => void }) {
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<CompanyForm>(() => formFromCompany(company));

  useEffect(() => { if (open) setForm(formFromCompany(company)); }, [open, company]);

  const handleSave = async () => {
    if (!form.name.trim()) { toast.error("Company name is required"); return; }
    setSaving(true);
    const { data, error } = await supabase.from("companies").update({
      name: form.name.trim(),
      industry: form.industry || null,
      website: form.website || null,
      phone: form.phone || null,
      email: form.email || null,
      address: form.address || null,
      city: form.city || null,
      state: form.state || null,
      zip: form.zip || null,
      notes: form.notes || null,
      updated_at: new Date().toISOString(),
    }).eq("id", company.id).select().single();
    setSaving(false);
    if (error) { toast.error("Failed to save: " + error.message); return; }
    toast.success("Company updated");
    onSaved(data as Company);
  };

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Edit Company</DialogTitle><DialogDescription>Update company details.</DialogDescription></DialogHeader>
        <CompanyFormFields form={form} setForm={setForm} />
        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save Changes"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}