// netlify/functions/lib/meta-whatsapp-recovery.ts
//
// LOST-DISPATCH RECOVERY for inbound WhatsApp messages.
//
// The gap this closes: meta-whatsapp-inbound.ts persists the inbound message
// (meta = null) and then fires ONE fire-and-forget request to
// ai-whatsapp-orchestrate-background. That request only logs on failure and the
// webhook still returns 200; Meta's own redelivery is absorbed by the
// (org_id, provider_message_id) unique index, which skips dispatch. So if the
// request never starts a background invocation, the message stays unclaimed
// forever: no AI run, no approval.
//
// The sweep is a SAFETY NET, not a second pipeline. It never calls the AI and
// never touches approvals or claims. It only finds messages the primary path
// dropped and re-sends them through the SAME internal background endpoint
// (same secret, same payload). The existing watermark gates, claim lease and
// idempotency in processWhatsAppBackground() decide whether anything actually
// runs, so overlapping sweeps, duplicate dispatches and races with the normal
// path cannot produce a second AI run or a second pending approval.
//
// RECOVERABLE MESSAGE (all must hold):
//   - sms_meta_messages row, channel 'whatsapp', direction 'in', contact_id set
//   - unclaimed (meta IS NULL) or abandoned (lease expired and not completed);
//     an actively leased or completed message is never selected
//     (same predicate as claimForAiDispatch in meta-whatsapp-claim.ts)
//   - older than RECOVERY_MIN_AGE_MS (still-in-flight normal processing has
//     finished its debounce window by then) and younger than RECOVERY_MAX_AGE_MS
//   - it is the NEWEST message of its conversation (org + contact + whatsapp):
//     no newer inbound (that message owns the burst) and no newer outbound
//     (a human or the AI already answered). Older messages of a burst therefore
//     never get their own AI run.
//   - its contact still belongs to the org
//
// Ages: min 30 s = comfortably above the 4 s default / 10 s max debounce plus
// dispatch start-up. Max 60 min: an AI draft answering a message that old is
// more misleading than helpful, well inside WhatsApp's 24 h reply window; the
// sweep runs every 2 minutes, so a normal orphan is recovered in ~2.5 min worst
// case and the cap only matters if the sweep itself was down for an hour.
//
// TIME BUDGET. This runs as a Netlify Scheduled Function, which has a 30 s
// execution limit. Everything is bounded: one candidate query (<= 200 rows),
// per-conversation checks in small parallel waves, <= 25 re-dispatches in small
// parallel waves, each dispatch capped at RECOVERY_DISPATCH_TIMEOUT_MS, and a
// soft deadline (RECOVERY_DEADLINE_MS) after which no further wave is started.
// Worst case: a wave started just before the deadline still ends within one
// dispatch timeout. Anything skipped, timed out or failed writes nothing, so it
// simply remains recoverable on the next sweep. The sweep never waits for the AI:
// the background endpoint only has to accept the dispatch (HTTP 202).
//
// Logs carry ids and counts only, never message bodies.

import { timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WhatsAppDispatchPayload } from "./meta-whatsapp-inbound";

export const RECOVERY_MIN_AGE_MS = 30_000;
export const RECOVERY_MAX_AGE_MS = 60 * 60 * 1000;
/** Rows scanned per sweep (newest first) and messages re-dispatched per sweep. */
export const RECOVERY_SCAN_LIMIT = 200;
export const RECOVERY_DISPATCH_LIMIT = 25;
/** Parallel per-conversation checks / re-dispatch requests per wave. */
export const RECOVERY_CONCURRENCY = 5;
/** Cap for one re-dispatch request (it only needs to get a 202 back). */
export const RECOVERY_DISPATCH_TIMEOUT_MS = 4_000;
/** No new wave is started after this much elapsed time (Netlify's limit is 30 s). */
export const RECOVERY_DEADLINE_MS = 18_000;

type Row = {
  id: string;
  org_id: string;
  contact_id: string | null;
  body: string | null;
  from_address: string | null;
  provider_message_id: string | null;
  created_at: string;
};

export type RecoverySummary = {
  scanned: number;
  candidates: number;
  dispatched: number;
  dispatchFailed: number;
  skippedNotNewest: number;
  skippedContact: number;
  skippedIncomplete: number;
  /** True when the soft deadline stopped the sweep early (the rest stays recoverable). */
  deadlineHit: boolean;
};

function isLater(a: { created_at: string; id: string }, b: { created_at: string; id: string }): boolean {
  return a.created_at > b.created_at || (a.created_at === b.created_at && a.id > b.id);
}

/** Runs `fn` over `items` in waves of `size`; stops starting waves once `shouldStop()`. Results keep input order. */
async function inWaves<T, R>(items: T[], size: number, shouldStop: () => boolean, fn: (item: T) => Promise<R>): Promise<{ results: R[]; stopped: boolean }> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    if (shouldStop()) return { results, stopped: true };
    results.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return { results, stopped: false };
}

/** Newest message (either direction) of the conversation — the recovery watermark. */
async function newestMessageId(supabase: SupabaseClient, orgId: string, contactId: string): Promise<string | null> {
  const { data } = await supabase
    .from("sms_meta_messages")
    .select("id, created_at")
    .eq("org_id", orgId)
    .eq("contact_id", contactId)
    .eq("channel", "whatsapp")
    .order("created_at", { ascending: false })
    .limit(5);
  let newest: { id: string; created_at: string } | null = null;
  for (const r of (data ?? []) as Array<{ id: string; created_at: string }>) {
    if (!newest || isLater(r, newest)) newest = r;
  }
  return newest?.id ?? null;
}

export type FindOptions = { nowMs?: number; clock?: () => number; startedAt?: number };

export async function findRecoverableWhatsAppInbound(
  supabase: SupabaseClient,
  opts: FindOptions = {},
): Promise<{ candidates: Row[]; summary: RecoverySummary }> {
  const nowMs = opts.nowMs ?? Date.now();
  const clock = opts.clock ?? Date.now;
  const startedAt = opts.startedAt ?? clock();
  const summary: RecoverySummary = { scanned: 0, candidates: 0, dispatched: 0, dispatchFailed: 0, skippedNotNewest: 0, skippedContact: 0, skippedIncomplete: 0, deadlineHit: false };
  const newestAllowed = new Date(nowMs - RECOVERY_MIN_AGE_MS).toISOString();
  const oldestAllowed = new Date(nowMs - RECOVERY_MAX_AGE_MS).toISOString();
  const nowIso = new Date(nowMs).toISOString();
  const overDeadline = () => clock() - startedAt >= RECOVERY_DEADLINE_MS;

  // Bounded, newest first. Index-friendly: a created_at range over a 1-hour
  // window (see the report for the optional partial index).
  const { data, error } = await supabase
    .from("sms_meta_messages")
    .select("id, org_id, contact_id, body, from_address, provider_message_id, created_at")
    .eq("channel", "whatsapp")
    .eq("direction", "in")
    .gte("created_at", oldestAllowed)
    .lte("created_at", newestAllowed)
    .or(`meta.is.null,and(meta->>ai_dispatch_lease_expires_at.lt.${nowIso},meta->>ai_dispatch_completed_at.is.null)`)
    .order("created_at", { ascending: false })
    .limit(RECOVERY_SCAN_LIMIT);
  if (error) {
    console.error("[whatsapp-recovery] candidate query failed:", error.message);
    return { candidates: [], summary };
  }
  const rows = ((data ?? []) as Row[]).filter((r) => !!r.contact_id);
  summary.scanned = rows.length;

  // One candidate per conversation: its newest row. Conversations are then
  // examined oldest first (closest to aging out) until enough candidates exist.
  const perConversation = new Map<string, Row>();
  for (const r of rows) {
    const key = `${r.org_id}|${r.contact_id}`;
    const cur = perConversation.get(key);
    if (!cur || isLater(r, cur)) perConversation.set(key, r);
  }
  const ordered = [...perConversation.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));

  const candidates: Row[] = [];
  for (let i = 0; i < ordered.length && candidates.length < RECOVERY_DISPATCH_LIMIT; i += RECOVERY_CONCURRENCY) {
    if (overDeadline()) {
      summary.deadlineHit = true;
      break;
    }
    const wave = ordered.slice(i, i + RECOVERY_CONCURRENCY);
    const verdicts = await Promise.all(
      wave.map(async (r): Promise<"ok" | "incomplete" | "notNewest" | "contact"> => {
        if (!r.provider_message_id || !r.from_address) return "incomplete";
        if ((await newestMessageId(supabase, r.org_id, r.contact_id!)) !== r.id) return "notNewest";
        const { data: contact } = await supabase.from("contacts").select("id").eq("id", r.contact_id!).eq("org_id", r.org_id).maybeSingle();
        return contact ? "ok" : "contact";
      }),
    );
    wave.forEach((r, k) => {
      const v = verdicts[k];
      if (v === "ok") candidates.push(r);
      else if (v === "incomplete") summary.skippedIncomplete++;
      else if (v === "notNewest") summary.skippedNotNewest++;
      else summary.skippedContact++;
    });
  }
  summary.candidates = Math.min(candidates.length, RECOVERY_DISPATCH_LIMIT);
  return { candidates: candidates.slice(0, RECOVERY_DISPATCH_LIMIT), summary };
}

export type RecoveryDeps = {
  /** Production: dispatchWhatsAppOrchestrationChecked. Tests: an in-process fake. */
  dispatch: (payload: WhatsAppDispatchPayload) => Promise<boolean>;
  /** Age reference for the recoverable window (tests pin it). */
  now?: () => number;
  /** Elapsed-time clock for the soft deadline (tests advance it). */
  clock?: () => number;
  /** Per-dispatch cap enforced here as well as inside the fetch. */
  dispatchTimeoutMs?: number;
};

function withTimeout(p: Promise<boolean>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      () => (clearTimeout(t), resolve(false)),
    );
  });
}

/**
 * One sweep. Safe to run repeatedly and concurrently: it only re-drives the
 * existing background path, which claims each message atomically.
 */
export async function runWhatsAppDispatchRecovery(supabase: SupabaseClient, deps: RecoveryDeps): Promise<RecoverySummary> {
  const clock = deps.clock ?? Date.now;
  const startedAt = clock();
  const timeoutMs = deps.dispatchTimeoutMs ?? RECOVERY_DISPATCH_TIMEOUT_MS;
  const { candidates, summary } = await findRecoverableWhatsAppInbound(supabase, { nowMs: (deps.now ?? Date.now)(), clock, startedAt });
  console.log("[whatsapp-recovery] candidates found:", { scanned: summary.scanned, candidates: summary.candidates });

  const { stopped } = await inWaves(candidates, RECOVERY_CONCURRENCY, () => clock() - startedAt >= RECOVERY_DEADLINE_MS, async (r) => {
    const ok = await withTimeout(
      deps.dispatch({
        orgId: r.org_id,
        contactId: r.contact_id!,
        phone: r.from_address!,
        body: r.body ?? "",
        providerMessageId: r.provider_message_id!,
        inboundMessageId: r.id,
      }),
      timeoutMs,
    );
    if (ok) {
      summary.dispatched++;
      console.log("[whatsapp-recovery] redispatched:", { messageId: r.id, orgId: r.org_id });
    } else {
      summary.dispatchFailed++; // nothing was written: the message stays recoverable
      console.error("[whatsapp-recovery] dispatch failed or timed out (message stays recoverable):", { messageId: r.id, orgId: r.org_id });
    }
    return ok;
  });
  if (stopped) summary.deadlineHit = true;
  console.log("[whatsapp-recovery] sweep summary:", summary);
  return summary;
}

function secretsEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Who may run the sweep handler:
 *   1. a Netlify scheduled invocation — its request body is `{"next_run": "<ISO>"}`.
 *      Functions configured with a `schedule` run only on published deploys and
 *      are not invokable through a production URL, so no other caller can produce
 *      that request in production. The body is checked for the exact shape only
 *      as the contract for "Run now"/scheduled/local invocations, NOT as a
 *      secret: nothing about it is treated as authentication.
 *   2. the internal dispatch secret (X-Internal-Secret), for deliberate manual /
 *      local runs.
 * The User-Agent is never consulted. Everything else is rejected.
 */
export function isAuthorizedSweepRequest(
  headers: Record<string, string | undefined>,
  rawBody: string | null | undefined,
  expectedSecret: string | undefined,
): boolean {
  const h: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  const provided = h["x-internal-secret"];
  if (expectedSecret && provided && secretsEqual(expectedSecret, provided)) return true;
  try {
    const next = JSON.parse(rawBody || "{}")?.next_run;
    return typeof next === "string" && Number.isFinite(Date.parse(next));
  } catch {
    return false;
  }
}
