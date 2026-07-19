// src/lib/workflow-templates.ts
// Pre-built workflow templates. Each template is a complete nodes + edges graph
// that gets instantiated (with fresh IDs) when a user clicks "Use template".

import type { WfRfNode, WfRfEdge, WfNodeType } from "@/lib/workflow-types";

// ── Template types ────────────────────────────────────────────────────────────

export type TemplateCategory = "lead" | "project" | "financial" | "communication";

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  trigger_type: WfNodeType;
  estimated_time: string;
  steps: number;
  nodes: WfRfNode[];
  edges: WfRfEdge[];
}

// ── Category UI metadata ──────────────────────────────────────────────────────

export const TEMPLATE_CATEGORY_STYLE: Record<TemplateCategory, {
  label: string;
  badge: string;
  dot: string;
}> = {
  lead:          { label: "Lead Nurturing",      dot: "bg-blue-500",    badge: "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-800" },
  project:       { label: "Project Management",  dot: "bg-violet-500",  badge: "bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-800" },
  financial:     { label: "Financial",           dot: "bg-emerald-500", badge: "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-800" },
  communication: { label: "Communication",       dot: "bg-amber-500",   badge: "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800" },
};

// ── Node factory helpers (keeps templates readable) ───────────────────────────

type N = WfRfNode;
type E = WfRfEdge;

function trig(id: string, nodeType: WfNodeType, label: string, subtitle: string, config: Record<string, any>, x = 300, y = 0): N {
  return { id, type: "wfNode", data: { nodeType, label, subtitle, config, category: "trigger" }, position: { x, y } };
}
function act(id: string, nodeType: WfNodeType, label: string, subtitle: string, config: Record<string, any>, x = 300, y = 0): N {
  return { id, type: "wfNode", data: { nodeType, label, subtitle, config, category: "action" }, position: { x, y } };
}
function cond(id: string, nodeType: WfNodeType, label: string, subtitle: string, config: Record<string, any>, x = 300, y = 0): N {
  return { id, type: "wfNode", data: { nodeType, label, subtitle, config, category: "condition" }, position: { x, y } };
}
function util(id: string, nodeType: WfNodeType, label: string, subtitle: string, config: Record<string, any>, x = 300, y = 0): N {
  return { id, type: "wfNode", data: { nodeType, label, subtitle, config, category: "utility" }, position: { x, y } };
}

// Standard linear edges
function edge(id: string, source: string, target: string, sh = "out", th = "in"): E {
  return { id, source, target, sourceHandle: sh, targetHandle: th };
}
function yesEdge(id: string, source: string, target: string): E {
  return { id, source, target, sourceHandle: "yes", targetHandle: "in", label: "Yes" };
}
function noEdge(id: string, source: string, target: string): E {
  return { id, source, target, sourceHandle: "no", targetHandle: "in", label: "No" };
}

// ── 10 Templates ──────────────────────────────────────────────────────────────

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [

  // ── 1. New lead follow-up ─────────────────────────────────────────────────
  {
    id: "tpl_new_lead_followup",
    name: "New Lead Follow-up",
    description: "Instantly welcome new leads with an SMS, then branch on score — high-scoring leads get a detailed email while low-scoring ones get a manual follow-up task.",
    category: "lead",
    trigger_type: "new_lead",
    estimated_time: "5 min setup",
    steps: 6,
    nodes: [
      trig("n1", "new_lead",    "New Lead",              "Any source",                               { source: "any" },                                           300, 0),
      util("n2", "wait",        "Wait 10 minutes",       "10 minutes",                               { amount: 10, unit: "minutes" },                             300, 150),
      act ("n3", "send_sms",    "Send welcome SMS",      "To: contact phone",                        { to: "contact_phone", message: "Hi {contact.first_name}, thanks for reaching out to {org.name}! We'll be in touch shortly." }, 300, 300),
      cond("n4", "if_else",     "Check lead score",      "lead.score > 50",                          { field: "lead.score", operator: "greater_than", value: "50" }, 300, 450),
      act ("n5", "send_email",  "Send detailed email",   "To: contact email",                        { to: "contact_email", subject: "Thanks for your interest in {org.name}", body: "Hi {contact.first_name},\n\nThanks for reaching out! We'd love to learn more about your project.\n\nWe'll follow up within 24 hours to discuss your needs.\n\nBest,\n{org.name}" }, 100, 600),
      act ("n6", "create_task", "Create follow-up task", "Manual follow-up — low score lead",        { title: "Follow up with {contact.first_name} — low-score lead", assignee: "owner", due_in: 1, due_unit: "days", priority: "medium" }, 500, 600),
    ],
    edges: [
      edge("e1",  "n1", "n2"),
      edge("e2",  "n2", "n3"),
      edge("e3",  "n3", "n4"),
      yesEdge("e4", "n4", "n5"),
      noEdge ("e5", "n4", "n6"),
    ],
  },

  // ── 2. Missed call callback ───────────────────────────────────────────────
  {
    id: "tpl_missed_call",
    name: "Missed Call Callback",
    description: "When a call goes unanswered, send a quick SMS within 2 minutes so the caller knows you're on it.",
    category: "communication",
    trigger_type: "missed_call",
    estimated_time: "2 min setup",
    steps: 3,
    nodes: [
      trig("n1", "missed_call", "Missed Call",     "Any caller",   { },                                                                                          300, 0),
      util("n2", "wait",        "Wait 2 minutes",  "2 minutes",    { amount: 2, unit: "minutes" },                                                               300, 150),
      act ("n3", "send_sms",    "Send callback SMS","To: caller",  { to: "contact_phone", message: "Hi {contact.first_name}, we just missed your call. We'll call you back shortly — {org.name}" }, 300, 300),
    ],
    edges: [
      edge("e1", "n1", "n2"),
      edge("e2", "n2", "n3"),
    ],
  },

  // ── 3. Estimate sent follow-up ────────────────────────────────────────────
  {
    id: "tpl_estimate_sent",
    name: "Estimate Sent Follow-up",
    description: "Two days after sending an estimate, check if it's still pending. If so, send an SMS nudge and then a formal email three days later.",
    category: "lead",
    trigger_type: "estimate_sent",
    estimated_time: "5 min setup",
    steps: 6,
    nodes: [
      trig("n1", "estimate_sent", "Estimate Sent",    "Any estimate",                              { },                                                          300, 0),
      util("n2", "wait",          "Wait 2 days",       "2 days",                                    { amount: 2, unit: "days" },                                  300, 150),
      cond("n3", "if_else",       "Still pending?",    "estimate.status equals pending",            { field: "lead.status", operator: "equals", value: "contacted" }, 300, 300),
      act ("n4", "send_sms",      "Nudge SMS",         "Check in on estimate",                      { to: "contact_phone", message: "Hi {contact.first_name}, just checking in on the estimate we sent. Any questions? Happy to walk you through it." }, 300, 450),
      util("n5", "wait",          "Wait 3 more days",  "3 days",                                    { amount: 3, unit: "days" },                                  300, 600),
      act ("n6", "send_email",    "Second follow-up",  "Formal follow-up email",                    { to: "contact_email", subject: "Following up on your estimate from {org.name}", body: "Hi {contact.first_name},\n\nI wanted to follow up on the estimate we sent you. We'd love the opportunity to work on your project.\n\nPlease don't hesitate to reach out with any questions.\n\nBest,\n{org.name}" }, 300, 750),
    ],
    edges: [
      edge("e1",    "n1", "n2"),
      edge("e2",    "n2", "n3"),
      yesEdge("e3", "n3", "n4"),
      edge("e4",    "n4", "n5"),
      edge("e5",    "n5", "n6"),
    ],
  },

  // ── 4. Estimate approved — welcome sequence ───────────────────────────────
  {
    id: "tpl_estimate_approved",
    name: "Estimate Approved — Welcome Sequence",
    description: "When a client approves an estimate, confirm via SMS, schedule a kickoff call, and invite them to the client portal.",
    category: "project",
    trigger_type: "estimate_approved",
    estimated_time: "3 min setup",
    steps: 4,
    nodes: [
      trig("n1", "estimate_approved",   "Estimate Approved",      "Any estimate",                           { },                                                  300, 0),
      act ("n2", "send_sms",            "Send confirmation SMS",   "Project confirmed",                      { to: "contact_phone", message: "Great news, {contact.first_name}! Your project with {org.name} is confirmed. We'll be in touch with next steps shortly." }, 300, 150),
      act ("n3", "create_task",         "Schedule kickoff call",   "Assign to owner",                        { title: "Schedule kickoff call with {contact.first_name}", assignee: "owner", due_in: 1, due_unit: "days", priority: "high" }, 300, 300),
      act ("n4", "send_portal_invite",  "Send portal invite",      "Client portal",                          { },                                                  300, 450),
    ],
    edges: [
      edge("e1", "n1", "n2"),
      edge("e2", "n2", "n3"),
      edge("e3", "n3", "n4"),
    ],
  },

  // ── 5. Invoice overdue reminder ───────────────────────────────────────────
  {
    id: "tpl_invoice_overdue",
    name: "Invoice Overdue Reminder",
    description: "Send a polite SMS when an invoice goes overdue, then escalate to a formal email after 3 days, followed by a call task.",
    category: "financial",
    trigger_type: "invoice_overdue",
    estimated_time: "3 min setup",
    steps: 5,
    nodes: [
      trig("n1", "invoice_overdue", "Invoice Overdue",      "7 days overdue",                  { days_overdue: 7 },                                              300, 0),
      act ("n2", "send_sms",        "Overdue SMS",           "Payment reminder",                { to: "contact_phone", message: "Hi {contact.first_name}, your invoice from {org.name} is past due. Please contact us to arrange payment or discuss options." }, 300, 150),
      util("n3", "wait",            "Wait 3 days",           "3 days",                          { amount: 3, unit: "days" },                                      300, 300),
      act ("n4", "send_email",      "Formal overdue notice", "Escalation email",                { to: "contact_email", subject: "Payment overdue — {org.name}", body: "Dear {contact.first_name},\n\nThis is a formal notice that your invoice is now past due. Please arrange payment at your earliest convenience.\n\nIf you have any questions, please contact us immediately.\n\n{org.name}" }, 300, 450),
      act ("n5", "create_task",     "Call client",           "Escalate to phone call",          { title: "Call {contact.first_name} re: overdue invoice", assignee: "owner", due_in: 0, due_unit: "days", priority: "high" }, 300, 600),
    ],
    edges: [
      edge("e1", "n1", "n2"),
      edge("e2", "n2", "n3"),
      edge("e3", "n3", "n4"),
      edge("e4", "n4", "n5"),
    ],
  },

  // ── 6. Project started notification ──────────────────────────────────────
  {
    id: "tpl_project_started",
    name: "Project Started Notification",
    description: "When a project kicks off, notify the client via SMS and give them portal access so they can track progress in real time.",
    category: "project",
    trigger_type: "project_status_changed",
    estimated_time: "2 min setup",
    steps: 3,
    nodes: [
      trig("n1", "project_status_changed", "Project Started",       "Status → In Progress",   { from_stage: "any", to_stage: "in-progress" },                   300, 0),
      act ("n2", "send_sms",               "Project kick-off SMS",  "Work has started",       { to: "contact_phone", message: "Hi {contact.first_name}, great news — work on your {org.name} project has officially started! You can track progress on your client portal." }, 300, 150),
      act ("n3", "send_portal_invite",     "Send portal invite",    "Client portal access",   { },                                                               300, 300),
    ],
    edges: [
      edge("e1", "n1", "n2"),
      edge("e2", "n2", "n3"),
    ],
  },

  // ── 7. Project completed — review request ────────────────────────────────
  {
    id: "tpl_project_completed",
    name: "Project Completed — Review Request",
    description: "One day after a project wraps, ask for an SMS review. If they haven't responded in 2 days, follow up with a more detailed email request.",
    category: "project",
    trigger_type: "project_status_changed",
    estimated_time: "3 min setup",
    steps: 5,
    nodes: [
      trig("n1", "project_status_changed", "Project Completed",     "Status → Completed",        { from_stage: "any", to_stage: "completed" },                  300, 0),
      util("n2", "wait",                   "Wait 1 day",            "1 days",                    { amount: 1, unit: "days" },                                   300, 150),
      act ("n3", "send_sms",               "Review request SMS",    "Ask for quick review",      { to: "contact_phone", message: "Hi {contact.first_name}, your project is complete! We'd love a quick Google review — it helps us a lot. Thank you, {org.name}" }, 300, 300),
      util("n4", "wait",                   "Wait 2 more days",      "2 days",                    { amount: 2, unit: "days" },                                   300, 450),
      act ("n5", "send_email",             "Review request email",  "Detailed review ask",       { to: "contact_email", subject: "How did we do? — {org.name}", body: "Hi {contact.first_name},\n\nWe hope you're thrilled with the work on your project!\n\nWe'd be incredibly grateful if you could leave us a review. It takes just 2 minutes and helps other homeowners find us.\n\nThank you for choosing {org.name}!" }, 300, 600),
    ],
    edges: [
      edge("e1", "n1", "n2"),
      edge("e2", "n2", "n3"),
      edge("e3", "n3", "n4"),
      edge("e4", "n4", "n5"),
    ],
  },

  // ── 8. New contact welcome ────────────────────────────────────────────────
  {
    id: "tpl_new_contact",
    name: "New Contact Welcome",
    description: "When a contact is created, send a warm welcome email within 5 minutes and create a CRM note task for the team.",
    category: "communication",
    trigger_type: "contact_created",
    estimated_time: "3 min setup",
    steps: 4,
    nodes: [
      trig("n1", "contact_created", "New Contact Created",  "Any source",               { source: "any" },                                                      300, 0),
      util("n2", "wait",            "Wait 5 minutes",       "5 minutes",                { amount: 5, unit: "minutes" },                                         300, 150),
      act ("n3", "send_email",      "Send welcome email",   "Intro email",              { to: "contact_email", subject: "Welcome to {org.name}!", body: "Hi {contact.first_name},\n\nWelcome! We're excited to connect with you.\n\nAt {org.name}, we're here to help with all your home renovation needs. We'll be in touch soon.\n\nBest,\n{org.name}" }, 300, 300),
      act ("n4", "create_task",     "Add CRM notes",        "Note qualification info",  { title: "Add notes for {contact.first_name} — new contact", assignee: "owner", due_in: 1, due_unit: "days", priority: "low" }, 300, 450),
    ],
    edges: [
      edge("e1", "n1", "n2"),
      edge("e2", "n2", "n3"),
      edge("e3", "n3", "n4"),
    ],
  },

  // ── 9. Appointment reminder ───────────────────────────────────────────────
  {
    id: "tpl_appointment_reminder",
    name: "Appointment Reminder",
    description: "Send a confirmation SMS 24 hours before a scheduled appointment, reducing no-shows.",
    category: "communication",
    trigger_type: "appointment_scheduled",
    estimated_time: "2 min setup",
    steps: 3,
    nodes: [
      trig("n1", "appointment_scheduled", "Appointment Scheduled", "Any appointment",     { },                                                                  300, 0),
      util("n2", "wait",                  "Wait until 24hr before","1 days",              { amount: 1, unit: "days" },                                          300, 150),
      act ("n3", "send_sms",              "Send reminder SMS",      "24hr reminder",       { to: "contact_phone", message: "Reminder: you have an appointment with {org.name} tomorrow. Reply CONFIRM to confirm or CANCEL to reschedule. Thanks!" }, 300, 300),
    ],
    edges: [
      edge("e1", "n1", "n2"),
      edge("e2", "n2", "n3"),
    ],
  },

  // ── 10. Lead gone cold re-engagement ─────────────────────────────────────
  {
    id: "tpl_cold_lead_reengagement",
    name: "Cold Lead Re-engagement",
    description: "7 days after a lead goes cold, use AI to generate a personalized re-engagement message, send it via SMS, then create a follow-up task.",
    category: "lead",
    trigger_type: "lead_status_changed",
    estimated_time: "5 min setup",
    steps: 5,
    nodes: [
      trig("n1", "lead_status_changed", "Lead Status: Cold",        "Status → Lost",            { from_status: "any", to_status: "lost" },                     300, 0),
      util("n2", "wait",                "Wait 7 days",               "7 days",                   { amount: 7, unit: "days" },                                   300, 150),
      util("n3", "ai_step",             "Generate re-engagement msg","Claude Haiku",             {
        system_prompt: "You are a friendly home renovation contractor assistant. Write concise, personal re-engagement SMS messages (under 160 chars). No emojis. End with the company name.",
        user_prompt: "Write a re-engagement SMS for a cold lead. Contact: {contact.first_name}, interested in: {lead.project_type}, budget: {lead.estimated_budget}. Company: {org.name}. Keep it friendly and brief.",
        output_variable: "ai_message",
      }, 300, 300),
      act ("n4", "send_sms",            "Send AI-generated SMS",     "Personalized message",     { to: "contact_phone", message: "{ai_message}" },               300, 450),
      act ("n5", "create_task",         "Follow-up task",            "If no response in 3 days", { title: "Follow up with {contact.first_name} — no response to re-engagement", assignee: "owner", due_in: 3, due_unit: "days", priority: "medium" }, 300, 600),
    ],
    edges: [
      edge("e1", "n1", "n2"),
      edge("e2", "n2", "n3"),
      edge("e3", "n3", "n4"),
      edge("e4", "n4", "n5"),
    ],
  },
];

// ── Instantiation helper ──────────────────────────────────────────────────────
// Generates fresh node/edge IDs so multiple workflows from the same template
// don't share IDs in the database.

export function instantiateTemplate(template: WorkflowTemplate): {
  nodes: WfRfNode[];
  edges: WfRfEdge[];
} {
  let seq = 0;
  const fresh = () => `n_${Date.now()}_${++seq}_${Math.random().toString(36).slice(2, 5)}`;

  const idMap = new Map<string, string>();
  for (const node of template.nodes) idMap.set(node.id, fresh());

  const nodes: WfRfNode[] = template.nodes.map((n) => ({
    ...n,
    id: idMap.get(n.id)!,
  }));

  let edgeSeq = 0;
  const nodes_edges: WfRfEdge[] = template.edges.map((e) => ({
    ...e,
    id: `e_${Date.now()}_${++edgeSeq}`,
    source: idMap.get(e.source)!,
    target: idMap.get(e.target)!,
  }));

  return { nodes, edges: nodes_edges };
}
