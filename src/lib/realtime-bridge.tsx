// src/lib/realtime-bridge.tsx
//
// ONE central Supabase Realtime -> TanStack Query invalidation layer
// (Platform State Sync Phase S0/S1), mounted exactly once near the app
// root (see __root.tsx). Replaces the previous pattern of each hook
// instance owning its own postgres_changes subscription — most visibly,
// sms-meta-conversations.ts used to open a SEPARATE channel per mounted
// instance (Inbox AND Sidebar each had their own), which is exactly the
// "duplicate subscription, duplicate copy" anti-pattern the platform-wide
// audit flagged as CRITICAL. Now there is exactly one subscription per
// table per org, and every consumer (however many components read the
// affected query) shares the one invalidation.
//
// Scope for S1: only the tables Conversations actually needs —
// sms_meta_messages and conversation_states — plus contacts, added because
// a Contact rename/tag edit needs to be reflected in the conversation
// list's displayed name without a refresh, and this is the least invasive
// way to achieve that without migrating contacts-store.ts itself (see the
// S1 report's "Contact/Lead lookup handling" section for the full
// reasoning; contacts-store.ts's own useContacts() consumers are
// unaffected — this only invalidates the Conversations queries that do
// their own separate contact-name lookup). leads/deals/projects/tasks/
// appointments were explicitly OUT of scope for S1.
//
// S2B adds ONE more: deal_activities INSERT -> Pipeline Pulse. This is the
// only Command Center table added to the bridge at that phase — audited
// against the same "clearly server-mutated, safely org-filterable,
// materially improves freshness" bar as everything else here. At S2B time,
// projects/deals were still useSyncExternalStore singletons (already live
// with zero realtime wiring); both have since been migrated to Query (deals
// in S4A, projects in S4B — see below) and now DO have subscriptions.
// invoices/appointments/tasks-for-Recent-Activity remain plain Query-backed
// reads with staleTime + focus-refetch, not bridge subscriptions — none of
// them are being actively written by another live user/session often
// enough during a single dashboard viewing to justify a dedicated channel;
// see the S2B report.
//
// S3 (Contacts + Leads migration) promotes `contacts` from an UPDATE-only
// conversation-name shim to a full INSERT/UPDATE/DELETE subscription, and
// adds `leads` INSERT/UPDATE/DELETE. Both are now TanStack Query-backed
// (contacts-store.ts / leads-store.ts), so a server-side write — a second
// tab, a Meta/Instagram webhook creating a Contact+Lead, a bulk import —
// must invalidate the shared list queries here. Fan-out is scoped:
//   contacts.* -> contacts, conversations.all (name/avatar/tag display),
//                 leads (contact enrichment), dashboard.summary (Recent
//                 Activity avatars)
//   leads.*    -> leads, conversations.all (Inbox Lead badge),
//                 dashboard.summary (New Leads / Recent Activity)
// DELETE events only carry the primary key and, without REPLICA IDENTITY
// FULL, the `org_id=eq` filter may not match them — that's an accepted
// limitation (INSERT/UPDATE coverage + focus-refetch still catch up); no
// migration is taken here to change replica identity.
//
// S4A (Deals / Pipeline migration) adds `deals` INSERT/UPDATE/DELETE. The
// Deals/Pipeline domain is now TanStack Query-backed (deals-store.ts's one
// `queryKeys.deals(orgId)` bundle), so a Deal written from a second tab or
// a server process must invalidate it here. Fan-out:
//   deals.* -> deals, dashboard.summary (Pipeline Value KPI / Live Pipeline
//              donut / Needs Attention Deals). Pipeline Pulse is NOT added —
//              it reads deal_activities, whose INSERT already invalidates
//              dashboard.pipelinePulse above.
// `pipelines` / `pipeline_stages` are NOT subscribed: they change only
// through Settings → Pipelines (rare, same-session), which invalidates
// `["deals"]` itself; a cross-tab stage-config edit is caught by
// focus-refetch. The DELETE-filter caveat above applies to `deals` too.
//
// S4B (Projects migration) adds `projects` INSERT/UPDATE/DELETE. Projects
// is now TanStack Query-backed (projects-store.ts's `queryKeys.projects
// (orgId)` list), so a Project written from a second tab or a server
// process must invalidate it here. Fan-out:
//   projects.* -> projects, dashboard.summary (Active Projects KPI /
//                 Recent Activity "Project created" / Needs Attention
//                 Projects rollup — that rollup reads useProjects()
//                 directly for names, so invalidating `projects` alone
//                 already refreshes it; dashboard.summary is included for
//                 Recent Activity/the vs-last-month baseline).
// Same DELETE-filter caveat as contacts/leads/deals above.
//
// S4C (Tasks migration) adds `tasks` INSERT/UPDATE/DELETE. Tasks is now
// TanStack Query-backed (tasks-store.ts's `queryKeys.tasks(orgId)` list),
// so a Task written from a second tab or a server process must invalidate
// it here. Fan-out:
//   tasks.* -> tasks, dashboard.summary. The Command Center's Today's Tasks
//              widget and Needs Attention (atomic overdue tasks + the
//              Projects rollup built from them) all read useTasks()
//              directly, so `["tasks"]` alone refreshes those;
//              dashboard.summary is included because Recent Activity's
//              "Task completed" feed is served by its own sub-query.
// Same DELETE-filter caveat as everything above.
//
// S4D (Calendar / Appointments migration) adds `appointments`
// INSERT/UPDATE/DELETE. Appointments is now TanStack Query-backed
// (appointments-store.ts's `queryKeys.appointments(orgId)` list), so an
// appointment written from a second tab or a server process (voice AI /
// Calendly / Google Calendar sync) must invalidate it here. Fan-out:
//   appointments.* -> appointments, dashboard.summary (Bookings Today
//                     count / Bookings sparkline / Next Booking card —
//                     all served by dashboardSummaryQuery's own
//                     appointment sub-queries, not by useAppointments()).
// Same DELETE-filter caveat as everything above.
//
// S5A (Companies / Accounts migration) adds `companies` INSERT/UPDATE/
// DELETE and `company_contacts` INSERT/UPDATE/DELETE. `useCompanies()` is
// now TanStack Query-backed (companies-store.ts's `queryKeys.companies
// (orgId)` list). Fan-out:
//   companies.*        -> companies, deals (deals-store snapshots
//                         `company.name` onto each deal as `companyName`
//                         at fetch time, so a rename must refetch the
//                         sales bundle; every other account-name surface
//                         reads useCompanies() live). Command Center does
//                         NOT use company data, so dashboard.summary is
//                         deliberately NOT invalidated here.
//   company_contacts.* -> contacts (the Contacts list / Accounts list
//                         contact-count derive the account link from
//                         contacts.company_id, but a company_contacts-only
//                         link — e.g. convert_lead_to_deal — should still
//                         nudge the contact surfaces), companies (any
//                         association-derived count on the Accounts list).
// Same DELETE-filter caveat as everything above (companies/company_contacts
// DELETE events carry only the PK; the org_id filter is omitted on DELETE).
//
// S5B (Account detail synchronization) promotes the account DETAIL route
// (accounts_.$accountSlug.tsx) off its instance-local contact/notes/
// activities `useState` arrays onto three more Query keys (company-
// relations.ts): `companyContacts(orgId, companyId)`, `companyNotes(orgId,
// companyId)`, `companyActivities(orgId, companyId)`. The bridge doesn't
// know which companyId (if any) is open in a given tab, so these three
// invalidate by the (org) PREFIX only — `["companyContacts", orgId]`
// matches every companyId's cached query underneath it via TanStack's
// default prefix matching, so whichever Account detail tab happens to be
// open picks up the change. `company_contacts` already had S5A coverage
// (-> contacts, companies) — this extends that same handler to ALSO cover
// the new prefix rather than adding a second subscription to the same
// table. `company_notes`/`company_activities` are new subscriptions.
// Same DELETE-filter caveat as everything above.
//
// S5C (Files migration) adds `project_files` INSERT/UPDATE/DELETE.
// files-store.ts's useFiles() is now TanStack Query-backed
// (queryKeys.files(orgId)), the single caller across the app (no
// entity-specific file panels exist today), so a file uploaded/renamed/
// moved/deleted from a second tab must invalidate it here. No denormalized
// file count exists on any other row (Contact/Project/Deal/Company/
// dashboard) — confirmed by search — so this fans out to nothing else.
// project-photos.ts (Project detail Photos tab) reads this same table
// through its own separate, non-Query module — out of S5C scope — but a
// photo INSERT/UPDATE/DELETE still correctly refreshes the Files page's
// list via this same handler (it's a real project_files row either way).
// Same DELETE-filter caveat as everything above.
//
// Never logs row payloads (message bodies, contact PII) — every handler
// below only ever logs the table name and event type, both safe.

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useOrgId } from "@/lib/org-id";
import { queryKeys } from "@/lib/query-keys";

export function RealtimeBridge(): null {
  const orgId = useOrgId();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!orgId) return;

    const invalidateSms = () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.sms(orgId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.unreadMessages(orgId) });
    };
    const invalidateConversationStates = () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.conversationStates(orgId) });
      // A conversation_states change (archive/star/thread<->contact link)
      // can affect what any of the three conversation sources renders
      // (Gmail's explicit-link matching, in particular) — invalidate the
      // whole conversations.* prefix rather than guessing which one.
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all(orgId) });
    };
    const invalidateContacts = () => {
      // S3: contacts-store.ts's useContacts() is now Query-backed, so the
      // Contacts list itself must refresh — plus the surfaces that render
      // Contact-derived name/avatar/tags.
      queryClient.invalidateQueries({ queryKey: queryKeys.contacts(orgId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all(orgId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.leads(orgId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.summary(orgId) });
    };
    const invalidateLeads = () => {
      // S3: Leads list + Inbox Lead badge + Command Center New Leads /
      // Recent Activity. A `leads` INSERT from a webhook also inserts a
      // `contacts` row — that fires the contacts handler above separately,
      // so this one doesn't need to touch contacts.
      queryClient.invalidateQueries({ queryKey: queryKeys.leads(orgId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all(orgId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.summary(orgId) });
    };
    const invalidateDeals = () => {
      // S4A: Deals/Pipeline is Query-backed (deals-store.ts). Refresh the
      // shared sales bundle + the Command Center's deal-derived numbers.
      queryClient.invalidateQueries({ queryKey: queryKeys.deals(orgId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.summary(orgId) });
    };
    const invalidateProjects = () => {
      // S4B: Projects is Query-backed (projects-store.ts). Refresh the
      // shared list + the Command Center numbers derived from it.
      queryClient.invalidateQueries({ queryKey: queryKeys.projects(orgId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.summary(orgId) });
    };
    const invalidateTasks = () => {
      // S4C: Tasks is Query-backed (tasks-store.ts). Refresh the shared
      // list (Tasks page, entity panels, Project task panels, Command
      // Center Today's Tasks + Needs Attention) + Recent Activity's
      // "Task completed" sub-query.
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks(orgId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.summary(orgId) });
    };
    const invalidateAppointments = () => {
      // S4D: Appointments is Query-backed (appointments-store.ts). Refresh
      // the shared list (Calendar views + every entity Appointments panel +
      // the detail sheet) + the Command Center's Bookings Today / Bookings
      // sparkline / Next Booking sub-queries.
      queryClient.invalidateQueries({ queryKey: queryKeys.appointments(orgId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.summary(orgId) });
    };
    const invalidateCompanies = () => {
      // S5A: Companies/Accounts is Query-backed (companies-store.ts).
      // Refresh the shared list + the sales bundle that snapshots the
      // account name onto each deal. NOT dashboard — Command Center has no
      // company/account data.
      queryClient.invalidateQueries({ queryKey: queryKeys.companies(orgId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.deals(orgId) });
    };
    const invalidateCompanyContacts = () => {
      // S5A: a Contact<->Account association change. The Query-backed
      // surfaces resolve the account link from contacts.company_id, but a
      // company_contacts-only write (convert_lead_to_deal, "link existing
      // contact") should still nudge the contact + account lists.
      queryClient.invalidateQueries({ queryKey: queryKeys.contacts(orgId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies(orgId) });
      // S5B: also refresh whichever Account detail tab's relationship
      // panel (if any) is showing this association — prefix match, see the
      // header comment above.
      queryClient.invalidateQueries({ queryKey: ["companyContacts", orgId] });
    };
    const invalidateCompanyNotes = () => {
      // S5B: Account detail Notes tab.
      queryClient.invalidateQueries({ queryKey: ["companyNotes", orgId] });
    };
    const invalidateCompanyActivities = () => {
      // S5B: Account detail Activity feed.
      queryClient.invalidateQueries({ queryKey: ["companyActivities", orgId] });
    };
    const invalidateFiles = () => {
      // S5C: Files is Query-backed (files-store.ts). No denormalized file
      // count exists anywhere else, so this refreshes only the Files list.
      queryClient.invalidateQueries({ queryKey: queryKeys.files(orgId) });
    };
    const invalidatePipelinePulse = () => {
      // Prefix match (no `period` argument) — invalidates every cached
      // period variant (7d/14d/30d/90d/year) in one call via TanStack's
      // default prefix matching, so switching timelines after a deal event
      // never shows stale data for whichever period wasn't currently
      // selected when the event arrived.
      queryClient.invalidateQueries({ queryKey: ["dashboard", orgId, "pipelinePulse"] });
    };

    // ONE channel for this org, covering every table this bridge watches —
    // not one channel per table, and never one per component.
    const channel = supabase
      .channel(`realtime-bridge-${orgId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "sms_meta_messages", filter: `org_id=eq.${orgId}` },
        () => invalidateSms(),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "sms_meta_messages", filter: `org_id=eq.${orgId}` },
        () => invalidateSms(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversation_states", filter: `org_id=eq.${orgId}` },
        () => invalidateConversationStates(),
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "contacts", filter: `org_id=eq.${orgId}` },
        () => invalidateContacts(),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "contacts", filter: `org_id=eq.${orgId}` },
        () => invalidateContacts(),
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "contacts" },
        () => invalidateContacts(),
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "leads", filter: `org_id=eq.${orgId}` },
        () => invalidateLeads(),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "leads", filter: `org_id=eq.${orgId}` },
        () => invalidateLeads(),
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "leads" },
        () => invalidateLeads(),
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "deals", filter: `org_id=eq.${orgId}` },
        () => invalidateDeals(),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "deals", filter: `org_id=eq.${orgId}` },
        () => invalidateDeals(),
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "deals" },
        () => invalidateDeals(),
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "deal_activities", filter: `org_id=eq.${orgId}` },
        () => invalidatePipelinePulse(),
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "projects", filter: `org_id=eq.${orgId}` },
        () => invalidateProjects(),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "projects", filter: `org_id=eq.${orgId}` },
        () => invalidateProjects(),
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "projects" },
        () => invalidateProjects(),
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "tasks", filter: `org_id=eq.${orgId}` },
        () => invalidateTasks(),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "tasks", filter: `org_id=eq.${orgId}` },
        () => invalidateTasks(),
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "tasks" },
        () => invalidateTasks(),
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "appointments", filter: `org_id=eq.${orgId}` },
        () => invalidateAppointments(),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "appointments", filter: `org_id=eq.${orgId}` },
        () => invalidateAppointments(),
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "appointments" },
        () => invalidateAppointments(),
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "companies", filter: `org_id=eq.${orgId}` },
        () => invalidateCompanies(),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "companies", filter: `org_id=eq.${orgId}` },
        () => invalidateCompanies(),
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "companies" },
        () => invalidateCompanies(),
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "company_contacts", filter: `org_id=eq.${orgId}` },
        () => invalidateCompanyContacts(),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "company_contacts", filter: `org_id=eq.${orgId}` },
        () => invalidateCompanyContacts(),
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "company_contacts" },
        () => invalidateCompanyContacts(),
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "company_notes", filter: `org_id=eq.${orgId}` },
        () => invalidateCompanyNotes(),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "company_notes", filter: `org_id=eq.${orgId}` },
        () => invalidateCompanyNotes(),
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "company_notes" },
        () => invalidateCompanyNotes(),
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "company_activities", filter: `org_id=eq.${orgId}` },
        () => invalidateCompanyActivities(),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "company_activities", filter: `org_id=eq.${orgId}` },
        () => invalidateCompanyActivities(),
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "company_activities" },
        () => invalidateCompanyActivities(),
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "project_files", filter: `org_id=eq.${orgId}` },
        () => invalidateFiles(),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "project_files", filter: `org_id=eq.${orgId}` },
        () => invalidateFiles(),
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "project_files" },
        () => invalidateFiles(),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [orgId, queryClient]);

  return null;
}
