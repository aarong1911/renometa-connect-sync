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
  UserPlus,
  Users,
  X,
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
import { useTopbarAction } from "@/lib/topbar-action";

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

function slugifyAccountName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "account";
}

async function createUniqueAccountSlug(
  orgId: string,
  accountName: string,
): Promise<string> {
  const baseSlug = slugifyAccountName(accountName);
  let candidate = baseSlug;
  let suffix = 2;

  while (true) {
    const { data, error } = await supabase
      .from("companies")
      .select("id")
      .eq("org_id", orgId)
      .eq("slug", candidate)
      .maybeSingle();

    if (error) throw error;
    if (!data) return candidate;

    candidate = `${baseSlug}-${suffix}`;
    suffix += 1;
  }
}

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
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState("Active");
  const [selected, setSelected] = useState<Company | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Company | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Company | null>(null);

  const loadCompanies = useCallback(async () => {
    setLoading(true);
    const orgId = await getOrgId();
    if (!orgId) {
      toast.error("Could not determine your workspace.");
      setLoading(false);
      return;
    }

    const { data, error } = await supabase
      .from("companies")
      .select("*")
      .eq("org_id", orgId)
      .order("name");

    if (error) {
      console.error("[accounts]", error);
      toast.error("Could not load accounts.");
    } else {
      setCompanies((data ?? []) as Company[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadCompanies();
  }, [loadCompanies]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return companies.filter((company) => {
      const matchesSearch =
        !query ||
        company.name.toLowerCase().includes(query) ||
        (company.industry ?? "").toLowerCase().includes(query) ||
        (company.city ?? "").toLowerCase().includes(query) ||
        (company.email ?? "").toLowerCase().includes(query) ||
        (company.tags ?? []).some((tag) => tag.toLowerCase().includes(query));

      return (
        matchesSearch &&
        (typeFilter === "All" || company.account_type === typeFilter) &&
        (statusFilter === "All" || company.status === statusFilter)
      );
    });
  }, [companies, search, typeFilter, statusFilter]);

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (company: Company) => {
    setEditing(company);
    setFormOpen(true);
  };

  const deleteCompany = async () => {
    if (!deleteTarget) return;

    const { error } = await supabase
      .from("companies")
      .delete()
      .eq("id", deleteTarget.id)
      .eq("org_id", deleteTarget.org_id);

    if (error) {
      toast.error("Could not delete the account.");
      return;
    }

    toast.success(`${deleteTarget.name} deleted.`);
    if (selected?.id === deleteTarget.id) setSelected(null);
    setDeleteTarget(null);
    await loadCompanies();
  };

  useTopbarAction(
    <Button size="sm" onClick={openCreate}>
      <Plus className="mr-1.5 h-3.5 w-3.5" />
      Add Account
    </Button>,
  );

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
        breadcrumb={["CRM", "Accounts"]}
      />

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
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search accounts, industries, cities, email, or tags…"
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
                <th className="py-2.5 pr-4 text-left">Status</th>
                <th className="py-2.5 pr-4 text-left">Updated</th>
                <th className="w-10 py-2.5 pr-3" />
              </tr>
            </thead>
            <tbody>
              {loading &&
                Array.from({ length: 5 }).map((_, index) => (
                  <tr key={index} className="border-b border-border">
                    {Array.from({ length: 7 }).map((__, column) => (
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
                    colSpan={8}
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
              </SheetHeader>

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
  const logoInputRef = useRef<HTMLInputElement>(null);

  const update = <K extends keyof CompanyForm>(
    key: K,
    value: CompanyForm[K],
  ) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  useEffect(() => {
    setForm(company ? companyToForm(company) : EMPTY_FORM);
    setSelectedLogoFile(null);
    setLogoPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return "";
    });
    setNewTag("");
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

    setSaving(true);
    try {
      const orgId = await getOrgId();
      if (!orgId) throw new Error("Could not determine workspace.");

      let savedCompany: Company;

      if (company) {
        const updatePayload = {
          ...companyPayload(form),
          ...(!company.slug
            ? {
                slug: await createUniqueAccountSlug(
                  orgId,
                  form.name.trim(),
                ),
              }
            : {}),
        };

        const { data, error } = await supabase
          .from("companies")
          .update(updatePayload)
          .eq("id", company.id)
          .eq("org_id", orgId)
          .select("*")
          .single();

        if (error) throw error;
        savedCompany = data as Company;
      } else {
        const slug = await createUniqueAccountSlug(
          orgId,
          form.name.trim(),
        );

        const { data, error } = await supabase
          .from("companies")
          .insert({
            ...companyPayload(form),
            org_id: orgId,
            slug,
          })
          .select("*")
          .single();

        if (error) throw error;
        savedCompany = data as Company;
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
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() => void save()}
            disabled={saving || uploadingLogo}
          >
            {saving ? "Saving…" : company ? "Save Changes" : "Create Account"}
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