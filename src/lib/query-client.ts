// src/lib/query-client.ts
//
// ONE central QueryClient factory (Platform State Sync Phase S0). Previously
// this same construction lived inline in router.tsx — extracted here so
// there is exactly one place that defines it, reused by both the router
// (TanStack Router's own loader context, unrelated to this pass — that
// wiring already existed) and any future non-route code that needs a
// QueryClient reference outside a component (rare — components should use
// useQueryClient() from context instead).
//
// S3 (Contacts + Leads migration): `createQueryClient()` now memoises a
// single instance for the app session, and `getQueryClient()` exposes it to
// module-level code. This is required because contacts-store.ts /
// leads-store.ts keep their existing IMPERATIVE async mutation functions
// (addContact/updateLead/…, called directly from ~25 call sites, not React
// hooks) — after a confirmed DB write they invalidate the relevant query
// keys on this shared client instead of the old module-singleton `emit()`.
// `getRouter()` in router.tsx still calls `createQueryClient()` exactly once
// at bootstrap, so the router context and every `useQueryClient()` consumer
// resolve to the very same instance these module functions invalidate.
//
// Defaults are deliberately conservative, not staleTime: 0 — see the
// platform-wide server-state audit's "stale-time / refetch policy" section.
// A global default can't express the audit's fast/medium/slow tiering
// exactly (that needs per-query overrides at each useQuery call site, e.g.
// Conversations' shorter staleTime in sms-meta-conversations.ts), but a
// moderate default plus focus-refetch is a reasonable baseline for
// everything that doesn't override it.
import { QueryClient } from "@tanstack/react-query";

let singleton: QueryClient | null = null;

export function createQueryClient(): QueryClient {
  if (singleton) return singleton;
  singleton = new QueryClient({
    defaultOptions: {
      queries: {
        // Moderate default (audit's "medium" tier) — individual domains
        // that need fresher data (Conversations) or can tolerate staler
        // data (slow-changing config) override this per-query.
        staleTime: 60_000,
        // Cheap, no-cost way to catch drift from another tab/session
        // without needing realtime on every table — complements, does not
        // replace, the central realtime bridge.
        refetchOnWindowFocus: true,
        // One retry only — this is a CRM inbox, not a resilience-critical
        // system; a real outage should surface as an error state quickly
        // rather than silently retrying for a long time.
        retry: 1,
      },
    },
  });
  return singleton;
}

/**
 * The one shared QueryClient for the app session. For MODULE-LEVEL code
 * only (imperative store mutations that must invalidate queries after a
 * write). Inside React, use `useQueryClient()` from context instead — it
 * resolves to this same instance.
 */
export function getQueryClient(): QueryClient {
  return createQueryClient();
}
