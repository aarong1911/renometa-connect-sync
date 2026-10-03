// netlify/functions/lib/ai/lead-trigger.ts
//
// Live Lead Qualification — Phase AI-3A. The small, explicit trigger layer
// this phase asked for: deterministic, dependency-free (no Supabase, no
// model, no network) rules for
//   (1) whether an inbound message is eligible to dispatch a live AI
//       trigger at all (channel scope + backfill guard),
//   (2) a deterministic idempotency key per trigger so the SAME lead
//       creation or SAME inbound message can never start two runs, and
//   (3) turning already-resolved CRM context (AILeadSummary/AIContactSummary)
//       into a deterministic "known qualification fields" structure, so the
//       agent is TOLD what it already knows rather than asked to infer it
//       from raw conversation text.
//
// Kept pure and side-effect-free on purpose — the actual dispatch (DB
// writes, orchestrateAI call, approval creation) lives in
// lib/lead-qualification-dispatch.ts, which imports this file rather than
// duplicating any of this logic.

import type { AIChannel, AIContactSummary, AILeadSummary } from "./types";

// ── Channel scope ────────────────────────────────────────────────────────
//
// Matches context-builder.ts's own MESSAGE_BACKED_CHANNELS exactly (sourced
// from sms_meta_messages) — deliberately NOT extended to email/voice/
// web_chat/internal for this phase:
//   - email (Gmail) has no send_email handler yet (action-registry.ts's
//     send_email is `isExecutable: false`, metadata only) and its inbound
//     path is a periodic/bootstrap SYNC, not a live event stream — see
//     "backfill guard" below for why that specifically disqualifies it
//     from live-trigger eligibility today, independent of the missing
//     handler.
//   - voice/web_chat/internal have no unified inbound-message trigger
//     point at all yet.
// A future channel only needs adding here (and to context-builder.ts's own
// set, if it isn't already there) — no other file hardcodes this list.
export const LIVE_TRIGGER_CHANNELS: ReadonlySet<AIChannel> = new Set(["sms", "whatsapp", "messenger", "instagram"]);

/**
 * Where a message/lead-creation event actually came from, as the caller
 * (a webhook, a sync job, a manual test) HONESTLY reports it — never
 * inferred from timing alone (a wall-clock "created after trigger startup"
 * watermark is racy across deploys/restarts and says nothing about intent;
 * an explicit source tag from the code path that persisted the row is the
 * only way to make this determination BOTH correct and simple; see the
 * Gmail-bootstrap guard test in this module's own test file for why
 * timing-based guards were rejected).
 *
 *   "live"      — a real-time provider delivery (a webhook, a send
 *                  confirmation) — the normal, expected case.
 *   "backfill"  — a bounded historical catch-up (e.g. Gmail bootstrap /
 *                  incremental-sync recovery, a manual "load history"
 *                  action) — never eligible for a live AI trigger, no
 *                  matter how recent the message's own timestamp is.
 *   undefined   — the caller did not say. Fails CLOSED (treated as NOT
 *                  live-eligible) — an unlabeled source is never assumed
 *                  safe to trigger from, per this phase's "do not
 *                  suddenly run Lead Qualification for historical
 *                  messages" requirement.
 */
export type MessageSyncOrigin = "live" | "backfill" | undefined;

export type InboundTriggerCandidate = {
  channel: AIChannel;
  /** "in" = from the customer, "out" = sent by this business. Only "in" can trigger. */
  direction: "in" | "out";
  /** True when the org/business authored this row itself (e.g. an internal note
   * mis-tagged as a message, or a system-generated row) — never a live trigger. */
  authoredByBusiness?: boolean;
  syncOrigin: MessageSyncOrigin;
};

/**
 * The single gate every inbound-message trigger path must pass before
 * dispatching AI Center. Total and pure: given the same input, always the
 * same answer. Fails closed on every axis — an unsupported channel, an
 * outbound/business row, or an unlabeled/backfill origin all return false;
 * only a real inbound customer message from a live delivery on a supported
 * channel returns true.
 */
export function isLiveTriggerEligible(candidate: InboundTriggerCandidate | undefined | null): boolean {
  if (!candidate) return false;
  if (candidate.direction !== "in") return false;
  if (candidate.authoredByBusiness) return false;
  if (!LIVE_TRIGGER_CHANNELS.has(candidate.channel)) return false;
  if (candidate.syncOrigin !== "live") return false;
  return true;
}

// ── Idempotency ──────────────────────────────────────────────────────────
//
// agent_executions already has a durable `idempotency_key text` column with
// `unique (org_id, idempotency_key)` (20260731_agentic_foundation.sql) — no
// new schema needed. The dispatcher inserts a queued agent_executions row
// with one of these keys BEFORE doing any model/CRM work; a unique-
// violation (23505) means a run for this exact trigger already exists, and
// the caller must treat that as a safe no-op, not an error. This is what
// makes a webhook retry, a duplicate provider event, an overlapping manual
// + auto sync, or two browser tabs all converge on exactly one run — the
// database enforces it, not a frontend "already clicked" flag.

const LEAD_QUALIFICATION_AGENT_KEY = "lead_qualification";

/** One run per lead per org, ever, for the lead_created trigger — a lead is only "created" once. */
export function buildLeadCreatedIdempotencyKey(leadId: string): string {
  return `${LEAD_QUALIFICATION_AGENT_KEY}:lead_created:${leadId}`;
}

/**
 * One run per persisted inbound message row, ever. `messageRowId` must be
 * the row's own durable database id (sms_meta_messages.id, or an
 * equivalent persisted-message primary key) — NEVER a timestamp, and never
 * a provider message id alone (a provider may redeliver the same message
 * under circumstances where this app's own persistence layer already
 * dedupes it to one row; keying off the row id transitively inherits that
 * guarantee instead of re-implementing provider-dedupe logic here).
 */
export function buildInboundMessageIdempotencyKey(messageRowId: string): string {
  return `${LEAD_QUALIFICATION_AGENT_KEY}:inbound_message:${messageRowId}`;
}

/**
 * Manual "Run Lead Qualification" invocations (the Leads page action).
 *
 * AI-3C HARDENING: a time-bucket dedupe window (the previous design) has an
 * unavoidable edge case — a click landing right at a bucket boundary, or a
 * slow retry that lands in the NEXT bucket, either creates a duplicate run
 * or (worse) makes a genuine intentional re-run wait out an arbitrary
 * window. Replaced with explicit invocation semantics instead: the client
 * generates one id per intentional click (`crypto.randomUUID()`) and sends
 * it on every retry of THAT SAME click; a later, separate click generates a
 * NEW id. The idempotency key is then a pure function of
 * (leadId, invocationId) — no clock involved, no boundary to land on.
 *
 * This key must NOT reuse buildLeadCreatedIdempotencyKey (that one is
 * permanent — one lead_created run per lead, ever) and must NOT be a bare
 * `manual:${leadId}` with no invocation component, for the same reason: the
 * first manual click would then permanently block every later one.
 *
 * The org/lead themselves are still always resolved server-side from the
 * caller's bearer token (see lead-qualification-trigger.ts) — the
 * invocation id is ONLY ever used as a client-supplied dedupe token, never
 * as an identity or authorization input.
 */
export function buildManualRunIdempotencyKey(leadId: string, invocationId: string): string {
  return `${LEAD_QUALIFICATION_AGENT_KEY}:manual_run:${leadId}:${invocationId}`;
}

/**
 * A manual invocation id is client-generated, so its SHAPE (never its
 * content-as-identity) is validated before it's trusted as a dedupe key
 * component — bounded length, safe charset only, so it can never be used to
 * smuggle a delimiter or inject something unexpected into the stored
 * idempotency_key string. A real `crypto.randomUUID()` value always
 * matches; this is deliberately a little more permissive than a strict UUID
 * regex so a non-browser caller (a test, a future retry client) isn't
 * forced into that exact format.
 */
const INVOCATION_ID_PATTERN = /^[a-zA-Z0-9_-]{8,100}$/;

export function isValidInvocationId(value: unknown): value is string {
  return typeof value === "string" && INVOCATION_ID_PATTERN.test(value);
}

// ── Known qualification fields ──────────────────────────────────────────
//
// A deterministic, code-computed structure — never left to the model to
// infer from raw conversation text (that was the AI-1J root cause for
// "asks for budget/timeline it was already given": the model only ever
// SAW that information buried in scrollback, never told explicitly "this
// is already known, do not ask again"). Every field here is sourced from a
// real, confirmed-live column (see context-builder.ts's fetchLeadSummary
// doc comments) — this function performs no new DB reads of its own.

export type KnownQualificationFields = {
  firstName?: string;
  projectType?: string;
  budget?: number;
  timeline?: string;
  location?: string;
};

/** First token of a full name, title-cased as stored — never invented, never split beyond the first space. */
function extractFirstName(fullName: string | undefined): string | undefined {
  const trimmed = fullName?.trim();
  if (!trimmed) return undefined;
  const first = trimmed.split(/\s+/)[0];
  return first || undefined;
}

export function resolveKnownQualificationFields(
  lead: AILeadSummary | undefined,
  contact: AIContactSummary | undefined,
): KnownQualificationFields {
  return {
    // Prefer the lead's own stored name snapshot (present even with no
    // linked contact) — see AILeadSummary.name's own doc comment — falling
    // back to the linked contact's name only when the lead has none.
    firstName: extractFirstName(lead?.name) ?? extractFirstName(contact?.name),
    projectType: lead?.projectType,
    budget: lead?.estimatedBudget,
    timeline: lead?.timeline,
    location: lead?.location,
  };
}

/**
 * Renders the known-fields structure as explicit prompt lines the agent
 * receives as FACT, alongside an unambiguous instruction not to re-ask
 * them — used by agents/lead-qualification.ts's prompt builders. Returns
 * an empty array (not a placeholder string) when nothing is known yet, so
 * a caller can decide whether to show a line at all.
 */
export function describeKnownQualificationFields(known: KnownQualificationFields): string[] {
  const lines: string[] = [];
  if (known.firstName) lines.push(`First name: ${known.firstName} (use it naturally; do not ask for it)`);
  if (known.projectType) lines.push(`Project type: ${known.projectType} (already known; do not ask what kind of project this is unless genuinely clarifying scope)`);
  if (known.budget !== undefined) lines.push(`Budget: $${known.budget.toLocaleString("en-US")} (already known; do not ask for budget again)`);
  if (known.timeline) lines.push(`Desired timeline: ${known.timeline} (already known; do not ask when they want to start again)`);
  if (known.location) lines.push(`Location/service area: ${known.location} (already known; do not ask where the project is again)`);
  return lines;
}
