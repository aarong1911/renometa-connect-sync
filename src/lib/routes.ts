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