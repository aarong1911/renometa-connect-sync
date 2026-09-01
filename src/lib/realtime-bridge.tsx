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
// only Command Center table added to the bridge — audited against the same
// "clearly server-mutated, safely org-filterable, materially improves
// freshness" bar as everything else here. projects/deals themselves
// do NOT need a subscription: Active Projects, Pipeline Value,
// and the Live Pipeline donut all read canonical useProjects()/
// useDeals() (useSyncExternalStore singletons that already emit on every
// mutation made through their own store functions), so they're already
// live with zero realtime wiring. invoices/appointments/tasks-for-Recent-
// Activity remain plain Query-backed reads with staleTime + focus-refetch,
// not bridge subscriptions — none of them are being actively written by
// another live user/session often enough during a single dashboard
// viewing to justify a dedicated channel; see the S2B report.
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
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [orgId, queryClient]);

  return null;
}
