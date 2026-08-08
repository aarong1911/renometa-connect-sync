// src/components/sales/deal-detail-drawer.tsx

import { useEffect, useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  AlertCircle,
  Bell,
  Briefcase,
  Building2,
  Calendar,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileText,
  Mail,
  MapPin,
  MessageSquare,
  Plus,
  Pencil,
  Phone,
  StickyNote,
  Trash2,
  User,
  Users,
  X,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { StatusBadge, type BadgeTone } from "@/components/ui/status-badge";
import { Button } from "@/components/ui/button";
import { ContactAvatar } from "@/components/ui/contact-avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { AddressAutocomplete } from "@/components/ui/address-autocomplete";
import { Label } from "@/components/ui/label";
import { EntityTasksPanel } from "@/components/tasks/entity-tasks-panel";
import { EntityAppointmentsPanel } from "@/components/appointments/entity-appointments-panel";
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
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  getDealActivities,
  getDealContacts,
  updateDeal,
} from "@/lib/deals-store";
import { formatDateShort, formatMoney } from "@/lib/format";
import { supabase } from "@/lib/supabase";
import { createProject, mapProjectRow, type Project as StoreProject } from "@/lib/projects-store";
import { PROJECT_STATUS_LABELS } from "@/lib/project-status";
// Contextual-drawer principle (Bug 2) — the exact same Project detail Sheet
// the Projects page and Calendar already reuse, never a second Project
// detail implementation.
import { ProjectDetailSheet } from "@/routes/projects.index";
import { EstimateFormSheet, fetchEstimateById, type Estimate as FullEstimate } from "@/routes/estimates";
import type {
  Deal,
  DealActivity,
  DealContact,
  LostReason,
  SalesPipelineStage,
} from "@/lib/sales/types";

const LOST_REASONS: LostReason[] = [
  "Budget",
  "Timing",
  "Scope",
  "Competitor",
  "No response",
];

// Mirrors estimates.tsx's own STATUS_TONE mapping so the drawer's badge
// reads the same way the Estimates page does — not a shared export since
// that page keeps it local too.
const ESTIMATE_STATUS_TONE: Record<string, BadgeTone> = {
  draft: "muted",
  sent: "info",
  viewed: "violet",
  accepted: "success",
  declined: "danger",
};

type LinkedEstimate = {
  id: string;
  number: string | null;
  title: string;
  status: string;
  total: number;
  client_total: number | null;
  created_at: string;
  valid_until: string | null;
  client_name: string | null;
};

const SOURCE_OPTIONS = [
  "Website",
  "Referral",
  "Google Ads",
  "Facebook",
  "Instagram",
  "Angi",
  "Thumbtack",
  "Walk-in",
  "Phone",
  "Other",
];

const SERVICE_OPTIONS = [
  "Kitchen Remodel",
  "Bathroom Remodel",
  "Complete Home Renovation",
  "Addition",
  "Basement Finish",
  "Outdoor Living",
  "Roofing",
  "Windows and Doors",
  "Other",
];

const BUDGET_OPTIONS = [
  "Under $10,000",
  "$10,000–$25,000",
  "$25,000–$50,000",
  "$50,000–$100,000",
  "$100,000–$250,000",
  "$250,000+",
  "Not sure",
];

const TIMELINE_OPTIONS = [
  "Immediately",
  "Within 30 days",
  "Within 60 days",
  "Within 90 days",
  "3–6 months",
  "6–12 months",
  "Just researching",
];

const NEXT_ACTIVITY_OPTIONS = [
  "Follow-up call",
  "Send email",
  "Send SMS",
  "Schedule consultation",
  "Schedule site visit",
  "Prepare estimate",
  "Send estimate",
  "Review proposal",
  "Request documents",
  "Internal review",
  "Other",
];

const REMINDER_OPTIONS = [
  { label: "At time of activity", value: 0 },
  { label: "5 minutes before", value: 5 },
  { label: "15 minutes before", value: 15 },
  { label: "30 minutes before", value: 30 },
  { label: "1 hour before", value: 60 },
  { label: "2 hours before", value: 120 },
  { label: "1 day before", value: 1440 },
  { label: "2 days before", value: 2880 },
  { label: "1 week before", value: 10080 },
];

function reminderLabel(minutes: number): string {
  return (
    REMINDER_OPTIONS.find((option) => option.value === minutes)?.label ??
    `${minutes} minutes before`
  );
}

const MANUAL_ACTIVITY_OPTIONS = [
  "Call",
  "Email",
  "SMS",
  "Meeting",
  "Site visit",
  "Follow-up",
  "Note",
];

type ManualActivityForm = {
  type: string;
  title: string;
  description: string;
  occurredAt: string;
};

const BLANK_MANUAL_ACTIVITY: ManualActivityForm = {
  type: "Call",
  title: "",
  description: "",
  occurredAt: new Date().toISOString().slice(0, 16),
};

type StageOption = {
  id: string;
  name: string;
  slug?: string;
  color?: string;
  pipelineId?: string;
  probability?: number;
};

type TeamMemberOption = {
  id: string;
  name: string;
};

type AccountOption = {
  id: string;
  name: string;
};

type ContactOption = {
  id: string;
  name: string;
  email: string;
  phone: string;
};

type EditForm = {
  name: string;
  value: string;
  probability: string;
  expectedClose: string;
  stage: string;
  ownerId: string;
  contactId: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  companyId: string;
  source: string;
  serviceType: string;
  budget: string;
  timeline: string;
  projectAddress: string;
  nextActivityTitle: string;
  nextActivityAt: string;
  nextActivityAssigneeId: string;
  reminderOffsets: number[];
  notes: string;
};

type DealDetailDrawerProps = {
  deal: Deal | null;
  onOpenChange: (open: boolean) => void;
  onStageChange?: (dealId: string, newStage: string) => void;
  onMarkLost?: (
    dealId: string,
    reason: LostReason,
    notes: string,
  ) => void;
  onDealUpdate?: (
    dealId: string,
    patch: Partial<Deal>,
  ) => void;
  onDelete?: (dealId: string) => void;
  stages?: StageOption[];
  teamMembers?: TeamMemberOption[];
};

function stageBadgeBackground(color: string): string {
  const normalized = color.replace("#", "");

  if (/^[0-9a-fA-F]{6}$/.test(normalized)) {
    const red = Number.parseInt(normalized.slice(0, 2), 16);
    const green = Number.parseInt(normalized.slice(2, 4), 16);
    const blue = Number.parseInt(normalized.slice(4, 6), 16);

    return `rgba(${red}, ${green}, ${blue}, 0.12)`;
  }

  return "#EEF2FF";
}

function normalizeStageBadgeColor(
  value?: string | null,
): string | null {
  if (!value) return null;

  const normalized = value.trim();

  if (/^#[0-9a-fA-F]{6}$/.test(normalized)) {
    return normalized;
  }

  const namedColors: Record<string, string> = {
    blue: "#3B82F6",
    violet: "#8B5CF6",
    purple: "#8B5CF6",
    cyan: "#0EA5E9",
    teal: "#0F766E",
    green: "#22C55E",
    amber: "#F59E0B",
    orange: "#F97316",
    red: "#EF4444",
    rose: "#F43F5E",
  };

  return namedColors[normalized.toLowerCase()] ?? null;
}

function stageBadgeColor(
  deal: Deal,
  stages: StageOption[],
): string {
  const currentStage = stages.find((stage) => {
    return (
      stage.id === deal.stageId ||
      stage.slug === deal.stage ||
      stage.id === deal.stage ||
      stage.name === deal.stageName ||
      stage.name === deal.stage
    );
  });

  const resolvedStageColor = normalizeStageBadgeColor(
    currentStage?.color,
  );

  if (resolvedStageColor) {
    return resolvedStageColor;
  }

  const dealStageColor = normalizeStageBadgeColor(
    deal.stageColor,
  );

  if (dealStageColor) {
    return dealStageColor;
  }

  const key = `${deal.stage} ${deal.stageName}`.toLowerCase();

  if (key.includes("new")) return "#0EA5E9";
  if (key.includes("qualified")) return "#8B5CF6";
  if (key.includes("proposal")) return "#F59E0B";
  if (key.includes("negotiation")) return "#3B82F6";
  if (key.includes("won")) return "#22C55E";
  if (key.includes("lost")) return "#EF4444";

  return "#6366F1";
}

function stageLabel(
  deal: Deal,
  stages: StageOption[],
): string {
  return (
    stages.find((stage) => {
      return (
        stage.id === deal.stageId ||
        stage.slug === deal.stage ||
        stage.id === deal.stage
      );
    })?.name ??
    deal.stageName ??
    deal.stage
  );
}

function selectedStageId(
  deal: Deal,
  stages: StageOption[],
): string {
  return (
    stages.find((stage) => {
      return (
        stage.id === deal.stageId ||
        stage.slug === deal.stage ||
        stage.id === deal.stage ||
        stage.name === deal.stageName ||
        stage.name === deal.stage
      );
    })?.id ??
    deal.stageId ??
    ""
  );
}

function activityIcon(type: string) {
  switch (type) {
    case "created":
    case "updated":
      return {
        Icon: CheckCircle2,
        className: "bg-blue-50 text-blue-600",
      };
    case "stage_changed":
    case "won":
    case "lost":
      return {
        Icon: FileText,
        className: "bg-violet-50 text-violet-600",
      };
    case "contact_linked":
    case "contact_unlinked":
      return {
        Icon: Users,
        className: "bg-emerald-50 text-emerald-600",
      };
    case "note_added":
      return {
        Icon: StickyNote,
        className: "bg-amber-50 text-amber-600",
      };
    default:
      return {
        Icon: MessageSquare,
        className: "bg-slate-100 text-slate-600",
      };
  }
}

function activityDisplayTitle(activity: DealActivity): string {
  if (activity.title !== "Deal updated") {
    return activity.title;
  }

  const metadata = activity.metadata ?? {};
  const field =
    metadata.field_label ??
    metadata.field ??
    metadata.property;

  if (field) {
    return `${String(field)} updated`;
  }

  return "Deal details updated";
}

function activityDetailLines(
  activity: DealActivity,
): string[] {
  const metadata = activity.metadata ?? {};
  const lines: string[] = [];

  const previous =
    metadata.previous_value ??
    metadata.previous ??
    metadata.from ??
    metadata.old_value;
  const next =
    metadata.new_value ??
    metadata.next ??
    metadata.to ??
    metadata.value;
  const field =
    metadata.field_label ??
    metadata.field ??
    metadata.property;

  if (field && previous !== undefined && next !== undefined) {
    lines.push(`${String(field)}: ${String(previous)} → ${String(next)}`);
  } else if (previous !== undefined && next !== undefined) {
    lines.push(`${String(previous)} → ${String(next)}`);
  }

  const assignee =
    metadata.assignee_name ??
    metadata.assigned_to_name ??
    metadata.owner_name;

  if (assignee) {
    lines.push(`Assigned to ${String(assignee)}`);
  }

  const reminderValues = metadata.reminders;
  if (Array.isArray(reminderValues) && reminderValues.length > 0) {
    const labels = reminderValues
      .map((value) => reminderLabel(Number(value)))
      .join(", ");
    lines.push(`Reminders: ${labels}`);
  }

  const related =
    metadata.account_name ??
    metadata.contact_name ??
    metadata.estimate_number ??
    metadata.task_title;

  if (related) {
    lines.push(String(related));
  }

  return lines;
}

function formatExactDate(value: string): string {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function EmptyTab({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof FileText;
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed p-6 text-center">
      <Icon className="mb-3 h-8 w-8 text-muted-foreground/50" />
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 max-w-xs text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

export function DealDetailDrawer({
  deal,
  onOpenChange,
  onStageChange,
  onMarkLost,
  onDealUpdate,
  onDelete,
  stages = [],
  teamMembers = [],
}: DealDetailDrawerProps) {
  const [activeTab, setActiveTab] = useState("overview");
  const [activities, setActivities] = useState<DealActivity[]>([]);
  const [contacts, setContacts] = useState<DealContact[]>([]);
  const [loadingActivity, setLoadingActivity] = useState(false);
  const [addActivityOpen, setAddActivityOpen] = useState(false);
  const [addingActivity, setAddingActivity] = useState(false);
  const [manualActivity, setManualActivity] =
    useState<ManualActivityForm>(BLANK_MANUAL_ACTIVITY);
  const [loadingContacts, setLoadingContacts] = useState(false);

  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [contactOptions, setContactOptions] = useState<ContactOption[]>([]);
  const [loadingContactOptions, setLoadingContactOptions] = useState(false);

  const [estimates, setEstimates] = useState<LinkedEstimate[]>([]);
  const [loadingEstimates, setLoadingEstimates] = useState(false);
  const [estimatesError, setEstimatesError] = useState<string | null>(null);

  const [linkedProject, setLinkedProject] = useState<StoreProject | null>(null);
  const [loadingProject, setLoadingProject] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  // Contextual-drawer principle (Bug 2) — "Open Project" opens the exact
  // same ProjectDetailSheet the Projects page and Calendar already reuse,
  // layered over this Deal drawer, instead of navigating to /projects.
  const [projectSheetOpen, setProjectSheetOpen] = useState(false);
  // Same principle for "Open Estimate" — reuses the exported EstimateFormSheet
  // (src/routes/estimates.tsx) in edit mode instead of navigating to
  // /estimates (which previously didn't even deep-link to the right estimate).
  const [estimateDrawerOpen, setEstimateDrawerOpen] = useState(false);
  const [estimateDrawerEstimate, setEstimateDrawerEstimate] = useState<FullEstimate | null>(null);
  const [estimateDrawerLoading, setEstimateDrawerLoading] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [lostOpen, setLostOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [lostReason, setLostReason] = useState<LostReason | "">("");
  const [lostNotes, setLostNotes] = useState("");
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [reminderToAdd, setReminderToAdd] = useState("1440");

  const stageOptions = useMemo(() => {
    const activePipelineId = deal?.pipelineId;
    const seen = new Set<string>();

    return stages
      .filter((stage) => {
        if (!activePipelineId || !stage.pipelineId) return true;
        return stage.pipelineId === activePipelineId;
      })
      .filter((stage) => {
        const key = (stage.slug ?? stage.name).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [deal?.pipelineId, stages]);

  useEffect(() => {
    setActiveTab("overview");

    if (!deal) {
      setActivities([]);
      setContacts([]);
      setEstimates([]);
      setEstimatesError(null);
      setLinkedProject(null);
      return;
    }

    void loadActivity(deal.id);
    void loadContacts(deal.id);
    void loadAccounts();
    void loadContactOptions();
    void loadEstimates(deal.id, deal.orgId);
    void loadLinkedProject(deal.id, deal.orgId);
  }, [deal?.id]);

  async function loadLinkedProject(dealId: string, orgId: string) {
    setLoadingProject(true);

    try {
      const { data, error } = await supabase
        .from("projects")
        .select("*, contacts!client_id(full_name), owner_profile:profiles!owner_id(first_name,last_name,email)")
        .eq("deal_id", dealId)
        .eq("org_id", orgId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;

      setLinkedProject(data ? mapProjectRow(data) : null);
    } catch (error) {
      console.error("[deal-drawer] project load failed:", error);
    } finally {
      setLoadingProject(false);
    }
  }

  async function handleCreateProject() {
    if (!deal || linkedProject || creatingProject) return;

    setCreatingProject(true);

    try {
      // Part 6 — defensive re-verify against the server immediately before
      // creating: local `linkedProject` state can be stale (e.g. another
      // tab/session just converted an Estimate for this Deal into a
      // Project). Never let a race create a duplicate Project.
      const { data: existing, error: existingErr } = await supabase
        .from("projects")
        .select("*, contacts!client_id(full_name), owner_profile:profiles!owner_id(first_name,last_name,email)")
        .eq("deal_id", deal.id)
        .eq("org_id", deal.orgId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existingErr) throw existingErr;
      if (existing) {
        const mapped = mapProjectRow(existing);
        setLinkedProject(mapped);
        toast.info(`Project "${mapped.name}" is already linked to this deal`);
        return;
      }

      const { project, error } = await createProject({
        name: deal.name,
        client_id: deal.contactId,
        status: "planning",
        address: deal.projectAddress || deal.address || undefined,
        budget_total: deal.value || undefined,
        ownerId: deal.ownerId ?? null,
        dealId: deal.id,
      });

      if (error || !project) throw error ?? new Error("Project not created");

      setLinkedProject(project);

      const {
        data: { user },
      } = await supabase.auth.getUser();

      await supabase.from("deal_activities").insert({
        org_id: deal.orgId,
        deal_id: deal.id,
        activity_type: "custom",
        title: "Converted to Project",
        description: project.name,
        actor_id: user?.id ?? null,
        actor_name:
          teamMembers.find((member) => member.id === user?.id)?.name ?? user?.email ?? "Team member",
        occurred_at: new Date().toISOString(),
      });

      toast.success(`Project "${project.name}" created`);
      void loadActivity(deal.id);
    } catch (error: any) {
      console.error("[deal-drawer] create project failed:", error);
      toast.error(error?.message ?? "Failed to create project");
    } finally {
      setCreatingProject(false);
    }
  }

  async function openEstimateDrawer(estimateId: string) {
    if (!deal) return;
    setEstimateDrawerLoading(true);
    try {
      const est = await fetchEstimateById(deal.orgId, estimateId);
      if (!est) { toast.error("Could not load this estimate"); return; }
      setEstimateDrawerEstimate(est);
      setEstimateDrawerOpen(true);
    } finally {
      setEstimateDrawerLoading(false);
    }
  }

  async function loadEstimates(dealId: string, orgId: string) {
    setLoadingEstimates(true);
    setEstimatesError(null);

    try {
      const { data, error } = await supabase
        .from("estimates")
        .select("id, number, title, status, total, client_total, created_at, valid_until, client_name")
        .eq("deal_id", dealId)
        .eq("org_id", orgId)
        .order("created_at", { ascending: false });

      if (error) throw error;

      setEstimates((data ?? []) as LinkedEstimate[]);
    } catch (error) {
      console.error("[deal-drawer] estimates load failed:", error);
      setEstimatesError("Failed to load estimates for this deal.");
    } finally {
      setLoadingEstimates(false);
    }
  }

  async function loadContactOptions() {
    setLoadingContactOptions(true);

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setContactOptions([]);
        return;
      }

      const { data: profile } = await supabase
        .from("profiles")
        .select("organization_id")
        .eq("id", user.id)
        .maybeSingle();

      const organizationId = profile?.organization_id;

      if (!organizationId) {
        setContactOptions([]);
        return;
      }

      const { data, error } = await supabase
        .from("contacts")
        .select("id, full_name, email, phone")
        .eq("org_id", organizationId)
        .order("full_name", { ascending: true });

      if (error) throw error;

      setContactOptions(
        (data ?? []).map((contact) => ({
          id: contact.id,
          name: contact.full_name ?? "Unnamed contact",
          email: contact.email ?? "",
          phone: contact.phone ?? "",
        })),
      );
    } catch (error) {
      console.error("[deal-drawer] contact option load failed:", error);
      setContactOptions([]);
    } finally {
      setLoadingContactOptions(false);
    }
  }

  async function loadAccounts() {
    setLoadingAccounts(true);

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setAccounts([]);
        return;
      }

      const { data: profile } = await supabase
        .from("profiles")
        .select("organization_id")
        .eq("id", user.id)
        .maybeSingle();

      const organizationId = profile?.organization_id;

      if (!organizationId) {
        setAccounts([]);
        return;
      }

      const { data, error } = await supabase
        .from("companies")
        .select("id, name")
        .eq("org_id", organizationId)
        .order("name", { ascending: true });

      if (error) throw error;

      setAccounts(
        (data ?? []).map((account) => ({
          id: account.id,
          name: account.name,
        })),
      );
    } catch (error) {
      console.error("[deal-drawer] account load failed:", error);
      setAccounts([]);
    } finally {
      setLoadingAccounts(false);
    }
  }

  async function addManualActivity() {
    if (!deal || !manualActivity.title.trim()) return;

    setAddingActivity(true);

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      const activityType =
        manualActivity.type === "Note"
          ? "note_added"
          : "custom";

      const { error } = await supabase
        .from("deal_activities")
        .insert({
          org_id: deal.orgId,
          deal_id: deal.id,
          activity_type: activityType,
          title: manualActivity.title.trim(),
          description: manualActivity.description.trim() || null,
          actor_id: user?.id ?? null,
          actor_name:
            teamMembers.find((member) => member.id === user?.id)?.name ??
            user?.email ??
            "Team member",
          metadata: {
            manual_type: manualActivity.type,
          },
          occurred_at:
            new Date(manualActivity.occurredAt).toISOString(),
        });

      if (error) throw error;

      await loadActivity(deal.id);
      setManualActivity(BLANK_MANUAL_ACTIVITY);
      setAddActivityOpen(false);
      toast.success("Activity added");
    } catch (error) {
      console.error("[deal-drawer] add activity failed:", error);
      toast.error("Failed to add activity.");
    } finally {
      setAddingActivity(false);
    }
  }

  async function loadActivity(dealId: string) {
    setLoadingActivity(true);

    try {
      setActivities(await getDealActivities(dealId));
    } catch (error) {
      console.error("[deal-drawer] activity load failed:", error);
      setActivities([]);
    } finally {
      setLoadingActivity(false);
    }
  }

  async function loadContacts(dealId: string) {
    setLoadingContacts(true);

    try {
      setContacts(await getDealContacts(dealId));
    } catch (error) {
      console.error("[deal-drawer] contacts load failed:", error);
      setContacts([]);
    } finally {
      setLoadingContacts(false);
    }
  }

  function openEdit() {
    if (!deal) return;

    setEditForm({
      name: deal.name,
      value: String(deal.value),
      probability: String(deal.probability),
      expectedClose: deal.expectedClose,
      stage: selectedStageId(deal, stageOptions),
      ownerId: deal.ownerId ?? "",
      contactId: deal.contactId ?? "",
      contactName: deal.contactName ?? "",
      contactEmail: deal.email ?? "",
      contactPhone: deal.phone ?? "",
      companyId: deal.companyId ?? "",
      source: deal.source ?? "",
      serviceType: deal.serviceType ?? "",
      budget: deal.budget ?? "",
      timeline: deal.timeline ?? "",
      projectAddress: deal.projectAddress ?? deal.address ?? "",
      nextActivityTitle: deal.nextActivityTitle ?? "",
      nextActivityAt: deal.nextActivityAt?.slice(0, 16) ?? "",
      nextActivityAssigneeId:
        String(deal.customFields?.next_activity_assignee_id ?? ""),
      reminderOffsets: Array.isArray(
        deal.customFields?.next_activity_reminders,
      )
        ? (
            deal.customFields?.next_activity_reminders as unknown[]
          )
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value))
        : deal.nextActivityTitle
          ? [1440, 60]
          : [],
      notes: deal.notes ?? "",
    });

    setEditOpen(true);
  }

  function updateEditField<K extends keyof EditForm>(
    field: K,
    value: EditForm[K],
  ) {
    setEditForm((current) => {
      if (!current) return current;

      return {
        ...current,
        [field]: value,
      };
    });
  }

  function addReminder() {
    if (!editForm) return;

    const minutes = Number(reminderToAdd);

    if (!Number.isFinite(minutes)) return;

    updateEditField(
      "reminderOffsets",
      [...new Set([...editForm.reminderOffsets, minutes])].sort(
        (a, b) => b - a,
      ),
    );
  }

  function removeReminder(minutes: number) {
    if (!editForm) return;

    updateEditField(
      "reminderOffsets",
      editForm.reminderOffsets.filter((value) => value !== minutes),
    );
  }

  function formatActivityValue(
    value: unknown,
    type?: "money" | "date" | "percent",
  ): string {
    if (value === null || value === undefined || value === "") {
      return "None";
    }

    if (type === "money") {
      return formatMoney(Number(value) || 0);
    }

    if (type === "percent") {
      return `${Number(value) || 0}%`;
    }

    if (type === "date") {
      return formatDateShort(String(value));
    }

    return String(value);
  }

  async function recordDetailedChanges(
    originalDeal: Deal,
    form: EditForm,
    selectedStage: StageOption | undefined,
  ) {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const actorName =
      teamMembers.find((member) => member.id === user?.id)?.name ??
      user?.email ??
      "Team member";

    const previousAssigneeId = String(
      originalDeal.customFields?.next_activity_assignee_id ?? "",
    );
    const previousReminders = Array.isArray(
      originalDeal.customFields?.next_activity_reminders,
    )
      ? (
          originalDeal.customFields
            ?.next_activity_reminders as unknown[]
        )
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value))
      : [];

    const selectedOwner =
      teamMembers.find((member) => member.id === form.ownerId)?.name ??
      "Unassigned";
    const selectedContact =
      contactOptions.find((contact) => contact.id === form.contactId)?.name ??
      form.contactName ??
      "No contact";
    const selectedAccount =
      accounts.find((account) => account.id === form.companyId)?.name ??
      "No account";
    const selectedActivityAssignee =
      teamMembers.find(
        (member) => member.id === form.nextActivityAssigneeId,
      )?.name ?? "Unassigned";
    const previousActivityAssignee =
      teamMembers.find((member) => member.id === previousAssigneeId)?.name ??
      "Unassigned";

    const changes: Array<{
      title: string;
      field: string;
      previous: unknown;
      next: unknown;
      valueType?: "money" | "date" | "percent";
      activityType?: string;
    }> = [
      {
        title: "Deal name updated",
        field: "Deal name",
        previous: originalDeal.name,
        next: form.name.trim(),
      },
      {
        title: "Deal value updated",
        field: "Value",
        previous: originalDeal.value,
        next: Number(form.value) || 0,
        valueType: "money",
        activityType: "value_changed",
      },
      {
        title: "Probability updated",
        field: "Probability",
        previous: originalDeal.probability,
        next: Number(form.probability) || 0,
        valueType: "percent",
      },
      {
        title: "Stage changed",
        field: "Stage",
        previous: originalDeal.stageName ?? originalDeal.stage,
        next: selectedStage?.name ?? form.stage,
        activityType: "stage_changed",
      },
      {
        title: "Expected close updated",
        field: "Expected close",
        previous: originalDeal.expectedClose,
        next: form.expectedClose,
        valueType: "date",
      },
      {
        title: "Owner changed",
        field: "Owner",
        previous: originalDeal.owner ?? "Unassigned",
        next: selectedOwner,
        activityType: "owner_changed",
      },
      {
        title: "Contact changed",
        field: "Contact",
        previous: originalDeal.contactName ?? "No contact",
        next: selectedContact,
      },
      {
        title: "Account changed",
        field: "Account",
        previous: originalDeal.companyName ?? "No account",
        next: selectedAccount,
      },
      {
        title: "Source updated",
        field: "Source",
        previous: originalDeal.source,
        next: form.source,
      },
      {
        title: "Service type updated",
        field: "Service type",
        previous: originalDeal.serviceType,
        next: form.serviceType,
      },
      {
        title: "Budget updated",
        field: "Budget",
        previous: originalDeal.budget,
        next: form.budget,
      },
      {
        title: "Timeline updated",
        field: "Timeline",
        previous: originalDeal.timeline,
        next: form.timeline,
      },
      {
        title: "Project address updated",
        field: "Project address",
        previous: originalDeal.projectAddress,
        next: form.projectAddress,
      },
      {
        title: "Next activity updated",
        field: "Next activity",
        previous: originalDeal.nextActivityTitle,
        next: form.nextActivityTitle,
      },
      {
        title: "Next activity due updated",
        field: "Next activity due",
        previous: originalDeal.nextActivityAt,
        next: form.nextActivityAt,
        valueType: "date",
      },
      {
        title: "Activity assignee changed",
        field: "Activity assignee",
        previous: previousActivityAssignee,
        next: selectedActivityAssignee,
      },
      {
        title: "Notes updated",
        field: "Notes",
        previous: originalDeal.notes,
        next: form.notes,
      },
    ];

    const rows: Array<{
      org_id: string;
      deal_id: string;
      activity_type: string;
      title: string;
      description: string;
      actor_id: string | null;
      actor_name: string;
      metadata: Record<string, unknown>;
      occurred_at: string;
    }> = changes
      .filter((change) => {
        const previous = formatActivityValue(
          change.previous,
          change.valueType,
        );
        const next = formatActivityValue(change.next, change.valueType);
        return previous !== next;
      })
      .map((change) => ({
        org_id: originalDeal.orgId,
        deal_id: originalDeal.id,
        activity_type: change.activityType ?? "updated",
        title: change.title,
        description: `${formatActivityValue(
          change.previous,
          change.valueType,
        )} → ${formatActivityValue(change.next, change.valueType)}`,
        actor_id: user?.id ?? null,
        actor_name: actorName,
        metadata: {
          field_label: change.field,
          previous_value: formatActivityValue(
            change.previous,
            change.valueType,
          ),
          new_value: formatActivityValue(
            change.next,
            change.valueType,
          ),
        },
        occurred_at: new Date().toISOString(),
      }));

    const remindersChanged =
      JSON.stringify([...previousReminders].sort((a, b) => a - b)) !==
      JSON.stringify([...form.reminderOffsets].sort((a, b) => a - b));

    if (remindersChanged) {
      rows.push({
        org_id: originalDeal.orgId,
        deal_id: originalDeal.id,
        activity_type: "updated",
        title: "Activity reminders updated",
        description: form.reminderOffsets.length
          ? form.reminderOffsets.map(reminderLabel).join(", ")
          : "All reminders removed",
        actor_id: user?.id ?? null,
        actor_name: actorName,
        metadata: {
          field_label: "Activity reminders",
          previous_value: previousReminders.length
            ? previousReminders.map(reminderLabel).join(", ")
            : "None",
          new_value: form.reminderOffsets.length
            ? form.reminderOffsets.map(reminderLabel).join(", ")
            : "None",
          reminders: form.reminderOffsets,
        },
        occurred_at: new Date().toISOString(),
      });
    }

    if (!rows.length) return;

    const { error } = await supabase
      .from("deal_activities")
      .insert(rows);

    if (error) {
      console.error("[deal-drawer] detailed activity insert failed:", error);
    }
  }

  async function saveEdit() {
    if (!deal || !editForm) return;

    const selectedStage = stageOptions.find((stage) => {
      return stage.id === editForm.stage;
    });

    const patch = {
      name: editForm.name.trim(),
      value: Number(editForm.value) || 0,
      probability: Number(editForm.probability) || 0,
      expectedClose: editForm.expectedClose,
      stage: selectedStage?.slug ?? selectedStage?.id ?? editForm.stage,
      stageId: selectedStage?.id ?? editForm.stage,
      ownerId: editForm.ownerId || undefined,
      contactId: editForm.contactId || undefined,
      contactName: editForm.contactName || undefined,
      email: editForm.contactEmail || undefined,
      phone: editForm.contactPhone || undefined,
      companyId: editForm.companyId || undefined,
      source: editForm.source || null,
      serviceType: editForm.serviceType || null,
      budget: editForm.budget || null,
      timeline: editForm.timeline || null,
      projectAddress: editForm.projectAddress || null,
      nextActivityTitle: editForm.nextActivityTitle || null,
      nextActivityAt: editForm.nextActivityAt || null,
      customFields: {
        ...deal.customFields,
        next_activity_assignee_id:
          editForm.nextActivityAssigneeId || null,
        next_activity_reminders:
          editForm.nextActivityTitle && editForm.nextActivityAt
            ? editForm.reminderOffsets
            : [],
        next_activity_reminder_recipient_id:
          editForm.nextActivityAssigneeId ||
          editForm.ownerId ||
          deal.ownerId ||
          null,
      },
      notes: editForm.notes || null,
    };

    setSaving(true);

    try {
      if (onDealUpdate) {
        await onDealUpdate(deal.id, patch as Partial<Deal>);
      } else {
        await updateDeal(deal.id, patch);
      }

      await recordDetailedChanges(deal, editForm, selectedStage);

      toast.success("Deal updated");
      setEditOpen(false);
      await loadActivity(deal.id);
    } catch (error) {
      console.error("[deal-drawer] update failed:", error);
      toast.error("Failed to update deal.");
    } finally {
      setSaving(false);
    }
  }

  async function handleWon() {
    if (!deal) return;
    // Part 11 — idempotency: the action bar already hides this button once
    // a deal is Won, but guard the handler itself too (defense in depth
    // against a stale render / rapid double-click) so a duplicate call can
    // never re-fire the "marked as Won" toast or side effects.
    if (deal.status === "won") {
      toast.info(`${deal.name} is already marked Won`);
      return;
    }

    try {
      if (onStageChange) {
        await onStageChange(deal.id, "won");
      } else {
        await updateDeal(deal.id, {
          stage: "won",
          status: "won",
        });
      }

      toast.success(`${deal.name} marked as Won`, {
        description: `${formatMoney(deal.value)} added to closed revenue.`,
      });

      onOpenChange(false);
    } catch (error) {
      console.error("[deal-drawer] mark won failed:", error);
      toast.error("Failed to mark deal as won.");
    }
  }

  async function confirmLost() {
    if (!deal || !lostReason) return;
    // Part 11 — same idempotency guard as handleWon.
    if (deal.status === "lost") {
      toast.info(`${deal.name} is already marked Lost`);
      setLostOpen(false);
      return;
    }

    setSaving(true);

    try {
      if (onMarkLost) {
        await onMarkLost(deal.id, lostReason, lostNotes);
      } else {
        await updateDeal(deal.id, {
          stage: "lost",
          status: "lost",
          lostReason,
          notes: lostNotes || deal.notes,
        });
      }

      toast.success(`${deal.name} marked as Lost`);
      setLostOpen(false);
      onOpenChange(false);
    } catch (error) {
      console.error("[deal-drawer] mark lost failed:", error);
      toast.error("Failed to mark deal as lost.");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deal || !onDelete) return;

    setSaving(true);

    try {
      await onDelete(deal.id);
      toast.success("Deal deleted");
      setDeleteOpen(false);
      onOpenChange(false);
    } catch (error) {
      console.error("[deal-drawer] delete failed:", error);
      toast.error("Failed to delete deal.");
    } finally {
      setSaving(false);
    }
  }

  if (!deal) {
    return (
      <Sheet open={false} onOpenChange={onOpenChange}>
        <SheetContent />
      </Sheet>
    );
  }

  const currentStageName = stageLabel(deal, stages);

  return (
    <>
      <Sheet open onOpenChange={onOpenChange}>
        <SheetContent className="w-full overflow-y-auto p-0 sm:max-w-3xl [&>button.absolute]:hidden">
          <SheetHeader className="border-b px-5 pb-5 pt-5 text-left">
            <div className="rounded-xl border bg-card p-4">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <Badge
                      className="px-2.5 py-1 font-semibold shadow-sm"
                      variant="outline"
                      style={{
                        borderColor: stageBadgeColor(deal, stages),
                        backgroundColor: stageBadgeBackground(
                          stageBadgeColor(deal, stages),
                        ),
                        color: stageBadgeColor(deal, stages),
                      }}
                    >
                      {currentStageName}
                    </Badge>

                    <Badge variant="secondary">
                      {deal.probability}% probability
                    </Badge>
                  </div>

                  <SheetTitle className="text-xl font-semibold leading-tight">
                    {deal.name}
                  </SheetTitle>

                  <div className="mt-3 grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <PersonAvatar
                        id={deal.contactId}
                        name={deal.contactName || "No contact"}
                        avatarKey={deal.contactAvatarKey}
                        avatarUrl={deal.contactAvatarUrl}
                        size="sm"
                      />
                      <div className="min-w-0">
                        <p className="text-[10px] uppercase tracking-wide">
                          Contact
                        </p>
                        <p className="truncate font-medium text-foreground">
                          {deal.contactName || "No contact"}
                        </p>
                      </div>
                    </div>

                    <div className="flex min-w-0 items-center gap-2">
                      <PersonAvatar
                        id={deal.ownerId}
                        name={deal.owner || "Unassigned"}
                        avatarUrl={deal.ownerAvatarUrl}
                        size="sm"
                      />
                      <div className="min-w-0">
                        <p className="text-[10px] uppercase tracking-wide">
                          Owner
                        </p>
                        <p className="truncate font-medium text-foreground">
                          {deal.owner || "Unassigned"}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="rounded-lg bg-[#FAF3E4] px-4 py-3 lg:min-w-44 lg:text-right">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Deal value
                  </p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
                    {formatMoney(deal.value)}
                  </p>
                  <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground lg:justify-end">
                    <Calendar className="h-3.5 w-3.5 text-amber-600" />
                    Expected {formatDateShort(deal.expectedClose)}
                  </p>
                </div>
              </div>

              {deal.lostReason && (
                <div className="mt-4 flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
                  <AlertCircle className="mt-0.5 h-4 w-4 text-red-600" />
                  <div>
                    <p className="text-sm font-medium text-red-700">
                      Lost · {deal.lostReason}
                    </p>
                    {deal.lostAt && (
                      <p className="text-xs text-red-600/80">
                        {formatDistanceToNow(new Date(deal.lostAt), {
                          addSuffix: true,
                        })}
                      </p>
                    )}
                  </div>
                </div>
              )}

              <div className="mt-4 flex flex-wrap gap-2 border-t pt-4">
                <Button size="sm" variant="outline" onClick={openEdit}>
                  <Pencil className="mr-1.5 h-4 w-4" />
                  Edit
                </Button>

                {/* Part 2/3 — action buttons represent possible TRANSITIONS out
                    of the deal's current terminal state, not a single "open"
                    gate: a Won deal can still be reverted to Lost (and vice
                    versa); only the transition INTO the deal's own current
                    state is hidden. */}
                {deal.status !== "won" && (
                  <Button
                    size="sm"
                    className="bg-blue-600 text-white hover:bg-blue-700"
                    onClick={handleWon}
                  >
                    <CheckCircle2 className="mr-1.5 h-4 w-4" />
                    Mark Won
                  </Button>
                )}

                {deal.status !== "lost" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setLostReason("");
                      setLostNotes("");
                      setLostOpen(true);
                    }}
                  >
                    <XCircle className="mr-1.5 h-4 w-4" />
                    Mark Lost
                  </Button>
                )}

                {onDelete && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setDeleteOpen(true)}
                  >
                    <Trash2 className="mr-1.5 h-4 w-4" />
                    Delete
                  </Button>
                )}
              </div>
            </div>
          </SheetHeader>

          <Tabs
            value={activeTab}
            onValueChange={setActiveTab}
            className="px-5 pb-6 pt-4"
          >
            <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto bg-transparent p-0">
              {[
                ["overview", "Overview"],
                ["activity", "Activity"],
                ["contacts", "Contacts"],
                ["estimate", "Estimate / Project"],
                ["tasks", "Tasks"],
                ["appointments", "Appointments"],
                ["notes", "Notes"],
                ["files", "Files"],
              ].map(([value, label]) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  className="rounded-md border border-transparent bg-transparent px-3 py-2
                    shadow-none transition-colors hover:bg-[#FAF3E4]/60
                    data-[state=active]:border-[#EADFC8]
                    data-[state=active]:bg-[#FAF3E4]
                    data-[state=active]:text-foreground
                    data-[state=active]:shadow-none"
                >
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value="overview" className="mt-5 space-y-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <PersonInfoCard
                  id={deal.contactId}
                  name={deal.contactName || "No contact"}
                  avatarKey={deal.contactAvatarKey}
                  avatarUrl={deal.contactAvatarUrl}
                  label="Primary contact"
                  detail={deal.email || deal.phone || undefined}
                />

                <InfoCard
                  icon={Building2}
                  iconClassName="bg-emerald-50 text-emerald-600"
                  label="Account"
                  value={deal.companyName || "No account"}
                />

                <PersonInfoCard
                  id={deal.ownerId}
                  name={deal.owner || "Unassigned"}
                  avatarUrl={deal.ownerAvatarUrl}
                  label="Owner"
                />

                <InfoCard
                  icon={Calendar}
                  iconClassName="bg-amber-50 text-amber-600"
                  label="Expected close"
                  value={formatDateShort(deal.expectedClose)}
                />

                <InfoCard
                  icon={FileText}
                  iconClassName="bg-blue-50 text-blue-600"
                  label="Source"
                  value={deal.source || "Not set"}
                />

                <InfoCard
                  icon={FileText}
                  iconClassName="bg-rose-50 text-rose-600"
                  label="Service type"
                  value={deal.serviceType || "Not set"}
                />

                <InfoCard
                  icon={FileText}
                  iconClassName="bg-lime-50 text-lime-700"
                  label="Budget"
                  value={deal.budget || "Not set"}
                />

                <InfoCard
                  icon={Clock3}
                  iconClassName="bg-orange-50 text-orange-600"
                  label="Timeline"
                  value={deal.timeline || "Not set"}
                />
              </div>

              <section>
                <SectionTitle>Project address</SectionTitle>
                <div className="flex gap-2 rounded-lg border bg-card p-3 text-sm">
                  <MapPin className="mt-0.5 h-4 w-4 text-teal-600" />
                  <span>
                    {deal.projectAddress || deal.address || "No address added"}
                  </span>
                </div>
              </section>

              <section>
                <SectionTitle>Next activity</SectionTitle>
                <div className="rounded-lg border bg-card p-3">
                  <p className="text-sm font-medium">
                    {deal.nextActivityTitle || "No next activity scheduled"}
                  </p>
                  {deal.nextActivityAt && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {new Date(deal.nextActivityAt).toLocaleString()}
                    </p>
                  )}
                </div>
              </section>

              {deal.tags.length > 0 && (
                <section>
                  <SectionTitle>Tags</SectionTitle>
                  <div className="flex flex-wrap gap-2">
                    {deal.tags.map((tag) => (
                      <Badge key={tag} variant="secondary">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </section>
              )}
            </TabsContent>

            <TabsContent value="activity" className="mt-5">
              <div className="mb-4 flex flex-col gap-3">
                <div className="flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    className="bg-blue-600 text-white hover:bg-blue-700"
                    onClick={() => setAddActivityOpen(true)}
                  >
                    <Plus className="mr-1.5 h-4 w-4" />
                    Add activity
                  </Button>
                </div>

                {deal.nextActivityTitle && (
                  <div className="rounded-xl border border-[#E3CA9A]
                    bg-[#FAF3E4]/45 p-4">
                    <div className="flex items-start gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center
                        justify-center rounded-full bg-white text-amber-700">
                        <Bell className="h-4 w-4" />
                      </div>

                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold uppercase
                          tracking-wide text-muted-foreground">
                          Upcoming activity
                        </p>
                        <p className="mt-0.5 text-sm font-semibold">
                          {deal.nextActivityTitle}
                        </p>

                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1
                          text-xs text-muted-foreground">
                          {deal.nextActivityAt && (
                            <span>
                              Due {formatExactDate(deal.nextActivityAt)}
                            </span>
                          )}
                          <span>
                            Assigned to{" "}
                            {teamMembers.find(
                              (member) =>
                                member.id ===
                                String(
                                  deal.customFields
                                    ?.next_activity_assignee_id ?? "",
                                ),
                            )?.name ??
                              deal.owner ??
                              "Unassigned"}
                          </span>
                        </div>

                        {Array.isArray(
                          deal.customFields?.next_activity_reminders,
                        ) &&
                          (
                            deal.customFields
                              ?.next_activity_reminders as unknown[]
                          ).length > 0 && (
                            <p className="mt-2 text-xs text-muted-foreground">
                              Reminders:{" "}
                              {(
                                deal.customFields
                                  ?.next_activity_reminders as unknown[]
                              )
                                .map((value) =>
                                  reminderLabel(Number(value)),
                                )
                                .join(", ")}
                            </p>
                          )}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {loadingActivity ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  Loading activity...
                </p>
              ) : activities.length ? (
                <div className="space-y-3">
                  {activities.map((activity) => {
                    const { Icon, className } = activityIcon(
                      activity.activityType,
                    );
                    const detailLines = activityDetailLines(activity);

                    return (
                      <div
                        key={activity.id}
                        className="flex gap-3 rounded-xl border bg-card p-4"
                      >
                        <div
                          className={`flex h-9 w-9 shrink-0 items-center
                            justify-center rounded-full ${className}`}
                        >
                          <Icon className="h-4 w-4" />
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-start
                            justify-between gap-2">
                            <p className="text-sm font-semibold">
                              {activityDisplayTitle(activity)}
                            </p>
                            <span className="text-xs text-muted-foreground">
                              {formatExactDate(activity.occurredAt)}
                            </span>
                          </div>

                          {activity.description ? (
                            <p className="mt-1 text-sm text-muted-foreground">
                              {activity.description}
                            </p>
                          ) : activity.title === "Deal updated" &&
                            detailLines.length === 0 ? (
                            <p className="mt-1 text-sm text-muted-foreground">
                              One or more Deal fields were updated.
                            </p>
                          ) : null}

                          {detailLines.length > 0 && (
                            <div className="mt-2 space-y-1">
                              {detailLines.map((line) => (
                                <p
                                  key={line}
                                  className="text-xs font-medium text-foreground"
                                >
                                  {line}
                                </p>
                              ))}
                            </div>
                          )}

                          <div className="mt-3 flex flex-wrap items-center
                            gap-x-2 text-xs text-muted-foreground">
                            <span>{activity.actorName || "System"}</span>
                            <span>·</span>
                            <span>
                              {formatDistanceToNow(
                                new Date(activity.occurredAt),
                                { addSuffix: true },
                              )}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <EmptyTab
                  icon={MessageSquare}
                  title="No activity yet"
                  description="Deal changes, calls, notes, stage updates, tasks, and estimates will appear here."
                />
              )}
            </TabsContent>

            <TabsContent value="contacts" className="mt-5">
              {loadingContacts ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  Loading contacts...
                </p>
              ) : contacts.length ? (
                <div className="space-y-3">
                  {contacts.map((link) => {
                    const contact = link.contact;

                    return (
                      <div
                        key={link.id}
                        className="flex items-center gap-3 rounded-lg border bg-card p-3"
                      >
                        <ContactAvatar
                          id={contact?.id ?? link.contactId}
                          name={contact?.fullName ?? "Contact"}
                          avatarKey={contact?.avatarKey}
                          size="md"
                        />

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-medium">
                              {contact?.fullName ?? "Unknown contact"}
                            </p>
                            {link.isPrimary && (
                              <Badge variant="secondary">Primary</Badge>
                            )}
                          </div>

                          <p className="truncate text-xs text-muted-foreground">
                            {link.role || link.relationshipTitle || "Stakeholder"}
                          </p>
                        </div>

                        <div className="flex gap-1">
                          {contact?.email && (
                            <Button size="icon" variant="ghost" asChild>
                              <a href={`mailto:${contact.email}`}>
                                <Mail className="h-4 w-4" />
                              </a>
                            </Button>
                          )}

                          {contact?.phone && (
                            <Button size="icon" variant="ghost" asChild>
                              <a href={`tel:${contact.phone}`}>
                                <Phone className="h-4 w-4" />
                              </a>
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <EmptyTab
                  icon={Users}
                  title="No additional contacts"
                  description="The primary contact is still linked through the deal record."
                />
              )}
            </TabsContent>

            <TabsContent value="estimate" className="mt-5 space-y-5">
              <div className="rounded-lg border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Briefcase className="h-4 w-4 text-muted-foreground" />
                    <p className="text-sm font-semibold">Project</p>
                  </div>
                  {linkedProject && (
                    <StatusBadge tone="muted">{PROJECT_STATUS_LABELS[linkedProject.status] ?? linkedProject.status}</StatusBadge>
                  )}
                </div>

                {loadingProject ? (
                  <p className="mt-2 text-sm text-muted-foreground">Loading project...</p>
                ) : linkedProject ? (
                  <>
                    <p className="mt-2 truncate text-sm font-medium">{linkedProject.name}</p>
                    <div className="mt-3">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setProjectSheetOpen(true)}
                      >
                        <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                        Open Project
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="mt-2 text-sm text-muted-foreground">
                      No project has been created for this deal yet.
                    </p>
                    {deal && (
                      <div className="mt-3">
                        <Button size="sm" onClick={() => void handleCreateProject()} disabled={creatingProject}>
                          <Plus className="mr-1.5 h-3.5 w-3.5" />
                          {creatingProject ? "Creating..." : "Create Project"}
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </div>

              {loadingEstimates ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  Loading estimates...
                </p>
              ) : estimatesError ? (
                <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                  {estimatesError}
                </div>
              ) : estimates.length ? (
                <div className="space-y-3">
                  {estimates.map((estimate) => (
                    <div key={estimate.id} className="rounded-lg border bg-card p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold">
                            {estimate.number ?? estimate.title}
                          </p>
                          {estimate.number && (
                            <p className="truncate text-xs text-muted-foreground">{estimate.title}</p>
                          )}
                        </div>
                        <StatusBadge tone={ESTIMATE_STATUS_TONE[estimate.status] ?? "muted"}>
                          {estimate.status}
                        </StatusBadge>
                      </div>

                      <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                        <div>
                          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Total</p>
                          <p className="font-medium">
                            {formatMoney(estimate.client_total ?? estimate.total)}
                          </p>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Created</p>
                          <p className="font-medium">{formatDateShort(estimate.created_at)}</p>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Expires</p>
                          <p className="font-medium">
                            {estimate.valid_until ? formatDateShort(estimate.valid_until) : "—"}
                          </p>
                        </div>
                        {estimate.client_name && (
                          <div className="col-span-2 sm:col-span-3">
                            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Contact</p>
                            <p className="font-medium">{estimate.client_name}</p>
                          </div>
                        )}
                      </div>

                      <div className="mt-3">
                        <Button variant="outline" size="sm" onClick={() => void openEstimateDrawer(estimate.id)} disabled={estimateDrawerLoading}>
                          <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                          Open Estimate
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyTab
                  icon={FileText}
                  title="No estimate linked"
                  description="Estimates created for this deal's contact will appear here once linked."
                />
              )}
            </TabsContent>

            <TabsContent value="tasks" className="mt-5">
              <EntityTasksPanel entityType="deal" entityId={deal.id} entityLabel="deal" />
            </TabsContent>

            <TabsContent value="appointments" className="mt-5">
              <EntityAppointmentsPanel
                entityType="deal"
                entityId={deal.id}
                entityLabel="deal"
                contactName={deal.contactName || undefined}
                contactPhone={deal.phone || undefined}
                contactEmail={deal.email || undefined}
                address={deal.projectAddress || deal.address || undefined}
              />
            </TabsContent>

            <TabsContent value="notes" className="mt-5">
              <div className="rounded-lg border bg-card p-4">
                <div className="flex gap-2">
                  <StickyNote className="mt-0.5 h-4 w-4 text-muted-foreground" />
                  <p className="whitespace-pre-wrap text-sm">
                    {deal.notes || "No notes added."}
                  </p>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="files" className="mt-5">
              <EmptyTab
                icon={FileText}
                title="Deal-linked files aren't available yet"
                description="Files can't be linked to a specific deal yet — this tab isn't checking for any. File support for deals is planned for a future release."
              />
            </TabsContent>
          </Tabs>
        </SheetContent>
      </Sheet>

      {/* Contextual-drawer principle (Bug 2) — layered directly over this
          Deal drawer (Sheet-over-Sheet: Radix stacks the newest Portal on
          top, dismisses independently). Closing it returns to this same
          Deal drawer/tab; deal state is untouched since it lives entirely
          in this component, not inside ProjectDetailSheet. */}
      <ProjectDetailSheet
        project={linkedProject}
        open={projectSheetOpen}
        onClose={() => setProjectSheetOpen(false)}
        onReload={() => { if (deal) void loadLinkedProject(deal.id, deal.orgId); }}
        onProjectUpdated={setLinkedProject}
      />

      {/* Contextual-drawer principle — "Open Estimate" opens the same
          EstimateFormSheet layered over this Deal drawer instead of
          navigating to /estimates. */}
      <EstimateFormSheet
        open={estimateDrawerOpen}
        onClose={() => { setEstimateDrawerOpen(false); setEstimateDrawerEstimate(null); }}
        orgId={deal?.orgId ?? ""}
        estimate={estimateDrawerEstimate ?? undefined}
        onSaved={() => { if (deal) void loadEstimates(deal.id, deal.orgId); }}
      />

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto [&>button.absolute]:hidden">
          <DialogHeader className="items-start text-left">
            <DialogTitle
              className="inline-flex rounded-full border border-[#E3CA9A]
                bg-[#FAF3E4] px-4 py-1.5 text-sm font-semibold text-foreground"
            >
              Edit Deal
            </DialogTitle>
            <DialogDescription>
              Update deal details, stage, owner, and project information.
            </DialogDescription>
          </DialogHeader>

          {editForm && (
            <div className="grid gap-4 py-1 sm:grid-cols-2">
              <Field label="Deal name" className="sm:col-span-2">
                <Input
                  className="bg-white"
                  value={editForm.name}
                  onChange={(event) =>
                    updateEditField("name", event.target.value)
                  }
                />
              </Field>

              <Field label="Value ($)">
                <Input
                  type="number"
                  min="0"
                  value={editForm.value}
                  onChange={(event) =>
                    updateEditField("value", event.target.value)
                  }
                />
              </Field>

              <Field label="Probability (%)">
                <Input
                  type="number"
                  min="0"
                  max="100"
                  value={editForm.probability}
                  onChange={(event) =>
                    updateEditField("probability", event.target.value)
                  }
                />
              </Field>

              <Field label="Stage">
                <Select
                  value={editForm.stage}
                  onValueChange={(value) => {
                    const stage = stageOptions.find((item) => {
                      return item.id === value;
                    });

                    updateEditField("stage", value);

                    if (stage?.probability !== undefined) {
                      updateEditField(
                        "probability",
                        String(stage.probability),
                      );
                    }
                  }}
                >
                  <SelectTrigger className="bg-white">
                    <SelectValue placeholder="Select stage" />
                  </SelectTrigger>
                  <SelectContent className="[&_[data-highlighted]]:bg-[#FAF3E4] [&_[data-state=checked]]:bg-[#FAF3E4]">
                    {stageOptions.map((stage) => (
                      <SelectItem
                        key={stage.id}
                        value={stage.id}
                      >
                        {stage.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Owner">
                <Select
                  value={editForm.ownerId}
                  onValueChange={(value) =>
                    updateEditField("ownerId", value)
                  }
                >
                  <SelectTrigger className="bg-white">
                    <SelectValue placeholder="Select owner" />
                  </SelectTrigger>
                  <SelectContent className="[&_[data-highlighted]]:bg-[#FAF3E4] [&_[data-state=checked]]:bg-[#FAF3E4]">
                    {teamMembers.map((member) => (
                      <SelectItem key={member.id} value={member.id}>
                        {member.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Contact" className="sm:col-span-2">
                <Select
                  value={editForm.contactId || "no-contact"}
                  onValueChange={(value) => {
                    if (value === "no-contact") {
                      updateEditField("contactId", "");
                      updateEditField("contactName", "");
                      updateEditField("contactEmail", "");
                      updateEditField("contactPhone", "");
                      return;
                    }

                    const contact = contactOptions.find(
                      (option) => option.id === value,
                    );

                    updateEditField("contactId", value);
                    updateEditField("contactName", contact?.name ?? "");
                    updateEditField("contactEmail", contact?.email ?? "");
                    updateEditField("contactPhone", contact?.phone ?? "");
                  }}
                >
                  <SelectTrigger className="bg-white">
                    <SelectValue
                      placeholder={
                        loadingContactOptions
                          ? "Loading contacts..."
                          : "Select contact"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent className="[&_[data-highlighted]]:bg-[#FAF3E4] [&_[data-state=checked]]:bg-[#FAF3E4]">
                    <SelectItem value="no-contact">
                      No contact
                    </SelectItem>
                    {contactOptions.map((contact) => (
                      <SelectItem key={contact.id} value={contact.id}>
                        {contact.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Contact name">
                <Input
                  className="bg-white"
                  value={editForm.contactName}
                  onChange={(event) =>
                    updateEditField("contactName", event.target.value)
                  }
                  placeholder="Contact name"
                  disabled={!editForm.contactId}
                />
              </Field>

              <Field label="Contact email">
                <Input
                  className="bg-white"
                  type="email"
                  value={editForm.contactEmail}
                  onChange={(event) =>
                    updateEditField("contactEmail", event.target.value)
                  }
                  placeholder="contact@example.com"
                  disabled={!editForm.contactId}
                />
              </Field>

              <Field label="Contact phone">
                <Input
                  className="bg-white"
                  value={editForm.contactPhone}
                  onChange={(event) =>
                    updateEditField("contactPhone", event.target.value)
                  }
                  placeholder="(555) 123-4567"
                  disabled={!editForm.contactId}
                />
              </Field>

              <Field label="Account">
                <Select
                  value={editForm.companyId || "no-account"}
                  onValueChange={(value) =>
                    updateEditField(
                      "companyId",
                      value === "no-account" ? "" : value,
                    )
                  }
                >
                  <SelectTrigger className="bg-white">
                    <SelectValue
                      placeholder={
                        loadingAccounts
                          ? "Loading accounts..."
                          : "Select account"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent className="[&_[data-highlighted]]:bg-[#FAF3E4] [&_[data-state=checked]]:bg-[#FAF3E4]">
                    <SelectItem value="no-account">
                      No account
                    </SelectItem>
                    {accounts.map((account) => (
                      <SelectItem key={account.id} value={account.id}>
                        {account.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Expected close">
                <Input
                  type="date"
                  value={editForm.expectedClose}
                  onChange={(event) =>
                    updateEditField("expectedClose", event.target.value)
                  }
                />
              </Field>

              <Field label="Source">
                <OptionSelect
                  value={editForm.source}
                  options={SOURCE_OPTIONS}
                  placeholder="Select source"
                  onChange={(value) => updateEditField("source", value)}
                />
              </Field>

              <Field label="Service type">
                <OptionSelect
                  value={editForm.serviceType}
                  options={SERVICE_OPTIONS}
                  placeholder="Select service"
                  onChange={(value) =>
                    updateEditField("serviceType", value)
                  }
                />
              </Field>

              <Field label="Budget">
                <OptionSelect
                  value={editForm.budget}
                  options={BUDGET_OPTIONS}
                  placeholder="Select budget"
                  onChange={(value) => updateEditField("budget", value)}
                />
              </Field>

              <Field label="Timeline">
                <OptionSelect
                  value={editForm.timeline}
                  options={TIMELINE_OPTIONS}
                  placeholder="Select timeline"
                  onChange={(value) => updateEditField("timeline", value)}
                />
              </Field>

              <Field label="Project address" className="sm:col-span-2">
                <AddressAutocomplete
                  className="bg-white"
                  value={editForm.projectAddress}
                  onChange={(value) =>
                    updateEditField("projectAddress", value)
                  }
                  onSelect={(parts) =>
                    updateEditField(
                      "projectAddress",
                      [
                        parts.street,
                        parts.city,
                        [parts.state, parts.zip].filter(Boolean).join(" "),
                      ]
                        .filter(Boolean)
                        .join(", "),
                    )
                  }
                  placeholder="123 Main Street, Miami, Florida"
                />
              </Field>

              <Field label="Next activity">
                <OptionSelect
                  value={editForm.nextActivityTitle}
                  options={NEXT_ACTIVITY_OPTIONS}
                  placeholder="Select next activity"
                  onChange={(value) =>
                    updateEditField("nextActivityTitle", value)
                  }
                />
              </Field>

              <Field label="Assign activity to">
                <Select
                  value={editForm.nextActivityAssigneeId || "unassigned"}
                  onValueChange={(value) =>
                    updateEditField(
                      "nextActivityAssigneeId",
                      value === "unassigned" ? "" : value,
                    )
                  }
                >
                  <SelectTrigger className="bg-white">
                    <SelectValue placeholder="Select team member" />
                  </SelectTrigger>
                  <SelectContent className="[&_[data-highlighted]]:bg-[#FAF3E4] [&_[data-state=checked]]:bg-[#FAF3E4]">
                    <SelectItem value="unassigned">
                      Unassigned
                    </SelectItem>
                    {teamMembers.map((member) => (
                      <SelectItem key={member.id} value={member.id}>
                        {member.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Next activity Due" className="sm:col-span-2">
                <Input
                  className="bg-white"
                  type="datetime-local"
                  value={editForm.nextActivityAt}
                  onChange={(event) =>
                    updateEditField("nextActivityAt", event.target.value)
                  }
                />
              </Field>

              {editForm.nextActivityTitle && (
                <div className="sm:col-span-2 rounded-xl border border-[#E3CA9A]
                  bg-[#FAF3E4]/45 p-4">
                  <div className="mb-3 flex items-start gap-2">
                    <Bell className="mt-0.5 h-4 w-4 text-amber-700" />
                    <div>
                      <p className="text-sm font-semibold text-foreground">
                        Set reminders
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Reminders go to the activity assignee, or the Deal owner
                        when no assignee is selected.
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Select
                      value={reminderToAdd}
                      onValueChange={setReminderToAdd}
                    >
                      <SelectTrigger className="bg-white sm:flex-1">
                        <SelectValue placeholder="Choose reminder" />
                      </SelectTrigger>
                      <SelectContent className="[&_[data-highlighted]]:bg-[#FAF3E4]">
                        {REMINDER_OPTIONS.map((option) => (
                          <SelectItem
                            key={option.value}
                            value={String(option.value)}
                          >
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    <Button
                      type="button"
                      variant="outline"
                      className="bg-white"
                      onClick={addReminder}
                      disabled={editForm.reminderOffsets.includes(
                        Number(reminderToAdd),
                      )}
                    >
                      Add reminder
                    </Button>
                  </div>

                  {editForm.reminderOffsets.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {editForm.reminderOffsets.map((minutes) => (
                        <span
                          key={minutes}
                          className="inline-flex items-center gap-1.5
                            rounded-full border border-[#E3CA9A] bg-white
                            px-2.5 py-1 text-xs font-medium"
                        >
                          {reminderLabel(minutes)}
                          <button
                            type="button"
                            className="rounded-full p-0.5 text-muted-foreground
                              hover:bg-[#FAF3E4] hover:text-foreground"
                            onClick={() => removeReminder(minutes)}
                            aria-label={`Remove ${reminderLabel(minutes)}`}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-3 text-xs text-muted-foreground">
                      No reminders selected.
                    </p>
                  )}
                </div>
              )}

              <Field label="Notes" className="sm:col-span-2">
                <Textarea
                  rows={4}
                  value={editForm.notes}
                  onChange={(event) =>
                    updateEditField("notes", event.target.value)
                  }
                />
              </Field>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditOpen(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              className="bg-blue-600 text-white hover:bg-blue-700"
              onClick={saveEdit}
              disabled={saving || !editForm?.name.trim()}
            >
              {saving ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={lostOpen} onOpenChange={setLostOpen}>
        <DialogContent className="[&>button.absolute]:hidden">
          <DialogHeader>
            <DialogTitle>Mark Deal as Lost</DialogTitle>
            <DialogDescription>
              Choose the main reason this opportunity was lost.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <Field label="Lost reason">
              <Select
                value={lostReason}
                onValueChange={(value) =>
                  setLostReason(value as LostReason)
                }
              >
                <SelectTrigger className="bg-white">
                  <SelectValue placeholder="Select a reason" />
                </SelectTrigger>
                <SelectContent className="[&_[data-highlighted]]:bg-[#FAF3E4] [&_[data-state=checked]]:bg-[#FAF3E4]">
                  {LOST_REASONS.map((reason) => (
                    <SelectItem key={reason} value={reason}>
                      {reason}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Notes">
              <Textarea
                rows={4}
                value={lostNotes}
                onChange={(event) => setLostNotes(event.target.value)}
                placeholder="Optional context..."
              />
            </Field>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setLostOpen(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmLost}
              disabled={!lostReason || saving}
            >
              {saving ? "Saving..." : "Mark Lost"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={addActivityOpen}
        onOpenChange={setAddActivityOpen}
      >
        <DialogContent
          className="max-w-lg [&>button]:hidden"
        >
          <DialogHeader className="items-start text-left">
            <DialogTitle
              className="inline-flex rounded-full border border-[#E3CA9A]
                bg-[#FAF3E4] px-4 py-1.5 text-sm font-semibold"
            >
              Add Activity
            </DialogTitle>
            <DialogDescription>
              Log a customer interaction or internal update.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <Field label="Activity type">
              <Select
                value={manualActivity.type}
                onValueChange={(value) =>
                  setManualActivity((current) => ({
                    ...current,
                    type: value,
                  }))
                }
              >
                <SelectTrigger className="bg-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="[&_[data-highlighted]]:bg-[#FAF3E4]">
                  {MANUAL_ACTIVITY_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Title">
              <Input
                className="bg-white"
                value={manualActivity.title}
                onChange={(event) =>
                  setManualActivity((current) => ({
                    ...current,
                    title: event.target.value,
                  }))
                }
                placeholder="e.g. Spoke with customer"
              />
            </Field>

            <Field label="Date and time">
              <Input
                className="bg-white"
                type="datetime-local"
                value={manualActivity.occurredAt}
                onChange={(event) =>
                  setManualActivity((current) => ({
                    ...current,
                    occurredAt: event.target.value,
                  }))
                }
              />
            </Field>

            <Field label="Details">
              <Textarea
                className="min-h-28 bg-white"
                value={manualActivity.description}
                onChange={(event) =>
                  setManualActivity((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
                placeholder="Add useful context about the activity."
              />
            </Field>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setAddActivityOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="bg-blue-600 text-white hover:bg-blue-700"
              disabled={
                !manualActivity.title.trim() || addingActivity
              }
              onClick={addManualActivity}
            >
              {addingActivity ? "Adding..." : "Add Activity"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="[&>button.absolute]:hidden">
          <DialogHeader>
            <DialogTitle>Delete Deal</DialogTitle>
            <DialogDescription>
              This permanently removes the deal and its linked deal activity.
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={saving}
            >
              {saving ? "Deleting..." : "Delete Deal"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}

function PersonAvatar({
  id,
  name,
  avatarKey,
  avatarUrl,
  size = "sm",
}: {
  id?: string | null;
  name: string;
  avatarKey?: string | null;
  avatarUrl?: string | null;
  size?: "sm" | "md";
}) {
  if (!avatarUrl) {
    return (
      <ContactAvatar
        id={id}
        name={name}
        avatarKey={avatarKey}
        size={size}
      />
    );
  }

  const sizeClass = size === "md" ? "h-10 w-10" : "h-8 w-8";
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  return (
    <Avatar className={`${sizeClass} shrink-0 ring-1 ring-black/5`}>
      <AvatarImage src={avatarUrl} alt={name} />
      <AvatarFallback className="bg-[#FAF3E4] text-xs font-semibold">
        {initials || "?"}
      </AvatarFallback>
    </Avatar>
  );
}

function PersonInfoCard({
  id,
  name,
  avatarKey,
  avatarUrl,
  label,
  detail,
}: {
  id?: string | null;
  name: string;
  avatarKey?: string | null;
  avatarUrl?: string | null;
  label: string;
  detail?: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-center gap-3">
        <PersonAvatar
          id={id}
          name={name}
          avatarKey={avatarKey}
          avatarUrl={avatarUrl}
          size="md"
        />
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="truncate text-sm font-medium">{name}</p>
          {detail && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {detail}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function InfoCard({
  icon: Icon,
  iconClassName,
  label,
  value,
  detail,
}: {
  icon: typeof User;
  iconClassName: string;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span
          className={`flex h-7 w-7 items-center justify-center rounded-md ${iconClassName}`}
        >
          <Icon className="h-4 w-4" />
        </span>
        {label}
      </div>
      <p className="truncate text-sm font-medium">{value}</p>
      {detail && (
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {detail}
        </p>
      )}
    </div>
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

function OptionSelect({
  value,
  options,
  placeholder,
  onChange,
}: {
  value: string;
  options: string[];
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="bg-white">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="[&_[data-highlighted]]:bg-[#FAF3E4] [&_[data-state=checked]]:bg-[#FAF3E4]">
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
