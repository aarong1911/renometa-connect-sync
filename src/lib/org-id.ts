// src/lib/org-id.ts
//
// Shared, memoized "current user's organization id" lookup for the
// Gmail/Conversations code paths (gmail-conversations.ts,
// conversation-states.ts, inbox.tsx's contact-panel effect), and — as of
// the /inbox auth-lock-contention fix — for sidebar.tsx and topbar.tsx's
// own org-id resolution too (they previously each had their own
// bespoke, near-identical copy of this same profiles/org_memberships
// lookup). Uses the existing supabase-js client — this is the same
// "organization_id" call that a browser devtools network tab reports as
// a REST request to `/rest/v1/profiles?select=organization_id&id=eq.
// <user-id>`, which is normal, correctly-authorized supabase-js
// behavior, not a bug — grepping the whole repo for a hand-built fetch
// to that path turns up nothing. Memoizing here avoids firing this same
// query redundantly from several hooks mounted at once.
//
// User id resolution now goes through auth-session.ts's shared,
// deduplicated session cache instead of calling supabase.auth.getUser()
// directly — see that file's header for why: /inbox mounts enough
// independent auth-consuming hooks at once that each one calling
// getUser() directly caused visible contention on supabase-js's single
// per-tab auth-storage lock in production.
//
// Deliberately NOT applied to sms-meta-conversations.ts or
// voice-conversations.ts — those channels' own org-id lookups are out of
// scope for this pass and are left exactly as they were.

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { resolveAuthUserId, useAuthUserId } from "@/lib/auth-session";

let cachedOrgId: string | null = null;
let cachedForUserId: string | null = null;
let inFlight: Promise<string | null> | null = null;

export async function getOrgId(): Promise<string | null> {
  const userId = await resolveAuthUserId();
  if (!userId) return null;

  if (cachedOrgId && cachedForUserId === userId) return cachedOrgId;
  if (inFlight && cachedForUserId === userId) return inFlight;

  cachedForUserId = userId;
  inFlight = (async () => {
    const { data: profile } = await supabase
      .from("profiles")
      .select("organization_id")
      .eq("id", userId)
      .maybeSingle();
    let orgId: string | null = profile?.organization_id ?? null;
    if (!orgId) {
      const { data: membership } = await supabase
        .from("org_memberships")
        .select("org_id")
        .eq("member_id", userId)
        .maybeSingle();
      orgId = membership?.org_id ?? null;
    }
    cachedOrgId = orgId;
    inFlight = null;
    return orgId;
  })();

  return inFlight;
}

/**
 * React hook wrapper around getOrgId() — Platform State Sync Phase S0/S1.
 * Used as the enabling condition + query-key input for every Query-backed
 * Conversations hook (sms-meta-conversations.ts/gmail-conversations.ts/
 * voice-conversations.ts), organization.ts (org branding/team roster),
 * deals-store.ts (Pipeline), Dashboard (index.tsx), and the central
 * realtime bridge (realtime-bridge.tsx) — one shared implementation
 * instead of each of those re-deriving org id its own way.
 *
 * Re-resolves whenever the shared auth session's user id changes
 * (useAuthUserId(), from auth-session.ts), rather than only once at
 * mount. Boot-race fix: this hook used to resolve org id via a one-shot
 * effect with an empty dependency array, calling getOrgId() exactly once
 * and never again. getOrgId() -> resolveAuthUserId() ->
 * resolveAuthSession() returns auth-session.ts's cached session
 * IMMEDIATELY once it has been resolved even once (by design, to avoid
 * hitting supabase-js's auth-storage lock repeatedly). On sign-in,
 * signin.tsx calls navigate({ to: "/" }) itself right after
 * signInWithEmail() resolves — BEFORE supabase's own SIGNED_IN
 * onAuthStateChange notification is guaranteed to have reached
 * auth-session.ts's listener and updated its cache. Every component that
 * freshly mounted because of that navigation (Dashboard, Sidebar/Topbar
 * org branding, Pipeline/deals, Conversations, RealtimeBridge) could call
 * this hook in that narrow window, capture the STILL-STALE pre-login
 * `null` user id, resolve orgId to null, and — because the effect never
 * re-ran — stay stuck at null indefinitely, even after the real session
 * landed a moment later. A full page reload "fixed" it only because that
 * wipes auth-session.ts's module-level cache entirely, forcing a fresh,
 * correct resolution. Depending on the reactive useAuthUserId() (which
 * IS correctly subscribed to auth-session.ts's live updates) instead of
 * an empty dependency array means this hook now re-resolves org id the
 * moment the real session becomes available, with no reload needed.
 */
export function useOrgId(): string | null {
  const userId = useAuthUserId();
  const [orgId, setOrgId] = useState<string | null>(
    userId && cachedForUserId === userId ? cachedOrgId : null,
  );

  useEffect(() => {
    let cancelled = false;
    if (!userId) {
      setOrgId(null);
      return;
    }
    getOrgId().then((id) => {
      if (!cancelled) setOrgId(id);
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return orgId;
}
