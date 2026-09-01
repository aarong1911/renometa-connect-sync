// src/lib/org-id.ts
//
// Shared, memoized "current user's organization id" lookup for the
// Gmail/Conversations code paths (gmail-conversations.ts,
// conversation-states.ts, inbox.tsx's contact-panel effect). Uses the
// existing supabase-js client — this is the same "organization_id" call
// that a browser devtools network tab reports as a REST request to
// `/rest/v1/profiles?select=organization_id&id=eq.<user-id>`, which is
// normal, correctly-authorized supabase-js behavior, not a bug — grepping
// the whole repo for a hand-built fetch to that path turns up nothing.
// Memoizing here just avoids firing this same query redundantly from
// several Gmail-related hooks mounted at once.
//
// Deliberately NOT applied to sms-meta-conversations.ts or
// voice-conversations.ts — those channels' own org-id lookups are out of
// scope for this pass and are left exactly as they were.

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

let cachedOrgId: string | null = null;
let cachedForUserId: string | null = null;
let inFlight: Promise<string | null> | null = null;

export async function getOrgId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  if (cachedOrgId && cachedForUserId === user.id) return cachedOrgId;
  if (inFlight && cachedForUserId === user.id) return inFlight;

  cachedForUserId = user.id;
  inFlight = (async () => {
    const { data: profile } = await supabase
      .from("profiles")
      .select("organization_id")
      .eq("id", user.id)
      .maybeSingle();
    let orgId: string | null = profile?.organization_id ?? null;
    if (!orgId) {
      const { data: membership } = await supabase
        .from("org_memberships")
        .select("org_id")
        .eq("member_id", user.id)
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
 * Resolves once (getOrgId() is already memoized per user above, so a
 * second component mounting this hook does not re-fire the network
 * request), returns null until resolved. Used as the enabling condition +
 * query-key input for every Query-backed Conversations hook
 * (sms-meta-conversations.ts/gmail-conversations.ts/voice-conversations.ts)
 * and by the central realtime bridge (realtime-bridge.tsx) — one shared
 * implementation instead of each of those re-deriving org id its own way.
 */
export function useOrgId(): string | null {
  const [orgId, setOrgId] = useState<string | null>(cachedOrgId);
  useEffect(() => {
    let cancelled = false;
    getOrgId().then((id) => {
      if (!cancelled) setOrgId(id);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return orgId;
}
