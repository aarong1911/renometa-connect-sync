// netlify/functions/gmail-sync.ts
//
// Manual Gmail synchronization: reads the calling org's real Gmail OAuth
// connection from the `integrations` table (provider = 'gmail'), refreshes
// the access token if needed, fetches recent messages via the Gmail API,
// and upserts them into gmail_messages.
//
// This is READ via the Gmail API OAuth connection — NOT the SMTP_USER/
// SMTP_PASSWORD app-password credentials used for sending in
// send-inbox-message.ts. Those are unrelated and are never touched here.
//
// Token format (verified against live data before writing this file):
// `integrations.access_token_encrypted`/`refresh_token_encrypted` are bytea
// columns. supabase-js returns bytea as a "\x{hex}" string; the hex decodes
// to a UTF-8 base64 string; that base64 decodes to raw
// iv(12) || authTag(16) || ciphertext, AES-256-GCM with
// key = SHA-256(ENCRYPTION_KEY) — the same scheme meta-oauth-callback.ts
// uses for meta_connections.access_token, just wrapped in a bytea/hex shell
// instead of a bare "enc:"-prefixed string.
//
// IMPORTANT — verified before writing this function:
//   - No gmail-oauth-start.ts/gmail-oauth-callback.ts exists anywhere in
//     this repo, so there is no way to (re)establish a Gmail connection
//     with a refresh token from here. That flow, and whatever process
//     originally wrote the live `integrations` rows this function reads,
//     lives outside this codebase.
//   - Several orgs' gmail integrations rows have access_token_encrypted but
//     NO refresh_token_encrypted. Those cannot be renewed once the access
//     token expires — this function detects that case and returns a clear,
//     specific error rather than guessing or fabricating a token.
//   - The org referenced as "current" in CLAUDE.md
//     (d7963ad6-4bfe-4cc2-b9c2-949a02a3fa72) has NO row in `integrations`
//     for any provider — Gmail has never been connected for it. This
//     function will correctly report "not connected" for that org rather
//     than silently doing nothing.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { decryptBytea, encryptToBytea } from "./lib/gmail-token-crypto";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
// RenoMeta Connect is a CRM inbox, not a general Gmail client — normal
// sync/refresh should be lightweight: the last 7 days, max 10 messages.
// Both are provider-side filters (Gmail's own `q=newer_than:7d` search
// operator + `maxResults`), not a client-side fetch-everything-then-filter
// — this avoids pulling months of unrelated mailbox history on every sync.
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const DEFAULT_WINDOW_DAYS = 7;
const DETAIL_FETCH_CONCURRENCY = 8;

// ── Gmail API helpers ────────────────────────────────────────────────────

type GmailListResponse = { messages?: { id: string; threadId: string }[]; resultSizeEstimate?: number };

type GmailMessageDetail = {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: { headers?: { name: string; value: string }[] };
};

function headerValue(detail: GmailMessageDetail, name: string): string | null {
  const h = detail.payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}

function splitAddressList(raw: string | null): string[] | null {
  if (!raw) return null;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : null;
}

async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresAt: string }> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET are not configured on the server");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    // Never log response body here — it can echo back token material.
    throw new Error(`Google token refresh failed (${res.status})`);
  }
  const json: any = await res.json();
  const expiresAt = new Date(Date.now() + (Number(json.expires_in) || 3600) * 1000).toISOString();
  return { accessToken: json.access_token, expiresAt };
}

async function gmailFetch(path: string, accessToken: string): Promise<Response> {
  return fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

// ── Handler ──────────────────────────────────────────────────────────────

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const authToken = event.headers.authorization?.slice(7);
  if (!authToken) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized" }) };
  }
  const { data: { user } } = await supabaseAdmin.auth.getUser(authToken);
  if (!user) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Invalid token" }) };
  }

  // Resolve org — profiles.organization_id first, org_memberships fallback,
  // same precedence used throughout the rest of the app (see e.g.
  // src/lib/*-store.ts's getOrgId()).
  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("organization_id")
    .eq("id", user.id)
    .maybeSingle();
  let orgId: string | null = profile?.organization_id ?? null;
  if (!orgId) {
    const { data: membership } = await supabaseAdmin
      .from("org_memberships")
      .select("org_id")
      .eq("member_id", user.id)
      .maybeSingle();
    orgId = membership?.org_id ?? null;
  }
  if (!orgId) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: "No organization found for this user" }) };
  }

  let reqBody: { limit?: number; windowDays?: number } = {};
  try { reqBody = event.body ? JSON.parse(event.body) : {}; } catch { /* default to {} */ }
  const limit = Math.min(Math.max(1, Number(reqBody.limit) || DEFAULT_LIMIT), MAX_LIMIT);
  // Gmail search-syntax date filter, not a client-side post-filter — keeps
  // "ordinary Conversations loading" from ever pulling months of history in
  // the first place. windowDays is only overridable by a future explicit
  // "Load more history" action; every normal call uses the 7-day default.
  const windowDays = Math.max(1, Number(reqBody.windowDays) || DEFAULT_WINDOW_DAYS);
  const gmailQuery = encodeURIComponent(`newer_than:${windowDays}d`);

  const startedAt = new Date().toISOString();

  const logResult = async (status: "success" | "error", message: string, stats: Record<string, number>) => {
    await supabaseAdmin.from("integration_sync_logs").insert({
      org_id: orgId,
      provider: "gmail",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status,
      message,
      stats,
    });
  };

  // ── Load the org's Gmail connection ───────────────────────────────────
  const { data: integration, error: integrationErr } = await supabaseAdmin
    .from("integrations")
    .select("id, status, access_token_encrypted, refresh_token_encrypted, token_expires_at")
    .eq("org_id", orgId)
    .eq("provider", "gmail")
    .maybeSingle();

  if (integrationErr) {
    console.error("[gmail-sync] failed to load integration row:", integrationErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to load Gmail connection" }) };
  }

  if (!integration || integration.status !== "connected" || !integration.access_token_encrypted) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({
        error: "Gmail is not connected for this organization. Connect Gmail in Settings → Integrations, then try again.",
      }),
    };
  }

  let accessToken: string;
  try {
    accessToken = decryptBytea(integration.access_token_encrypted);
  } catch (error: any) {
    console.error("[gmail-sync] token decrypt failed:", error.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Failed to read the stored Gmail token" }) };
  }

  // Attempt the call with the current token first — token_expires_at on
  // some rows is null/unreliable, so a live 401 is the source of truth for
  // "this token no longer works", not the stored expiry timestamp.
  let listRes = await gmailFetch(`/messages?maxResults=${limit}&q=${gmailQuery}`, accessToken);

  if (listRes.status === 401) {
    if (!integration.refresh_token_encrypted) {
      const msg = "This Gmail connection's access token has expired and there is no refresh token on file, so it cannot be renewed automatically. Reconnect Gmail for this organization to continue syncing.";
      await logResult("error", msg, { fetched: 0, inserted: 0, updated: 0, skipped: 0 });
      await supabaseAdmin.from("integrations").update({ last_sync_at: new Date().toISOString(), last_sync_status: "error", sync_error: msg }).eq("id", integration.id);
      return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: msg }) };
    }

    try {
      const refreshTokenPlain = decryptBytea(integration.refresh_token_encrypted);
      const { accessToken: newToken, expiresAt } = await refreshAccessToken(refreshTokenPlain);
      accessToken = newToken;
      await supabaseAdmin
        .from("integrations")
        .update({ access_token_encrypted: encryptToBytea(newToken), token_expires_at: expiresAt })
        .eq("id", integration.id);
      listRes = await gmailFetch(`/messages?maxResults=${limit}&q=${gmailQuery}`, accessToken);
    } catch (error: any) {
      console.error("[gmail-sync] token refresh failed:", error.message);
      const msg = "Gmail connection has expired and could not be renewed automatically. Reconnect Gmail for this organization to continue syncing.";
      await logResult("error", msg, { fetched: 0, inserted: 0, updated: 0, skipped: 0 });
      await supabaseAdmin.from("integrations").update({ last_sync_at: new Date().toISOString(), last_sync_status: "error", sync_error: msg }).eq("id", integration.id);
      return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: msg }) };
    }
  }

  if (!listRes.ok) {
    const msg = `Gmail API list request failed (${listRes.status})`;
    console.error("[gmail-sync]", msg);
    await logResult("error", msg, { fetched: 0, inserted: 0, updated: 0, skipped: 0 });
    await supabaseAdmin.from("integrations").update({ last_sync_at: new Date().toISOString(), last_sync_status: "error", sync_error: msg }).eq("id", integration.id);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: msg }) };
  }

  const listJson: GmailListResponse = await listRes.json();
  const fetchedIds = (listJson.messages ?? []).map((m) => m.id);

  if (fetchedIds.length === 0) {
    await logResult("success", "No messages returned by Gmail", { fetched: 0, inserted: 0, updated: 0, skipped: 0 });
    await supabaseAdmin.from("integrations").update({ last_sync_at: new Date().toISOString(), last_sync_status: "ok", sync_error: null }).eq("id", integration.id);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, fetched: 0, inserted: 0, updated: 0, skipped: 0 }) };
  }

  // Which of these ids already exist for this org — used to report
  // inserted vs updated counts. Duplicates themselves are prevented by the
  // upsert below (gmail_messages.id, the Gmail message id, is the primary
  // key), independent of this lookup.
  const { data: existingRows } = await supabaseAdmin
    .from("gmail_messages")
    .select("id")
    .eq("org_id", orgId)
    .in("id", fetchedIds);
  const existingIds = new Set((existingRows ?? []).map((r: any) => r.id));

  // Message-ID/In-Reply-To/References are RFC 5322 threading headers — NOT
  // the same thing as Gmail's own thread_id (already captured separately
  // below via detail.threadId). Needed so send-inbox-message.ts can build
  // real inReplyTo/references values for outbound replies.
  const detailHeaders = "&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Bcc&metadataHeaders=Message-ID&metadataHeaders=In-Reply-To&metadataHeaders=References";
  const rows: any[] = [];
  let skipped = 0;

  for (let i = 0; i < fetchedIds.length; i += DETAIL_FETCH_CONCURRENCY) {
    const batch = fetchedIds.slice(i, i + DETAIL_FETCH_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (id) => {
        try {
          const res = await gmailFetch(`/messages/${id}?format=metadata${detailHeaders}`, accessToken);
          if (!res.ok) return null;
          return (await res.json()) as GmailMessageDetail;
        } catch {
          return null;
        }
      }),
    );
    for (const detail of results) {
      if (!detail) { skipped++; continue; }
      rows.push({
        id: detail.id,
        org_id: orgId,
        thread_id: detail.threadId,
        internal_date: detail.internalDate ? new Date(Number(detail.internalDate)).toISOString() : null,
        snippet: detail.snippet ?? null,
        from_email: headerValue(detail, "From"),
        to_emails: splitAddressList(headerValue(detail, "To")),
        cc_emails: splitAddressList(headerValue(detail, "Cc")),
        bcc_emails: splitAddressList(headerValue(detail, "Bcc")),
        subject: headerValue(detail, "Subject"),
        labels: detail.labelIds ?? null,
        // RFC 5322 identity — distinct from `thread_id` (Gmail's own
        // grouping id, already stored above). Direction is derived the same
        // way the client currently does (labels.includes("SENT")), just
        // computed once here server-side so it's a stored, queryable fact
        // instead of being re-derived ad hoc on every read.
        rfc_message_id: headerValue(detail, "Message-ID"),
        in_reply_to: headerValue(detail, "In-Reply-To"),
        references_header: headerValue(detail, "References"),
        direction: (detail.labelIds ?? []).includes("SENT") ? "out" : "in",
      });
    }
  }

  if (rows.length > 0) {
    const { error: upsertErr } = await supabaseAdmin.from("gmail_messages").upsert(rows, { onConflict: "id" });
    if (upsertErr) {
      const msg = `Failed to save fetched messages: ${upsertErr.message}`;
      console.error("[gmail-sync]", msg);
      await logResult("error", msg, { fetched: fetchedIds.length, inserted: 0, updated: 0, skipped: fetchedIds.length });
      await supabaseAdmin.from("integrations").update({ last_sync_at: new Date().toISOString(), last_sync_status: "error", sync_error: msg }).eq("id", integration.id);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: msg }) };
    }
  }

  const inserted = rows.filter((r) => !existingIds.has(r.id)).length;
  const updated = rows.filter((r) => existingIds.has(r.id)).length;

  await supabaseAdmin
    .from("gmail_sync_state")
    .upsert({ org_id: orgId, updated_at: new Date().toISOString() }, { onConflict: "org_id" });

  await supabaseAdmin
    .from("integrations")
    .update({ last_sync_at: new Date().toISOString(), last_sync_status: "ok", sync_error: null })
    .eq("id", integration.id);

  await logResult("success", `Synced ${rows.length} of ${fetchedIds.length} fetched messages`, {
    fetched: fetchedIds.length,
    inserted,
    updated,
    skipped,
  });

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ ok: true, fetched: fetchedIds.length, inserted, updated, skipped }),
  };
};
