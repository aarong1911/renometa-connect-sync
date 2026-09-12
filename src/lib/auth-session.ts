// src/lib/auth-session.ts
//
// Single shared, deduplicated source of truth for the current Supabase
// auth session.
//
// Root cause this exists to fix (prod incident on connect.renometa.com,
// especially /inbox): several independent modules/components each called
// supabase.auth.getSession()/getUser() on their own mount, and one
// (permissions.ts's useCurrentUserRole) also registered its OWN
// onAuthStateChange subscription. Every one of those calls acquires
// supabase-js's single per-tab navigator Lock guarding the persisted
// session (`lock:sb-<project-ref>-auth-token`) — see GoTrueClient's
// `_acquireLock`, used internally by both getSession() and getUser().
// /inbox mounts far more of these at once than any other route (root
// auth guard + role guard + sidebar + org-id resolution used by 3+
// conversation-loading hooks + Inbox's own two mount effects), so the
// lock's internal queue backs up; when a queued request doesn't get the
// lock within GoTrue's own timeout, it logs exactly the errors seen in
// prod ("was not released within 5000ms", "Forcefully acquiring the lock
// to recover") as its built-in orphaned-lock recovery kicks in.
//
// The fix is not to disable or steal locks (GoTrue already does the
// stealing itself, safely, as a last resort) — it's to stop asking the
// same question dozens of times concurrently. This module keeps ONE
// cached session, refreshed by exactly ONE onAuthStateChange
// subscription (registered lazily, once, on first use), and dedupes
// concurrent first-time resolution via a single in-flight promise.
// Every consumer below reads the same cache instead of independently
// hitting the lock.

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

let cachedSession: Session | null | undefined = undefined; // undefined = not yet resolved
let inFlight: Promise<Session | null> | null = null;
let subscribed = false;
const listeners = new Set<() => void>();

function ensureSubscribed() {
  if (subscribed) return;
  subscribed = true;
  supabase.auth.onAuthStateChange((_event, session) => {
    cachedSession = session;
    inFlight = null;
    for (const l of listeners) l();
  });
}

/**
 * Resolves the current session once per cold cache; every concurrent or
 * later caller shares that same result instead of each independently
 * acquiring the auth storage lock. Kept live afterward by the one
 * onAuthStateChange subscription above (sign-in/out/token refresh update
 * the cache automatically — no re-fetch needed).
 */
export async function resolveAuthSession(): Promise<Session | null> {
  ensureSubscribed();
  if (cachedSession !== undefined) return cachedSession;
  if (inFlight) return inFlight;
  inFlight = supabase.auth.getSession().then(({ data: { session } }) => {
    cachedSession = session;
    inFlight = null;
    return session;
  });
  return inFlight;
}

export async function resolveAuthUserId(): Promise<string | null> {
  const session = await resolveAuthSession();
  return session?.user?.id ?? null;
}

/** React hook: live session state. `checked` flips true once the first resolution completes. */
export function useAuthSession(): { session: Session | null; checked: boolean } {
  const [session, setSession] = useState<Session | null | undefined>(cachedSession);

  useEffect(() => {
    ensureSubscribed();
    let cancelled = false;
    if (cachedSession === undefined) {
      resolveAuthSession().then((s) => {
        if (!cancelled) setSession(s);
      });
    }
    const listener = () => setSession(cachedSession);
    listeners.add(listener);
    return () => {
      cancelled = true;
      listeners.delete(listener);
    };
  }, []);

  return { session: session ?? null, checked: session !== undefined };
}

/** React hook: just the current user id, live-updated with the shared session. */
export function useAuthUserId(): string | null {
  const { session } = useAuthSession();
  return session?.user?.id ?? null;
}
