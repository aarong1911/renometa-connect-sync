// Centralized route constants — update paths here when renaming routes.
import { linkOptions } from "@tanstack/react-router";

export const ROUTES = {
  AI_CENTER: "/ai-center",
  CALL_LOGS: "/automation/call-logs",
  WORKFLOWS: "/automation/workflows",
  TRIGGERS: "/automation/triggers",
  LEADS: "/leads",
  PIPELINE: "/pipeline",
  CONTACTS: "/contacts",
  COMPANIES: "/companies",
  PROJECTS: "/projects",
  CALENDAR: "/calendar",
  SETTINGS: "/settings",
} as const;

/** Type-safe search params for the AI Center agent detail view. */
export type AgentSearchParams = { agentId?: string };

/** Type-safe link options for the workflow detail page. */
export const workflowDetailLink = (workflowId: string) =>
  linkOptions({
    to: "/automation/workflows/$workflowId",
    params: { workflowId },
  });

/** Type-safe link options for opening a specific agent's detail drawer. */
export const agentDetailLink = (agentId: string) =>
  linkOptions({
    to: "/ai-center",
    search: { agentId },
  });

/** Type-safe link options for a company's detail page (/accounts/$accountSlug — preserved as-is, see Phase 9.4 report). */
export const accountDetailLink = (accountSlug: string) =>
  linkOptions({
    to: "/accounts/$accountSlug",
    params: { accountSlug },
  });

/** Type-safe link options for opening a specific lead's detail drawer (Phase 10.1 — task "Related to" links). */
export const leadDetailLink = (leadId: string) =>
  linkOptions({
    to: "/leads",
    search: { leadId },
  });

/** Type-safe link options for opening a specific deal's detail drawer (Phase 10.1 — task "Related to" links). */
export const dealDetailLink = (dealId: string) =>
  linkOptions({
    to: "/pipeline",
    search: { dealId },
  });

/** Type-safe link options for opening a specific project's detail drawer (global Tasks page — "View Project Plan" quick action). */
export const projectDetailLink = (projectId: string) =>
  linkOptions({
    to: "/projects",
    search: { projectId },
  });

/**
 * Deep-link into a Project's Schedule & Tasks tab, optionally landing on a
 * specific subview and/or highlighting a specific phase/milestone/task —
 * used by Calendar (Phase 13.2B) so a planning event opens the exact
 * relevant context instead of just the Project's Overview.
 */
export const projectScheduleLink = (
  projectId: string,
  opts?: { subview?: "plan" | "timeline" | "milestones" | "tasks"; taskId?: string; milestoneId?: string; phaseId?: string },
) =>
  linkOptions({
    to: "/projects",
    search: {
      projectId,
      tab: "schedule",
      subview: opts?.subview,
      task: opts?.taskId,
      milestone: opts?.milestoneId,
      phase: opts?.phaseId,
    },
  });