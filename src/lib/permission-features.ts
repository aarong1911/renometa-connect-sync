// src/lib/permission-features.ts
//
// Security audit (post-13.3B) — the feature/action permission catalog was
// previously private to src/routes/settings.permissions.tsx, so nothing
// outside that one page could check "does this role/member have edit
// access to feature X" without re-implementing the table. Extracted here,
// unchanged in content, so both the Permissions settings page and
// server-side/Netlify permission checks (change-order-permissions.ts)
// share exactly one definition — never two copies that can drift.
import type { Role } from "./organization";

export type PermissionAction = "view" | "create" | "edit" | "delete";
export const PERMISSION_ACTIONS: PermissionAction[] = ["view", "create", "edit", "delete"];

export type PermissionFeature = { id: string; label: string; description: string };
export type PermissionSection = { label: string; features: PermissionFeature[] };

export const PERMISSION_SECTIONS: PermissionSection[] = [
  { label: "CRM", features: [
    { id: "contacts",      label: "Contacts",      description: "Client & vendor profiles" },
    { id: "companies",     label: "Companies",      description: "Business accounts" },
    { id: "leads",         label: "Leads",          description: "Top-of-funnel pipeline" },
    { id: "pipeline",      label: "Pipeline",       description: "Sales stages" },
  ]},
  { label: "Projects", features: [
    { id: "projects",      label: "Projects",       description: "Jobs & scopes" },
    { id: "tasks",         label: "Tasks",          description: "Checklists & schedules" },
    { id: "calendar",      label: "Calendar",       description: "Scheduling & dispatch" },
    { id: "files",         label: "Files",          description: "Documents & assets" },
    { id: "change_orders", label: "Change Orders",  description: "Scope, price & schedule amendments and customer approvals" },
  ]},
  { label: "Inbox", features: [
    { id: "conversations", label: "Conversations",  description: "Client & team messages" },
    { id: "templates",     label: "Templates",      description: "Message templates" },
    { id: "broadcasts",    label: "Broadcasts",     description: "Bulk messaging" },
  ]},
  { label: "Automation", features: [
    { id: "workflows",     label: "Workflows",      description: "Automated sequences" },
    { id: "ai_center",     label: "AI Center",      description: "AI tools & agents" },
    { id: "triggers",      label: "Triggers",       description: "Event-based actions" },
  ]},
  { label: "Financials", features: [
    { id: "estimates",     label: "Estimates",      description: "Proposals & bids" },
    { id: "invoices",      label: "Invoices",       description: "Billing & collections" },
    { id: "payments",      label: "Payments",       description: "Transactions & receipts" },
  ]},
  { label: "Insights", features: [
    { id: "analytics",     label: "Analytics",      description: "Business reporting" },
    { id: "reputation",    label: "Reputation",     description: "Reviews & ratings" },
  ]},
];

// ── Role action defaults ──────────────────────────────────────────────────────
// Which features each role can access by route, and default actions within them.
// change_orders granted to the same operations/production/financial roles that
// already see Projects/Estimates — never to field_worker/viewer (external,
// redirected before reaching Connect) or estimator/sales (pre-sale only, no
// Project execution access).

export const ROLE_FEATURE_ACCESS: Record<Role, string[]> = {
  owner:          ["*"],
  admin:          ["*"],
  office_manager: ["contacts","companies","leads","pipeline","projects","tasks","calendar","files","change_orders","conversations","templates","broadcasts","estimates","invoices","payments"],
  estimator:      ["contacts","companies","leads","pipeline","conversations","templates","estimates"],
  sales:          ["contacts","companies","leads","pipeline","conversations","templates","broadcasts","estimates"],
  project_manager:["contacts","companies","projects","tasks","calendar","files","change_orders","conversations","templates","estimates"],
  field_worker:   [],
  accountant:     ["contacts","companies","estimates","invoices","payments","analytics","change_orders"],
  viewer:         [],
};

export const ROLE_ACTION_DEFAULTS: Record<Role, Record<PermissionAction, boolean>> = {
  owner:          { view: true,  create: true,  edit: true,  delete: true  },
  admin:          { view: true,  create: true,  edit: true,  delete: true  },
  office_manager: { view: true,  create: true,  edit: true,  delete: false },
  estimator:      { view: true,  create: true,  edit: true,  delete: false },
  sales:          { view: true,  create: true,  edit: true,  delete: false },
  project_manager:{ view: true,  create: true,  edit: true,  delete: false },
  field_worker:   { view: false, create: false, edit: false, delete: false },
  accountant:     { view: true,  create: false, edit: false, delete: false },
  viewer:         { view: false, create: false, edit: false, delete: false },
};

export function getRoleDefaultPermission(role: Role, featureId: string, action: PermissionAction): boolean {
  const access = ROLE_FEATURE_ACCESS[role];
  const hasAccess = access[0] === "*" || access.includes(featureId);
  if (!hasAccess) return false;
  return ROLE_ACTION_DEFAULTS[role][action];
}
