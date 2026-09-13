// netlify/functions/lib/ai/types.ts
//
// AI Center — Phase AI-1C. Shared runtime contracts for the pipeline every
// future component will speak:
//
//   Channel/Event Adapter -> AIChannelEvent -> Context Builder
//     -> AIResolvedContext -> Router -> AIRouteDecision -> Orchestrator
//     -> (ModelProvider | AI Tool Registry | AIAgentHandoff) -> AIRunResult
//
// This file defines TYPES ONLY. It does not implement an adapter, context
// builder, router, or orchestrator, and it never calls a model, executes a
// tool, or queries Supabase.
//
// ── TRUST BOUNDARY (read this before adding a field) ───────────────────
//
// Two families of type live here, and they must never be confused:
//
//   1. UNTRUSTED — AIChannelEvent, AIExternalIdentity, AIEventContent.
//      These describe data that originated outside our server: a webhook
//      payload, a browser test-console submission, a provider's own
//      identity claims. Nothing in this family may be used directly to
//      scope a database query, decide organization membership, or grant
//      any capability. In particular, a payload's own claimed org id is
//      NOT proof of org membership — see AIChannelEvent.claimedOrganizationId
//      below and netlify/functions/lib/resolve-org.ts for the only pattern
//      already proven safe in this repo for turning a request into a real
//      org id (never trust a client/provider-supplied id; always resolve
//      it server-side, e.g. from a verified bearer token or a webhook's
//      own signed/looked-up tenant mapping).
//
//   2. TRUSTED — AITrustedContext. Populated exclusively by trusted server
//      code (a Context Builder / Router / Orchestrator that has already
//      done real org/identity resolution) and never constructed from, or
//      overridable by, model output or adapter/provider input. Nothing in
//      this file, and nothing that consumes AITrustedContext, should ever
//      accept these fields as arguments coming from an AIChannelEvent or
//      from a model's tool-call arguments.
//
// A third rule worth stating plainly: metadata is not authorization.
// AIChannelEvent.metadata and AIResolvedContext are both informational —
// neither is ever a substitute for the trust resolution above.

import type {
  Actor,
  AutonomyLevel,
} from "../../../../src/lib/agentic/types";
import type { AIToolExecutionResult } from "./tools/types";

// ── Channels ─────────────────────────────────────────────────────────────
//
// Provider-neutral vocabulary only — no "twilio_sms" / "vapi_voice" /
// "meta_instagram" values. A channel adapter maps its own provider's
// concept onto one of these; provider-specific detail belongs in
// AIChannelEvent.metadata, never in the channel value itself. This list
// matches (and does not rename) the channel vocabulary the DB layer
// already uses for sms/whatsapp/messenger/instagram (see
// src/lib/sms-meta-conversations.ts, conversation_states.channel), plus
// voice/email/web_chat/internal for the channels that don't yet share
// that table.

export const AI_CHANNELS = [
  "voice",
  "sms",
  "email",
  "web_chat",
  "messenger",
  "instagram",
  "whatsapp",
  "internal",
] as const;

export type AIChannel = (typeof AI_CHANNELS)[number];

// ── Event vocabulary (extensible, not exhaustive) ───────────────────────
//
// KNOWN_AI_EVENT_TYPES lists the event types we can already name a real
// source for (a channel message, a Vapi call lifecycle event, a new-lead
// trigger, the test console). AIEventType additionally accepts any other
// string so a future event source doesn't require touching this file —
// the `string & {}` idiom keeps autocomplete/type-checking for the known
// values without widening the type to bare `string` everywhere it's used.

export const KNOWN_AI_EVENT_TYPES = [
  "message_received",
  "call_started",
  "call_ended",
  "missed_call",
  "new_lead",
  "manual_test",
  "internal_request",
  "workflow_trigger",
] as const;

export type KnownAIEventType = (typeof KNOWN_AI_EVENT_TYPES)[number];
export type AIEventType = KnownAIEventType | (string & {});

// ── External identity (UNTRUSTED) ───────────────────────────────────────
//
// Represents whatever a channel adapter could extract about who's on the
// other end, using only external/provider-facing identifiers. Deliberately
// excludes orgId, contactId, and leadId — those are internal identities
// resolved by trusted server code (the future identity resolver /
// Context Builder), never supplied by a provider payload or a model.

export type AIExternalIdentity = {
  phone?: string;
  email?: string;
  /** Provider-specific external id, e.g. a Messenger PSID, an Instagram
   * IGSID, or a Vapi call/customer identifier. Opaque outside its own
   * channel — never assumed unique across channels. */
  externalUserId?: string;
  displayName?: string;
};

// ── Content (UNTRUSTED) ─────────────────────────────────────────────────

export type AIContentType = "text" | "voice_transcript" | "image" | "file";

/** A reference to an attachment, not the attachment's bytes. No repo-wide
 * canonical attachment-reference shape was found to reuse (project_files
 * and the Meta/email attachment paths each have their own DB-row shape,
 * and none of them are safe to import into this server-runtime contract),
 * so this is intentionally minimal: enough to point at something already
 * stored (a Storage path) or already hosted (a vetted URL), never a raw
 * arbitrary buffer/base64 blob passed through this contract. */
export type AIContentAttachment = {
  type: "image" | "file" | "audio";
  url?: string;
  storagePath?: string;
  mimeType?: string;
  fileName?: string;
};

export type AIEventContent = {
  type: AIContentType;
  text?: string;
  attachments?: AIContentAttachment[];
};

// ── Normalized inbound event (UNTRUSTED) ────────────────────────────────
//
// What a channel adapter produces from a provider payload. This is the
// ONLY shape the future Context Builder/Router may read for "what just
// happened" — but per the trust-boundary note above, nothing here may be
// used as-is to authorize anything.

export type AIChannelEvent = {
  /** Adapter-assigned id for this event (for idempotency/tracing) —
   * not a database primary key. */
  eventId: string;
  /**
   * The organization id AS CLAIMED by the inbound payload or adapter, if
   * any (e.g. a webhook resolved it from a phone-number/page mapping
   * before this event was even constructed). UNTRUSTED. This field exists
   * so an adapter can carry a resolution hint forward — it must be
   * independently re-verified server-side (the same way
   * resolve-org.ts / vapi-webhook.ts's resolveTenant() already do it
   * today) before anything derives an AITrustedContext from it. Never
   * read this field to scope a query or grant a capability.
   */
  claimedOrganizationId?: string;
  channel: AIChannel;
  eventType: AIEventType;
  /** Provider's own conversation/thread id, if it has one (e.g. a Vapi
   * call id, a Gmail thread id). Opaque, channel-scoped. */
  externalConversationId?: string;
  /** Provider's own message id, if this event represents one message. */
  externalMessageId?: string;
  identity?: AIExternalIdentity;
  content: AIEventContent;
  /** Adapter/provider-specific extra data. Opaque by design — an
   * orchestrator may log or forward it, but it is never a source of
   * authorization (see this file's header: "metadata is not
   * authorization"). */
  metadata?: Record<string, unknown>;
  /** ISO-8601 timestamp of when the event occurred at the source, if the
   * provider supplied one (may differ from when it was received). */
  occurredAt?: string;
};

// ── Trusted runtime context (SERVER-OWNED) ──────────────────────────────
//
// Populated only by trusted server code that has already performed real
// identity/org resolution (e.g. a verified bearer token via
// resolve-org.ts, or a webhook's own signed tenant mapping) and, where
// applicable, already loaded the relevant agent_instances row. A model's
// output, a tool-call argument, or an AIChannelEvent's own fields must
// NEVER be used to construct or override any field on this type — compare
// to AIToolTrustedContext in tools/types.ts, which enforces the identical
// rule one layer down, at tool-execution time.
//
// Actor and AutonomyLevel are reused directly from src/lib/agentic/types
// rather than redefined here, so there remains exactly one definition of
// each in the codebase.

export type AITrustedContext = {
  orgId: string;
  actor: Actor;
  /** Set once a corresponding agent_executions row exists. */
  executionId?: string;
  userId?: string;
  contactId?: string;
  leadId?: string;
  projectId?: string;
  /** Matches the conversation_states convention of keying a conversation
   * by (contact, channel) — e.g. `${contactId}::${channel}` — until/unless
   * a real conversations table exists. Optional: not every event is part
   * of an ongoing conversation (e.g. a scheduled/system-triggered run). */
  conversationKey?: string;
  autonomyLevel?: AutonomyLevel;
};

// ── Resolved CRM context (Context Builder output) ───────────────────────
//
// Compact, AI-facing summaries — not copies of the underlying CRM tables.
// Each summary carries only what an agent plausibly needs to reason about
// the current interaction; the full row (and anything sensitive on it,
// e.g. integration_settings, access tokens, internal cost figures) is
// never exposed here. A future Context Builder is responsible for
// filtering to exactly this shape — this type exists so it has a fixed,
// reviewable contract to fill in, not `Record<string, any>`.

export type AIOrganizationSummary = {
  id: string;
  name: string;
  timezone?: string;
};

export type AIContactSummary = {
  id: string;
  name: string;
  phone?: string;
  email?: string;
};

export type AILeadSummary = {
  id: string;
  status: string;
  source?: string;
  score?: number;
};

export type AIProjectSummary = {
  id: string;
  name: string;
  status: string;
};

/** One message, already stripped to what an agent needs to read a short
 * recent-history window — never the full DB row (no provider_message_id,
 * no raw `meta` jsonb, no is_read/internal bookkeeping). Added in AI-1D
 * alongside AIConversationSummary.recentMessages; see that field's comment
 * for scope. */
export type AIConversationMessageSummary = {
  direction: "in" | "out";
  text: string;
  occurredAt: string;
};

export type AIConversationSummary = {
  channel: AIChannel;
  externalConversationId?: string;
  /**
   * Whether AI currently may respond autonomously in this conversation.
   * FORWARD-LOOKING: the AI-1 repository audit found no human-takeover /
   * AI-vs-human-ownership schema anywhere in the codebase yet
   * (conversation_states only tracks archive/star). Until that schema
   * exists, any Context Builder implementation must treat this as
   * unknown and default it to `false` — never assume AI ownership merely
   * because this field is absent.
   */
  aiOwned?: boolean;
  /**
   * A small, bounded, oldest-first window of recent messages (AI-1D: up to
   * 10), populated only for the message-table-backed channels
   * (sms/whatsapp/messenger/instagram, sourced from sms_meta_messages).
   * Undefined for channels with no unified conversation data source yet
   * (email/voice/web_chat/internal) — those get real context once their
   * own channel adapters exist, not by overloading this field. Added
   * after AI-1C shipped without it; AI-1C's shape had no field capable of
   * holding conversation content, and AI-1D's context builder needs one.
   */
  recentMessages?: AIConversationMessageSummary[];
};

export type AIResolvedContext = {
  organization: AIOrganizationSummary;
  contact?: AIContactSummary;
  lead?: AILeadSummary;
  project?: AIProjectSummary;
  conversation?: AIConversationSummary;
  channel: AIChannel;
};

// ── Agent identity (extensible) ──────────────────────────────────────────
//
// Same extensible-union strategy as AIEventType: known system agents get
// real literal types, a future custom agent can still be represented
// without editing this file. Listing a key here is NOT registering an
// agent or granting it behavior — per the ai-center skill, agents are
// configuration on a shared orchestrator, and defining a key here confers
// no capability by itself.

export const KNOWN_AI_AGENT_KEYS = ["reception", "lead_qualification", "scheduling"] as const;
export type KnownAIAgentKey = (typeof KNOWN_AI_AGENT_KEYS)[number];
export type AIAgentKey = KnownAIAgentKey | (string & {});

// ── Routing ──────────────────────────────────────────────────────────────

/** Where a routing decision came from — lets a future Router honor the
 * ai-center skill's preferred order (deterministic rules before model
 * classification) and lets the run result explain itself. */
export type AIRouteSource =
  | "deterministic"
  | "conversation_state"
  | "rule"
  | "model"
  | "fallback";

export type AIRouteDecision = {
  agentKey: AIAgentKey;
  reason: string;
  /** 0-1, only meaningful when `source` is "model"; omitted for
   * deterministic decisions, which are certain by construction. */
  confidence?: number;
  source: AIRouteSource;
};

// ── Handoff ──────────────────────────────────────────────────────────────
//
// A formal, structured handoff between two agents — not a prompt-level
// simulation. Per the ai-center skill: "Avoid blindly copying the entire
// prior conversation into every handoff." `summary` is meant to be a
// short paragraph the receiving agent can act on, not a transcript;
// enforcing a hard size limit is a future validation concern, not this
// type's job.

export type AIAgentHandoff = {
  fromAgent: AIAgentKey;
  toAgent: AIAgentKey;
  reason: string;
  goal?: string;
  summary: string;
  knownFacts?: Record<string, unknown>;
  openQuestions?: string[];
};

// ── Orchestration run result ─────────────────────────────────────────────
//
// toolResults reuses AIToolExecutionResult from tools/types.ts rather than
// defining a second, competing tool-result shape — see this file's header
// on dependency direction: ai/types.ts depends on tools/types.ts (a leaf
// contract), never the reverse.
//
// ModelRequest/ModelResponse (providers/model-provider.ts) are
// deliberately NOT imported here: nothing in this run-result contract
// needs the model's raw response shape — `responseText` is the already-
// extracted text a future orchestrator would pull from
// ModelResponse.text, and token/cost accounting belongs to
// src/lib/agentic/usage.ts, not to this result type. Importing
// model-provider.ts here with nothing to use it for would be unnecessary
// coupling between two leaf contracts that should stay independent.

export type AIRunStatus =
  | "completed"
  | "awaiting_approval"
  | "handed_off"
  | "human_escalation"
  | "failed";

export type AIRunResult = {
  executionId: string;
  status: AIRunStatus;
  agentKey: AIAgentKey;
  responseText?: string;
  handoff?: AIAgentHandoff;
  toolResults?: AIToolExecutionResult[];
  /** Sanitized only — never a raw thrown error, stack trace, or database
   * error object. Follows the same convention as
   * tools/registry.ts's sanitizeError(). */
  error?: string;
};
