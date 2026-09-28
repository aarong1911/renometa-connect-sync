// netlify/functions/lib/gmail-history-sync.ts
//
// Incremental Gmail sync core — the durable-cursor replacement for the
// fixed "newest 10 messages" polling window. Extracted from gmail-sync.ts as
// an injectable, dependency-free-of-network core (same "AI-2E testability
// refactor" pattern already used elsewhere in this repo, e.g.
// lib/meta-whatsapp-background.ts) so it can be unit-tested with a fake Gmail
// API and the in-memory fake Supabase client — no live Gmail/Supabase.
// gmail-sync.ts (the Netlify handler) keeps auth/org-resolution/token-refresh
// and constructs the real GmailApi + calls runGmailMessageSync().
//
// WHY History API, not a bigger `maxResults`: the newest-10 window failed
// because a busy mailbox can receive >10 unrelated messages between syncs,
// pushing a genuine CRM reply out of range even though sync itself was
// working. Gmail's users.history.list gives an authoritative, ordered feed
// of everything that changed since a stored cursor (historyId) — no window
// to outrun, and Gmail (not this app) tracks what's already been seen.
//
// CURSOR: `historyId` is an opaque Gmail value that can exceed safe JS
// integer precision — it is stored/compared as a STRING everywhere, never
// parsed into a JS `number` or BigInt. See parseHistoryId's doc comment.
//
// MODE SELECTION:
//   bootstrap    — no usable stored cursor (first sync ever, OR the stored
//                  cursor belongs to a different Gmail account than the one
//                  currently connected — see cursorIsUsable). Paginates
//                  messages.list (newest first, no `q=` — seebuildGmailListPath's
//                  own history for why `q=` lags), bounded by
//                  BOOTSTRAP_MAX_MESSAGES, then calls users.getProfile to
//                  establish a fresh cursor.
//   incremental  — a usable stored cursor exists. Paginates
//                  users.history.list?startHistoryId=... with
//                  historyTypes=messageAdded (the record type Gmail emits for
//                  both a newly arrived inbound message and a message just
//                  added to Sent — exactly what Conversations needs; message
//                  deletion and label-only changes are NOT processed by this
//                  pass, documented rather than silently pretended). A 404
//                  (Gmail's documented response for an expired/purged
//                  startHistoryId) falls back to a bootstrap in the same call
//                  — never fails forever, never duplicates rows (upserts are
//                  idempotent), never deletes existing messages.
//
// CURSOR ADVANCE SAFETY: the cursor is written ONLY after every discovered
// message has been fetched, extracted and upserted successfully — never
// before, never on a partial failure. The write is an optimistic
// compare-and-set (CAS): conditioned on the row's `gmail_history_id` still
// equalling the value this sync read at the start. If a concurrent sync (a
// second tab, another device, an overlapping manual+auto call) already
// advanced it, this write matches zero rows and is silently skipped — the
// invariant "an older sync can never overwrite a newer cursor with an older
// historyId" holds by construction, without needing a lock/lease, because
// idempotent upserts mean neither sync loses data even if only one cursor
// write "wins".
//
// ACCOUNT SAFETY: gmail_history_id_account_email is stored alongside the
// cursor. It must equal the connection's CURRENT provider_account_email for
// the cursor to be trusted — reconnecting Gmail as a DIFFERENT account can
// never inherit the old account's cursor (see cursorIsUsable). Reconnecting
// the SAME account keeps its existing cursor.

import type { SupabaseClient } from "@supabase/supabase-js";
import { extractGmailBody, type GmailPayloadPart } from "./gmail-mime";
import { reconcileSmtpSentRows } from "./gmail-sent-reconcile";

// ── Bounds (see the module header for the reasoning behind each) ───────────
export const BOOTSTRAP_PAGE_SIZE = 100;
export const BOOTSTRAP_MAX_MESSAGES = 300; // within the suggested 100–500 range
export const BOOTSTRAP_MAX_PAGES = Math.ceil(BOOTSTRAP_MAX_MESSAGES / BOOTSTRAP_PAGE_SIZE) + 1;
export const HISTORY_PAGE_SIZE = 500; // Gmail's max for history.list; cheap event records, not full messages
export const HISTORY_MAX_PAGES = 25; // safety cap against a pathological loop, never expected to be hit in practice
export const DETAIL_FETCH_CONCURRENCY = 8;

// ── Gmail API surface this module needs, injected so tests never touch the network ──

export type GmailMessageDetail = {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPayloadPart;
};

export type GmailListPage = { ids: string[]; nextPageToken?: string };
export type GmailHistoryPage = { messageIds: string[]; nextPageToken?: string; historyId?: string };
export type GmailProfile = { historyId: string; emailAddress: string | null };

/** Thrown by GmailApi.listHistory for Gmail's documented "startHistoryId too old" response (HTTP 404). */
export class GmailHistoryInvalidError extends Error {
  constructor(message = "Gmail history cursor is no longer valid") {
    super(message);
    this.name = "GmailHistoryInvalidError";
  }
}

export type GmailApi = {
  /** messages.list, newest first, no `q=` (see buildGmailListPath). */
  listMessages(pageToken?: string): Promise<GmailListPage>;
  /** users.history.list?startHistoryId=...&historyTypes=messageAdded. Throws GmailHistoryInvalidError on a 404. */
  listHistory(startHistoryId: string, pageToken?: string): Promise<GmailHistoryPage>;
  /** messages.get?format=full. Returns null for a message that can no longer be fetched (best-effort, matches current behavior). */
  getMessage(id: string): Promise<GmailMessageDetail | null>;
  /** users.getProfile — used only to establish a fresh cursor after a bootstrap. */
  getProfile(): Promise<GmailProfile>;
};

// ── URL builders (pure; the real GmailApi implementation in gmail-sync.ts uses these) ──

/**
 * Bootstrap listing path. NO `q=` filter — `q=newer_than:` runs against
 * Gmail's search index, which lags behind brand-new mail (the exact bug this
 * module's sibling fix, buildGmailListPath's original routine-sync fix,
 * addressed) — a plain list reads the mailbox directly. Newest-first by
 * Gmail's own default ordering, paginated via `pageToken`.
 */
export function buildGmailListPath(limit: number, windowDays?: number, pageToken?: string): string {
  const params = new URLSearchParams({ maxResults: String(limit) });
  if (windowDays !== undefined) params.set("q", `newer_than:${windowDays}d`);
  if (pageToken) params.set("pageToken", pageToken);
  return `/messages?${params.toString()}`;
}

export function buildGmailHistoryPath(startHistoryId: string, pageToken?: string): string {
  const params = new URLSearchParams({ startHistoryId, maxResults: String(HISTORY_PAGE_SIZE) });
  params.append("historyTypes", "messageAdded");
  if (pageToken) params.set("pageToken", pageToken);
  return `/history?${params.toString()}`;
}

/** Extracts the deduped messageAdded ids (plus pagination/cursor info) from one raw history.list response. */
export function parseHistoryResponse(json: any): GmailHistoryPage {
  const ids = new Set<string>();
  for (const record of (json?.history ?? []) as any[]) {
    for (const added of record?.messagesAdded ?? []) {
      const id = added?.message?.id;
      if (typeof id === "string" && id) ids.add(id);
    }
  }
  return {
    messageIds: [...ids],
    nextPageToken: typeof json?.nextPageToken === "string" ? json.nextPageToken : undefined,
    // Gmail returns the mailbox's CURRENT historyId on every page (including
    // the last); the caller uses the value from the FINAL page as the new
    // cursor. Always a string — never parsed as a number.
    historyId: typeof json?.historyId === "string" ? json.historyId : undefined,
  };
}

// ── Cursor trust + advancement ──────────────────────────────────────────────

export type StoredCursor = { historyId: string | null; accountEmail: string | null };

/** A stored cursor is trusted only when it belongs to the CURRENTLY connected account (see the module header's "ACCOUNT SAFETY"). */
export function cursorIsUsable(stored: StoredCursor, currentAccountEmail: string | null): stored is { historyId: string; accountEmail: string } {
  return !!stored.historyId && !!currentAccountEmail && stored.accountEmail === currentAccountEmail;
}

/**
 * Optimistic compare-and-set: writes the new cursor only if the row's
 * gmail_history_id still equals `previous` (read at the start of this sync).
 * Returns false (and writes nothing) if a concurrent sync already moved it —
 * the safe outcome, since upserts are idempotent and no data is lost either
 * way. Never regresses a newer cursor to an older one.
 */
export async function advanceHistoryCursor(
  supabase: SupabaseClient,
  integrationId: string,
  previous: string | null,
  next: string,
  accountEmail: string | null,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("integrations")
    .update({ gmail_history_id: next, gmail_history_id_account_email: accountEmail })
    .eq("id", integrationId)
    .filter("gmail_history_id", previous === null ? "is" : "eq", previous)
    .select("id");
  if (error) {
    console.error("[gmail-history-sync] cursor advance failed:", error.message);
    return false;
  }
  return (data ?? []).length > 0;
}

// ── Message processing (shared by both modes) ───────────────────────────────

function headerValue(detail: GmailMessageDetail, name: string): string | null {
  const h = detail.payload?.headers?.find((x: { name: string; value: string }) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}
function splitAddressList(raw: string | null): string[] | null {
  if (!raw) return null;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : null;
}

export type ProcessOutcome = { fetched: number; inserted: number; updated: number; skipped: number; unchanged: number; changed: number };

/**
 * Shared tail end of both sync modes: given a set of candidate Gmail message
 * ids, fetch details ONLY for ones that genuinely need it (new to us, or a
 * legacy row with no body yet — same optimization as the routine-sync fix),
 * extract the body, reconcile outbound SMTP rows, and upsert. Never throws on
 * an individual message fetch failure (matches existing behavior — counted as
 * `skipped`); a genuine upsert failure DOES throw, so the caller never
 * advances the cursor past messages that were not actually saved.
 */
export async function processCandidateMessages(
  supabase: SupabaseClient,
  orgId: string,
  gmail: GmailApi,
  candidateIds: string[],
): Promise<ProcessOutcome> {
  if (candidateIds.length === 0) return { fetched: 0, inserted: 0, updated: 0, skipped: 0, unchanged: 0, changed: 0 };

  const { data: existingRows, error: existingErr } = await supabase
    .from("gmail_messages")
    .select("id, body_text")
    .eq("org_id", orgId)
    .in("id", candidateIds);
  if (existingErr) throw new Error(`Could not check existing messages: ${existingErr.message}`);
  const existingIds = new Set((existingRows ?? []).map((r: any) => r.id));
  const hasBody = new Set((existingRows ?? []).filter((r: any) => typeof r.body_text === "string").map((r: any) => r.id));
  const idsToFetch = candidateIds.filter((id) => !hasBody.has(id));
  const unchanged = candidateIds.length - idsToFetch.length;

  const rows: any[] = [];
  let skipped = 0;
  for (let i = 0; i < idsToFetch.length; i += DETAIL_FETCH_CONCURRENCY) {
    const batch = idsToFetch.slice(i, i + DETAIL_FETCH_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (id) => {
        try {
          return await gmail.getMessage(id);
        } catch {
          return null;
        }
      }),
    );
    for (const detail of results) {
      if (!detail) {
        skipped++;
        continue;
      }
      rows.push({
        id: detail.id,
        org_id: orgId,
        thread_id: detail.threadId,
        internal_date: detail.internalDate ? new Date(Number(detail.internalDate)).toISOString() : null,
        snippet: detail.snippet ?? null,
        body_text: extractGmailBody(detail.payload).text,
        from_email: headerValue(detail, "From"),
        to_emails: splitAddressList(headerValue(detail, "To")),
        cc_emails: splitAddressList(headerValue(detail, "Cc")),
        bcc_emails: splitAddressList(headerValue(detail, "Bcc")),
        subject: headerValue(detail, "Subject"),
        labels: detail.labelIds ?? null,
        rfc_message_id: headerValue(detail, "Message-ID"),
        in_reply_to: headerValue(detail, "In-Reply-To"),
        references_header: headerValue(detail, "References"),
        direction: (detail.labelIds ?? []).includes("SENT") ? "out" : "in",
      });
    }
  }

  if (rows.length > 0) {
    await reconcileSmtpSentRows(supabase, orgId, rows);
    const { error: upsertErr } = await supabase.from("gmail_messages").upsert(rows, { onConflict: "id" });
    if (upsertErr) throw new Error(`Failed to save fetched messages: ${upsertErr.message}`);
  }

  const inserted = rows.filter((r) => !existingIds.has(r.id)).length;
  const updated = rows.filter((r) => existingIds.has(r.id)).length;
  return { fetched: candidateIds.length, inserted, updated, skipped, unchanged, changed: rows.length };
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

export type BootstrapResult = ProcessOutcome & { mode: "bootstrap"; pages: number; cappedAt?: number; newHistoryId: string | null; cursorAdvanced: boolean };

export async function runBootstrap(
  supabase: SupabaseClient,
  orgId: string,
  integrationId: string,
  previousCursor: string | null,
  gmail: GmailApi,
  opts: { maxMessages?: number; maxPages?: number } = {},
): Promise<BootstrapResult> {
  const maxMessages = opts.maxMessages ?? BOOTSTRAP_MAX_MESSAGES;
  const maxPages = opts.maxPages ?? BOOTSTRAP_MAX_PAGES;

  const ids: string[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  let cappedAt: number | undefined;
  do {
    const page = await gmail.listMessages(pageToken);
    pages++;
    for (const id of page.ids) {
      if (ids.length >= maxMessages) {
        cappedAt = maxMessages;
        break;
      }
      ids.push(id);
    }
    pageToken = cappedAt === undefined ? page.nextPageToken : undefined;
  } while (pageToken && pages < maxPages);
  console.log("[gmail-history-sync] bootstrap: pages fetched", { pages, candidateCount: ids.length, cappedAt: cappedAt ?? null });

  const outcome = await processCandidateMessages(supabase, orgId, gmail, ids);

  // Cursor is established only AFTER every candidate message has been
  // successfully processed — see the module header's "CURSOR ADVANCE SAFETY".
  const profile = await gmail.getProfile();
  const cursorAdvanced = await advanceHistoryCursor(supabase, integrationId, previousCursor, profile.historyId, profile.emailAddress);
  console.log("[gmail-history-sync] bootstrap: cursor established", { advanced: cursorAdvanced });

  return { mode: "bootstrap", pages, cappedAt, newHistoryId: profile.historyId, cursorAdvanced, ...outcome };
}

// ── Incremental ──────────────────────────────────────────────────────────────

export type IncrementalResult = ProcessOutcome & { mode: "incremental"; pages: number; newHistoryId: string | null; cursorAdvanced: boolean };

export async function runIncremental(
  supabase: SupabaseClient,
  orgId: string,
  integrationId: string,
  startHistoryId: string,
  accountEmail: string | null,
  gmail: GmailApi,
  opts: { maxPages?: number } = {},
): Promise<IncrementalResult> {
  const maxPages = opts.maxPages ?? HISTORY_MAX_PAGES;
  const idSet = new Set<string>();
  let pageToken: string | undefined;
  let pages = 0;
  let latestHistoryId: string | undefined;
  do {
    const page = await gmail.listHistory(startHistoryId, pageToken);
    pages++;
    for (const id of page.messageIds) idSet.add(id);
    if (page.historyId) latestHistoryId = page.historyId; // last page's value wins — Gmail's current mailbox historyId
    pageToken = page.nextPageToken;
  } while (pageToken && pages < maxPages);
  console.log("[gmail-history-sync] incremental: history pages fetched", { pages, uniqueMessageIds: idSet.size });

  const outcome = await processCandidateMessages(supabase, orgId, gmail, [...idSet]);

  let cursorAdvanced = false;
  const newHistoryId = latestHistoryId ?? null;
  if (newHistoryId && newHistoryId !== startHistoryId) {
    cursorAdvanced = await advanceHistoryCursor(supabase, integrationId, startHistoryId, newHistoryId, accountEmail);
  }
  console.log("[gmail-history-sync] incremental: cursor advance", { from: startHistoryId, to: newHistoryId, advanced: cursorAdvanced });

  return { mode: "incremental", pages, newHistoryId, cursorAdvanced, ...outcome };
}

// ── Orchestration ────────────────────────────────────────────────────────────

export type GmailMessageSyncResult = (BootstrapResult | IncrementalResult) & { recoveredFromInvalidCursor: boolean };

/**
 * Picks bootstrap vs incremental based on cursor usability, runs it, and — if
 * an incremental sync's cursor turns out to be invalid/expired (Gmail's
 * documented 404 for a too-old startHistoryId) — falls back to a bootstrap in
 * the SAME call rather than failing the sync. Never deletes existing
 * `gmail_messages` rows in either path; upserts are idempotent, so recovery
 * can never duplicate a row.
 */
export async function runGmailMessageSync(
  supabase: SupabaseClient,
  orgId: string,
  integrationId: string,
  stored: StoredCursor,
  currentAccountEmail: string | null,
  gmail: GmailApi,
  opts: { maxMessages?: number; maxBootstrapPages?: number; maxHistoryPages?: number } = {},
): Promise<GmailMessageSyncResult> {
  if (cursorIsUsable(stored, currentAccountEmail)) {
    console.log("[gmail-history-sync] mode: incremental", { hasCursor: true });
    try {
      const result = await runIncremental(supabase, orgId, integrationId, stored.historyId, currentAccountEmail, gmail, { maxPages: opts.maxHistoryPages });
      return { ...result, recoveredFromInvalidCursor: false };
    } catch (err) {
      if (!(err instanceof GmailHistoryInvalidError)) throw err;
      console.warn("[gmail-history-sync] stored history cursor is no longer valid — recovering with a bounded bootstrap.");
      const result = await runBootstrap(supabase, orgId, integrationId, stored.historyId, gmail, { maxMessages: opts.maxMessages, maxPages: opts.maxBootstrapPages });
      return { ...result, recoveredFromInvalidCursor: true };
    }
  }
  console.log("[gmail-history-sync] mode: bootstrap", { hasCursor: !!stored.historyId, accountChanged: !!stored.historyId && stored.accountEmail !== currentAccountEmail });
  const result = await runBootstrap(supabase, orgId, integrationId, stored.historyId, gmail, { maxMessages: opts.maxMessages, maxPages: opts.maxBootstrapPages });
  return { ...result, recoveredFromInvalidCursor: false };
}
