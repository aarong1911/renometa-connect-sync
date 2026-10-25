// src/lib/test-console-access.ts
//
// Client side of the internal Test Console gate. The browser only ever learns a boolean from /ai-test-console-access; the
// allowlist itself lives only in the server environment and is never sent here. This is a UI
// convenience — ai-orchestrate.ts independently refuses non-allowlisted callers with a 403.
//
// Fails CLOSED: a network error, a non-OK response or an unexpected body all resolve to "denied".

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export type TestConsoleAccess = "loading" | "allowed" | "denied";

export async function fetchTestConsoleAccess(): Promise<boolean> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return false;
    const res = await fetch("/.netlify/functions/ai-test-console-access", { headers: { Authorization: `Bearer ${session.access_token}` } });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    return body?.allowed === true;
  } catch {
    return false;
  }
}

export function useTestConsoleAccess(): TestConsoleAccess {
  const [access, setAccess] = useState<TestConsoleAccess>("loading");
  useEffect(() => {
    let cancelled = false;
    void fetchTestConsoleAccess().then((ok) => { if (!cancelled) setAccess(ok ? "allowed" : "denied"); });
    return () => { cancelled = true; };
  }, []);
  return access;
}

/** The tab to show for a requested URL tab. "console" is honored only for an allowed user; while access is unresolved a
 * "console" request shows the default tab (never the console, never a flash of it). */
export function resolveRequestedTab<T extends string>(requested: T | undefined, access: TestConsoleAccess, fallback: T): T {
  if (requested === ("console" as T) && access !== "allowed") return fallback;
  return requested ?? fallback;
}
