// src/lib/permissions.ts
import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { useTeam, type Role } from "./organization";

// ── Route definitions (must match sidebar nav `to` values exactly) ────────────

const DASHBOARD   = "/";
const CONTACTS    = "/contacts";
const COMPANIES   = "/companies";
const LEADS       = "/leads";
const PIPELINE    = "/sales/pipeline";
const PROJECTS    = "/projects";
const TASKS       = "/tasks";
const CALENDAR    = "/calendar";
const FILES       = "/files";
const INBOX       = "/inbox";           // includes /inbox/templates
const TEMPLATES   = "/inbox/templates";
const MARKETING   = "/marketing";
const AUTOMATION  = "/automation";
const ESTIMATES   = "/financials/estimates";
const INVOICES    = "/financials/invoices";
const PAYMENTS    = "/financials/payments";
const ANALYTICS   = "/insights/analytics";
const REPUTATION  = "/insights/reputation";

// ── Granular allowed routes per role ─────────────────────────────────────────

export const ROLE_ALLOWED_ROUTES: Record<Role, string[] | "*"> = {

  // All pages including settings
  owner: "*",

  // All functional pages — NO settings
  admin: [
    DASHBOARD, CONTACTS, COMPANIES, LEADS, PIPELINE,
    PROJECTS, TASKS, CALENDAR, FILES,
    INBOX, TEMPLATES, MARKETING,
    AUTOMATION,           // covers /automation/workflows, /agents, /triggers
    ESTIMATES, INVOICES, PAYMENTS,
    ANALYTICS, REPUTATION,
  ],

  // Operations — NO automation, NO insights, NO settings
  office_manager: [
    DASHBOARD, CONTACTS, COMPANIES, LEADS, PIPELINE,
    PROJECTS, TASKS, CALENDAR, FILES,
    INBOX, TEMPLATES, MARKETING,
    ESTIMATES, INVOICES, PAYMENTS,
  ],

  // Pre-sale only — NO projects/tasks/calendar/files, NO invoices/payments, NO automation/insights
  estimator: [
    DASHBOARD, CONTACTS, COMPANIES, LEADS, PIPELINE,
    INBOX, TEMPLATES,
    ESTIMATES,
  ],

  // Sales focus — NO projects execution, NO invoices/payments, NO automation/analytics
  sales: [
    DASHBOARD, CONTACTS, COMPANIES, LEADS, PIPELINE,
    INBOX, TEMPLATES, MARKETING,
    ESTIMATES,
  ],

  // Production only — NO leads/pipeline, NO invoices/payments, NO automation/insights
  project_manager: [
    DASHBOARD, CONTACTS, COMPANIES,
    PROJECTS, TASKS, CALENDAR, FILES,
    INBOX, TEMPLATES,
    ESTIMATES,
  ],

  // 100% external — redirect to field.renometa.com
  field_worker: [],

  // Financial domain only — NO leads/pipeline, NO projects ops, NO inbox, NO automation
  accountant: [
    DASHBOARD, CONTACTS, COMPANIES,
    ESTIMATES, INVOICES, PAYMENTS,
    ANALYTICS,
  ],

  // 100% external — redirect to portal.renometa.com
  viewer: [],
};

// External redirects for roles with no internal access
export const ROLE_EXTERNAL_REDIRECT: Partial<Record<Role, string>> = {
  field_worker: "https://field.renometa.com",
  viewer:       "https://portal.renometa.com",
};

// Default landing page after login
export const ROLE_DEFAULT_ROUTE: Record<Role, string> = {
  owner:          DASHBOARD,
  admin:          DASHBOARD,
  office_manager: DASHBOARD,
  estimator:      LEADS,
  sales:          LEADS,
  project_manager:DASHBOARD,
  field_worker:   DASHBOARD, // redirected externally before reaching this
  accountant:     INVOICES,
  viewer:         DASHBOARD, // redirected externally before reaching this
};

// ── Helpers ───────────────────────────────────────────────────────────────────

export function canAccessRoute(role: Role | null, pathname: string): boolean {
  if (!role) return true; // still loading — don't block
  const allowed = ROLE_ALLOWED_ROUTES[role];
  if (allowed === "*") return true;
  if (allowed.length === 0) return false;
  return allowed.some(prefix =>
    prefix === "/"
      ? pathname === "/"
      : pathname === prefix || pathname.startsWith(prefix + "/")
  );
}

export function filterNavGroups<T extends { items: Array<{ to: string }> }>(
  groups: T[], role: Role | null
): T[] {
  if (!role) return groups;
  const allowed = ROLE_ALLOWED_ROUTES[role];
  if (allowed === "*") return groups;
  return groups
    .map(group => ({
      ...group,
      items: group.items.filter(item => {
        if (allowed.length === 0) return false;
        return allowed.some(prefix =>
          prefix === "/"
            ? item.to === "/"
            : item.to === prefix ||
              item.to.startsWith(prefix + "/") ||
              prefix.startsWith(item.to + "/") ||
              prefix === item.to
        );
      }),
    }))
    .filter(group => group.items.length > 0);
}

// Settings only visible to owner
export function canAccessSettings(role: Role | null): boolean {
  return role === "owner";
}

// ── Hook: current logged-in user's role ───────────────────────────────────────

export function useCurrentUserRole(): Role | null {
  const team = useTeam();
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => setUserId(user?.id ?? null));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      setUserId(session?.user?.id ?? null);
    });
    return () => subscription.unsubscribe();
  }, []);

  if (!userId) return null;
  const member = team.find(m => m.id === userId);
  return member?.role ?? null;
}