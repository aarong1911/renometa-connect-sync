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
//
// MESSAGE-ID COLLISIONS (2026-10-31): gmail_messages_org_rfc_message_id_uq
// (20260728) allows one row per (org_id, rfc_message_id), but Gmail does not
// promise one message per Message-ID — the same header can arrive on two
// distinct Gmail messages (a copy delivered twice, to an alias, to Spam, or
// the separate Sent and Inbox copies of mail sent to yourself outside the
// Gmail API). Before this fix such a batch failed its upsert as a whole, the
// cursor (correctly) stayed put, and every later sync re-fetched the same
// batch and failed again — Gmail sync stopped for the org from 2026-10-27.
// See assignRfcOwnership / upsertFetchedRows for the resolution:
//   - Gmail's message id stays the identity; every distinct message is kept.
//   - One row per Message-ID keeps rfc_message_id: the row already stored
//     for the org, else (within the batch) the SENT copy, then the earliest
//     internal_date, then the smallest id. Deterministic, so retries and
//     overlapping syncs agree, and a stored owner never changes.
//   - Every other copy gets rfc_message_id = null and keeps the header in
//     duplicate_rfc_message_id (20261031); before that migration it is saved
//     without it rather than failing.
//   - A concurrent writer claiming the Message-ID between the lookup and the
//     upsert (23505 on that index) is re-resolved and retried, bounded.
//
// SAME GMAIL ACCOUNT IN TWO ORGS (fail closed): gmail_messages.id is the bare
// Gmail message id — the primary key has no org_id — so two orgs syncing one
// mailbox cannot both store a message. An upsert on "id" used to MOVE the
// other org's row into this one. Now a batch containing ids another org holds
// fails with GmailMessageOwnedByAnotherOrgError before any write; new rows
// are inserted with ON CONFLICT (id) DO NOTHING and verified afterwards, so a
// race between the two orgs can't overwrite either. The cursor never moves
// past such a batch, so nothing is silently skipped; the sync stays failed
// (with that message) until one org disconnects. Real support for one mailbox
// in several orgs needs a primary key of (org_id, id) plus matching changes
// to every writer and reader of gmail_messages ids — not done here.

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
export const RFC_RESOLVE_MAX_ATTEMPTS = 3; // upsert attempts when a concurrent writer claims a Message-ID mid-flight
const RFC_LOOKUP_CHUNK = 50; // Message-IDs per `in (...)` filter, keeps the PostgREST URL short

/** Holds the Message-ID header of a copy that cannot keep it in rfc_message_id (migration 20261031). */
export const DUPLICATE_RFC_COLUMN = "duplicate_rfc_message_id";

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

// ── Message-ID collisions (see the module header) ───────────────────────────

/** A gmail_messages row as built from a fetched Gmail message (the fields collision handling reads). */
export type FetchedMessageRow = {
  id: string;
  labels?: string[] | null;
  internal_date?: string | null;
  rfc_message_id?: string | null;
  [column: string]: unknown;
};

const isSentRow = (row: FetchedMessageRow) => Array.isArray(row.labels) && row.labels.includes("SENT");
const internalTime = (row: FetchedMessageRow) => (row.internal_date ? Date.parse(row.internal_date) : Number.POSITIVE_INFINITY);

/** Which of several batch rows sharing a Message-ID keeps it: SENT copy, then earliest internal_date, then smallest id. */
function compareRfcOwnerPreference(a: FetchedMessageRow, b: FetchedMessageRow): number {
  const sent = Number(!isSentRow(a)) - Number(!isSentRow(b));
  if (sent !== 0) return sent;
  const ta = internalTime(a);
  const tb = internalTime(b);
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export type RfcDemotion = { id: string; ownerId: string; ownerStored: boolean };

/**
 * Pure: decides which row keeps each Message-ID. `originalRfc` maps row id ->
 * the header as fetched; `storedOwners` maps Message-ID -> the id of the row
 * already holding it for this org. Demoted rows get rfc_message_id = null and
 * the header in DUPLICATE_RFC_COLUMN; other rows never carry that key (so a
 * batch without collisions doesn't depend on the 20261031 column existing).
 */
export function assignRfcOwnership(
  rows: FetchedMessageRow[],
  originalRfc: Map<string, string | null>,
  storedOwners: Map<string, string>,
): { rows: FetchedMessageRow[]; demoted: RfcDemotion[] } {
  const groups = new Map<string, FetchedMessageRow[]>();
  for (const row of rows) {
    const rfc = originalRfc.get(row.id) ?? null;
    if (!rfc) continue;
    groups.set(rfc, [...(groups.get(rfc) ?? []), row]);
  }
  const ownerOf = new Map<string, string>();
  for (const [rfc, group] of groups) {
    ownerOf.set(rfc, storedOwners.get(rfc) ?? [...group].sort(compareRfcOwnerPreference)[0].id);
  }

  const demoted: RfcDemotion[] = [];
  const resolved = rows.map((row): FetchedMessageRow => {
    const { [DUPLICATE_RFC_COLUMN]: _previous, ...base } = row;
    const rfc = originalRfc.get(row.id) ?? null;
    const ownerId = rfc ? ownerOf.get(rfc) : undefined;
    if (!rfc || ownerId === row.id) return { ...base, rfc_message_id: rfc };
    demoted.push({ id: row.id, ownerId: ownerId!, ownerStored: storedOwners.has(rfc) });
    return { ...base, rfc_message_id: null, [DUPLICATE_RFC_COLUMN]: rfc };
  });
  return { rows: resolved, demoted };
}

async function loadStoredRfcOwners(supabase: SupabaseClient, orgId: string, rfcs: string[]): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  for (let i = 0; i < rfcs.length; i += RFC_LOOKUP_CHUNK) {
    const { data, error } = await supabase
      .from("gmail_messages")
      .select("id, rfc_message_id")
      .eq("org_id", orgId)
      .in("rfc_message_id", rfcs.slice(i, i + RFC_LOOKUP_CHUNK));
    if (error) throw new Error(`Could not check stored Message-IDs: ${error.message}`);
    for (const r of (data ?? []) as Array<{ id: string; rfc_message_id: string }>) owners.set(r.rfc_message_id, r.id);
  }
  return owners;
}

const isRfcUniqueViolation = (error: { code?: string; message?: string }) =>
  error.code === "23505" && /rfc_message_id/i.test(error.message ?? "");
const isMissingDuplicateColumn = (error: { message?: string }) => (error.message ?? "").includes(DUPLICATE_RFC_COLUMN);
const withoutDuplicateColumn = (rows: FetchedMessageRow[]) => rows.map(({ [DUPLICATE_RFC_COLUMN]: _omit, ...rest }) => rest);

async function loadOwnIds(supabase: SupabaseClient, orgId: string, ids: string[]): Promise<Set<string>> {
  const { data, error } = await supabase.from("gmail_messages").select("id").eq("org_id", orgId).in("id", ids);
  if (error) throw new Error(`Could not check existing messages: ${error.message}`);
  return new Set((data ?? []).map((r: { id: string }) => r.id));
}

/**
 * One write of a resolved batch. Rows this org already holds are upserted on
 * their id. Every other row is inserted with ON CONFLICT (id) DO NOTHING, so
 * a Gmail id that another org stored in the meantime is never overwritten
 * (the caller then fails closed). A unique violation on another index (the
 * Message-ID one) still raises, as with a plain upsert.
 */
async function writeResolvedRows(supabase: SupabaseClient, rows: FetchedMessageRow[], ownIds: Set<string>) {
  const fresh = rows.filter((r) => !ownIds.has(r.id));
  const own = rows.filter((r) => ownIds.has(r.id));
  if (fresh.length > 0) {
    const { error } = await supabase.from("gmail_messages").upsert(fresh, { onConflict: "id", ignoreDuplicates: true });
    if (error) return { error };
  }
  if (own.length > 0) {
    const { error } = await supabase.from("gmail_messages").upsert(own, { onConflict: "id" });
    if (error) return { error };
  }
  return { error: null };
}

/**
 * Saves one fetched batch (keyed by Gmail id) without ever violating
 * gmail_messages_org_rfc_message_id_uq or touching another org's row. Throws
 * on any failure it can't resolve, so the caller never advances the cursor
 * past unsaved messages. Every step is idempotent, so a retry after a
 * partial write converges on the same rows.
 */
async function upsertFetchedRows(supabase: SupabaseClient, orgId: string, rows: FetchedMessageRow[]): Promise<RfcDemotion[]> {
  const originalRfc = new Map<string, string | null>(rows.map((r) => [r.id, r.rfc_message_id ?? null]));
  const rfcs = [...new Set([...originalRfc.values()].filter((v): v is string => !!v))];
  const ids = rows.map((r) => r.id);
  let duplicateColumnAvailable = true;

  for (let attempt = 1; ; attempt++) {
    const resolved = assignRfcOwnership(rows, originalRfc, await loadStoredRfcOwners(supabase, orgId, rfcs));
    // Re-read each attempt: reconcileSmtpSentRows or a concurrent sync of this org may have just stored some of them.
    const ownIds = await loadOwnIds(supabase, orgId, ids);
    const payload = duplicateColumnAvailable ? resolved.rows : withoutDuplicateColumn(resolved.rows);
    let { error } = await writeResolvedRows(supabase, payload, ownIds);
    if (error && duplicateColumnAvailable && resolved.demoted.length > 0 && isMissingDuplicateColumn(error)) {
      console.warn(`[gmail-history-sync] ${DUPLICATE_RFC_COLUMN} column not present yet (migration 20261031) — saving duplicate copies without their original Message-ID.`);
      duplicateColumnAvailable = false;
      ({ error } = await writeResolvedRows(supabase, withoutDuplicateColumn(resolved.rows), ownIds));
    }
    if (!error) {
      // An insert skipped by DO NOTHING means another org now holds that id.
      await assertNoForeignOwnership(supabase, orgId, ids.filter((id) => !ownIds.has(id)));
      if (resolved.demoted.length > 0) {
        // Ids and labels only — never addresses, subjects or the header itself.
        const labelsOf = new Map(rows.map((r) => [r.id, r.labels ?? null]));
        console.warn("[gmail-history-sync] Message-ID shared by several Gmail messages; kept on one, cleared on the others", {
          orgId,
          collisions: resolved.demoted.map((d) => ({ ...d, labels: labelsOf.get(d.id), ownerLabels: labelsOf.get(d.ownerId) ?? null })),
        });
      }
      return resolved.demoted;
    }
    if (isRfcUniqueViolation(error) && attempt < RFC_RESOLVE_MAX_ATTEMPTS) {
      console.warn("[gmail-history-sync] Message-ID claimed by a concurrent write; re-resolving the batch", { orgId, attempt });
      continue;
    }
    throw new Error(`Failed to save fetched messages: ${error.message}`);
  }
}

export type ProcessOutcome = {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  unchanged: number;
  changed: number;
  /** Copies stored without rfc_message_id because another Gmail message in the org holds that Message-ID. */
  rfcCollisions: number;
};

/**
 * Thrown when Gmail message ids in this batch are already stored for a
 * DIFFERENT org — the same Gmail account connected to two organizations.
 * gmail_messages.id is the bare Gmail id (no org_id in the primary key), so
 * both orgs cannot hold the same message. The sync fails closed: nothing
 * from the batch is attributed elsewhere, the other org's rows are never
 * touched, and the cursor is not advanced, so no mail is silently skipped.
 * Full support needs an (org_id, id) key — see the module header.
 */
export class GmailMessageOwnedByAnotherOrgError extends Error {
  constructor(readonly count: number) {
    super(
      // Disconnecting the other org does NOT clear this: gmail-disconnect.ts keeps synced messages by design.
      `This Gmail account is also synced by another RenoMeta organization, which already holds ${count} of these messages. ` +
        "One Gmail account can't be synced by two organizations yet, so Gmail sync for this organization is paused — contact RenoMeta support. " +
        "Nothing was saved; the next sync retries from the same point.",
    );
    this.name = "GmailMessageOwnedByAnotherOrgError";
  }
}

async function assertNoForeignOwnership(supabase: SupabaseClient, orgId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { data, error } = await supabase.from("gmail_messages").select("id").neq("org_id", orgId).in("id", ids);
  if (error) throw new Error(`Could not check existing messages: ${error.message}`);
  const count = (data ?? []).length;
  if (count > 0) {
    // Counts only — never the other org's id or any of its message data.
    console.warn("[gmail-history-sync] Gmail ids already stored for another org; failing closed", { orgId, count });
    throw new GmailMessageOwnedByAnotherOrgError(count);
  }
}

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
  candidateIdsIn: string[],
): Promise<ProcessOutcome> {
  // A bootstrap can list one id on two pages when mail arrives mid-pagination;
  // a repeated id would make the upsert touch the same row twice, which Postgres rejects.
  const candidateIds = [...new Set(candidateIdsIn)];
  if (candidateIds.length === 0) return { fetched: 0, inserted: 0, updated: 0, skipped: 0, unchanged: 0, changed: 0, rfcCollisions: 0 };

  // Before any Gmail fetch: a batch containing another org's messages fails
  // as a whole (see GmailMessageOwnedByAnotherOrgError).
  await assertNoForeignOwnership(supabase, orgId, candidateIds);

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

  let rfcCollisions = 0;
  if (rows.length > 0) {
    // Re-key temporary SMTP rows first, so a sent message's own row is the
    // stored owner of its Message-ID when collisions are resolved.
    await reconcileSmtpSentRows(supabase, orgId, rows);
    rfcCollisions = (await upsertFetchedRows(supabase, orgId, rows)).length;
  }

  const inserted = rows.filter((r) => !existingIds.has(r.id)).length;
  const updated = rows.filter((r) => existingIds.has(r.id)).length;
  return { fetched: candidateIds.length, inserted, updated, skipped, unchanged, changed: rows.length, rfcCollisions };
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
