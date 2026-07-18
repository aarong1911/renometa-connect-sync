import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Mail, MessageSquare, FileSpreadsheet, ListChecks, FileText, Plus, Search, Star,
  Copy, Trash2, Send, Eye, BarChart3, Clock, TrendingUp, ClipboardList, Code2, Phone, AlertTriangle, Calendar, Image as ImageIcon, Pencil, RefreshCw,
} from "lucide-react";
import { formatMoney } from "@/lib/format";
import { toast } from "sonner";
import { useOrganization } from "@/lib/organization";
import { addLead } from "@/lib/leads-store";
import type { Lead } from "@/lib/mock-data";

export const Route = createFileRoute("/settings/templates")({
  head: () => ({
    meta: [
      { title: "Templates — Settings" },
      { name: "description", content: "Reusable message, estimate, project plan, and document templates." },
    ],
  }),
  component: TemplatesPage,
});

// ============ Types & seed data ============
type TemplateKind = "message" | "estimate" | "plan" | "document" | "form";
type MessageChannel = "email" | "sms";

type BaseTemplate = {
  id: string;
  kind: TemplateKind;
  name: string;
  category: string;
  description: string;
  tags: string[];
  owner: string;
  updatedAt: string;
  uses: number;
  starred: boolean;
};

type MessageTemplate = BaseTemplate & {
  kind: "message";
  channel: MessageChannel;
  subject?: string;
  body: string;
  openRate?: number;
  replyRate?: number;
};

type EstimateLine = { name: string; qty: number; unit: string; price: number };
type EstimateTemplate = BaseTemplate & {
  kind: "estimate";
  projectType: string;
  lines: EstimateLine[];
  markup: number; // percent
  notes: string;
};

type PlanTask = { name: string; phase: string; days: number; trade?: string };
type PlanTemplate = BaseTemplate & {
  kind: "plan";
  projectType: string;
  durationDays: number;
  tasks: PlanTask[];
};

type DocumentTemplate = BaseTemplate & {
  kind: "document";
  docType: string;
  body: string;
};

// ============ Forms (embeddable lead capture) ============
type FormFieldType =
  | "text"
  | "email"
  | "tel"
  | "address"
  | "textarea"
  | "select"
  | "date"
  | "time-slot"
  | "file";

type FormField = {
  key: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  /** Options for select fields. */
  options?: string[];
  /** Optional help text shown under the field. */
  helpText?: string;
  /** Optional emphasis (e.g. emergency phone). */
  emphasized?: boolean;
};

type FormVariant =
  | "general_contact"
  | "free_estimate"
  | "schedule_consultation"
  | "emergency"
  | "referral"
  | "warranty"
  | "maintenance_plan"
  | "insurance_claim";

type FormTemplate = BaseTemplate & {
  kind: "form";
  variant: FormVariant;
  /** Recommended placement on the customer's website. */
  placement: string;
  /** Submit button label. */
  submitLabel: string;
  /** Confirmation message shown after submit. */
  successMessage: string;
  fields: FormField[];
};

type AnyTemplate = MessageTemplate | EstimateTemplate | PlanTemplate | DocumentTemplate | FormTemplate;

// ----- Trade-specific seed values -----
/** Map an industry label (from organization settings) to a normalized trade key. */
function tradeKey(industry: string | undefined): string {
  const i = (industry ?? "").toLowerCase();
  if (i.includes("hvac")) return "hvac";
  if (i.includes("plumb")) return "plumbing";
  if (i.includes("electric")) return "electrical";
  if (i.includes("roof")) return "roofing";
  if (i.includes("paint")) return "painting";
  if (i.includes("landscap")) return "landscaping";
  if (i.includes("floor")) return "flooring";
  if (i.includes("window") || i.includes("door")) return "windows";
  if (i.includes("handyman")) return "handyman";
  return "general"; // General Contractor / Remodeler default
}

const PROJECT_TYPES_BY_TRADE: Record<string, string[]> = {
  general: [
    "Kitchen Remodel",
    "Bathroom Remodel",
    "Basement Finishing",
    "Room Addition",
    "Whole-Home Renovation",
    "Deck/Patio",
    "Roofing",
    "Siding",
    "Windows & Doors",
    "Painting",
    "Flooring",
    "HVAC",
    "Plumbing",
    "Electrical",
    "Landscaping",
    "Handyman/Repairs",
    "Custom",
  ],
  hvac: ["AC install / replace", "Furnace install / replace", "Heat pump", "Ductwork", "Maintenance / tune-up", "Other"],
  plumbing: ["Water heater", "Repipe", "Drain / sewer", "Fixture install", "Bathroom remodel", "Other"],
  electrical: ["Panel upgrade", "EV charger", "Lighting", "Rewire", "Generator", "Other"],
  roofing: ["Full replacement", "Repair", "Inspection", "Gutters", "Skylight", "Other"],
  painting: ["Interior painting", "Exterior painting", "Cabinet refinish", "Deck / fence stain", "Commercial", "Other"],
  landscaping: ["Design + install", "Lawn care", "Hardscape (patio / walkway)", "Irrigation", "Tree service", "Other"],
  flooring: ["Hardwood", "LVP / vinyl", "Tile", "Carpet", "Refinish", "Other"],
  windows: ["Window replacement", "Patio door", "Entry door", "Storm windows", "Other"],
  handyman: ["Small repair", "Honey-do list", "Mounting / install", "Drywall patch", "Other"],
};

const URGENCY_OPTIONS = ["Right now", "Within 24 hours", "Within 48 hours"];
const TIMELINE_OPTIONS = ["ASAP", "Within 1 month", "1–3 months", "3–6 months", "Just researching"];
const TIME_SLOTS = ["Morning (8am–12pm)", "Midday (12pm–2pm)", "Afternoon (2pm–5pm)", "Evening (5pm–8pm)"];

function buildSeedForms(industry: string | undefined): FormTemplate[] {
  const trade = tradeKey(industry);
  const projectTypes = PROJECT_TYPES_BY_TRADE[trade] ?? PROJECT_TYPES_BY_TRADE.general;
  const today = new Date().toISOString().slice(0, 10);
  const base = (overrides: Partial<FormTemplate>): FormTemplate => ({
    id: "",
    kind: "form",
    name: "",
    category: "Lead capture",
    description: "",
    tags: ["embed", "lead-capture"],
    owner: "Maria Chen",
    updatedAt: today,
    uses: 0,
    starred: false,
    variant: "general_contact",
    placement: "Contact page",
    submitLabel: "Submit",
    successMessage: "Thanks — we'll be in touch shortly.",
    fields: [],
    ...overrides,
  });

  const forms: FormTemplate[] = [
    base({
      id: "f1",
      variant: "general_contact",
      name: "General Contact Form",
      category: "Contact",
      description: "Simple get-in-touch form for the Contact page.",
      placement: "Contact page",
      submitLabel: "Send message",
      successMessage: "Thanks for reaching out — we'll reply within 1 business day.",
      starred: true,
      uses: 412,
      fields: [
        { key: "first_name", label: "First name", type: "text", required: true },
        { key: "last_name", label: "Last name", type: "text", required: true },
        { key: "email", label: "Email", type: "email", required: true },
        { key: "phone", label: "Phone", type: "tel", required: false },
        { key: "message", label: "Message", type: "textarea", required: true },
      ],
    }),
    base({
      id: "f2",
      variant: "free_estimate",
      name: "Free Estimate Request",
      category: "Estimate",
      description: "High-intent lead capture for Services / Home page.",
      placement: "Services or Home page",
      submitLabel: "Get my free estimate",
      successMessage: "Got it — we'll review your project and reach out within 24 hours.",
      starred: true,
      uses: 631,
      fields: [
        { key: "first_name", label: "First name", type: "text", required: true },
        { key: "last_name", label: "Last name", type: "text", required: true },
        { key: "email", label: "Email", type: "email", required: true },
        { key: "phone", label: "Phone", type: "tel", required: true },
        { key: "address", label: "Project address", type: "address", required: true },
        { key: "project_type", label: "Project type", type: "select", required: true, options: projectTypes },
        { key: "description", label: "Tell us about your project", type: "textarea", required: true },
        { key: "timeline", label: "Preferred timeline", type: "select", required: false, options: TIMELINE_OPTIONS },
        { key: "photos", label: "Photos (optional)", type: "file", required: false, helpText: "Upload up to 5 photos to help us scope your project." },
      ],
    }),
    base({
      id: "f3",
      variant: "schedule_consultation",
      name: "Schedule Consultation",
      category: "Booking",
      description: "Book a discovery call or on-site visit.",
      placement: "Booking page",
      submitLabel: "Request appointment",
      successMessage: "We received your request — you'll get a confirmation shortly.",
      uses: 188,
      fields: [
        { key: "first_name", label: "First name", type: "text", required: true },
        { key: "last_name", label: "Last name", type: "text", required: true },
        { key: "email", label: "Email", type: "email", required: true },
        { key: "phone", label: "Phone", type: "tel", required: true },
        { key: "project_type", label: "Project type", type: "select", required: true, options: projectTypes },
        { key: "preferred_date", label: "Preferred date", type: "date", required: true },
        { key: "preferred_time", label: "Preferred time", type: "time-slot", required: true, options: TIME_SLOTS },
        { key: "notes", label: "Anything we should know?", type: "textarea", required: false },
      ],
    }),
  ];

  forms.push(
    base({
      id: "f4",
      variant: "emergency",
      name: "Emergency / Urgent Request",
      category: "Emergency",
      description: "Urgent service request for immediate needs.",
      placement: "Emergency Service page (sticky CTA)",
      submitLabel: "Get help now",
      successMessage: "Help is on the way — we'll call you back within 15 minutes.",
      tags: ["embed", "lead-capture", "emergency"],
      starred: true,
      uses: 74,
      fields: [
        { key: "first_name", label: "First name", type: "text", required: true },
        { key: "phone", label: "Phone (we'll call you back)", type: "tel", required: true, emphasized: true, helpText: "Best number to reach you right now." },
        { key: "address", label: "Service address", type: "address", required: true },
        { key: "issue_type", label: "Issue type", type: "select", required: true, options: ["Water Damage", "Electrical Hazard", "No Heat/AC", "Roof Leak", "Gas Smell", "Structural", "Other"] },
        { key: "description", label: "Describe the issue", type: "textarea", required: false },
        { key: "urgency", label: "How soon do you need help?", type: "select", required: true, options: URGENCY_OPTIONS },
      ],
    }),
    base({
      id: "f5",
      variant: "referral",
      name: "Referral Form",
      category: "Contact",
      description: "Let happy clients refer friends and family.",
      placement: "Referrals page or post-project email",
      submitLabel: "Send referral",
      successMessage: "Thanks for the referral — we'll reach out shortly.",
      uses: 96,
      fields: [
        { key: "referrer_name", label: "Your name", type: "text", required: false },
        { key: "referrer_email", label: "Your email", type: "email", required: false },
        { key: "referrer_phone", label: "Your phone", type: "tel", required: false },
        { key: "referred_name", label: "Friend's name", type: "text", required: true },
        { key: "referred_phone", label: "Friend's phone", type: "tel", required: true },
        { key: "referred_email", label: "Friend's email", type: "email", required: false },
        { key: "project_type", label: "Project type", type: "select", required: false, options: projectTypes },
        { key: "notes", label: "Additional notes", type: "textarea", required: false },
      ],
    }),
    base({
      id: "f6",
      variant: "warranty",
      name: "Warranty Claim",
      category: "Contact",
      description: "Post-project warranty request from existing clients.",
      placement: "Client portal or Warranty page",
      submitLabel: "Submit warranty claim",
      successMessage: "We received your claim — our team will review and follow up within 2 business days.",
      uses: 42,
      fields: [
        { key: "first_name", label: "First name", type: "text", required: true },
        { key: "last_name", label: "Last name", type: "text", required: true },
        { key: "email", label: "Email", type: "email", required: false },
        { key: "phone", label: "Phone", type: "tel", required: true },
        { key: "address", label: "Project address", type: "address", required: false },
        { key: "project_date", label: "Original project date", type: "date", required: false },
        { key: "description", label: "Issue description", type: "textarea", required: true, helpText: "Describe the warranty issue..." },
        { key: "photos", label: "Photos", type: "file", required: false, helpText: "Upload photos of the issue (multiple allowed)." },
      ],
    }),
    base({
      id: "f7",
      variant: "maintenance_plan",
      name: "Maintenance Plan Signup",
      category: "Booking",
      description: "Recurring service plan enrollment for HVAC, plumbing, landscaping.",
      placement: "Maintenance Plans page",
      submitLabel: "Enroll me",
      successMessage: "You're on the list — we'll confirm your plan details shortly.",
      uses: 63,
      fields: [
        { key: "first_name", label: "First name", type: "text", required: true },
        { key: "last_name", label: "Last name", type: "text", required: true },
        { key: "email", label: "Email", type: "email", required: true },
        { key: "phone", label: "Phone", type: "tel", required: true },
        { key: "address", label: "Service address", type: "address", required: true },
        { key: "service_type", label: "Service type", type: "select", required: false, options: ["HVAC Maintenance", "Plumbing Inspection", "Landscape Maintenance", "Gutter Cleaning", "General Home Maintenance", "Other"] },
        { key: "frequency", label: "Preferred frequency", type: "select", required: false, options: ["Monthly", "Quarterly", "Bi-Annually", "Annually"] },
        { key: "contact_method", label: "Preferred contact method", type: "select", required: false, options: ["Phone", "Email", "Text"] },
      ],
    }),
    base({
      id: "f8",
      variant: "insurance_claim",
      name: "Insurance Claim Intake",
      category: "Estimate",
      description: "Storm damage or insurance-related project intake.",
      placement: "Storm Damage / Insurance page",
      submitLabel: "Submit claim intake",
      successMessage: "Thanks — our claims specialist will contact you within 24 hours.",
      uses: 31,
      fields: [
        { key: "first_name", label: "First name", type: "text", required: true },
        { key: "last_name", label: "Last name", type: "text", required: true },
        { key: "phone", label: "Phone", type: "tel", required: true },
        { key: "email", label: "Email", type: "email", required: false },
        { key: "address", label: "Property address", type: "address", required: true },
        { key: "damage_date", label: "Date of damage", type: "date", required: false },
        { key: "insurance_company", label: "Insurance company", type: "text", required: false },
        { key: "claim_number", label: "Claim number", type: "text", required: false, helpText: "If already filed." },
        { key: "damage_type", label: "Damage type", type: "select", required: false, options: ["Wind/Storm", "Hail", "Water/Flood", "Fire", "Tree/Debris", "Other"] },
        { key: "description", label: "Damage description", type: "textarea", required: false },
        { key: "photos", label: "Photos of damage", type: "file", required: false, helpText: "Upload photos (multiple allowed)." },
      ],
    }),
  );

  return forms;
}

const MERGE_TAGS = [
  "{{first_name}}", "{{last_name}}", "{{project_address}}", "{{project_type}}",
  "{{owner_name}}", "{{company_name}}", "{{deposit_amount}}", "{{start_date}}",
  "{{estimate_total}}", "{{deposit_due}}",
];

const SEED: AnyTemplate[] = [
  // Messages — Email
  {
    id: "m1", kind: "message", channel: "email", name: "New lead — welcome",
    category: "Welcome", description: "First touch within 5 minutes of an inbound lead.",
    tags: ["welcome", "speed-to-lead"], owner: "Maria Chen", updatedAt: "2026-04-12", uses: 482, starred: true,
    subject: "Thanks for reaching out, {{first_name}}!",
    body: "Hi {{first_name}},\n\nThanks for considering {{company_name}} for your {{project_type}} project at {{project_address}}. I'd love to schedule a 15-min discovery call to learn more about your goals.\n\nWhat times work best this week?\n\n— {{owner_name}}",
    openRate: 64, replyRate: 31,
  },
  {
    id: "m2", kind: "message", channel: "email", name: "Estimate follow-up (3 day)",
    category: "Follow-up", description: "Sent 3 days after estimate delivery if no response.",
    tags: ["follow-up", "estimate"], owner: "James Park", updatedAt: "2026-04-08", uses: 318, starred: true,
    subject: "Quick check on your {{project_type}} estimate",
    body: "Hi {{first_name}},\n\nJust circling back on the {{project_type}} estimate I sent ({{estimate_total}}). Happy to walk you through any line item or adjust scope.\n\nWould a quick call Thursday or Friday work?\n\n— {{owner_name}}",
    openRate: 58, replyRate: 22,
  },
  {
    id: "m3", kind: "message", channel: "email", name: "Deposit reminder",
    category: "Billing", description: "Friendly nudge for outstanding deposits.",
    tags: ["billing", "reminder"], owner: "Priya Shah", updatedAt: "2026-04-01", uses: 164, starred: false,
    subject: "Reserve your start date — deposit due {{deposit_due}}",
    body: "Hi {{first_name}},\n\nWe're holding {{start_date}} for your {{project_type}}. To lock it in, we need the {{deposit_amount}} deposit by {{deposit_due}}.\n\nPay securely here: [payment link]\n\n— {{owner_name}}",
    openRate: 71, replyRate: 44,
  },
  {
    id: "m4", kind: "message", channel: "email", name: "Project complete — review request",
    category: "Reputation", description: "Sent at substantial completion to invite a Google review.",
    tags: ["reviews", "reputation"], owner: "Maria Chen", updatedAt: "2026-03-28", uses: 96, starred: false,
    subject: "It was a pleasure, {{first_name}} 🛠️",
    body: "Hi {{first_name}},\n\nWe loved working on your {{project_type}} at {{project_address}}. If you have 60 seconds, a quick Google review helps us keep doing what we love:\n\n[review link]\n\nThanks again!\n— {{owner_name}}",
    openRate: 68, replyRate: 18,
  },
  // Messages — SMS
  {
    id: "m5", kind: "message", channel: "sms", name: "Speed-to-lead text",
    category: "Welcome", description: "Auto-text within 60 seconds of new lead.",
    tags: ["sms", "speed-to-lead"], owner: "James Park", updatedAt: "2026-04-15", uses: 612, starred: true,
    body: "Hey {{first_name}}, this is {{owner_name}} from {{company_name}}. Got your inquiry for {{project_type}} — got 5 min for a quick chat? Reply YES and I'll call.",
    openRate: 98, replyRate: 47,
  },
  {
    id: "m6", kind: "message", channel: "sms", name: "Site visit reminder",
    category: "Scheduling", description: "Day-before SMS reminder with arrival window.",
    tags: ["sms", "scheduling"], owner: "Priya Shah", updatedAt: "2026-04-10", uses: 287, starred: false,
    body: "Reminder: {{owner_name}} from {{company_name}} will be at {{project_address}} tomorrow between 9–10am. Reply RESCHED to change.",
    openRate: 96, replyRate: 12,
  },

  // Estimate templates
  {
    id: "e1", kind: "estimate", name: "Kitchen — Mid-range remodel",
    category: "Kitchen", description: "Standard 150 sqft kitchen with semi-custom cabinets and quartz.",
    tags: ["kitchen", "mid-range"], owner: "Maria Chen", updatedAt: "2026-04-11", uses: 142, starred: true,
    projectType: "Kitchen", markup: 22,
    lines: [
      { name: "Demo & disposal", qty: 1, unit: "lot", price: 3800 },
      { name: "Semi-custom cabinetry", qty: 22, unit: "lf", price: 480 },
      { name: "Quartz countertops", qty: 48, unit: "sf", price: 95 },
      { name: "Tile backsplash + install", qty: 32, unit: "sf", price: 28 },
      { name: "Plumbing rough + finish", qty: 1, unit: "lot", price: 4200 },
      { name: "Electrical rough + finish", qty: 1, unit: "lot", price: 3600 },
      { name: "Appliance install", qty: 1, unit: "lot", price: 1200 },
      { name: "Painting (kitchen + adj. dining)", qty: 1, unit: "lot", price: 2400 },
      { name: "Project management", qty: 1, unit: "lot", price: 4800 },
    ],
    notes: "Excludes flooring, structural changes, and appliance cost. 50% deposit, 40% midpoint, 10% completion.",
  },
  {
    id: "e2", kind: "estimate", name: "Primary bath — full gut",
    category: "Bath", description: "100 sqft primary bath with tile shower, freestanding tub, double vanity.",
    tags: ["bath", "premium"], owner: "James Park", updatedAt: "2026-04-05", uses: 88, starred: false,
    projectType: "Bath", markup: 25,
    lines: [
      { name: "Demo & disposal", qty: 1, unit: "lot", price: 2800 },
      { name: "Plumbing reroute + finish", qty: 1, unit: "lot", price: 5400 },
      { name: "Curbless shower assembly + waterproofing", qty: 1, unit: "lot", price: 4200 },
      { name: "Floor + wall tile install", qty: 220, unit: "sf", price: 18 },
      { name: "Double vanity install", qty: 1, unit: "ea", price: 1800 },
      { name: "Freestanding tub install", qty: 1, unit: "ea", price: 1400 },
      { name: "Heated floor mat + thermostat", qty: 1, unit: "lot", price: 1800 },
      { name: "Project management", qty: 1, unit: "lot", price: 3600 },
    ],
    notes: "Tile and fixtures supplied by owner. 14-week lead time on vanity.",
  },
  {
    id: "e3", kind: "estimate", name: "Single-story addition — 400 sqft",
    category: "Addition", description: "400 sqft slab-on-grade addition, framed, dried-in, finished.",
    tags: ["addition"], owner: "Priya Shah", updatedAt: "2026-03-29", uses: 31, starred: false,
    projectType: "Addition", markup: 20,
    lines: [
      { name: "Site prep + foundation", qty: 1, unit: "lot", price: 28000 },
      { name: "Framing + sheathing", qty: 400, unit: "sf", price: 38 },
      { name: "Roofing + flashing", qty: 1, unit: "lot", price: 9200 },
      { name: "Windows + exterior doors", qty: 1, unit: "lot", price: 7400 },
      { name: "MEP rough", qty: 1, unit: "lot", price: 14800 },
      { name: "Insulation + drywall", qty: 400, unit: "sf", price: 14 },
      { name: "Interior finish + paint", qty: 1, unit: "lot", price: 12400 },
      { name: "Permits + inspections", qty: 1, unit: "lot", price: 3800 },
      { name: "Project management", qty: 1, unit: "lot", price: 14000 },
    ],
    notes: "Excludes flooring and HVAC equipment. 12–14 week schedule from permit.",
  },
  {
    id: "e4", kind: "estimate", name: "Deck — 320 sqft composite",
    category: "Outdoor", description: "Pressure-treated frame with composite decking, aluminum railing, and stairs.",
    tags: ["deck", "outdoor"], owner: "James Park", updatedAt: "2026-04-14", uses: 54, starred: false,
    projectType: "Deck", markup: 22,
    lines: [
      { name: "Permits + design", qty: 1, unit: "lot", price: 1200 },
      { name: "Footings + posts", qty: 8, unit: "ea", price: 320 },
      { name: "Pressure-treated framing", qty: 320, unit: "sf", price: 18 },
      { name: "Composite decking + fasteners", qty: 320, unit: "sf", price: 22 },
      { name: "Aluminum railing system", qty: 56, unit: "lf", price: 78 },
      { name: "Stairs (4 risers) + landing", qty: 1, unit: "lot", price: 2400 },
      { name: "Project management", qty: 1, unit: "lot", price: 2800 },
    ],
    notes: "Excludes lighting, gas line, and demo of existing deck. 3–4 week schedule.",
  },
  {
    id: "e5", kind: "estimate", name: "Roof replacement — asphalt shingle",
    category: "Roofing", description: "Tear-off and re-roof up to 24 squares with architectural shingles.",
    tags: ["roofing"], owner: "Priya Shah", updatedAt: "2026-04-12", uses: 76, starred: true,
    projectType: "Roofing", markup: 18,
    lines: [
      { name: "Tear-off + dump fees", qty: 24, unit: "sq", price: 95 },
      { name: "Underlayment + ice & water shield", qty: 24, unit: "sq", price: 65 },
      { name: "Architectural shingles + install", qty: 24, unit: "sq", price: 380 },
      { name: "Drip edge + flashing", qty: 1, unit: "lot", price: 1200 },
      { name: "Ridge vent (continuous)", qty: 42, unit: "lf", price: 14 },
      { name: "Pipe boots + step flashing", qty: 1, unit: "lot", price: 600 },
      { name: "Project management", qty: 1, unit: "lot", price: 1800 },
    ],
    notes: "Includes 30-year manufacturer warranty + 5-year workmanship. Excludes deck repair beyond 2 sheets.",
  },
  {
    id: "e6", kind: "estimate", name: "Basement finish — 800 sqft",
    category: "Basement", description: "Open-plan basement with bedroom, full bath, and rec room.",
    tags: ["basement"], owner: "Maria Chen", updatedAt: "2026-04-02", uses: 41, starred: false,
    projectType: "Basement", markup: 22,
    lines: [
      { name: "Framing + insulation", qty: 800, unit: "sf", price: 16 },
      { name: "Egress window + cut", qty: 1, unit: "ea", price: 4200 },
      { name: "Plumbing rough + finish (bath)", qty: 1, unit: "lot", price: 6800 },
      { name: "Electrical rough + finish", qty: 1, unit: "lot", price: 5200 },
      { name: "HVAC supply + return", qty: 1, unit: "lot", price: 3800 },
      { name: "Drywall + paint", qty: 800, unit: "sf", price: 9 },
      { name: "LVP flooring + base", qty: 800, unit: "sf", price: 7 },
      { name: "Bath tile + fixtures install", qty: 1, unit: "lot", price: 4400 },
      { name: "Project management", qty: 1, unit: "lot", price: 6400 },
    ],
    notes: "Excludes vanity, fixtures, and flooring material upgrades. 8–10 week schedule.",
  },
  {
    id: "e7", kind: "estimate", name: "Whole-home interior repaint",
    category: "Painting", description: "2,400 sqft home — walls, ceilings, trim, and doors.",
    tags: ["painting", "refresh"], owner: "Devon Reyes", updatedAt: "2026-04-18", uses: 112, starred: false,
    projectType: "Painting", markup: 15,
    lines: [
      { name: "Surface prep + patching", qty: 1, unit: "lot", price: 2400 },
      { name: "Walls — 2 coats", qty: 2400, unit: "sf", price: 2.6 },
      { name: "Ceilings — flat white", qty: 2400, unit: "sf", price: 1.4 },
      { name: "Trim + baseboards", qty: 1100, unit: "lf", price: 3.2 },
      { name: "Interior doors (paint both sides)", qty: 14, unit: "ea", price: 110 },
      { name: "Mask, drop, cleanup", qty: 1, unit: "lot", price: 1200 },
      { name: "Project management", qty: 1, unit: "lot", price: 1600 },
    ],
    notes: "Owner selects colors from supplier deck. 5–7 working days, occupied home.",
  },

  // Project plan templates
  {
    id: "p1", kind: "plan", name: "Kitchen remodel — 8 week",
    category: "Kitchen", description: "Standard kitchen with semi-custom cabinets.",
    tags: ["kitchen"], owner: "Maria Chen", updatedAt: "2026-04-09", uses: 67, starred: true,
    projectType: "Kitchen", durationDays: 56,
    tasks: [
      { name: "Pre-construction meeting", phase: "Pre-con", days: 1 },
      { name: "Order cabinets + countertops", phase: "Pre-con", days: 1 },
      { name: "Demo & disposal", phase: "Demo", days: 2, trade: "Labor" },
      { name: "Plumbing rough", phase: "Rough-in", days: 2, trade: "Plumbing" },
      { name: "Electrical rough", phase: "Rough-in", days: 2, trade: "Electrical" },
      { name: "Drywall + paint prep", phase: "Finish prep", days: 4, trade: "Drywall" },
      { name: "Cabinet install", phase: "Install", days: 3, trade: "Carpentry" },
      { name: "Countertop template + install", phase: "Install", days: 7 },
      { name: "Backsplash tile", phase: "Finish", days: 2, trade: "Tile" },
      { name: "Plumbing + electrical finish", phase: "Finish", days: 2 },
      { name: "Appliance install", phase: "Finish", days: 1 },
      { name: "Punch list + walkthrough", phase: "Closeout", days: 2 },
    ],
  },
  {
    id: "p2", kind: "plan", name: "Bathroom remodel — 4 week",
    category: "Bath", description: "Hall bath with tub-to-shower conversion.",
    tags: ["bath"], owner: "James Park", updatedAt: "2026-04-02", uses: 48, starred: false,
    projectType: "Bath", durationDays: 28,
    tasks: [
      { name: "Demo & disposal", phase: "Demo", days: 1, trade: "Labor" },
      { name: "Plumbing reroute", phase: "Rough-in", days: 2, trade: "Plumbing" },
      { name: "Electrical updates", phase: "Rough-in", days: 1, trade: "Electrical" },
      { name: "Shower pan + waterproofing", phase: "Rough-in", days: 2, trade: "Tile" },
      { name: "Drywall + skim", phase: "Finish prep", days: 3, trade: "Drywall" },
      { name: "Tile install", phase: "Finish", days: 5, trade: "Tile" },
      { name: "Vanity + fixtures install", phase: "Finish", days: 2, trade: "Plumbing" },
      { name: "Paint + trim", phase: "Finish", days: 2 },
      { name: "Punch list", phase: "Closeout", days: 1 },
    ],
  },
  {
    id: "p3", kind: "plan", name: "Whole home — 16 week",
    category: "Whole Home", description: "Full interior renovation, staying in scope.",
    tags: ["whole-home", "premium"], owner: "Priya Shah", updatedAt: "2026-03-25", uses: 12, starred: false,
    projectType: "Whole Home", durationDays: 112,
    tasks: [
      { name: "Pre-construction & permitting", phase: "Pre-con", days: 14 },
      { name: "Demo (all rooms)", phase: "Demo", days: 7 },
      { name: "Structural framing changes", phase: "Frame", days: 10, trade: "Carpentry" },
      { name: "MEP rough (all trades)", phase: "Rough-in", days: 14 },
      { name: "Insulation + drywall", phase: "Finish prep", days: 12, trade: "Drywall" },
      { name: "Flooring install", phase: "Finish", days: 8, trade: "Flooring" },
      { name: "Cabinetry + millwork", phase: "Finish", days: 10, trade: "Carpentry" },
      { name: "Tile + stone", phase: "Finish", days: 12, trade: "Tile" },
      { name: "Paint + trim", phase: "Finish", days: 10 },
      { name: "MEP finish + appliances", phase: "Finish", days: 8 },
      { name: "Final inspections + punch", phase: "Closeout", days: 7 },
    ],
  },
  {
    id: "p4", kind: "plan", name: "Single-story addition — 14 week",
    category: "Addition", description: "400 sqft slab-on-grade addition from permit to closeout.",
    tags: ["addition"], owner: "Priya Shah", updatedAt: "2026-04-15", uses: 22, starred: false,
    projectType: "Addition", durationDays: 98,
    tasks: [
      { name: "Permits + survey", phase: "Pre-con", days: 14 },
      { name: "Excavation + footings", phase: "Site", days: 5, trade: "Excavation" },
      { name: "Foundation + slab pour", phase: "Site", days: 6, trade: "Concrete" },
      { name: "Framing + sheathing", phase: "Frame", days: 10, trade: "Carpentry" },
      { name: "Roofing + flashing", phase: "Frame", days: 4, trade: "Roofing" },
      { name: "Windows + exterior doors", phase: "Frame", days: 3, trade: "Carpentry" },
      { name: "MEP rough (all trades)", phase: "Rough-in", days: 10 },
      { name: "Insulation + drywall", phase: "Finish prep", days: 8, trade: "Drywall" },
      { name: "Interior finish + paint", phase: "Finish", days: 14 },
      { name: "MEP finish", phase: "Finish", days: 6 },
      { name: "Siding + exterior trim", phase: "Exterior", days: 8, trade: "Siding" },
      { name: "Final inspections + punch", phase: "Closeout", days: 10 },
    ],
  },
  {
    id: "p5", kind: "plan", name: "Composite deck — 3 week",
    category: "Outdoor", description: "320 sqft composite deck with railing and stairs.",
    tags: ["deck", "outdoor"], owner: "James Park", updatedAt: "2026-04-16", uses: 38, starred: false,
    projectType: "Deck", durationDays: 18,
    tasks: [
      { name: "Permits + design sign-off", phase: "Pre-con", days: 4 },
      { name: "Layout + footing dig", phase: "Site", days: 2, trade: "Labor" },
      { name: "Footings poured + cured", phase: "Site", days: 3, trade: "Concrete" },
      { name: "Posts + framing", phase: "Frame", days: 3, trade: "Carpentry" },
      { name: "Composite deck boards", phase: "Install", days: 2, trade: "Carpentry" },
      { name: "Railing system", phase: "Install", days: 1 },
      { name: "Stairs + landing", phase: "Install", days: 2, trade: "Carpentry" },
      { name: "Final inspection + walkthrough", phase: "Closeout", days: 1 },
    ],
  },
  {
    id: "p6", kind: "plan", name: "Roof replacement — 1 week",
    category: "Roofing", description: "Tear-off and re-roof, 24 squares architectural shingle.",
    tags: ["roofing"], owner: "Priya Shah", updatedAt: "2026-04-17", uses: 61, starred: true,
    projectType: "Roofing", durationDays: 5,
    tasks: [
      { name: "Material delivery + site prep", phase: "Pre-con", days: 1 },
      { name: "Tear-off + dump", phase: "Demo", days: 1, trade: "Roofing" },
      { name: "Deck inspection + repair", phase: "Frame", days: 1, trade: "Carpentry" },
      { name: "Underlayment + flashing", phase: "Install", days: 1, trade: "Roofing" },
      { name: "Shingle install + ridge vent", phase: "Install", days: 1, trade: "Roofing" },
    ],
  },
  {
    id: "p7", kind: "plan", name: "Basement finish — 9 week",
    category: "Basement", description: "800 sqft basement with bedroom, full bath, and rec room.",
    tags: ["basement"], owner: "Maria Chen", updatedAt: "2026-04-10", uses: 19, starred: false,
    projectType: "Basement", durationDays: 60,
    tasks: [
      { name: "Permits + layout", phase: "Pre-con", days: 7 },
      { name: "Egress window cut + install", phase: "Site", days: 3 },
      { name: "Framing + insulation", phase: "Frame", days: 7, trade: "Carpentry" },
      { name: "Plumbing rough (bath)", phase: "Rough-in", days: 3, trade: "Plumbing" },
      { name: "Electrical rough", phase: "Rough-in", days: 3, trade: "Electrical" },
      { name: "HVAC supply + return", phase: "Rough-in", days: 2, trade: "HVAC" },
      { name: "Inspections — rough", phase: "Rough-in", days: 1 },
      { name: "Drywall + paint", phase: "Finish prep", days: 8, trade: "Drywall" },
      { name: "Bath tile + fixtures", phase: "Finish", days: 5, trade: "Tile" },
      { name: "LVP flooring + base", phase: "Finish", days: 4, trade: "Flooring" },
      { name: "Trim + interior doors", phase: "Finish", days: 4, trade: "Carpentry" },
      { name: "MEP finish", phase: "Finish", days: 3 },
      { name: "Final inspections + punch", phase: "Closeout", days: 10 },
    ],
  },
  {
    id: "p8", kind: "plan", name: "Whole-home repaint — 1 week",
    category: "Painting", description: "2,400 sqft interior repaint, occupied home.",
    tags: ["painting", "refresh"], owner: "Devon Reyes", updatedAt: "2026-04-19", uses: 84, starred: false,
    projectType: "Painting", durationDays: 6,
    tasks: [
      { name: "Walkthrough + color confirm", phase: "Pre-con", days: 1 },
      { name: "Surface prep + patching", phase: "Prep", days: 1, trade: "Painting" },
      { name: "Mask + drop cloths", phase: "Prep", days: 1, trade: "Painting" },
      { name: "Ceilings + walls — coat 1", phase: "Paint", days: 1, trade: "Painting" },
      { name: "Walls — coat 2 + trim", phase: "Paint", days: 1, trade: "Painting" },
      { name: "Touch-ups + cleanup", phase: "Closeout", days: 1 },
    ],
  },

  // Document templates
  {
    id: "d1", kind: "document", name: "Construction agreement",
    category: "Contract", description: "Master construction agreement for residential remodels.",
    tags: ["contract", "legal"], owner: "Maria Chen", updatedAt: "2026-04-01", uses: 156, starred: true,
    docType: "Contract",
    body: "CONSTRUCTION AGREEMENT\n\nBetween {{company_name}} (\"Contractor\") and {{first_name}} {{last_name}} (\"Owner\")\nProject location: {{project_address}}\n\n1. SCOPE OF WORK\nContractor shall perform the {{project_type}} work as detailed in the attached Estimate dated [date], totaling {{estimate_total}}.\n\n2. PAYMENT SCHEDULE\n- Deposit: {{deposit_amount}} due upon signing\n- Progress payments per attached schedule\n- Final payment upon substantial completion\n\n3. CHANGE ORDERS\nAll changes must be documented in writing and signed by both parties.\n\n4. WARRANTY\nWorkmanship warranted for one (1) year from substantial completion.\n\n[full terms continue…]\n\nOwner: ____________________  Date: __________\nContractor: ________________  Date: __________",
  },
  {
    id: "d2", kind: "document", name: "Change order",
    category: "Change Order", description: "Standard CO with cost and schedule impact.",
    tags: ["change-order"], owner: "James Park", updatedAt: "2026-03-30", uses: 84, starred: false,
    docType: "Change Order",
    body: "CHANGE ORDER #__\n\nProject: {{project_type}} at {{project_address}}\nDate: [date]\n\nDESCRIPTION OF CHANGE\n[describe scope change]\n\nCOST IMPACT: $______\nSCHEDULE IMPACT: ___ days\n\nNew contract total: $______\n\nApproved by Owner: ____________________  Date: __________\nApproved by Contractor: ________________  Date: __________",
  },
  {
    id: "d3", kind: "document", name: "Conditional lien waiver",
    category: "Lien Waiver", description: "Conditional waiver upon progress payment.",
    tags: ["lien"], owner: "Priya Shah", updatedAt: "2026-03-22", uses: 72, starred: false,
    docType: "Lien Waiver",
    body: "CONDITIONAL WAIVER AND RELEASE UPON PROGRESS PAYMENT\n\nProperty: {{project_address}}\nUndersigned: {{company_name}}\nOwner: {{first_name}} {{last_name}}\n\nUpon receipt of payment in the amount of $______, the undersigned waives any mechanic's lien rights through [through date].\n\nSigned: ____________________  Date: __________",
  },
  {
    id: "d4", kind: "document", name: "1-year warranty letter",
    category: "Warranty", description: "Issued at project closeout.",
    tags: ["warranty", "closeout"], owner: "Maria Chen", updatedAt: "2026-03-15", uses: 41, starred: false,
    docType: "Warranty",
    body: "WORKMANSHIP WARRANTY\n\nDear {{first_name}},\n\nThank you for choosing {{company_name}} for your {{project_type}} at {{project_address}}.\n\n{{company_name}} warrants the workmanship for a period of one (1) year from {{start_date}}. Manufacturer warranties on materials and equipment are passed through and may extend longer.\n\nFor warranty service, contact: warranty@{{company_name}}.com\n\nWarmly,\n{{owner_name}}",
  },
];

const KIND_META: Record<TemplateKind, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  message: { label: "Messages", icon: Mail },
  estimate: { label: "Estimates", icon: FileSpreadsheet },
  plan: { label: "Project plans", icon: ListChecks },
  document: { label: "Documents", icon: FileText },
  form: { label: "Forms", icon: ClipboardList },
};

// ============ Component ============
function TemplatesPage() {
  const org = useOrganization();
  const [items, setItems] = useState<AnyTemplate[]>(() => [...SEED, ...buildSeedForms(org.industry)]);
  const [kind, setKind] = useState<TemplateKind>("message");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("All");
  const [projectTypeFilter, setProjectTypeFilter] = useState<string>("All");
  const [selectedId, setSelectedId] = useState<string>(SEED[0].id);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [autoSyncPlans, setAutoSyncPlans] = useState<boolean>(true);

  const ofKind = useMemo(() => items.filter((t) => t.kind === kind), [items, kind]);
  const categories = useMemo(() => ["All", ...Array.from(new Set(ofKind.map((t) => t.category)))], [ofKind]);
  const projectTypes = useMemo(
    () => [
      "All",
      ...Array.from(
        new Set(
          ofKind
            .filter((t): t is EstimateTemplate => t.kind === "estimate")
            .map((t) => t.projectType),
        ),
      ),
    ],
    [ofKind],
  );

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    return ofKind.filter((t) => {
      if (category !== "All" && t.category !== category) return false;
      if (
        kind === "estimate" &&
        projectTypeFilter !== "All" &&
        (t as EstimateTemplate).projectType !== projectTypeFilter
      ) {
        return false;
      }
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.tags.some((tag) => tag.toLowerCase().includes(q))
      );
    });
  }, [ofKind, query, category, kind, projectTypeFilter]);

  const selected = items.find((t) => t.id === selectedId && t.kind === kind) ?? filtered[0];

  // Reset selection when switching kinds
  const switchKind = (k: TemplateKind) => {
    setKind(k);
    setCategory("All");
    setProjectTypeFilter("All");
    setQuery("");
    const first = items.find((t) => t.kind === k);
    if (first) setSelectedId(first.id);
  };

  const updateSelected = (patch: Partial<AnyTemplate>) => {
    if (!selected) return;
    setItems((prev) =>
      prev.map((t) => (t.id === selected.id ? ({ ...t, ...patch, updatedAt: new Date().toISOString().slice(0, 10) } as AnyTemplate) : t)),
    );
  };

  const toggleStar = (id: string) => {
    setItems((prev) => prev.map((t) => (t.id === id ? { ...t, starred: !t.starred } : t)));
  };

  const duplicate = (t: AnyTemplate) => {
    const copy = { ...t, id: `${t.id}-${Date.now()}`, name: `${t.name} (copy)`, uses: 0, starred: false } as AnyTemplate;
    setItems((prev) => [copy, ...prev]);
    setSelectedId(copy.id);
    toast.success("Template duplicated");
  };

  const remove = (id: string) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
    toast.success("Template deleted");
  };

  const createNew = () => {
    const base = {
      id: `new-${Date.now()}`,
      name: "Untitled template",
      category: "General",
      description: "",
      tags: [],
      owner: "Maria Chen",
      updatedAt: new Date().toISOString().slice(0, 10),
      uses: 0,
      starred: false,
    };
    let n: AnyTemplate;
    if (kind === "message") {
      n = { ...base, kind: "message", channel: "email", subject: "", body: "" };
    } else if (kind === "estimate") {
      n = { ...base, kind: "estimate", projectType: "Kitchen", lines: [], markup: 20, notes: "" };
    } else if (kind === "plan") {
      n = { ...base, kind: "plan", projectType: "Kitchen", durationDays: 0, tasks: [] };
    } else if (kind === "document") {
      n = { ...base, kind: "document", docType: "Contract", body: "" };
    } else {
      n = {
        ...base,
        kind: "form",
        variant: "general_contact",
        placement: "Contact page",
        submitLabel: "Submit",
        successMessage: "Thanks — we'll be in touch shortly.",
        fields: [
          { key: "first_name", label: "First name", type: "text", required: true },
          { key: "email", label: "Email", type: "email", required: true },
          { key: "message", label: "Message", type: "textarea", required: true },
        ],
      };
    }
    setItems((prev) => [n, ...prev]);
    setSelectedId(n.id);
  };

  // Analytics
  const analytics = useMemo(() => {
    const totalUses = ofKind.reduce((s, t) => s + t.uses, 0);
    const msgs = ofKind.filter((t): t is MessageTemplate => t.kind === "message");
    const avgOpen = msgs.length ? Math.round(msgs.reduce((s, m) => s + (m.openRate ?? 0), 0) / msgs.length) : null;
    const avgReply = msgs.length ? Math.round(msgs.reduce((s, m) => s + (m.replyRate ?? 0), 0) / msgs.length) : null;
    const top = [...ofKind].sort((a, b) => b.uses - a.uses)[0];
    return { totalUses, avgOpen, avgReply, top };
  }, [ofKind]);

  // Auto-sync project plans from estimate categories.
  // For every estimate category without a matching plan, create a starter plan
  // whose tasks mirror the estimate line items (1 day each, "Build" phase).
  const syncPlansFromEstimates = (silent = false) => {
    setItems((prev) => {
      const estimates = prev.filter((t): t is EstimateTemplate => t.kind === "estimate");
      const planCategories = new Set(
        prev.filter((t) => t.kind === "plan").map((t) => t.category.toLowerCase()),
      );
      // Pick one representative estimate per category (highest uses).
      const byCategory = new Map<string, EstimateTemplate>();
      for (const e of estimates) {
        const key = e.category.toLowerCase();
        const existing = byCategory.get(key);
        if (!existing || e.uses > existing.uses) byCategory.set(key, e);
      }
      const additions: PlanTemplate[] = [];
      for (const [key, est] of byCategory) {
        if (planCategories.has(key)) continue;
        const tasks: PlanTask[] = est.lines.length
          ? est.lines.map((l) => ({ name: l.name, phase: "Build", days: 1 }))
          : [{ name: "Scope of work", phase: "Build", days: 1 }];
        additions.push({
          id: `plan-sync-${key}-${Date.now()}`,
          kind: "plan",
          name: `${est.category} — plan (synced)`,
          category: est.category,
          description: `Auto-generated from estimate "${est.name}". Edit phases and durations to fit your typical schedule.`,
          tags: ["synced", est.category.toLowerCase()],
          owner: "System",
          updatedAt: new Date().toISOString().slice(0, 10),
          uses: 0,
          starred: false,
          projectType: est.projectType,
          durationDays: tasks.reduce((s, t) => s + t.days, 0),
          tasks,
        });
      }
      if (!additions.length) {
        if (!silent) toast.info("Plans already cover every estimate category.");
        return prev;
      }
      if (!silent) toast.success(`Synced ${additions.length} plan${additions.length === 1 ? "" : "s"} from estimates.`);
      return [...additions, ...prev];
    });
  };

  // Run auto-sync silently on mount and whenever the toggle is turned on.
  useEffect(() => {
    if (autoSyncPlans) syncPlansFromEstimates(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSyncPlans]);

  return (
    <div className="space-y-4">
      {/* Kind tabs */}
      <Tabs value={kind} onValueChange={(v) => switchKind(v as TemplateKind)}>
        <TabsList>
          {(Object.keys(KIND_META) as TemplateKind[]).map((k) => {
            const Icon = KIND_META[k].icon;
            return (
              <TabsTrigger key={k} value={k} className="gap-1.5">
                <Icon className="h-3.5 w-3.5" />
                {KIND_META[k].label}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>

      {/* Analytics strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <AnalyticsTile icon={BarChart3} label="Total uses (90d)" value={analytics.totalUses.toLocaleString()} />
        <AnalyticsTile
          icon={TrendingUp}
          label={kind === "message" ? "Avg open rate" : "Templates"}
          value={kind === "message" && analytics.avgOpen != null ? `${analytics.avgOpen}%` : String(ofKind.length)}
        />
        <AnalyticsTile
          icon={Send}
          label={kind === "message" ? "Avg reply rate" : "Categories"}
          value={kind === "message" && analytics.avgReply != null ? `${analytics.avgReply}%` : String(categories.length - 1)}
        />
        <AnalyticsTile icon={Clock} label="Most used" value={analytics.top?.name ?? "—"} small />
      </div>

      {/* Library + editor */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[340px_1fr]">
        {/* Library */}
        <Card className="flex flex-col overflow-hidden">
          <div className="space-y-2 border-b p-3">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search templates…"
                  className="h-8 pl-7 text-sm"
                />
              </div>
              <Button size="sm" className="h-8" onClick={createNew}>
                <Plus className="h-3.5 w-3.5" />
                {kind === "form" ? <span className="ml-1 text-xs">Custom form</span> : null}
              </Button>
            </div>
            <div className="flex flex-wrap gap-1">
              {categories.map((c) => (
                <button
                  key={c}
                  onClick={() => setCategory(c)}
                  className={
                    "rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors " +
                    (category === c
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-muted-foreground hover:bg-secondary/70")
                  }
                >
                  {c}
                </button>
              ))}
            </div>
            {kind === "estimate" && projectTypes.length > 1 && (
              <div className="flex flex-wrap items-center gap-1">
                <span className="mr-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Project type
                </span>
                {projectTypes.map((p) => (
                  <button
                    key={p}
                    onClick={() => setProjectTypeFilter(p)}
                    className={
                      "rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors " +
                      (projectTypeFilter === p
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-background text-muted-foreground hover:bg-secondary/50")
                    }
                  >
                    {p}
                  </button>
                ))}
              </div>
            )}
            {kind === "plan" && (
              <div className="rounded-md border border-dashed bg-muted/30 p-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-[11px] font-medium">
                      <RefreshCw className="h-3 w-3 text-primary" />
                      Sync with estimates
                    </div>
                    <p className="mt-0.5 text-[10px] leading-tight text-muted-foreground">
                      Auto-create a plan for every estimate category.
                    </p>
                  </div>
                  <label className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={autoSyncPlans}
                      onChange={(e) => setAutoSyncPlans(e.target.checked)}
                      className="h-3 w-3 accent-primary"
                    />
                    Auto
                  </label>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2 h-6 w-full text-[10px]"
                  onClick={() => syncPlansFromEstimates(false)}
                >
                  <RefreshCw className="h-3 w-3" /> Sync now
                </Button>
              </div>
            )}
          </div>
          <ScrollArea className="max-h-[640px] flex-1">
            <div className="divide-y">
              {filtered.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setSelectedId(t.id)}
                  className={
                    "block w-full px-3 py-2.5 text-left transition-colors " +
                    (selected?.id === t.id ? "bg-primary/5" : "hover:bg-secondary/50")
                  }
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{t.name}</span>
                        {t.kind === "message" && (
                          <Badge variant="secondary" className="h-4 px-1 text-[9px] uppercase">
                            {(t as MessageTemplate).channel}
                          </Badge>
                        )}
                      </div>
                      <div className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{t.description}</div>
                      <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                        <span>{t.category}</span>
                        <span>·</span>
                        <span>{t.uses.toLocaleString()} uses</span>
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleStar(t.id);
                      }}
                      className="shrink-0"
                    >
                      <Star
                        className={
                          "h-3.5 w-3.5 " +
                          (t.starred ? "fill-amber-400 text-amber-400" : "text-muted-foreground")
                        }
                      />
                    </button>
                  </div>
                  <div className="mt-1.5 flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[10px]"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPreviewId(t.id);
                      }}
                    >
                      <Eye className="h-3 w-3" /> Preview
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[10px]"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedId(t.id);
                      }}
                    >
                      <Pencil className="h-3 w-3" /> Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[10px] text-destructive hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteId(t.id);
                      }}
                    >
                      <Trash2 className="h-3 w-3" /> Delete
                    </Button>
                  </div>
                </button>
              ))}
              {filtered.length === 0 && (
                <div className="p-6 text-center text-xs text-muted-foreground">No templates match.</div>
              )}
            </div>
          </ScrollArea>
        </Card>

        {/* Editor + preview */}
        <Card className="overflow-hidden">
          {selected ? (
            <div className="grid grid-cols-1 lg:grid-cols-2">
              <div className="space-y-4 border-b p-4 lg:border-b-0 lg:border-r">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 space-y-1">
                    <Label className="text-xs">Name</Label>
                    <Input
                      value={selected.name}
                      onChange={(e) => updateSelected({ name: e.target.value } as Partial<AnyTemplate>)}
                      className="h-9 text-sm font-medium"
                    />
                  </div>
                  <div className="flex gap-1 pt-5">
                    <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => duplicate(selected)}>
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => remove(selected.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Category</Label>
                    <Input
                      value={selected.category}
                      onChange={(e) => updateSelected({ category: e.target.value } as Partial<AnyTemplate>)}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Owner</Label>
                    <Input
                      value={selected.owner}
                      onChange={(e) => updateSelected({ owner: e.target.value } as Partial<AnyTemplate>)}
                      className="h-8 text-sm"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs">Description</Label>
                  <Input
                    value={selected.description}
                    onChange={(e) => updateSelected({ description: e.target.value } as Partial<AnyTemplate>)}
                    className="h-8 text-sm"
                  />
                </div>

                <Separator />

                {/* Kind-specific fields */}
                {selected.kind === "message" && (
                  <MessageEditor t={selected} onChange={(p) => updateSelected(p)} />
                )}
                {selected.kind === "estimate" && (
                  <EstimateEditor t={selected} onChange={(p) => updateSelected(p)} />
                )}
                {selected.kind === "plan" && <PlanEditor t={selected} onChange={(p) => updateSelected(p)} />}
                {selected.kind === "document" && (
                  <DocumentEditor t={selected} onChange={(p) => updateSelected(p)} />
                )}
                {selected.kind === "form" && (
                  <FormEditor t={selected} onChange={(p) => updateSelected(p)} />
                )}

                <div className="rounded-md border bg-muted/30 p-2.5">
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Merge tags
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {MERGE_TAGS.map((tag) => (
                      <button
                        key={tag}
                        onClick={() => {
                          navigator.clipboard.writeText(tag).catch(() => {});
                          toast.success(`Copied ${tag}`);
                        }}
                        className="rounded border bg-background px-1.5 py-0.5 font-mono text-[10px] hover:bg-secondary"
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Live preview */}
              <div className="bg-muted/20 p-4">
                <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <Eye className="h-3 w-3" /> Live preview
                </div>
                <Card className="overflow-hidden">
                  <Preview t={selected} />
                </Card>
                {selected.kind === "message" &&
                  ((selected as MessageTemplate).openRate != null || (selected as MessageTemplate).replyRate != null) && (
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded-md border bg-background p-2">
                        <div className="text-[10px] uppercase text-muted-foreground">Open rate</div>
                        <div className="text-base font-semibold">{(selected as MessageTemplate).openRate}%</div>
                      </div>
                      <div className="rounded-md border bg-background p-2">
                        <div className="text-[10px] uppercase text-muted-foreground">Reply rate</div>
                        <div className="text-base font-semibold">{(selected as MessageTemplate).replyRate}%</div>
                      </div>
                    </div>
                  )}
              </div>
            </div>
          ) : (
            <div className="p-12 text-center text-sm text-muted-foreground">Select a template to edit.</div>
          )}
        </Card>
      </div>

      {/* Live preview modal */}
      <Dialog open={previewId !== null} onOpenChange={(o) => !o && setPreviewId(null)}>
        <DialogContent className="max-w-2xl p-0">
          {(() => {
            const pt = items.find((x) => x.id === previewId);
            if (!pt) return null;
            return (
              <>
                <DialogHeader className="border-b px-5 py-4">
                  <DialogTitle className="text-base">{pt.name}</DialogTitle>
                  <DialogDescription className="text-xs">
                    {pt.kind === "form"
                      ? "Live preview — submissions create a real lead in your pipeline."
                      : "Live preview of this template."}
                  </DialogDescription>
                </DialogHeader>
                <div className="max-h-[70vh] overflow-auto bg-muted/20 p-4">
                  <Preview t={pt} />
                </div>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this form?</AlertDialogTitle>
            <AlertDialogDescription>
              {(() => {
                const dt = items.find((x) => x.id === deleteId);
                return dt ? `"${dt.name}" will be permanently removed. This cannot be undone.` : "";
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteId) remove(deleteId);
                setDeleteId(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ============ Editors ============
function MessageEditor({ t, onChange }: { t: MessageTemplate; onChange: (p: Partial<MessageTemplate>) => void }) {
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="text-xs">Channel</Label>
        <Select value={t.channel} onValueChange={(v) => onChange({ channel: v as MessageChannel })}>
          <SelectTrigger className="h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="email">
              <span className="flex items-center gap-1.5">
                <Mail className="h-3 w-3" /> Email
              </span>
            </SelectItem>
            <SelectItem value="sms">
              <span className="flex items-center gap-1.5">
                <MessageSquare className="h-3 w-3" /> SMS
              </span>
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      {t.channel === "email" && (
        <div className="space-y-1">
          <Label className="text-xs">Subject</Label>
          <Input
            value={t.subject ?? ""}
            onChange={(e) => onChange({ subject: e.target.value })}
            className="h-8 text-sm"
          />
        </div>
      )}
      <div className="space-y-1">
        <Label className="text-xs">Body</Label>
        <Textarea
          value={t.body}
          onChange={(e) => onChange({ body: e.target.value })}
          rows={t.channel === "sms" ? 4 : 9}
          className="text-sm font-mono"
        />
        {t.channel === "sms" && (
          <div className="text-[10px] text-muted-foreground">{t.body.length} / 320 chars</div>
        )}
      </div>
    </div>
  );
}

function EstimateEditor({ t, onChange }: { t: EstimateTemplate; onChange: (p: Partial<EstimateTemplate>) => void }) {
  const subtotal = t.lines.reduce((s, l) => s + l.qty * l.price, 0);
  const total = subtotal * (1 + t.markup / 100);
  const updateLine = (idx: number, patch: Partial<EstimateLine>) => {
    onChange({ lines: t.lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)) });
  };
  const removeLine = (idx: number) => {
    onChange({ lines: t.lines.filter((_, i) => i !== idx) });
  };
  const addLine = () => {
    onChange({ lines: [...t.lines, { name: "New line item", qty: 1, unit: "lot", price: 0 }] });
  };
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Project type</Label>
          <Input
            value={t.projectType}
            onChange={(e) => onChange({ projectType: e.target.value })}
            className="h-8 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Markup %</Label>
          <Input
            type="number"
            value={t.markup}
            onChange={(e) => onChange({ markup: Number(e.target.value) || 0 })}
            className="h-8 text-sm"
          />
        </div>
      </div>
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label className="text-xs">Line items ({t.lines.length})</Label>
          <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={addLine}>
            <Plus className="h-3 w-3" /> Add line
          </Button>
        </div>
        <div className="max-h-56 overflow-auto rounded-md border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-2 py-1 text-left font-medium">Item</th>
                <th className="px-2 py-1 text-right font-medium w-16">Qty</th>
                <th className="px-2 py-1 text-left font-medium w-14">Unit</th>
                <th className="px-2 py-1 text-right font-medium w-20">Rate</th>
                <th className="px-2 py-1 text-right font-medium w-20">Total</th>
                <th className="px-1 py-1 w-6"></th>
              </tr>
            </thead>
            <tbody>
              {t.lines.map((l, i) => (
                <tr key={i} className="border-t">
                  <td className="px-1 py-0.5">
                    <Input
                      value={l.name}
                      onChange={(e) => updateLine(i, { name: e.target.value })}
                      className="h-7 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-1"
                    />
                  </td>
                  <td className="px-1 py-0.5">
                    <Input
                      type="number"
                      value={l.qty}
                      onChange={(e) => updateLine(i, { qty: Number(e.target.value) || 0 })}
                      className="h-7 border-0 bg-transparent px-1 text-right text-xs tabular-nums shadow-none focus-visible:ring-1"
                    />
                  </td>
                  <td className="px-1 py-0.5">
                    <Input
                      value={l.unit}
                      onChange={(e) => updateLine(i, { unit: e.target.value })}
                      className="h-7 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-1"
                    />
                  </td>
                  <td className="px-1 py-0.5">
                    <Input
                      type="number"
                      value={l.price}
                      onChange={(e) => updateLine(i, { price: Number(e.target.value) || 0 })}
                      className="h-7 border-0 bg-transparent px-1 text-right text-xs tabular-nums shadow-none focus-visible:ring-1"
                    />
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">{formatMoney(l.qty * l.price)}</td>
                  <td className="px-1 py-1 text-right">
                    <button
                      onClick={() => removeLine(i)}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label="Remove line"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </td>
                </tr>
              ))}
              {t.lines.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                    No line items yet — click "Add line" to start.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>Subtotal {formatMoney(subtotal)} · Markup {t.markup}%</span>
          <span className="font-semibold text-foreground">Total {formatMoney(total)}</span>
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Notes</Label>
        <Textarea value={t.notes} onChange={(e) => onChange({ notes: e.target.value })} rows={3} className="text-sm" />
      </div>
    </div>
  );
}

function PlanEditor({ t, onChange }: { t: PlanTemplate; onChange: (p: Partial<PlanTemplate>) => void }) {
  const sumDays = (tasks: PlanTask[]) => tasks.reduce((s, task) => s + (Number(task.days) || 0), 0);
  const applyTasks = (tasks: PlanTask[]) => {
    onChange({ tasks, durationDays: sumDays(tasks) });
  };
  const updateTask = (idx: number, patch: Partial<PlanTask>) => {
    applyTasks(t.tasks.map((task, i) => (i === idx ? { ...task, ...patch } : task)));
  };
  const removeTask = (idx: number) => {
    applyTasks(t.tasks.filter((_, i) => i !== idx));
  };
  const addTask = () => {
    applyTasks([...t.tasks, { name: "New task", phase: "Pre-con", days: 1 }]);
  };
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Project type</Label>
          <Input
            value={t.projectType}
            onChange={(e) => onChange({ projectType: e.target.value })}
            className="h-8 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Duration (days) · auto</Label>
          <Input
            type="number"
            value={sumDays(t.tasks)}
            readOnly
            tabIndex={-1}
            className="h-8 bg-muted/40 text-sm"
          />
        </div>
      </div>
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label className="text-xs">Tasks ({t.tasks.length})</Label>
          <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={addTask}>
            <Plus className="h-3 w-3" /> Add task
          </Button>
        </div>
        <div className="max-h-72 overflow-auto rounded-md border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-2 py-1 text-left font-medium">Task</th>
                <th className="px-2 py-1 text-left font-medium w-28">Phase</th>
                <th className="px-2 py-1 text-left font-medium w-24">Trade</th>
                <th className="px-2 py-1 text-right font-medium w-14">Days</th>
                <th className="px-1 py-1 w-6"></th>
              </tr>
            </thead>
            <tbody>
              {t.tasks.map((task, i) => (
                <tr key={i} className="border-t">
                  <td className="px-1 py-0.5">
                    <Input
                      value={task.name}
                      onChange={(e) => updateTask(i, { name: e.target.value })}
                      className="h-7 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-1"
                    />
                  </td>
                  <td className="px-1 py-0.5">
                    <Input
                      value={task.phase}
                      onChange={(e) => updateTask(i, { phase: e.target.value })}
                      className="h-7 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-1"
                    />
                  </td>
                  <td className="px-1 py-0.5">
                    <Input
                      value={task.trade ?? ""}
                      onChange={(e) => updateTask(i, { trade: e.target.value || undefined })}
                      placeholder="—"
                      className="h-7 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-1"
                    />
                  </td>
                  <td className="px-1 py-0.5">
                    <Input
                      type="number"
                      value={task.days}
                      onChange={(e) => updateTask(i, { days: Number(e.target.value) || 0 })}
                      className="h-7 border-0 bg-transparent px-1 text-right text-xs tabular-nums shadow-none focus-visible:ring-1"
                    />
                  </td>
                  <td className="px-1 py-1 text-right">
                    <button
                      onClick={() => removeTask(i)}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label="Remove task"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </td>
                </tr>
              ))}
              {t.tasks.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                    No tasks yet — click "Add task" to start.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function DocumentEditor({ t, onChange }: { t: DocumentTemplate; onChange: (p: Partial<DocumentTemplate>) => void }) {
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="text-xs">Document type</Label>
        <Input
          value={t.docType}
          onChange={(e) => onChange({ docType: e.target.value })}
          className="h-8 text-sm"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Body</Label>
        <Textarea
          value={t.body}
          onChange={(e) => onChange({ body: e.target.value })}
          rows={14}
          className="text-sm font-mono"
        />
      </div>
    </div>
  );
}

// ============ Preview (with merge tag highlighting) ============
const SAMPLE: Record<string, string> = {
  first_name: "Sarah",
  last_name: "Jenkins",
  project_address: "14 Elm Street, Portland OR",
  project_type: "Kitchen remodel",
  owner_name: "Maria Chen",
  company_name: "RenoMeta Builders",
  deposit_amount: "$24,000",
  start_date: "May 12, 2026",
  estimate_total: "$96,400",
  deposit_due: "April 28, 2026",
};

function renderMerged(text: string) {
  const parts = text.split(/(\{\{[^}]+\}\})/g);
  return parts.map((p, i) => {
    const match = p.match(/^\{\{([^}]+)\}\}$/);
    if (match) {
      const val = SAMPLE[match[1].trim()];
      return <span key={i}>{val ?? p}</span>;
    }
    return <span key={i}>{p}</span>;
  });
}

function Preview({ t }: { t: AnyTemplate }) {
  if (t.kind === "message") {
    if (t.channel === "email") {
      return (
        <div className="bg-background">
          <div className="border-b px-4 py-2.5 text-xs">
            <div className="text-muted-foreground">
              <span className="font-medium text-foreground">To:</span> {SAMPLE.first_name} {SAMPLE.last_name}
            </div>
            <div className="mt-0.5 text-muted-foreground">
              <span className="font-medium text-foreground">Subject:</span> {renderMerged(t.subject ?? "")}
            </div>
          </div>
          <div className="whitespace-pre-wrap p-4 text-sm leading-relaxed">{renderMerged(t.body)}</div>
        </div>
      );
    }
    return (
      <div className="bg-background p-4">
        <div className="ml-auto max-w-[80%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground">
          <div className="whitespace-pre-wrap">{renderMerged(t.body)}</div>
        </div>
        <div className="mt-1 text-right text-[10px] text-muted-foreground">{t.body.length} chars</div>
      </div>
    );
  }
  if (t.kind === "estimate") {
    const subtotal = t.lines.reduce((s, l) => s + l.qty * l.price, 0);
    const markupAmt = subtotal * (t.markup / 100);
    const total = subtotal + markupAmt;
    return (
      <div className="bg-background p-4 text-sm">
        <div className="mb-3">
          <div className="text-base font-semibold">{t.name}</div>
          <div className="text-xs text-muted-foreground">{t.projectType} estimate · {SAMPLE.project_address}</div>
        </div>
        <table className="w-full text-xs">
          <thead className="border-b">
            <tr className="text-left text-muted-foreground">
              <th className="pb-1.5 font-medium">Description</th>
              <th className="pb-1.5 text-right font-medium">Qty</th>
              <th className="pb-1.5 text-right font-medium">Rate</th>
              <th className="pb-1.5 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {t.lines.map((l, i) => (
              <tr key={i} className="border-b last:border-0">
                <td className="py-1.5">{l.name}</td>
                <td className="py-1.5 text-right tabular-nums">{l.qty} {l.unit}</td>
                <td className="py-1.5 text-right tabular-nums">{formatMoney(l.price)}</td>
                <td className="py-1.5 text-right tabular-nums">{formatMoney(l.qty * l.price)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2">
            <tr><td colSpan={3} className="pt-2 text-right text-xs text-muted-foreground">Subtotal</td><td className="pt-2 text-right tabular-nums">{formatMoney(subtotal)}</td></tr>
            <tr><td colSpan={3} className="text-right text-xs text-muted-foreground">Markup ({t.markup}%)</td><td className="text-right tabular-nums">{formatMoney(markupAmt)}</td></tr>
            <tr><td colSpan={3} className="pt-1 text-right text-sm font-semibold">Total</td><td className="pt-1 text-right text-sm font-semibold tabular-nums">{formatMoney(total)}</td></tr>
          </tfoot>
        </table>
        {t.notes && (
          <div className="mt-3 rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">{t.notes}</div>
        )}
      </div>
    );
  }
  if (t.kind === "plan") {
    const phases = Array.from(new Set(t.tasks.map((task) => task.phase)));
    return (
      <div className="bg-background p-4 text-sm">
        <div className="mb-3 flex items-end justify-between">
          <div>
            <div className="text-base font-semibold">{t.name}</div>
            <div className="text-xs text-muted-foreground">{t.projectType} · {t.durationDays} day plan</div>
          </div>
          <div className="text-xs text-muted-foreground">{t.tasks.length} tasks</div>
        </div>
        {phases.map((phase) => (
          <div key={phase} className="mb-3">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{phase}</div>
            <div className="space-y-1">
              {t.tasks.filter((task) => task.phase === phase).map((task, i) => (
                <div key={i} className="flex items-center justify-between rounded-md border px-2 py-1.5 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                    <span>{task.name}</span>
                    {task.trade && <Badge variant="secondary" className="h-4 px-1 text-[9px]">{task.trade}</Badge>}
                  </div>
                  <span className="text-muted-foreground tabular-nums">{task.days}d</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (t.kind === "document") {
    return (
      <div className="bg-background p-6 text-sm">
        <div className="mb-3 text-center">
          <Badge variant="outline" className="text-[10px] uppercase">{t.docType}</Badge>
        </div>
        <div className="whitespace-pre-wrap font-serif leading-relaxed text-foreground/90">
          {renderMerged(t.body)}
        </div>
      </div>
    );
  }
  // form
  return <FormPreview t={t} />;
}

function AnalyticsTile({
  icon: Icon,
  label,
  value,
  small,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  small?: boolean;
}) {
  return (
    <Card className="p-3">
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
          <div className={"mt-1 truncate font-semibold " + (small ? "text-sm" : "text-lg")}>{value}</div>
        </div>
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="h-3.5 w-3.5" />
        </div>
      </div>
    </Card>
  );
}

// ============ Form editor & preview ============
const FIELD_TYPE_LABELS: Record<FormFieldType, string> = {
  text: "Short text",
  email: "Email",
  tel: "Phone",
  address: "Address",
  textarea: "Long text",
  select: "Dropdown",
  date: "Date",
  "time-slot": "Time slot",
  file: "File upload",
};

function FormEditor({ t, onChange }: { t: FormTemplate; onChange: (p: Partial<FormTemplate>) => void }) {
  const updateField = (idx: number, patch: Partial<FormField>) => {
    const next = t.fields.map((f, i) => (i === idx ? { ...f, ...patch } : f));
    onChange({ fields: next });
  };
  const removeField = (idx: number) => {
    onChange({ fields: t.fields.filter((_, i) => i !== idx) });
  };
  const addField = () => {
    onChange({
      fields: [
        ...t.fields,
        { key: `field_${t.fields.length + 1}`, label: "New field", type: "text", required: false },
      ],
    });
  };
  const moveField = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= t.fields.length) return;
    const next = [...t.fields];
    [next[idx], next[target]] = [next[target], next[idx]];
    onChange({ fields: next });
  };

  const embedSnippet = `<script src="https://embed.lovable.app/forms/${t.id}.js" async></script>\n<div data-form-id="${t.id}"></div>`;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Recommended placement</Label>
          <Input
            value={t.placement}
            onChange={(e) => onChange({ placement: e.target.value })}
            className="h-8 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Submit button label</Label>
          <Input
            value={t.submitLabel}
            onChange={(e) => onChange({ submitLabel: e.target.value })}
            className="h-8 text-sm"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Confirmation message</Label>
        <Textarea
          value={t.successMessage}
          onChange={(e) => onChange({ successMessage: e.target.value })}
          rows={2}
          className="text-sm"
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs">Fields ({t.fields.length})</Label>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={addField}>
            <Plus className="h-3 w-3" /> Add field
          </Button>
        </div>
        <div className="space-y-1.5">
          {t.fields.map((f, i) => (
            <div key={i} className="rounded-md border p-2">
              <div className="grid grid-cols-[1fr_120px_auto] items-end gap-2">
                <div className="space-y-0.5">
                  <Label className="text-[10px] uppercase text-muted-foreground">Label</Label>
                  <Input
                    value={f.label}
                    onChange={(e) => updateField(i, { label: e.target.value })}
                    className="h-7 text-xs"
                  />
                </div>
                <div className="space-y-0.5">
                  <Label className="text-[10px] uppercase text-muted-foreground">Type</Label>
                  <Select value={f.type} onValueChange={(v) => updateField(i, { type: v as FormFieldType })}>
                    <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(FIELD_TYPE_LABELS) as FormFieldType[]).map((type) => (
                        <SelectItem key={type} value={type}>{FIELD_TYPE_LABELS[type]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => moveField(i, -1)} title="Move up">↑</Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => moveField(i, 1)} title="Move down">↓</Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => removeField(i)} title="Remove">
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={f.required}
                    onChange={(e) => updateField(i, { required: e.target.checked })}
                  />
                  Required
                </label>
                {(f.type === "select" || f.type === "time-slot") && (
                  <Input
                    value={(f.options ?? []).join(", ")}
                    onChange={(e) =>
                      updateField(i, {
                        options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                      })
                    }
                    placeholder="Comma-separated options"
                    className="h-7 flex-1 text-xs"
                  />
                )}
              </div>
            </div>
          ))}
          {t.fields.length === 0 && (
            <div className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
              No fields yet — add your first one.
            </div>
          )}
        </div>
      </div>

      <div className="rounded-md border bg-muted/30 p-2.5">
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          <Code2 className="h-3 w-3" /> Embed snippet
        </div>
        <pre className="max-h-24 overflow-auto rounded bg-background p-2 text-[10px] leading-relaxed">{embedSnippet}</pre>
        <Button
          variant="outline"
          size="sm"
          className="mt-1.5 h-7 text-xs"
          onClick={() => {
            navigator.clipboard.writeText(embedSnippet).catch(() => {});
            toast.success("Embed snippet copied");
          }}
        >
          <Copy className="h-3 w-3" /> Copy snippet
        </Button>
      </div>
    </div>
  );
}

function FormPreview({ t }: { t: FormTemplate }) {
  const isEmergency = t.variant === "emergency";
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, boolean>>({});
  const [submitted, setSubmitted] = useState(false);

  const setValue = (k: string, v: string) => {
    setValues((prev) => ({ ...prev, [k]: v }));
    if (errors[k]) setErrors((prev) => ({ ...prev, [k]: false }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const nextErrors: Record<string, boolean> = {};
    for (const f of t.fields) {
      if (f.required && f.type !== "file" && !(values[f.key] ?? "").trim()) {
        nextErrors[f.key] = true;
      }
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      toast.error("Please fill in the required fields.");
      return;
    }

    const first = values.first_name ?? "";
    const last = values.last_name ?? "";
    const fullName = `${first} ${last}`.trim() || values.email || values.phone || "Website lead";
    const score: Lead["score"] = t.variant === "emergency" ? "hot"
      : t.variant === "free_estimate" ? "warm" : "cold";
    const projectType = values.project_type || values.issue_type ||
      (t.variant === "general_contact" ? "General inquiry"
        : t.variant === "schedule_consultation" ? "Consultation"
        : t.variant === "emergency" ? "Emergency service" : "Estimate request");
    const noteParts: string[] = [`Submitted via "${t.name}" form.`];
    if (values.description) noteParts.push(`Description: ${values.description}`);
    if (values.message) noteParts.push(`Message: ${values.message}`);
    if (values.notes) noteParts.push(`Notes: ${values.notes}`);
    if (values.timeline) noteParts.push(`Timeline: ${values.timeline}`);
    if (values.preferred_date) noteParts.push(`Preferred date: ${values.preferred_date}`);
    if (values.preferred_time) noteParts.push(`Preferred time: ${values.preferred_time}`);
    if (values.urgency) noteParts.push(`Urgency: ${values.urgency}`);

    const now = new Date().toISOString();
    const lead = await addLead({
      name: fullName,
      email: values.email ?? "",
      phone: values.phone ?? "",
      address: values.address ?? "",
      source: "Website",
      status: "new",
      score,
      projectType,
      estimatedBudget: 0,
      notes: noteParts.join("\n"),
      owner: "Unassigned",
      ownerInitials: "—",
      createdAt: now,
      lastActivity: now,
    });

    setSubmitted(true);
    setValues({});
    setErrors({});
    toast.success("Lead created", {
      description: `${lead.name} added to your leads pipeline.`,
    });
  };

  return (
    <div className="bg-background">
      <div className={"px-4 py-3 " + (isEmergency ? "bg-destructive/10 border-b border-destructive/30" : "border-b bg-muted/30")}>
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              {isEmergency && <AlertTriangle className="h-4 w-4 text-destructive" />}
              {t.name}
            </div>
            <div className="text-[11px] text-muted-foreground">{t.placement}</div>
          </div>
          <Badge variant="outline" className="text-[10px]">{t.fields.length} fields</Badge>
        </div>
      </div>
      {submitted ? (
        <div className="space-y-3 p-6 text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
            ✓
          </div>
          <p className="text-sm font-medium">{t.successMessage}</p>
          <p className="text-[11px] text-muted-foreground">A new lead was added to your pipeline.</p>
          <Button size="sm" variant="outline" onClick={() => setSubmitted(false)}>
            Submit another
          </Button>
        </div>
      ) : (
        <form className="space-y-2.5 p-4" onSubmit={handleSubmit}>
          {t.fields.map((f) => (
            <FormFieldPreview
              key={f.key}
              field={f}
              value={values[f.key] ?? ""}
              onChange={(v) => setValue(f.key, v)}
              invalid={!!errors[f.key]}
            />
          ))}
          <Button
            type="submit"
            className={"mt-1 w-full " + (isEmergency ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : "")}
          >
            {t.submitLabel}
          </Button>
          <p className="text-center text-[10px] text-muted-foreground">Submissions land in Leads as Website source.</p>
        </form>
      )}
    </div>
  );
}

function FormFieldPreview({
  field,
  value,
  onChange,
  invalid,
}: {
  field: FormField;
  value: string;
  onChange: (v: string) => void;
  invalid: boolean;
}) {
  const labelEl = (
    <Label className={"text-xs " + (field.emphasized ? "text-destructive font-semibold" : "")}>
      {field.label}
      {field.required && <span className="ml-0.5 text-destructive">*</span>}
    </Label>
  );
  const wrap = (input: React.ReactNode) => (
    <div className="space-y-1">
      {labelEl}
      {input}
      {field.helpText && <p className="text-[10px] text-muted-foreground">{field.helpText}</p>}
      {invalid && <p className="text-[10px] text-destructive">Required.</p>}
    </div>
  );
  const invalidCls = invalid ? " border-destructive" : "";
  switch (field.type) {
    case "textarea":
      return wrap(
        <Textarea
          rows={3}
          className={"text-sm" + invalidCls}
          placeholder={`Enter ${field.label.toLowerCase()}…`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />,
      );
    case "select":
    case "time-slot":
      return wrap(
        <Select value={value || undefined} onValueChange={onChange}>
          <SelectTrigger className={"h-9 text-sm" + invalidCls}>
            <SelectValue placeholder="Select…" />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((o) => (
              <SelectItem key={o} value={o}>{o}</SelectItem>
            ))}
          </SelectContent>
        </Select>,
      );
    case "date":
      return wrap(
        <div className="relative">
          <Calendar className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="date"
            className={"h-9 pl-8 text-sm" + invalidCls}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>,
      );
    case "file":
      return wrap(
        <div className="flex items-center gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
          <ImageIcon className="h-3.5 w-3.5" />
          Click or drag to upload
        </div>,
      );
    case "tel":
      return wrap(
        <div className="relative">
          <Phone className={"pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 " + (field.emphasized ? "text-destructive" : "text-muted-foreground")} />
          <Input
            type="tel"
            className={"h-9 pl-8 text-sm " + (field.emphasized ? "border-destructive font-medium" : "") + invalidCls}
            placeholder="(555) 123-4567"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>,
      );
    case "address":
      return wrap(
        <Input
          className={"h-9 text-sm" + invalidCls}
          placeholder="Street, City, State ZIP"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />,
      );
    case "email":
      return wrap(
        <Input
          type="email"
          className={"h-9 text-sm" + invalidCls}
          placeholder="you@example.com"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />,
      );
    default:
      return wrap(
        <Input
          className={"h-9 text-sm" + invalidCls}
          placeholder={`Enter ${field.label.toLowerCase()}…`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />,
      );
  }
}
