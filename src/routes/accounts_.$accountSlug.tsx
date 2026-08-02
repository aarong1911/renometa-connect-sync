import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { format, formatDistanceToNow } from "date-fns";
import {
  Activity,
  BriefcaseBusiness,
  Building2,
  CalendarClock,
  CalendarDays,
  CircleDollarSign,
  ExternalLink,
  FileText,
  FolderKanban,
  Globe,
  Mail,
  MapPin,
  MessageSquareText,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Phone,
  Pin,
  Plus,
  StickyNote,
  Trash2,
  Upload,
  UserPlus,
  Users,
  WalletCards,
} from "lucide-react";
import { toast } from "sonner";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ContactAvatar } from "@/components/ui/contact-avatar";
import { NewDealDialog } from "@/components/sales/new-deal-dialog";
import { EntityAppointmentsPanel } from "@/components/appointments/entity-appointments-panel";
import { EntityEstimatesPanel } from "@/components/estimates/entity-estimates-panel";
import { AppointmentDialog } from "@/components/calendar/appointment-dialog";
import { AccountRelatedDeals } from "@/components/accounts/account-related-deals";
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
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { formatMoney, formatDateShort } from "@/lib/format";
import { fetchCompanyBySlug, updateCompany, findCompanyDuplicateCandidates, type CompanyDuplicateCandidate } from "@/lib/companies-store";
import { useDeals } from "@/lib/deals-store";

export const Route = createFileRoute("/accounts_/$accountSlug")({
  component: AccountDetailsPage,
});

type Company = {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  account_type: string;
  status: string;
  industry: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  owner_name: string | null;
  logo_url: string | null;
  tags: string[] | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type ContactOption = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  avatar_url?: string | null;
  avatar_key?: string | null;
};

type LinkedContact = {
  id: string;
  contact_id: string;
  relationship_title: string | null;
  is_primary: boolean;
  contact: ContactOption | null;
};

type CompanyNote = {
  id: string;
  title?: string | null;
  body?: string | null;
  note?: string | null;
  content?: string | null;
  is_pinned?: boolean | null;
  author_name?: string | null;
  created_at: string;
  updated_at?: string | null;
};

type CompanyActivity = {
  id: string;
  activity_type: string;
  title: string;
  description: string | null;
  occurred_at?: string | null;
  created_at: string;
  created_by_name?: string | null;
};

// Company-level Projects/Estimates/Invoices (Priority 6/7) — projects,
// estimates, and invoices have no company_id column at all (confirmed via a
// live schema check). Rather than free-text company-name matching, these
// are resolved via the real, ID-based chain: contacts.company_id (the
// canonical direct contact→company link, distinct from the many-to-many
// company_contacts table — see the Phase 9.4 report for the reconciliation
// of the two) → projects/estimates.client_id / invoices.client_id. This is
// explicitly an indirect, contact-mediated count/list, not a direct FK —
// documented here and in the report rather than presented as authoritative
// company-level data.
type RelatedProject = { id: string; name: string; status: string; completion_percentage: number | null };
type RelatedEstimate = { id: string; title: string | null; number: string | null; status: string | null; total: number | null; valid_until: string | null; created_at: string };
type RelatedInvoice = { id: string; invoice_number: string | null; status: string | null; total_amount: number | null; amount_paid: number | null; due_date: string | null };
type DealActivityRow = { id: string; deal_id: string; activity_type: string; title: string; description: string | null; actor_name: string | null; occurred_at: string };
type AppointmentActivityRow = {
  id: string; activity_type: string; actor_id: string | null; created_at: string;
  appointments: { title: string | null; service: string | null; contact_name: string | null } | null;
};

const APPOINTMENT_ACTIVITY_LABELS: Record<string, string> = {
  created: "Appointment scheduled",
  rescheduled: "Appointment rescheduled",
  confirmed: "Appointment confirmed",
  started: "Appointment started",
  completed: "Appointment completed",
  reopened: "Appointment reopened",
  cancelled: "Appointment cancelled",
  restored: "Appointment restored",
  marked_no_show: "Appointment marked No Show",
  assigned: "Appointment assigned",
  unassigned: "Appointment unassigned",
  relationship_changed: "Appointment relationship changed",
  location_changed: "Appointment location changed",
};

type AddContactMode = "existing" | "new";

type EditCompanyForm = {
  name: string;
  account_type: string;
  status: string;
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
};

const TAB_ITEMS = [
  { value: "overview", label: "Overview", icon: Activity },
  { value: "contacts", label: "Contacts", icon: Users },
  { value: "activity", label: "Activity", icon: MessageSquareText },
  { value: "opportunities", label: "Opportunities", icon: BriefcaseBusiness },
  { value: "projects", label: "Projects", icon: FolderKanban },
  { value: "appointments", label: "Appointments", icon: CalendarClock },
  { value: "financials", label: "Financials", icon: WalletCards },
  { value: "files", label: "Files", icon: Paperclip },
  { value: "notes", label: "Notes", icon: StickyNote },
] as const;

type TabValue = (typeof TAB_ITEMS)[number]["value"];

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

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function formatPhone(value: string | null): string {
  if (!value) return "";
  const digits = value.replace(/\D/g, "").slice(0, 10);
  if (digits.length !== 10) return value;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function accountTypeClass(type: string): string {
  const key = type.toLowerCase();
  if (key.includes("customer")) return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (key.includes("prospect")) return "border-blue-200 bg-blue-50 text-blue-700";
  if (key.includes("property")) return "border-cyan-200 bg-cyan-50 text-cyan-700";
  if (key.includes("vendor") || key.includes("supplier"))
    return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function noteText(note: CompanyNote): string {
  return note.body || note.note || note.content || "";
}

function companyToEditForm(company: Company): EditCompanyForm {
  return {
    name: company.name,
    account_type: company.account_type,
    status: company.status,
    industry: company.industry ?? "",
    owner_name: company.owner_name ?? "",
    email: company.email ?? "",
    phone: formatPhone(company.phone),
    website: company.website ?? "",
    address: company.address ?? "",
    city: company.city ?? "",
    state: company.state ?? "",
    zip: company.zip ?? "",
    country: company.country ?? "United States",
  };
}

function AccountDetailsPage() {
  const { accountSlug } = Route.useParams();
  const navigate = useNavigate();
  const [company, setCompany] = useState<Company | null>(null);
  const [contacts, setContacts] = useState<LinkedContact[]>([]);
  const [contactOptions, setContactOptions] = useState<ContactOption[]>([]);
  const [notes, setNotes] = useState<CompanyNote[]>([]);
  const [activities, setActivities] = useState<CompanyActivity[]>([]);
  const [projects, setProjects] = useState<RelatedProject[]>([]);
  const [estimates, setEstimates] = useState<RelatedEstimate[]>([]);
  const [invoices, setInvoices] = useState<RelatedInvoice[]>([]);
  const [dealActivities, setDealActivities] = useState<DealActivityRow[]>([]);
  const [appointmentActivities, setAppointmentActivities] = useState<AppointmentActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [activeTab, setActiveTab] = useState<TabValue>("overview");
  const [editOpen, setEditOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [newDealOpen, setNewDealOpen] = useState(false);
  const [editingNote, setEditingNote] = useState<CompanyNote | null>(null);

  const loadAccount = useCallback(async () => {
    setLoading(true);
    setNotFound(false);

    const orgId = await getOrgId();
    if (!orgId) {
      toast.error("Could not determine your workspace.");
      setLoading(false);
      return;
    }

    // Phase 9.4 — routed through the canonical companies-store's slug
    // lookup (org-scoped, same query this page always ran) so a successful
    // load also populates the shared reactive cache other pages read from,
    // instead of this page silently keeping its own separate copy.
    const loadedCompanyFromStore = await fetchCompanyBySlug(accountSlug);

    if (!loadedCompanyFromStore) {
      setNotFound(true);
      setLoading(false);
      return;
    }

    const loadedCompany = loadedCompanyFromStore as unknown as Company;
    const resolvedCompanyId = loadedCompany.id;

    setCompany(loadedCompany);

    const [contactsResult, optionsResult, notesResult, activitiesResult] = await Promise.all([
      supabase
        .from("company_contacts")
        .select(
          "id, contact_id, relationship_title, is_primary, contact:contacts(id, full_name, email, phone, avatar_url, avatar_key)",
        )
        .eq("company_id", resolvedCompanyId)
        .eq("org_id", orgId)
        .order("is_primary", { ascending: false }),
      supabase
        .from("contacts")
        .select("id, full_name, email, phone, avatar_url, avatar_key")
        .eq("org_id", orgId)
        .order("full_name"),
      supabase
        .from("company_notes")
        .select("*")
        .eq("company_id", resolvedCompanyId)
        .eq("org_id", orgId)
        .order("is_pinned", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("company_activities")
        .select("*")
        .eq("company_id", resolvedCompanyId)
        .eq("org_id", orgId)
        .order("occurred_at", { ascending: false, nullsFirst: false })
        .limit(50),
    ]);

    if (!contactsResult.error)
      setContacts((contactsResult.data ?? []) as unknown as LinkedContact[]);
    if (!optionsResult.error) setContactOptions((optionsResult.data ?? []) as ContactOption[]);
    if (!notesResult.error) setNotes((notesResult.data ?? []) as CompanyNote[]);
    if (!activitiesResult.error) setActivities((activitiesResult.data ?? []) as CompanyActivity[]);

    // Projects/Estimates/Invoices (Priority 6/7) — resolved via the direct
    // contacts.company_id link (not company_contacts, and not free-text
    // name matching). Also real deal_activities for this company's deals
    // (deals.company_id is a real direct FK), merged into Activity below.
    const [{ data: directContacts }, { data: companyDeals }] = await Promise.all([
      supabase.from("contacts").select("id").eq("org_id", orgId).eq("company_id", resolvedCompanyId),
      supabase.from("deals").select("id").eq("org_id", orgId).eq("company_id", resolvedCompanyId),
    ]);
    const directContactIds = (directContacts ?? []).map((c: any) => c.id as string);
    const dealIds = (companyDeals ?? []).map((d: any) => d.id as string);

    const [projectsResult, estimatesResult, invoicesResult, dealActivityResult] = await Promise.all([
      directContactIds.length > 0
        ? supabase.from("projects").select("id, name, status, completion_percentage").eq("org_id", orgId).in("client_id", directContactIds).order("created_at", { ascending: false })
        : Promise.resolve({ data: [], error: null } as any),
      directContactIds.length > 0
        ? supabase.from("estimates").select("id, title, number, status, total, valid_until, created_at").eq("org_id", orgId).in("client_id", directContactIds).order("created_at", { ascending: false })
        : Promise.resolve({ data: [], error: null } as any),
      directContactIds.length > 0
        ? supabase.from("invoices").select("id, invoice_number, status, total_amount, amount_paid, due_date").eq("org_id", orgId).in("client_id", directContactIds).order("issue_date", { ascending: false })
        : Promise.resolve({ data: [], error: null } as any),
      dealIds.length > 0
        ? supabase.from("deal_activities").select("id, deal_id, activity_type, title, description, actor_name, occurred_at").eq("org_id", orgId).in("deal_id", dealIds).order("occurred_at", { ascending: false }).limit(50)
        : Promise.resolve({ data: [], error: null } as any),
    ]);

    if (!projectsResult.error) setProjects((projectsResult.data ?? []) as RelatedProject[]);
    if (!estimatesResult.error) setEstimates((estimatesResult.data ?? []) as RelatedEstimate[]);
    if (!invoicesResult.error) setInvoices((invoicesResult.data ?? []) as RelatedInvoice[]);
    if (!dealActivityResult.error) setDealActivities((dealActivityResult.data ?? []) as DealActivityRow[]);

    // Appointment activities for this account (Phase 10.3 correction pass)
    // — appointments.entity_type='company', entity_id=resolvedCompanyId.
    // Bounded (limit 20) and org+entity-scoped, never an unbounded
    // organization-wide appointment_activities scan.
    const { data: apptActivityRows, error: apptActivityError } = await supabase
      .from("appointment_activities")
      .select("id, activity_type, actor_id, created_at, appointments!inner(title, service, contact_name, entity_type, entity_id, org_id)")
      .eq("org_id", orgId)
      .eq("appointments.entity_type", "company")
      .eq("appointments.entity_id", resolvedCompanyId)
      .order("created_at", { ascending: false })
      .limit(20);
    if (!apptActivityError) setAppointmentActivities((apptActivityRows ?? []) as unknown as AppointmentActivityRow[]);

    setLoading(false);
  }, [accountSlug]);

  useEffect(() => {
    void loadAccount();
  }, [loadAccount]);

  const primaryContact = useMemo(
    () => contacts.find((item) => item.is_primary) ?? contacts[0] ?? null,
    [contacts],
  );
  const pinnedNotes = useMemo(() => notes.filter((note) => note.is_pinned).slice(0, 3), [notes]);

  // Overview metrics (Phase 9.4 consistency pass) — real data only, and no
  // second deals query: reuses the same reactive useDeals() store
  // AccountRelatedDeals already reads, filtered by the real
  // deals.company_id FK. "Open" is deal.status === "open" — the exact
  // open/won/lost interpretation the Pipeline page uses (deals-store
  // derives status from the stage's own outcome column). Won/Lost never
  // count toward Open Opportunities or Pipeline Value.
  const allDeals = useDeals();
  const companyDealStats = useMemo(() => {
    const companyDeals = allDeals.filter((d) => d.companyId === company?.id);
    const open = companyDeals.filter((d) => d.status === "open");
    return {
      openCount: open.length,
      openValue: open.reduce((sum, d) => sum + Number(d.value ?? 0), 0),
    };
  }, [allDeals, company?.id]);

  // Active Projects — same "active" status set the Command Center's own
  // Active Projects KPI uses (src/routes/index.tsx), applied to this
  // page's already-loaded, contact-mediated project list. A project whose
  // status falls outside both the active and terminal sets still isn't
  // counted — matching the Command Center's inclusion-list behavior
  // exactly rather than inventing a third interpretation.
  const activeProjectsCount = useMemo(() => {
    const ACTIVE_PROJECT_STATUSES = new Set(["planning", "contracted", "pre-construction", "active", "punch-list"]);
    return projects.filter((p) => ACTIVE_PROJECT_STATUSES.has((p.status ?? "").toLowerCase())).length;
  }, [projects]);

  // Priority 9 — merges the existing real company_activities (currently
  // only ever "note added" events) with real deal_activities for this
  // company's deals (deals.company_id is a real direct FK) — both have
  // genuine timestamps; nothing here is fabricated or backdated from
  // updated_at. Deal-stage/creation events previously had no representation
  // in this tab at all.
  const mergedActivity = useMemo<CompanyActivity[]>(() => {
    const fromDeals: CompanyActivity[] = dealActivities.map((d) => ({
      id: `deal-activity-${d.id}`,
      activity_type: d.activity_type,
      title: d.title,
      description: d.description,
      occurred_at: d.occurred_at,
      created_at: d.occurred_at,
      created_by_name: d.actor_name ?? undefined,
    }));
    // Appointment lifecycle events (Phase 10.3 correction pass) — prefixed
    // "appointment_" so ActivityList can give them a distinct CalendarClock
    // icon instead of the generic note icon every other row uses.
    const fromAppointments: CompanyActivity[] = appointmentActivities.map((a) => {
      const appt = a.appointments;
      const subject = appt?.title || appt?.service || "Appointment";
      return {
        id: `appt-activity-${a.id}`,
        activity_type: `appointment_${a.activity_type}`,
        title: APPOINTMENT_ACTIVITY_LABELS[a.activity_type] ?? "Appointment updated",
        description: appt?.contact_name ? `${subject} with ${appt.contact_name}` : subject,
        occurred_at: a.created_at,
        created_at: a.created_at,
        created_by_name: a.actor_id ? undefined : "System",
      };
    });
    return [...activities, ...fromDeals, ...fromAppointments].sort(
      (a, b) => new Date(b.occurred_at || b.created_at).getTime() - new Date(a.occurred_at || a.created_at).getTime(),
    );
  }, [activities, dealActivities, appointmentActivities]);

  const recentActivity = mergedActivity.slice(0, 5);

  const openAddNote = () => {
    setEditingNote(null);
    setNoteOpen(true);
  };

  const openEditNote = (note: CompanyNote) => {
    setEditingNote(note);
    setNoteOpen(true);
  };

  const navigateToModule = async (to: "/pipeline" | "/projects" | "/calendar" | "/files") => {
    if (company) {
      sessionStorage.setItem(
        "renometa:selectedAccount",
        JSON.stringify({
          id: company.id,
          name: company.name,
          org_id: company.org_id,
        }),
      );
    }
    await navigate({ to });
  };

  // "Create Project" is a real deep-link into the New Project dialog
  // pre-filled with this account (Part 27) — previously just navigated to
  // /projects with no prefill at all, a no-op-feeling broken button.
  const createProjectForAccount = () => {
    if (!company) return;
    void navigate({ to: "/projects", search: { openNew: true, companyId: company.id } });
  };

  // Primary-contact change remains two client-side steps (clear old, set
  // new) — NOT atomic. A transactional set_company_primary_contact RPC was
  // considered for this pass and deliberately deferred: writing a
  // SECURITY DEFINER migration requires verifying the live RLS/grant
  // state on company_contacts, which this environment cannot do (no SQL/
  // dashboard access — the same limitation documented in every Phase 9
  // pass). The two steps are individually idempotent, so a failure between
  // them leaves "no primary" (recoverable by clicking again), never two
  // primaries — and company_contacts_one_primary_idx backstops that at the
  // DB level regardless.
  const makePrimary = async (item: LinkedContact) => {
    if (!company) return;
    try {
      await supabase
        .from("company_contacts")
        .update({ is_primary: false })
        .eq("company_id", company.id)
        .eq("org_id", company.org_id);

      const { error } = await supabase
        .from("company_contacts")
        .update({ is_primary: true })
        .eq("id", item.id)
        .eq("org_id", company.org_id);

      if (error) throw error;

      // Invariant sync (Phase 9.4): the primary contact's direct
      // affiliation follows the primary flag — per the consistency spec,
      // "when marking a contact primary... set contacts.company_id to that
      // company if it is not already." Org-scoped like every other write.
      await supabase
        .from("contacts")
        .update({ company_id: company.id, company: null })
        .eq("id", item.contact_id)
        .eq("org_id", company.org_id)
        .neq("company_id", company.id);

      toast.success(`${item.contact?.full_name ?? "Contact"} is now the primary contact.`);
      await loadAccount();
    } catch (error) {
      console.error("[make-primary]", error);
      toast.error("Could not update the primary contact.");
    }
  };

  const unlinkContact = async (item: LinkedContact) => {
    if (!company) return;
    try {
      const { error } = await supabase
        .from("company_contacts")
        .delete()
        .eq("id", item.id)
        .eq("org_id", company.org_id);

      if (error) throw error;

      // Invariant sync (Phase 9.4): never leave contacts.company_id
      // pointing at a company the contact was just removed from. The
      // .eq("company_id", company.id) filter means a contact whose direct
      // affiliation is some OTHER company is untouched. Legacy free-text
      // contacts.company is deliberately left alone as a display fallback.
      await supabase
        .from("contacts")
        .update({ company_id: null })
        .eq("id", item.contact_id)
        .eq("org_id", company.org_id)
        .eq("company_id", company.id);

      toast.success("Contact removed from this account.");
      await loadAccount();
    } catch (error) {
      console.error("[unlink-contact]", error);
      toast.error("Could not remove the contact.");
    }
  };

  const toggleNotePin = async (note: CompanyNote) => {
    if (!company) return;
    try {
      const { error } = await supabase
        .from("company_notes")
        .update({ is_pinned: !note.is_pinned })
        .eq("id", note.id)
        .eq("org_id", company.org_id);
      if (error) throw error;
      await loadAccount();
    } catch (error) {
      console.error("[pin-note]", error);
      toast.error("Could not update the note.");
    }
  };

  const deleteNote = async (note: CompanyNote) => {
    if (!company) return;
    try {
      const { error } = await supabase
        .from("company_notes")
        .delete()
        .eq("id", note.id)
        .eq("org_id", company.org_id);
      if (error) throw error;
      toast.success("Note deleted.");
      await loadAccount();
    } catch (error) {
      console.error("[delete-note]", error);
      toast.error("Could not delete the note.");
    }
  };

  if (loading) return <AccountDetailsSkeleton />;

  if (notFound || !company) {
    return (
      <Card className="mx-auto mt-16 max-w-lg p-8 text-center">
        <Building2 className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Account not found</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          This account may have been deleted or you may not have access to it.
        </p>
        <Button asChild className="mt-5">
          <Link to="/companies">Return to Accounts</Link>
        </Button>
      </Card>
    );
  }

  const address = [company.address, company.city, company.state, company.zip]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="space-y-3">
      <Card className="overflow-hidden p-0">
        <div className="flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <Avatar className="h-20 w-20 rounded-2xl border bg-background">
              <AvatarImage
                src={company.logo_url || undefined}
                alt={`${company.name} logo`}
                className="object-cover"
              />
              <AvatarFallback className="rounded-2xl bg-gold-soft text-lg font-semibold text-gold-hover">
                {initials(company.name)}
              </AvatarFallback>
            </Avatar>

            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-2xl font-semibold tracking-tight">{company.name}</h1>
                <Badge variant="outline" className={accountTypeClass(company.account_type)}>
                  {company.account_type}
                </Badge>
                <Badge
                  variant="outline"
                  className="border-emerald-200 bg-emerald-50 text-emerald-700"
                >
                  <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  {company.status}
                </Badge>
              </div>

              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
                {(company.city || company.state) && (
                  <span className="flex items-center gap-1.5">
                    <MapPin className="h-4 w-4" />
                    {[company.city, company.state].filter(Boolean).join(", ")}
                  </span>
                )}
                <span className="flex items-center gap-1.5">
                  <Users className="h-4 w-4" />
                  Owner: {company.owner_name || "Unassigned"}
                </span>
                {company.email && (
                  <a
                    href={`mailto:${company.email}`}
                    className="flex items-center gap-1.5 hover:text-foreground"
                  >
                    <Mail className="h-4 w-4" />
                    {company.email}
                  </a>
                )}
                {company.phone && (
                  <a
                    href={`tel:${company.phone}`}
                    className="flex items-center gap-1.5 hover:text-foreground"
                  >
                    <Phone className="h-4 w-4" />
                    {formatPhone(company.phone)}
                  </a>
                )}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              variant="outline"
              className="border-slate-200 bg-white text-slate-800 hover:bg-slate-50"
              onClick={() => setEditOpen(true)}
            >
              <Pencil className="mr-1.5 h-4 w-4 text-amber-600" />
              Edit Account
            </Button>
            <Button
              variant="outline"
              className="border-slate-200 bg-white text-slate-800 hover:bg-slate-50"
              onClick={() => setContactOpen(true)}
            >
              <UserPlus className="mr-1.5 h-4 w-4 text-blue-600" />
              Add Contact
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => void navigator.clipboard.writeText(company.id)}>
                  Copy account ID
                </DropdownMenuItem>
                {company.website && (
                  <DropdownMenuItem asChild>
                    <a href={company.website} target="_blank" rel="noreferrer">
                      Open website
                    </a>
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as TabValue)}>
          <div className="border-t border-border px-3">
            <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-none bg-transparent p-0">
              {TAB_ITEMS.map(({ value, label, icon: Icon }) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  className="h-11 rounded-none border-b-2 border-transparent px-3 text-xs data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                >
                  <Icon className="mr-1.5 h-3.5 w-3.5" /> {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <TabsContent value="overview" className="m-0 border-t border-border bg-canvas p-3">
            <OverviewTab
              company={company}
              primaryContact={primaryContact}
              recentActivity={recentActivity}
              pinnedNotes={pinnedNotes}
              address={address}
              onEdit={() => setEditOpen(true)}
              onAddContact={() => setContactOpen(true)}
              onAddNote={openAddNote}
              onNewDeal={() => setNewDealOpen(true)}
              onShowActivity={() => setActiveTab("activity")}
              onShowNotes={() => setActiveTab("notes")}
              onNavigate={navigateToModule}
              onCreateProject={createProjectForAccount}
              openDealsCount={companyDealStats.openCount}
              pipelineValue={companyDealStats.openValue}
              activeProjectsCount={activeProjectsCount}
            />
          </TabsContent>

          <TabsContent value="contacts" className="m-0 border-t border-border bg-canvas p-3">
            <ContactsTab
              contacts={contacts}
              onAdd={() => setContactOpen(true)}
              onMakePrimary={makePrimary}
              onUnlink={unlinkContact}
            />
          </TabsContent>

          <TabsContent value="activity" className="m-0 border-t border-border bg-canvas p-3">
            <ActivityTab activities={mergedActivity} onAddNote={openAddNote} />
          </TabsContent>

          <TabsContent value="notes" className="m-0 border-t border-border bg-canvas p-3">
            <NotesTab
              notes={notes}
              onAdd={openAddNote}
              onEdit={openEditNote}
              onPin={toggleNotePin}
              onDelete={deleteNote}
            />
          </TabsContent>

          <TabsContent value="opportunities" className="m-0 border-t border-border bg-canvas p-3">
            <Card className="p-5">
              <AccountRelatedDeals companyId={company.id} />
            </Card>
          </TabsContent>

          <TabsContent value="projects" className="m-0 border-t border-border bg-canvas p-3">
            {projects.length > 0 ? (
              <CompanyProjectsTab projects={projects} onOpen={() => void navigateToModule("/projects")} />
            ) : (
              <ModuleEmptyState tab="projects" onOpen={() => void navigateToModule("/projects")} />
            )}
          </TabsContent>
          <TabsContent value="appointments" className="m-0 border-t border-border bg-canvas p-3">
            <Card className="p-5">
              <EntityAppointmentsPanel
                entityType="company"
                entityId={company.id}
                entityLabel="account"
                contactName={primaryContact?.contact?.full_name || company.name}
                contactPhone={primaryContact?.contact?.phone || undefined}
                contactEmail={primaryContact?.contact?.email || undefined}
                address={address || undefined}
              />
            </Card>
          </TabsContent>

          <TabsContent value="financials" className="m-0 border-t border-border bg-canvas p-3">
            <CompanyFinancialsTab
              companyId={company.id}
              invoices={invoices}
              onOpen={() => void navigate({ to: "/financials" })}
            />
          </TabsContent>
          <TabsContent value="files" className="m-0 border-t border-border bg-canvas p-3">
            <ModuleEmptyState tab="files" onOpen={() => void navigateToModule("/files")} />
          </TabsContent>
        </Tabs>
      </Card>

      <NewDealDialog
        open={newDealOpen}
        onOpenChange={setNewDealOpen}
        initialValues={{
          name: `${company.name} Deal`,
          contactName: primaryContact?.contact?.full_name ?? "",
          email: primaryContact?.contact?.email ?? "",
          phone: primaryContact?.contact?.phone ? formatPhone(primaryContact.contact.phone) : "",
          address,
        }}
        onCreated={() => {
          setActiveTab("opportunities");
        }}
      />

      <EditAccountDialog
        open={editOpen}
        company={company}
        onClose={() => setEditOpen(false)}
        onSaved={loadAccount}
      />
      <AddContactDialog
        open={contactOpen}
        company={company}
        options={contactOptions}
        linkedContactIds={contacts.map((item) => item.contact_id)}
        onClose={() => setContactOpen(false)}
        onSaved={loadAccount}
      />
      <NoteDialog
        open={noteOpen}
        company={company}
        note={editingNote}
        onClose={() => {
          setNoteOpen(false);
          setEditingNote(null);
        }}
        onSaved={loadAccount}
      />
    </div>
  );
}

function OverviewTab({
  company,
  primaryContact,
  recentActivity,
  pinnedNotes,
  address,
  onEdit,
  onAddContact,
  onAddNote,
  onNewDeal,
  onShowActivity,
  onShowNotes,
  onNavigate,
  onCreateProject,
  openDealsCount,
  pipelineValue,
  activeProjectsCount,
}: {
  company: Company;
  primaryContact: LinkedContact | null;
  recentActivity: CompanyActivity[];
  pinnedNotes: CompanyNote[];
  address: string;
  onEdit: () => void;
  onAddContact: () => void;
  onAddNote: () => void;
  onNewDeal: () => void;
  onShowActivity: () => void;
  onShowNotes: () => void;
  onCreateProject: () => void;
  onNavigate: (to: "/pipeline" | "/projects" | "/calendar" | "/files") => Promise<void>;
  openDealsCount: number;
  pipelineValue: number;
  activeProjectsCount: number;
}) {
  const [scheduleOpen, setScheduleOpen] = useState(false);
  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1.8fr)_minmax(320px,0.9fr)]">
      <div className="space-y-3">
        <Card className="overflow-hidden p-0">
          <CardHeaderBar
            icon={Building2}
            title="Account Details"
            action={
              <Button variant="ghost" size="sm" onClick={onEdit}>
                <Pencil className="mr-1.5 h-3.5 w-3.5 text-amber-600" />
                Edit
              </Button>
            }
          />
          <div className="p-5">
            <div className="grid gap-5 md:grid-cols-2">
              <div className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-3 text-sm">
                <InfoLabel>Account Type</InfoLabel>
                <span>{company.account_type}</span>
                <InfoLabel>Industry</InfoLabel>
                <span>{company.industry || "—"}</span>
                <InfoLabel>Status</InfoLabel>
                <Badge
                  variant="outline"
                  className="w-fit border-emerald-200 bg-emerald-50 text-emerald-700"
                >
                  {company.status}
                </Badge>
                <InfoLabel>Owner</InfoLabel>
                <span>{company.owner_name || "Unassigned"}</span>
              </div>
              <div className="space-y-3 border-t pt-4 text-sm md:border-l md:border-t-0 md:pl-6 md:pt-0">
                <ContactLine
                  icon={Mail}
                  label="Email"
                  value={company.email}
                  href={company.email ? `mailto:${company.email}` : undefined}
                />
                <ContactLine
                  icon={Phone}
                  label="Phone"
                  value={formatPhone(company.phone)}
                  href={company.phone ? `tel:${company.phone}` : undefined}
                />
                <ContactLine
                  icon={Globe}
                  label="Website"
                  value={company.website}
                  href={company.website || undefined}
                  external
                />
                <ContactLine
                  icon={MapPin}
                  label="Address"
                  value={address || "—"}
                  href={
                    address
                      ? `https://maps.google.com/?q=${encodeURIComponent(address)}`
                      : undefined
                  }
                  external
                />
              </div>
            </div>
            <div className="mt-5 flex items-center gap-3 border-t pt-4">
              <span className="text-xs font-medium text-muted-foreground">Tags</span>
              <div className="flex flex-wrap gap-1.5">
                {(company.tags ?? []).map((tag) => (
                  <Badge key={tag} variant="secondary">
                    {tag}
                  </Badge>
                ))}
                {(company.tags ?? []).length === 0 && (
                  <span className="text-sm text-muted-foreground">No tags</span>
                )}
              </div>
            </div>
          </div>
        </Card>

        <Card className="overflow-hidden p-0">
          <CardHeaderBar icon={Users} title="Primary Contact" />
          <div className="p-5">
            {primaryContact?.contact ? (
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                <AccountContactAvatar
                  contact={primaryContact.contact}
                  className="h-16 w-16"
                  size="lg"
                />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{primaryContact.contact.full_name}</div>
                  <div className="text-sm text-muted-foreground">
                    {primaryContact.relationship_title || "Primary contact"}
                  </div>
                  {primaryContact.contact.email && (
                    <a
                      href={`mailto:${primaryContact.contact.email}`}
                      className="mt-2 block text-sm text-primary hover:underline"
                    >
                      {primaryContact.contact.email}
                    </a>
                  )}
                  {primaryContact.contact.phone && (
                    <a
                      href={`tel:${primaryContact.contact.phone}`}
                      className="mt-1 block text-sm text-primary hover:underline"
                    >
                      {formatPhone(primaryContact.contact.phone)}
                    </a>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" asChild>
                    <Link to="/contacts">View Contact</Link>
                  </Button>
                  {primaryContact.contact.email && (
                    <Button variant="outline" size="sm" asChild>
                      <a href={`mailto:${primaryContact.contact.email}`}>
                        <Mail className="mr-1.5 h-3.5 w-3.5" />
                        Send Email
                      </a>
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <EmptyInline
                icon={Users}
                text="No primary contact is linked to this account."
                action="Add Contact"
                onAction={onAddContact}
              />
            )}
          </div>
        </Card>

        <Card className="overflow-hidden p-0">
          <CardHeaderBar
            icon={Activity}
            title="Recent Activity"
            action={
              <Button variant="ghost" size="sm" onClick={onShowActivity}>
                View All
              </Button>
            }
          />
          <div className="p-5">
            <ActivityList activities={recentActivity} compact onAddNote={onAddNote} />
          </div>
        </Card>
      </div>

      <div className="space-y-3">
        <Card className="overflow-hidden p-0">
          <CardHeaderBar icon={Plus} title="Quick Actions" />
          <div className="grid grid-cols-2 gap-2 p-4">
            <QuickAction icon={UserPlus} label="Add Contact" tone="blue" onClick={onAddContact} />
            <QuickAction icon={StickyNote} label="Add Note" tone="gold" onClick={onAddNote} />
            <QuickAction
              icon={CircleDollarSign}
              label="New Deal"
              tone="success"
              onClick={onNewDeal}
            />
            <QuickAction
              icon={FolderKanban}
              label="Create Project"
              tone="violet"
              onClick={onCreateProject}
            />
            <QuickAction
              icon={CalendarDays}
              label="Schedule Appointment"
              tone="cyan"
              onClick={() => setScheduleOpen(true)}
            />
            <QuickAction
              icon={Upload}
              label="Upload File"
              tone="neutral"
              onClick={() => void onNavigate("/files")}
            />
          </div>
        </Card>

        <Card className="overflow-hidden p-0">
          <CardHeaderBar icon={Activity} title="Account Summary" />
          <div className="px-4 pb-2">
            {/* All three rows are real (Phase 9.4 consistency pass):
                deals via the direct deals.company_id FK from the shared
                useDeals() store (open-status only — Won/Lost excluded,
                same interpretation as the Pipeline page); Active Projects
                via this page's contact-mediated project list, using the
                Command Center's own active-status set. The former
                "Outstanding Balance" / "Lifetime Revenue" rows were
                REMOVED, not populated — the only reachable invoice data
                is the indirect contact-mediated set, and presenting a sum
                of that as authoritative company accounting would overstate
                its accuracy. */}
            <SummaryRow label="Open Opportunities" value={String(openDealsCount)} />
            <SummaryRow label="Pipeline Value" value={formatMoney(pipelineValue)} />
            <SummaryRow label="Active Projects" value={String(activeProjectsCount)} last />
          </div>
        </Card>

        <Card className="overflow-hidden p-0">
          <CardHeaderBar
            icon={Pin}
            title="Important Notes"
            action={
              <Button variant="ghost" size="sm" onClick={onShowNotes}>
                View All
              </Button>
            }
          />
          <div className="p-4">
            {pinnedNotes.length > 0 ? (
              <div className="space-y-2">
                {pinnedNotes.map((note) => (
                  <div
                    key={note.id}
                    className="rounded-lg border border-amber-200 bg-amber-50/60 p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-sm font-medium">{note.title || "Pinned note"}</div>
                      <Pin className="h-3.5 w-3.5 text-amber-600" />
                    </div>
                    <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">
                      {noteText(note)}
                    </p>
                    <div className="mt-2 text-[11px] text-muted-foreground">
                      {format(new Date(note.created_at), "MMM d, yyyy")}
                    </div>
                  </div>
                ))}
              </div>
            ) : company.notes ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm text-muted-foreground">
                {company.notes}
              </div>
            ) : (
              <EmptyInline
                icon={Pin}
                text="No important notes yet."
                action="Add Note"
                onAction={onAddNote}
              />
            )}
          </div>
        </Card>

        <div className="px-1 text-[11px] text-muted-foreground">
          Created {format(new Date(company.created_at), "MMM d, yyyy")} · Updated{" "}
          {formatDistanceToNow(new Date(company.updated_at), {
            addSuffix: true,
          })}
        </div>
      </div>

      <AppointmentDialog
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        prefill={{
          entityType: "company",
          entityId: company.id,
          entityLabel: company.name,
          contactName: primaryContact?.contact?.full_name || company.name,
          contactPhone: primaryContact?.contact?.phone || undefined,
          contactEmail: primaryContact?.contact?.email || undefined,
          address: address || undefined,
          source: "company",
        }}
        onSaved={() => toast.success("Appointment scheduled")}
      />
    </div>
  );
}

function ContactsTab({
  contacts,
  onAdd,
  onMakePrimary,
  onUnlink,
}: {
  contacts: LinkedContact[];
  onAdd: () => void;
  onMakePrimary: (item: LinkedContact) => void;
  onUnlink: (item: LinkedContact) => void;
}) {
  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="font-semibold">Account Contacts</h2>
          <p className="text-sm text-muted-foreground">People connected to this account.</p>
        </div>
        <Button size="sm" onClick={onAdd}>
          <UserPlus className="mr-1.5 h-3.5 w-3.5" />
          Add Contact
        </Button>
      </div>
      {contacts.length === 0 ? (
        <EmptyInline
          icon={Users}
          text="No contacts are linked to this account."
          action="Add Contact"
          onAction={onAdd}
        />
      ) : (
        <div className="divide-y rounded-lg border">
          {contacts.map((item) => (
            <div key={item.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
              <AccountContactAvatar contact={item.contact} size="md" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {item.contact?.full_name || "Unknown contact"}
                  </span>
                  {item.is_primary && <Badge variant="secondary">Primary</Badge>}
                </div>
                <div className="text-sm text-muted-foreground">
                  {item.relationship_title || "Contact"}
                </div>
              </div>
              <div className="text-sm text-muted-foreground">{item.contact?.email || "—"}</div>
              <div className="text-sm text-muted-foreground">
                {formatPhone(item.contact?.phone || null) || "—"}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {!item.is_primary && (
                    <DropdownMenuItem onClick={() => void onMakePrimary(item)}>
                      Make primary
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive"
                    onClick={() => void onUnlink(item)}
                  >
                    Remove from account
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ActivityTab({
  activities,
  onAddNote,
}: {
  activities: CompanyActivity[];
  onAddNote: () => void;
}) {
  return (
    <Card className="p-5">
      <div className="mb-4">
        <h2 className="font-semibold">Account Activity</h2>
        <p className="text-sm text-muted-foreground">
          Calls, messages, appointments, sales updates, and system changes.
        </p>
      </div>
      <ActivityList activities={activities} onAddNote={onAddNote} />
    </Card>
  );
}

// ── Company-level Projects (Priority 6) — resolved via contacts.company_id,
// see the RelatedProject type comment above for why this is ID-based but
// indirect rather than a direct company_id FK (projects has none). ───────
function CompanyProjectsTab({ projects, onOpen }: { projects: RelatedProject[]; onOpen: () => void }) {
  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="font-semibold">Account Projects</h2>
          <p className="text-sm text-muted-foreground">
            Projects for contacts linked to this account.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={onOpen}>Open Projects</Button>
      </div>
      <div className="space-y-2">
        {projects.map((project) => (
          <div key={project.id} className="rounded-xl border bg-white p-3">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-50 text-blue-600">
                <FolderKanban className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{project.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {project.status}
                  {project.completion_percentage !== null ? ` · ${project.completion_percentage}% complete` : ""}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ── Company-level Estimates + Invoices (Priority 7) — same contact-based
// resolution as Projects; kept as one "Financials" tab (matching the
// existing TAB_ITEMS grouping and the app's own financials.estimates.tsx /
// financials.invoices.tsx pairing) rather than splitting into two new
// top-level tabs. ─────────────────────────────────────────────────────────
function CompanyFinancialsTab({
  companyId,
  invoices,
  onOpen,
}: {
  companyId: string;
  invoices: RelatedInvoice[];
  onOpen: () => void;
}) {
  return (
    <div className="space-y-4">
      {/* Phase 10.4: real, org-scoped estimates panel with a working "New
          estimate" action — now queries estimates.company_id directly
          (added by the 20260809 migration) instead of the old
          resolve-through-linked-contacts workaround this comment used to
          describe. */}
      <Card className="p-5">
        <EntityEstimatesPanel entityType="company" entityId={companyId} entityLabel="account" />
      </Card>

      {invoices.length > 0 && (
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="font-semibold">Invoices</h2>
              <p className="text-sm text-muted-foreground">
                Invoices for contacts linked to this account.
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={onOpen}>Open Financials</Button>
          </div>
          <div className="space-y-2">
            {invoices.map((invoice) => (
              <div key={invoice.id} className="rounded-xl border bg-white p-3">
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-violet-50 text-violet-700">
                    <WalletCards className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{invoice.invoice_number || "Invoice"}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {invoice.status || "draft"}
                      {invoice.due_date ? ` · Due ${formatDateShort(invoice.due_date)}` : ""}
                      {/* amount_paid is a real, separate column — shown as
                          its own data point rather than an unsupported
                          computed remaining-balance figure. */}
                      {invoice.amount_paid ? ` · ${formatMoney(invoice.amount_paid)} paid` : ""}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-semibold">{formatMoney(invoice.total_amount ?? 0)}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function NotesTab({
  notes,
  onAdd,
  onEdit,
  onPin,
  onDelete,
}: {
  notes: CompanyNote[];
  onAdd: () => void;
  onEdit: (note: CompanyNote) => void;
  onPin: (note: CompanyNote) => void;
  onDelete: (note: CompanyNote) => void;
}) {
  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="font-semibold">Account Notes</h2>
          <p className="text-sm text-muted-foreground">Internal notes shared with your team.</p>
        </div>
        <Button size="sm" onClick={onAdd}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add Note
        </Button>
      </div>
      {notes.length === 0 ? (
        <EmptyInline
          icon={StickyNote}
          text="No account notes yet."
          action="Add Note"
          onAction={onAdd}
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {notes.map((note) => (
            <div key={note.id} className="rounded-lg border p-4">
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-medium">{note.title || "Account note"}</h3>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => onEdit(note)}>
                      <Pencil className="mr-2 h-4 w-4" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void onPin(note)}>
                      <Pin className="mr-2 h-4 w-4" />
                      {note.is_pinned ? "Unpin" : "Pin"}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive"
                      onClick={() => void onDelete(note)}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                {noteText(note)}
              </p>
              <div className="mt-4 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>
                  {note.author_name || "Team member"} ·{" "}
                  {format(new Date(note.created_at), "MMM d, yyyy")}
                </span>
                {note.is_pinned && <Pin className="h-3.5 w-3.5 text-gold-hover" />}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ActivityList({
  activities,
  compact = false,
  onAddNote,
}: {
  activities: CompanyActivity[];
  compact?: boolean;
  onAddNote: () => void;
}) {
  if (activities.length === 0) {
    return (
      <EmptyInline
        icon={Activity}
        text="No activity has been recorded for this account."
        action="Add Note"
        onAction={onAddNote}
      />
    );
  }

  return (
    <div className="space-y-1">
      {activities.map((item) => {
        const activityDate = item.occurred_at || item.created_at;

        const isAppointment = item.activity_type.startsWith("appointment_");

        return (
          <div key={item.id} className="grid grid-cols-[32px_1fr_auto] gap-3 py-2">
            <span className={cn(
              "grid h-8 w-8 place-items-center rounded-full",
              isAppointment ? "bg-info-soft text-info" : "bg-blue-50 text-blue-700",
            )}>
              {isAppointment ? <CalendarClock className="h-4 w-4" /> : <MessageSquareText className="h-4 w-4" />}
            </span>

            <div className="min-w-0">
              <div className="text-sm font-medium">{item.title}</div>
              {item.description && (
                <div
                  className={
                    compact
                      ? "truncate text-sm text-muted-foreground"
                      : "text-sm text-muted-foreground"
                  }
                >
                  {item.description}
                </div>
              )}
            </div>

            <div className="pl-4 text-right text-[11px] text-muted-foreground">
              <div>
                {activityDate
                  ? formatDistanceToNow(new Date(activityDate), {
                      addSuffix: true,
                    })
                  : "Unknown date"}
              </div>
              {item.created_by_name && <div>{item.created_by_name}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ModuleEmptyState({
  tab,
  onOpen,
}: {
  tab: "opportunities" | "projects" | "financials" | "files";
  onOpen: () => void;
}) {
  const config = {
    opportunities: {
      icon: BriefcaseBusiness,
      title: "Account opportunities",
      description: "Related pipeline opportunities will appear here.",
      action: "New Deal",
    },
    projects: {
      icon: FolderKanban,
      title: "Account projects",
      description: "Projects connected to this account will appear here.",
      action: "Open Projects",
    },
    financials: {
      icon: WalletCards,
      title: "Account financials",
      description: "Estimates, invoices, payments, and balances will appear here.",
      action: "Open Financials",
    },
    files: {
      icon: FileText,
      title: "Account files",
      description: "Contracts, proposals, photos, and other documents will appear here.",
      action: "Open Files",
    },
  }[tab];
  const Icon = config.icon;
  return (
    <Card className="p-10 text-center">
      <Icon className="mx-auto mb-3 h-9 w-9 text-muted-foreground" />
      <h2 className="font-semibold">{config.title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{config.description}</p>
      <Button className="mt-4" onClick={onOpen}>
        {config.action}
      </Button>
    </Card>
  );
}

function EditAccountDialog({
  open,
  company,
  onClose,
  onSaved,
}: {
  open: boolean;
  company: Company;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState<EditCompanyForm>(() => companyToEditForm(company));
  const [saving, setSaving] = useState(false);
  const [duplicates, setDuplicates] = useState<CompanyDuplicateCandidate[] | null>(null);
  const [duplicatesCheckedFor, setDuplicatesCheckedFor] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setForm(companyToEditForm(company));
      setDuplicates(null);
      setDuplicatesCheckedFor(null);
    }
  }, [company, open]);
  const update = (key: keyof EditCompanyForm, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    setDuplicates(null);
    setDuplicatesCheckedFor(null);
  };
  const save = async () => {
    if (!form.name.trim()) return toast.error("Account name is required.");

    // Edit-collision warning (Phase 9.4 consistency pass) — excludes this
    // company itself, so keeping its own current name/domain never warns;
    // only an edit INTO another company's exact normalized name/domain
    // does. Acknowledge by clicking Save again ("Save anyway").
    const checkKey = `${form.name.trim().toLowerCase()}|${form.website.trim().toLowerCase()}`;
    if (!(duplicates && duplicates.length > 0 && duplicatesCheckedFor === checkKey)) {
      const candidates = findCompanyDuplicateCandidates(form.name, form.website, company.id);
      if (candidates.length > 0) {
        setDuplicates(candidates);
        setDuplicatesCheckedFor(checkKey);
        return;
      }
      setDuplicates([]);
      setDuplicatesCheckedFor(checkKey);
    }

    setSaving(true);
    try {
      // Migrated to the canonical store (Phase 9.4 consistency pass) — the
      // same org-scoped update this dialog previously ran directly, but the
      // shared reactive cache now stays in sync too.
      const saved = await updateCompany(company.id, {
        name: form.name.trim(),
        account_type: form.account_type,
        status: form.status,
        industry: form.industry.trim() || null,
        owner_name: form.owner_name.trim() || null,
        email: form.email.trim() || null,
        phone: form.phone.replace(/\D/g, "") || null,
        website: form.website.trim() || null,
        address: form.address.trim() || null,
        city: form.city.trim() || null,
        state: form.state.trim() || null,
        zip: form.zip.trim() || null,
        country: form.country.trim() || "United States",
      });
      if (!saved) throw new Error("update failed");
      toast.success("Account updated.");
      onClose();
      await onSaved();
    } catch (error) {
      console.error("[edit-account]", error);
      toast.error("Could not update the account.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Account</DialogTitle>
          <DialogDescription>Update the core account information.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2 md:grid-cols-2">
          <Field label="Account name" className="md:col-span-2">
            <Input value={form.name} onChange={(e) => update("name", e.target.value)} />
          </Field>
          <Field label="Account type">
            <Input
              value={form.account_type}
              onChange={(e) => update("account_type", e.target.value)}
            />
          </Field>
          <Field label="Status">
            <Select value={form.status} onValueChange={(v) => update("status", v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Active">Active</SelectItem>
                <SelectItem value="Inactive">Inactive</SelectItem>
                <SelectItem value="Archived">Archived</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Industry">
            <Input value={form.industry} onChange={(e) => update("industry", e.target.value)} />
          </Field>
          <Field label="Owner">
            <Input value={form.owner_name} onChange={(e) => update("owner_name", e.target.value)} />
          </Field>
          <Field label="Email">
            <Input
              type="email"
              value={form.email}
              onChange={(e) => update("email", e.target.value)}
            />
          </Field>
          <Field label="Phone">
            <Input value={form.phone} onChange={(e) => update("phone", e.target.value)} />
          </Field>
          <Field label="Website" className="md:col-span-2">
            <Input value={form.website} onChange={(e) => update("website", e.target.value)} />
          </Field>
          <Field label="Street address" className="md:col-span-2">
            <Input value={form.address} onChange={(e) => update("address", e.target.value)} />
          </Field>
          <Field label="City">
            <Input value={form.city} onChange={(e) => update("city", e.target.value)} />
          </Field>
          <Field label="State">
            <Input value={form.state} onChange={(e) => update("state", e.target.value)} />
          </Field>
          <Field label="ZIP">
            <Input value={form.zip} onChange={(e) => update("zip", e.target.value)} />
          </Field>
          <Field label="Country">
            <Input value={form.country} onChange={(e) => update("country", e.target.value)} />
          </Field>
        </div>
        {duplicates && duplicates.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
            <div className="font-medium text-amber-800">
              This matches {duplicates.length === 1 ? "another existing account" : "other existing accounts"}
            </div>
            <ul className="mt-1.5 space-y-1">
              {duplicates.map((d) => (
                <li key={d.id} className="text-xs text-amber-900">
                  {d.name} — matched by {d.matchedOn === "name" ? "name" : "website"}
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[11px] text-amber-700">
              Click "Save anyway" to keep these values regardless.
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : duplicates && duplicates.length > 0 ? "Save anyway" : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddContactDialog({
  open,
  company,
  options,
  linkedContactIds,
  onClose,
  onSaved,
}: {
  open: boolean;
  company: Company;
  options: ContactOption[];
  linkedContactIds: string[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [mode, setMode] = useState<AddContactMode>("existing");
  const [existingId, setExistingId] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [title, setTitle] = useState("");
  const [primary, setPrimary] = useState(false);
  const [saving, setSaving] = useState(false);
  const available = options.filter((option) => !linkedContactIds.includes(option.id));
  useEffect(() => {
    if (open) {
      setMode("existing");
      setExistingId("");
      setName("");
      setEmail("");
      setPhone("");
      setTitle("");
      setPrimary(false);
    }
  }, [open]);
  const save = async () => {
    setSaving(true);
    try {
      let contactId = existingId;
      if (mode === "new") {
        if (!name.trim()) throw new Error("Contact name is required.");
        const { data, error } = await supabase
          .from("contacts")
          .insert({
            org_id: company.org_id,
            full_name: name.trim(),
            email: email.trim() || null,
            phone: phone.replace(/\D/g, "") || null,
            // Canonical direct affiliation (Phase 9.4 consistency pass) —
            // previously wrote the legacy free-text `company` name here;
            // a contact created FOR this account gets company_id, never
            // new legacy text.
            company_id: company.id,
            company: null,
            source: "account",
            labels: [],
          })
          .select("id")
          .single();
        if (error) throw error;
        contactId = data.id;
      }
      if (!contactId) throw new Error("Select a contact.");
      if (primary)
        await supabase
          .from("company_contacts")
          .update({ is_primary: false })
          .eq("company_id", company.id)
          .eq("org_id", company.org_id);
      const { error } = await supabase.from("company_contacts").upsert(
        {
          org_id: company.org_id,
          company_id: company.id,
          contact_id: contactId,
          relationship_title: title.trim() || null,
          is_primary: primary,
        },
        { onConflict: "company_id,contact_id" },
      );
      if (error) throw error;

      // Invariant sync (Phase 9.4) for the existing-contact path:
      //  - no direct company yet          → this becomes it
      //  - marked primary here            → this becomes it (primary
      //                                     implies default affiliation,
      //                                     per the consistency spec)
      //  - already directly affiliated
      //    with a DIFFERENT company and
      //    not marked primary             → association-only; never
      //                                     silently reassigned (the
      //                                     many-to-many company_contacts
      //                                     row carries the relationship),
      //                                     disclosed via toast below.
      if (mode === "existing") {
        const { data: current } = await supabase
          .from("contacts")
          .select("company_id")
          .eq("id", contactId)
          .eq("org_id", company.org_id)
          .maybeSingle();
        const currentCompanyId = current?.company_id ?? null;
        if (!currentCompanyId || primary) {
          if (currentCompanyId !== company.id) {
            await supabase
              .from("contacts")
              .update({ company_id: company.id, company: null })
              .eq("id", contactId)
              .eq("org_id", company.org_id);
          }
          toast.success("Contact linked to account.");
        } else if (currentCompanyId !== company.id) {
          toast.success("Contact linked to account.", {
            description: "They stay directly affiliated with their existing company — this is an additional association. Mark them primary here to move their direct affiliation.",
          });
        } else {
          toast.success("Contact linked to account.");
        }
      } else {
        toast.success("Contact linked to account.");
      }

      onClose();
      await onSaved();
    } catch (error) {
      console.error("[add-contact]", error);
      toast.error(error instanceof Error ? error.message : "Could not add the contact.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Contact</DialogTitle>
          <DialogDescription>
            Link an existing contact or create a new one for {company.name}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <Field label="Contact source">
            <Select value={mode} onValueChange={(v) => setMode(v as AddContactMode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="existing">Existing contact</SelectItem>
                <SelectItem value="new">Create new contact</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {mode === "existing" ? (
            <Field label="Contact">
              <Select value={existingId || undefined} onValueChange={setExistingId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select contact" />
                </SelectTrigger>
                <SelectContent>
                  {available.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.full_name}
                      {option.email ? ` — ${option.email}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : (
            <>
              <Field label="Full name">
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Email">
                  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                </Field>
                <Field label="Phone">
                  <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
                </Field>
              </div>
            </>
          )}
          <Field label="Title / relationship">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Property Manager"
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={primary}
              onChange={(e) => setPrimary(e.target.checked)}
            />
            Set as primary contact
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Add Contact"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NoteDialog({
  open,
  company,
  note,
  onClose,
  onSaved,
}: {
  open: boolean;
  company: Company;
  note: CompanyNote | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) {
      setTitle(note?.title ?? "");
      setBody(note ? noteText(note) : "");
      setPinned(Boolean(note?.is_pinned));
    }
  }, [note, open]);
  const save = async () => {
    if (!body.trim()) return toast.error("Note text is required.");
    setSaving(true);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      let authorName = "Team member";
      if (user) {
        const { data: profile } = await supabase
          .from("profiles")
          .select("first_name,last_name,email")
          .eq("id", user.id)
          .maybeSingle();
        authorName =
          [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") ||
          profile?.email ||
          user.email ||
          "Team member";
      }
      if (note) {
        const { error } = await supabase
          .from("company_notes")
          .update({
            title: title.trim() || null,
            body: body.trim(),
            is_pinned: pinned,
            author_name: authorName,
          })
          .eq("id", note.id)
          .eq("org_id", company.org_id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("company_notes").insert({
          org_id: company.org_id,
          company_id: company.id,
          title: title.trim() || null,
          body: body.trim(),
          is_pinned: pinned,
          author_name: authorName,
        });
        if (error) throw error;
        await supabase.from("company_activities").insert({
          org_id: company.org_id,
          company_id: company.id,
          activity_type: "note",
          title: "Note added",
          description: title.trim() || body.trim().slice(0, 140),
          created_by_name: authorName,
          occurred_at: new Date().toISOString(),
        });
      }
      toast.success(note ? "Note updated." : "Note added.");
      onClose();
      await onSaved();
    } catch (error) {
      console.error("[save-note]", error);
      toast.error("Could not save the note.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{note ? "Edit Note" : "Add Note"}</DialogTitle>
          <DialogDescription>Save an internal note for {company.name}.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <Field label="Title">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Optional note title"
            />
          </Field>
          <Field label="Note">
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              placeholder="Write an internal account note…"
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
            Pin as important
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : note ? "Save Changes" : "Add Note"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AccountContactAvatar({
  contact,
  size = "md",
  className,
}: {
  contact: ContactOption | null | undefined;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const name = contact?.full_name || "Contact";
  const sizeClasses = {
    sm: "h-8 w-8",
    md: "h-10 w-10",
    lg: "h-16 w-16",
  } as const;

  if (contact?.avatar_url) {
    return (
      <Avatar className={`${sizeClasses[size]} shrink-0 ${className ?? ""}`}>
        <AvatarImage src={contact.avatar_url} alt={name} className="object-cover" />
        <AvatarFallback>{initials(name)}</AvatarFallback>
      </Avatar>
    );
  }

  return (
    <ContactAvatar
      id={contact?.id}
      name={name}
      avatarKey={contact?.avatar_key}
      size={size === "lg" ? "lg" : size}
      className={className}
    />
  );
}

function InfoLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
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
function ContactLine({
  icon: Icon,
  label,
  value,
  href,
  external = false,
}: {
  icon: typeof Mail;
  label: string;
  value: string | null;
  href?: string;
  external?: boolean;
}) {
  return (
    <div className="grid grid-cols-[92px_1fr] gap-3">
      <span className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-4 w-4" />
        {label}
      </span>
      {href ? (
        <a
          href={href}
          target={external ? "_blank" : undefined}
          rel={external ? "noreferrer" : undefined}
          className="min-w-0 truncate text-primary hover:underline"
        >
          {value}
          {external && <ExternalLink className="ml-1 inline h-3 w-3" />}
        </a>
      ) : (
        <span>{value || "—"}</span>
      )}
    </div>
  );
}
function CardHeaderBar({
  icon: Icon,
  title,
  action,
}: {
  icon: typeof Building2;
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 border-b border-amber-100 bg-[#FAF3E4] px-4 py-2.5">
      <div className="flex items-center gap-2 font-semibold">
        <Icon className="h-4 w-4 text-amber-600" />
        <span>{title}</span>
      </div>
      {action}
    </div>
  );
}

function QuickAction({
  icon: Icon,
  label,
  onClick,
  tone = "blue",
}: {
  icon: typeof UserPlus;
  label: string;
  onClick: () => void;
  tone?: "blue" | "gold" | "success" | "violet" | "cyan" | "neutral";
}) {
  const iconClasses = {
    blue: "text-blue-600",
    gold: "text-amber-600",
    success: "text-emerald-600",
    violet: "text-violet-600",
    cyan: "text-cyan-600",
    neutral: "text-slate-600",
  } as const;

  return (
    <Button
      variant="outline"
      className="h-10 justify-start border-blue-200 bg-blue-50 text-xs text-slate-800 hover:bg-blue-100"
      onClick={onClick}
    >
      <span className="mr-2 grid h-6 w-6 place-items-center rounded-md bg-white">
        <Icon className={`h-3.5 w-3.5 ${iconClasses[tone]}`} />
      </span>
      {label}
    </Button>
  );
}

function SummaryRow({
  label,
  value,
  last = false,
}: {
  label: string;
  value: string;
  last?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between py-2.5 text-sm ${last ? "" : "border-b"}`}>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
function EmptyInline({
  icon: Icon,
  text,
  action,
  onAction,
}: {
  icon: typeof Users;
  text: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed px-5 py-8 text-center">
      <Icon className="mb-2 h-7 w-7 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{text}</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onAction}>
        {action}
      </Button>
    </div>
  );
}
function AccountDetailsSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-4 w-64" />
      <Card className="p-5">
        <div className="flex gap-4">
          <Skeleton className="h-20 w-20 rounded-2xl" />
          <div className="flex-1 space-y-3">
            <Skeleton className="h-7 w-72" />
            <Skeleton className="h-4 w-96 max-w-full" />
          </div>
        </div>
        <Skeleton className="mt-5 h-11 w-full" />
      </Card>
      <div className="grid gap-3 xl:grid-cols-[1.8fr_0.9fr]">
        <div className="space-y-3">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
        <div className="space-y-3">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    </div>
  );
}
