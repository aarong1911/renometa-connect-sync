// netlify/functions/lib/ai/context-builder.ts
//
// AI Center — Phase AI-1D. The Context Builder: assembles a small, scoped
// AIResolvedContext from already-trusted server-owned identifiers.
//
//   Untrusted AIChannelEvent -> Auth/Identity Resolution -> AITrustedContext
//     -> [this file] -> AIResolvedContext -> Router/Orchestrator (later)
//
// This file is NOT an authorization layer, an org resolver, a model prompt
// builder, a tool executor, or a conversation router. It assumes org and
// entity identity have already been resolved by trusted code (e.g.
// resolve-org.ts's resolveOrgFromBearerToken, or a webhook's own verified
// tenant mapping) and only retrieves + normalizes CRM context afterward.
//
// SECURITY: buildAIContext() never reads AIChannelEvent.claimedOrganizationId
// or any other unverified value — every parameter it accepts is assumed to
// already be trustworthy by the time it's called. Every query below that
// touches an org-scoped table filters on BOTH the entity's own id AND the
// trusted orgId (`.eq("id", x).eq("org_id", orgId)`), never id alone, so a
// UUID for another organization's record can never be returned even if a
// caller passed one in by mistake.
//
// READ ONLY: every query in this file is a SELECT. No insert/update/
// upsert/delete/RPC, no outbound communication, no workflow trigger.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AIChannel,
  AIConversationMessageSummary,
  AIConversationSummary,
  AIContactSummary,
  AILeadSummary,
  AIOrganizationSummary,
  AIProjectSummary,
  AIResolvedContext,
} from "./types";

/** Channels backed today by sms_meta_messages (per the AI-1 audit: there is
 * no canonical `conversations` table; SMS/WhatsApp/Messenger/Instagram
 * conversations are derived by grouping that table's rows by
 * (contact_id, channel)). Email is structurally separate (its own
 * gmail_messages/email tables); voice lives in voice_calls; web_chat and
 * internal have no table at all yet. This file deliberately does not
 * build channel-specific adapters for any of those — a future adapter
 * supplies their context, not this one. */
const MESSAGE_BACKED_CHANNELS: ReadonlySet<AIChannel> = new Set([
  "sms",
  "whatsapp",
  "messenger",
  "instagram",
]);

/** Hard cap on recent-message context. No existing repo convention for
 * "how many messages is a bounded window" was found to reuse (handlers.ts's
 * getLeadContext caps notes at 5; there's no equivalent precedent for
 * messages), so 10 is chosen per this task's own suggested default —
 * small enough to stay well clear of "full conversation dump." */
const RECENT_MESSAGE_LIMIT = 10;

/**
 * Thrown only for a genuine query/database failure (a Supabase `error`
 * result) — never for an optional entity that simply doesn't exist or
 * doesn't belong to the trusted org. Kept local to this file: nothing else
 * needs to catch this type specifically yet, and it carries no more detail
 * than a sanitized message plus the real error as `cause` (for server-side
 * logging only — see the catch sites below, which log the real error and
 * never put it in the message itself).
 */
export class AIContextBuilderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AIContextBuilderError";
  }
}

export type BuildAIContextParams = {
  /** Server-side (service-role or equivalent) Supabase client — the caller
   * supplies it; this file never constructs one and never reads
   * SUPABASE_SERVICE_ROLE_KEY itself. Same client-typing pattern as
   * src/lib/agentic/types.ts's ActionContext. */
  supabase: SupabaseClient;
  /** Trusted org id — already resolved by the caller (e.g. via
   * resolve-org.ts). Never derived here from anything provider-supplied. */
  orgId: string;
  channel: AIChannel;
  /** Trusted contact id, if the caller has already resolved one. */
  contactId?: string;
  /** Trusted lead id, if the caller has already resolved one. */
  leadId?: string;
  /** Trusted project id, if the caller has already resolved one. */
  projectId?: string;
  /** Opaque conversation grouping key, if the caller has one (see
   * AITrustedContext.conversationKey in ./types.ts). For the
   * message-backed channels this file supports, the real grouping key in
   * the database is (contactId, channel) — sms_meta_messages has no
   * separate conversation-id column — so this value is not used to query
   * anything here; it is only carried through onto
   * AIConversationSummary.externalConversationId as a label for whatever
   * called this function to recognize later. */
  conversationKey?: string;
};

// ── Organization ─────────────────────────────────────────────────────────
//
// Not optional in AIResolvedContext, so unlike contact/lead/project below,
// a missing row here is treated as a genuine failure (a trusted orgId that
// doesn't resolve to a real organization indicates a bug upstream, not an
// absent-but-expected entity) — it throws rather than returning a partial
// context principal callers would otherwise silently accept.
//
// Only id/name/timezone are selected — confirmed live-queried columns
// (see execute-workflow.ts, invite-member.ts). Deliberately excludes
// integration_settings, billing configuration, and every other
// organizations column: this file must never read secrets/credentials.
async function fetchOrganizationSummary(
  supabase: SupabaseClient,
  orgId: string,
): Promise<AIOrganizationSummary> {
  const { data, error } = await supabase
    .from("organizations")
    .select("id, name, timezone")
    .eq("id", orgId)
    .maybeSingle();

  if (error) {
    console.error("[ai/context-builder] fetchOrganizationSummary failed:", error);
    throw new AIContextBuilderError("Could not load organization context.", { cause: error });
  }
  if (!data) {
    throw new AIContextBuilderError("Organization not found for the trusted orgId.");
  }

  return {
    id: data.id,
    name: data.name ?? "Unnamed organization",
    timezone: data.timezone ?? undefined,
  };
}

// ── Contact ──────────────────────────────────────────────────────────────
//
// Columns match handlers.ts's getLeadContext/draftCustomerReply, which
// already query contacts as (id, full_name, email, phone) — reused
// verbatim rather than guessed. Optional: not found (or not in this org)
// returns undefined, never an unscoped fallback query.
async function fetchContactSummary(
  supabase: SupabaseClient,
  orgId: string,
  contactId: string,
): Promise<AIContactSummary | undefined> {
  const { data, error } = await supabase
    .from("contacts")
    .select("id, full_name, email, phone")
    .eq("id", contactId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (error) {
    console.error("[ai/context-builder] fetchContactSummary failed:", error);
    throw new AIContextBuilderError("Could not load contact context.", { cause: error });
  }
  if (!data) return undefined;

  return {
    id: data.id,
    name: data.full_name ?? "Unknown",
    phone: data.phone ?? undefined,
    email: data.email ?? undefined,
  };
}

// ── Lead ─────────────────────────────────────────────────────────────────
//
// Columns match handlers.ts's getLeadContext (id, status, source) plus
// `score`, which is a real column (confirmed via run-agent.ts's own
// `.update({ score, ... })`) — but note it is populated by nothing in the
// current UI (src/routes/leads.tsx documents the UI's hot/warm/cold badge
// as a client-computed value, NOT read from this column, and states the
// real `leads.score` int is "always null today"). It is still selected
// here because it's a real, type-matching column and may be populated by
// a future agent — callers must not treat `undefined`/null score as "cold"
// or any other meaningful signal today.
async function fetchLeadSummary(
  supabase: SupabaseClient,
  orgId: string,
  leadId: string,
): Promise<AILeadSummary | undefined> {
  const { data, error } = await supabase
    .from("leads")
    .select("id, status, source, score")
    .eq("id", leadId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (error) {
    console.error("[ai/context-builder] fetchLeadSummary failed:", error);
    throw new AIContextBuilderError("Could not load lead context.", { cause: error });
  }
  if (!data) return undefined;

  return {
    id: data.id,
    status: data.status ?? "new",
    source: data.source ?? undefined,
    score: data.score ?? undefined,
  };
}

// ── Project ──────────────────────────────────────────────────────────────
//
// Columns match the exact scoped-query pattern already used by
// portal-invite.ts: `.select("id, name, address, status").eq("id",
// projectId).eq("org_id", orgId)` — id/name/status reused here (address
// omitted; AIProjectSummary has no field for it and this task explicitly
// scopes project context to id/name/status only, deferring files/
// financials/tasks).
async function fetchProjectSummary(
  supabase: SupabaseClient,
  orgId: string,
  projectId: string,
): Promise<AIProjectSummary | undefined> {
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, status")
    .eq("id", projectId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (error) {
    console.error("[ai/context-builder] fetchProjectSummary failed:", error);
    throw new AIContextBuilderError("Could not load project context.", { cause: error });
  }
  if (!data) return undefined;

  return {
    id: data.id,
    name: data.name ?? "Untitled project",
    status: data.status ?? "unknown",
  };
}

// ── Conversation ─────────────────────────────────────────────────────────
//
// Deliberately conservative, per this task's scope: only the four
// message-table-backed channels get real context, sourced from
// sms_meta_messages using the exact columns confirmed live-queried by
// src/lib/sms-meta-conversations.ts ("id, contact_id, channel, direction,
// body, from_address, created_at, meta, is_read, provider_message_id") —
// this file selects only (direction, body, created_at), the minimum
// needed for AIConversationMessageSummary, never the raw `meta` jsonb or
// provider_message_id. Every other channel (email/voice/web_chat/
// internal) returns undefined; no channel-specific adapter is built here.
async function fetchConversationSummary(
  supabase: SupabaseClient,
  orgId: string,
  channel: AIChannel,
  contactId: string | undefined,
  conversationKey: string | undefined,
): Promise<AIConversationSummary | undefined> {
  if (!contactId || !MESSAGE_BACKED_CHANNELS.has(channel)) return undefined;

  const { data, error } = await supabase
    .from("sms_meta_messages")
    .select("direction, body, created_at")
    .eq("org_id", orgId)
    .eq("contact_id", contactId)
    .eq("channel", channel)
    .order("created_at", { ascending: false })
    .limit(RECENT_MESSAGE_LIMIT);

  if (error) {
    console.error("[ai/context-builder] fetchConversationSummary failed:", error);
    throw new AIContextBuilderError("Could not load recent conversation messages.", { cause: error });
  }

  // Query is newest-first (so LIMIT keeps the N most recent rows); reverse
  // once in memory so the returned window reads oldest-first, the order an
  // agent should read a conversation in.
  const recentMessages: AIConversationMessageSummary[] = (data ?? [])
    .slice()
    .reverse()
    .map((row) => ({
      direction: row.direction === "out" ? "out" : "in",
      text: row.body ?? "",
      occurredAt: row.created_at,
    }));

  return {
    channel,
    externalConversationId: conversationKey,
    // aiOwned intentionally left undefined — no human-takeover schema
    // exists yet (see types.ts's AIConversationSummary.aiOwned comment).
    recentMessages,
  };
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Assembles a scoped AIResolvedContext from trusted, already-resolved
 * identifiers. Every optional entity (contact/lead/project/conversation)
 * that is either omitted or not found (or not owned by `orgId`) simply
 * comes back as `undefined` — that is the expected, non-error case for an
 * entity this event doesn't concern. A genuine Supabase query failure on
 * ANY of the underlying fetches throws AIContextBuilderError instead of
 * silently degrading to an empty section, per this task's error strategy:
 * a real database error means the returned context cannot be trusted, so
 * the whole call fails rather than returning context that looks complete
 * but silently omitted something real.
 *
 * Independent sections (organization, contact, lead, project,
 * conversation) are fetched in parallel via Promise.all — they don't
 * depend on each other's results, and per the reasoning above, a failure
 * in any one of them is treated as fatal to the whole call anyway, so
 * there is no meaningful "partial success" mode being given up by using
 * Promise.all here.
 */
export async function buildAIContext(params: BuildAIContextParams): Promise<AIResolvedContext> {
  const { supabase, orgId, channel, contactId, leadId, projectId, conversationKey } = params;

  const [organization, contact, lead, project, conversation] = await Promise.all([
    fetchOrganizationSummary(supabase, orgId),
    contactId ? fetchContactSummary(supabase, orgId, contactId) : Promise.resolve(undefined),
    leadId ? fetchLeadSummary(supabase, orgId, leadId) : Promise.resolve(undefined),
    projectId ? fetchProjectSummary(supabase, orgId, projectId) : Promise.resolve(undefined),
    fetchConversationSummary(supabase, orgId, channel, contactId, conversationKey),
  ]);

  return { organization, contact, lead, project, conversation, channel };
}
