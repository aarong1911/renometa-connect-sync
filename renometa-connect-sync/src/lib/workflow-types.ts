// src/lib/workflow-types.ts
// Central type system for the workflow builder and execution engine.

import type { LucideIcon } from "lucide-react";
import {
  UserPlus, RefreshCw, Briefcase, Receipt, AlertCircle, CheckCircle2,
  FileText, Calendar, PhoneMissed, UserRound, Play, FileCheck,
  MessageSquare, Mail, CheckSquare, ArrowUpRight, UserCheck, Share2, StickyNote,
  GitBranch, Filter, Clock, Sparkles, Webhook,
} from "lucide-react";

// ── Node categories ────────────────────────────────────────────────────────

export type WfNodeCategory = "trigger" | "action" | "condition" | "utility";

// ── Node types ─────────────────────────────────────────────────────────────

export type TriggerType =
  | "new_lead" | "lead_status_changed" | "project_status_changed"
  | "invoice_created" | "invoice_overdue" | "estimate_approved" | "estimate_sent"
  | "form_submitted" | "appointment_scheduled" | "missed_call"
  | "contact_created" | "manual";

export type ActionType =
  | "send_sms" | "send_email" | "create_task" | "update_status"
  | "assign_member" | "send_portal_invite" | "add_note";

export type ConditionType = "if_else" | "filter";

export type UtilityType = "wait" | "ai_step" | "webhook";

export type WfNodeType = TriggerType | ActionType | ConditionType | UtilityType;

// ── React-Flow node data (stored in node.data) ─────────────────────────────

export interface WfNodeData extends Record<string, unknown> {
  nodeType: WfNodeType;
  label: string;
  subtitle: string;
  config: Record<string, any>;
  category: WfNodeCategory;
}

// Serialisable React Flow node (stored as JSONB in workflows.nodes)
export interface WfRfNode {
  id: string;
  type: "wfNode";
  data: WfNodeData;
  position: { x: number; y: number };
}

// Serialisable React Flow edge (stored as JSONB in workflows.edges)
export interface WfRfEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: string;
  animated?: boolean;
}

// ── Category styling ───────────────────────────────────────────────────────

export const CATEGORY_STYLE: Record<WfNodeCategory, {
  label: string;
  dot: string;
  bg: string;
  border: string;
  text: string;
  badge: string;
}> = {
  trigger: {
    label: "Triggers",
    dot: "bg-blue-500",
    bg: "bg-blue-50 dark:bg-blue-950/30",
    border: "border-blue-200 dark:border-blue-800",
    text: "text-blue-700 dark:text-blue-300",
    badge: "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300",
  },
  action: {
    label: "Actions",
    dot: "bg-emerald-500",
    bg: "bg-emerald-50 dark:bg-emerald-950/30",
    border: "border-emerald-200 dark:border-emerald-800",
    text: "text-emerald-700 dark:text-emerald-300",
    badge: "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300",
  },
  condition: {
    label: "Conditions",
    dot: "bg-amber-500",
    bg: "bg-amber-50 dark:bg-amber-950/30",
    border: "border-amber-200 dark:border-amber-800",
    text: "text-amber-700 dark:text-amber-300",
    badge: "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300",
  },
  utility: {
    label: "Utilities",
    dot: "bg-slate-400",
    bg: "bg-slate-50 dark:bg-slate-900/40",
    border: "border-slate-200 dark:border-slate-700",
    text: "text-slate-600 dark:text-slate-300",
    badge: "bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800/60 dark:text-slate-300",
  },
};

// ── Node metadata (palette info + defaults) ────────────────────────────────

export interface WfNodeMeta {
  type: WfNodeType;
  category: WfNodeCategory;
  label: string;
  description: string;
  icon: LucideIcon;
  defaultConfig: Record<string, any>;
  defaultSubtitle: string;
}

export const NODE_META: WfNodeMeta[] = [
  // ── Triggers ──
  { type: "new_lead",               category: "trigger",   icon: UserPlus,      label: "New Lead",               description: "Fires when a new lead is created",                  defaultSubtitle: "Any source",                   defaultConfig: { source: "any" } },
  { type: "lead_status_changed",    category: "trigger",   icon: RefreshCw,     label: "Lead Status Changed",    description: "Fires when a lead moves to a new status",           defaultSubtitle: "Any status change",            defaultConfig: { from_status: "any", to_status: "any" } },
  { type: "project_status_changed", category: "trigger",   icon: Briefcase,     label: "Project Status Changed", description: "Fires when a project changes stage",                defaultSubtitle: "Any stage change",             defaultConfig: { from_stage: "any", to_stage: "any" } },
  { type: "invoice_created",        category: "trigger",   icon: Receipt,       label: "Invoice Created",        description: "Fires when an invoice is issued",                   defaultSubtitle: "Any amount",                   defaultConfig: {} },
  { type: "invoice_overdue",        category: "trigger",   icon: AlertCircle,   label: "Invoice Overdue",        description: "Fires when an invoice passes its due date",         defaultSubtitle: "7 days overdue",               defaultConfig: { days_overdue: 7 } },
  { type: "estimate_approved",      category: "trigger",   icon: CheckCircle2,  label: "Estimate Approved",      description: "Fires when a client approves an estimate",          defaultSubtitle: "Any estimate",                 defaultConfig: {} },
  { type: "estimate_sent",          category: "trigger",   icon: FileCheck,     label: "Estimate Sent",          description: "Fires when an estimate is sent to a client",        defaultSubtitle: "Any estimate",                 defaultConfig: {} },
  { type: "form_submitted",         category: "trigger",   icon: FileText,      label: "Form Submitted",         description: "Fires when a lead form is submitted",               defaultSubtitle: "Any form",                     defaultConfig: { form_name: "" } },
  { type: "appointment_scheduled",  category: "trigger",   icon: Calendar,      label: "Appointment Scheduled",  description: "Fires when an appointment is booked",               defaultSubtitle: "Any appointment",              defaultConfig: {} },
  { type: "missed_call",            category: "trigger",   icon: PhoneMissed,   label: "Missed Call",            description: "Fires when an inbound call is unanswered",          defaultSubtitle: "Any caller",                   defaultConfig: {} },
  { type: "contact_created",        category: "trigger",   icon: UserRound,     label: "Contact Created",        description: "Fires when a new contact is added",                 defaultSubtitle: "Any source",                   defaultConfig: { source: "any" } },
  { type: "manual",                 category: "trigger",   icon: Play,          label: "Manual Trigger",         description: "Triggered manually from a contact or lead record",  defaultSubtitle: "On demand",                    defaultConfig: {} },

  // ── Actions ──
  { type: "send_sms",           category: "action",    icon: MessageSquare, label: "Send SMS",            description: "Send a text message to a contact",        defaultSubtitle: "To: contact phone",        defaultConfig: { to: "contact_phone", message: "Hi {contact.first_name}, " } },
  { type: "send_email",         category: "action",    icon: Mail,          label: "Send Email",          description: "Send an email to a contact",              defaultSubtitle: "To: contact email",        defaultConfig: { to: "contact_email", subject: "Following up from {org.name}", body: "Hi {contact.first_name},\n\n" } },
  { type: "create_task",        category: "action",    icon: CheckSquare,   label: "Create Task",         description: "Create a task and assign to a team member",defaultSubtitle: "Assign to owner",         defaultConfig: { title: "Follow up with {contact.first_name}", assignee: "owner", member_id: "", member_name: "", due_in: 1, due_unit: "days", priority: "medium" } },
  { type: "update_status",      category: "action",    icon: ArrowUpRight,  label: "Update Status",       description: "Update the status of a lead or project",  defaultSubtitle: "Change stage/status",      defaultConfig: { entity: "lead", field: "status", value: "" } },
  { type: "assign_member",      category: "action",    icon: UserCheck,     label: "Assign Member",       description: "Assign a team member to the record",      defaultSubtitle: "Round-robin",              defaultConfig: { strategy: "round_robin", member_id: "", member_name: "" } },
  { type: "send_portal_invite", category: "action",    icon: Share2,        label: "Send Portal Invite",  description: "Invite the contact to the client portal",  defaultSubtitle: "To contact email",         defaultConfig: { send_to: "contact_email", custom_email: "", note: "" } },
  { type: "add_note",           category: "action",    icon: StickyNote,    label: "Add Note",            description: "Add an internal note to the record",       defaultSubtitle: "Internal note",            defaultConfig: { target: "lead", content: "" } },

  // ── Conditions ──
  { type: "if_else", category: "condition", icon: GitBranch, label: "If / Else", description: "Branch the flow based on a condition",   defaultSubtitle: "Set condition below",  defaultConfig: { field: "lead.score", operator: "equals", value: "" } },
  { type: "filter",  category: "condition", icon: Filter,    label: "Filter",    description: "Continue only if condition is met",      defaultSubtitle: "Set filter below",     defaultConfig: { field: "lead.status", operator: "equals", value: "" } },

  // ── Utilities ──
  { type: "wait",    category: "utility", icon: Clock,     label: "Wait",        description: "Pause the workflow for a set duration",    defaultSubtitle: "Wait 1 day",           defaultConfig: { amount: 1, unit: "days" } },
  { type: "ai_step", category: "utility", icon: Sparkles,  label: "AI Step",     description: "Run a Claude Haiku prompt on this contact", defaultSubtitle: "Claude Haiku",         defaultConfig: { system_prompt: "You are a helpful assistant for a home renovation contractor.", user_prompt: "", output_variable: "ai_output" } },
  { type: "webhook", category: "utility", icon: Webhook,   label: "Webhook",     description: "POST data to an external URL",             defaultSubtitle: "POST https://…",       defaultConfig: { url: "", method: "POST", headers: [], body: "" } },
];

export const NODE_META_MAP = Object.fromEntries(
  NODE_META.map((m) => [m.type, m]),
) as Record<WfNodeType, WfNodeMeta>;

export const NODES_BY_CATEGORY: Record<WfNodeCategory, WfNodeMeta[]> = {
  trigger:   NODE_META.filter((m) => m.category === "trigger"),
  action:    NODE_META.filter((m) => m.category === "action"),
  condition: NODE_META.filter((m) => m.category === "condition"),
  utility:   NODE_META.filter((m) => m.category === "utility"),
};

// ── Condition field options ────────────────────────────────────────────────

export const CONDITION_FIELDS = [
  { value: "lead.score",           label: "Lead Score" },
  { value: "lead.status",          label: "Lead Status" },
  { value: "lead.source",          label: "Lead Source" },
  { value: "lead.estimated_budget",label: "Estimated Budget" },
  { value: "lead.project_type",    label: "Project Type" },
  { value: "contact.source",       label: "Contact Source" },
  { value: "project.stage",        label: "Project Stage" },
  { value: "project.budget",       label: "Project Budget" },
  { value: "invoice.amount",       label: "Invoice Amount" },
  { value: "invoice.days_overdue", label: "Days Overdue" },
];

export const CONDITION_OPERATORS = [
  { value: "equals",         label: "equals" },
  { value: "not_equals",     label: "does not equal" },
  { value: "contains",       label: "contains" },
  { value: "not_contains",   label: "does not contain" },
  { value: "greater_than",   label: "is greater than" },
  { value: "less_than",      label: "is less than" },
  { value: "is_empty",       label: "is empty" },
  { value: "is_not_empty",   label: "is not empty" },
];

// ── Variable tokens ────────────────────────────────────────────────────────

export const VARIABLE_TOKENS = [
  { token: "{contact.first_name}", label: "First name" },
  { token: "{contact.last_name}",  label: "Last name" },
  { token: "{contact.phone}",      label: "Phone" },
  { token: "{contact.email}",      label: "Email" },
  { token: "{lead.project_type}",  label: "Project type" },
  { token: "{lead.estimated_budget}", label: "Est. budget" },
  { token: "{project.name}",       label: "Project name" },
  { token: "{project.stage}",      label: "Project stage" },
  { token: "{org.name}",           label: "Company name" },
];

// ── Helpers ────────────────────────────────────────────────────────────────

export function makeWfNode(
  type: WfNodeType,
  position: { x: number; y: number },
): WfRfNode {
  const meta = NODE_META_MAP[type];
  return {
    id: `node_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type: "wfNode",
    data: {
      nodeType: type,
      label: meta.label,
      subtitle: meta.defaultSubtitle,
      config: { ...meta.defaultConfig },
      category: meta.category,
    },
    position,
  };
}

export function nodeHasTwoOutputs(type: WfNodeType): boolean {
  return type === "if_else";
}
