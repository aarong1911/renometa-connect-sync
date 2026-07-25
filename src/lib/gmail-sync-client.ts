// src/lib/gmail-sync-client.ts
//
// Shared client-side helpers for triggering/checking Gmail sync — extracted
// so Settings → Integrations and the Conversations "Sync Gmail" button hit
// netlify/functions/gmail-sync.ts and gmail-connection-status.ts the exact
// same way (same auth pattern, same response shape) instead of each having
// their own copy. Settings → Integrations predates this file and has its
// own working inline copy of the sync call — left untouched there to avoid
// touching already-working code; this is for new callers (Conversations).

import { supabase } from "@/lib/supabase";

export type GmailSyncResult =
  | { ok: true; fetched: number; inserted: number; updated: number; skipped: number }
  | { ok: false; error: string };

export async function triggerGmailSync(): Promise<GmailSyncResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, error: "You must be signed in to sync Gmail" };

  try {
    const res = await fetch("/.netlify/functions/gmail-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({}),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: result.error ?? "Gmail sync failed" };
    }
    return {
      ok: true,
      fetched: result.fetched ?? 0,
      inserted: result.inserted ?? 0,
      updated: result.updated ?? 0,
      skipped: result.skipped ?? 0,
    };
  } catch {
    return { ok: false, error: "Network error — Gmail sync did not complete" };
  }
}

export type GmailConnectionStatus = {
  connected: boolean;
  accountEmail: string | null;
  // Connected account's own Google profile photo, when Google has returned
  // one and it's been captured (see gmail-oauth-callback.ts) — a safe,
  // non-secret URL only. Never fetched for/applied to any other sender.
  accountPictureUrl: string | null;
  hasRefreshToken: boolean;
  tokenExpiresAt: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  syncError: string | null;
};

export async function fetchGmailConnectionStatus(): Promise<GmailConnectionStatus | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;
  try {
    const res = await fetch("/.netlify/functions/gmail-connection-status", {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
