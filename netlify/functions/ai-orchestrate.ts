/// <reference types="node" />
// netlify/functions/ai-orchestrate.ts
//
// AI Center — Phase AI-1G. The first authenticated HTTP entrypoint into
// AI Center orchestration. A thin HTTP/auth/normalization adapter around
// orchestrateAI() — it contains NO orchestration logic of its own (no
// context building, no routing, no prompt construction, no model calls,
// no execution-lifecycle writes). All of that stays inside
// lib/ai/orchestrator.ts and the modules it calls.
//
//   HTTP request -> bearer auth -> trusted org/user resolution
//     -> validate normalized AI event input -> verify any supplied
//     entity ids belong to this org -> construct AITrustedContext
//     -> orchestrateAI() -> safe JSON AIRunResult response
//
// SCOPE: this endpoint is for authenticated internal/Test-Console use
// only. It does NOT accept provider webhooks, unsigned Vapi events, Meta
// webhook payloads, or raw Twilio payloads — those get their own signed,
// provider-specific entry points later (real channel adapters, not this
// file). It performs no tool execution, no agent handoffs, no Scheduling
// behavior, and no outbound communication — orchestrateAI() itself
// doesn't do any of that yet either (AI-1F).
//
// ── TRUST BOUNDARY ───────────────────────────────────────────────────────
//
// The ONLY source of trust this endpoint recognizes is a verified Supabase
// bearer token, resolved via resolveOrgFromBearerToken() (the existing
// shared helper — not reimplemented here). Everything else in the request
// body is untrusted input to be validated and, where it references an
// internal entity, independently re-verified against the authenticated
// org before use:
//
//   - event.metadata is not authorization.
//   - event.identity is not authorization.
//   - event.claimedOrganizationId is not authorization — accepted only
//     because it's a structural part of AIChannelEvent (an adadpter might
//     carry a diagnostic hint), never read to establish orgId, and never
//     forwarded into AITrustedContext.
//   - request.context.contactId/leadId/projectId are internal entity
//     references the CALLER supplied. They are authenticated (the caller
//     proved who they are) but NOT yet trusted to belong to that caller's
//     org — each supplied id is independently checked with an
//     `.eq("id", id).eq("org_id", orgId)` read before it is allowed into
//     AITrustedContext. An id that doesn't resolve in this org is
//     rejected (400) without revealing whether it exists in another one.
//   - A request body containing orgId/organizationId/trustedOrgId/actor/
//     userId/autonomyLevel/executionId at any validated level is REJECTED
//     (400), not silently ignored — see REQUEST_SCHEMA below, which is
//     built with `.strict()` at every level so an unexpected key is a
//     validation error, not a field nobody reads. This is deliberate: an
//     API that silently drops trust-sensitive-looking fields still LOOKS
//     like it accepts them to anyone reading a captured request.
//
// Only resolveOrgFromBearerToken()'s result (userId, orgId) and the
// server-owned constants below (actor.source, autonomyLevel) ever reach
// AITrustedContext.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { orchestrateAI } from "./lib/ai/orchestrator";
import { AI_CHANNELS, type AIChannelEvent, type AITrustedContext } from "./lib/ai/types";

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const serviceRoleConfigured = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: HEADERS, body: JSON.stringify(body) };
}

// ── Request validation ───────────────────────────────────────────────────
//
// AI-1C shipped only TypeScript types for AIChannelEvent (no runtime
// validation, by design). This is the first place real HTTP input reaches
// that contract, so real runtime validation is added here — using Zod
// (already a repo dependency; no new package). This does not change or
// re-implement ai/types.ts — it validates that HTTP input is SHAPED like
// an AIChannelEvent before normalizing it into one.
//
// Deliberately narrower than the full AIChannelEvent/AIEventType surface:
// this Test-Console-facing endpoint only needs to originate the four
// event types below in AI-1G. A future channel adapter with a real
// provider payload to normalize can justify a wider (or different)
// validator; this one does not need to guess that shape in advance.
const EVENT_TYPE_ALLOWLIST = ["manual_test", "internal_request", "message_received", "new_lead"] as const;

const MAX_TEXT_LENGTH = 4000;
const METADATA_MAX_SERIALIZED_BYTES = 4096;

const identitySchema = z
  .object({
    phone: z.string().trim().min(1).max(32).optional(),
    email: z.string().trim().min(1).max(254).optional(),
    externalUserId: z.string().trim().min(1).max(200).optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const contentSchema = z
  .object({
    type: z.enum(["text", "voice_transcript", "image", "file"]),
    text: z.string().max(MAX_TEXT_LENGTH).optional(),
  })
  .strict();

// metadata is validated only for shape/size — its CONTENTS remain
// untrusted no matter what's in it (see this file's header). A plain
// object bounded to a small serialized size, nothing more.
const metadataSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .refine(
    (value) => {
      if (value === undefined) return true;
      try {
        return JSON.stringify(value).length <= METADATA_MAX_SERIALIZED_BYTES;
      } catch {
        return false;
      }
    },
    { message: `metadata must serialize to at most ${METADATA_MAX_SERIALIZED_BYTES} bytes` },
  );

// `.strict()` on every object below means an unexpected key (e.g. an
// `orgId` someone tries to sneak into `event` or `context`) is a
// validation error, not a silently-ignored field — see this file's
// header on why that matters.
const eventSchema = z
  .object({
    eventId: z.string().trim().min(1).max(100).optional(),
    // Never trusted for authorization — see this file's header. Accepted
    // only because it's a structural part of AIChannelEvent.
    claimedOrganizationId: z.string().trim().min(1).max(200).optional(),
    channel: z.enum(AI_CHANNELS),
    eventType: z.enum(EVENT_TYPE_ALLOWLIST),
    externalConversationId: z.string().trim().min(1).max(200).optional(),
    externalMessageId: z.string().trim().min(1).max(200).optional(),
    identity: identitySchema.optional(),
    content: contentSchema,
    metadata: metadataSchema,
    occurredAt: z.string().datetime().optional(),
  })
  .strict();

// Internal entity references. Authenticated (the caller proved who they
// are) but NOT trusted to belong to this org until independently
// verified — see verifyEntityBelongsToOrg() below and this file's header.
const contextSchema = z
  .object({
    contactId: z.string().uuid().optional(),
    leadId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    // No canonical conversations table exists yet (see ai/types.ts) — an
    // opaque, bounded label only, never used for authorization.
    conversationKey: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const requestSchema = z
  .object({
    event: eventSchema,
    context: contextSchema.optional(),
  })
  .strict();

// Simple, explicit cap rather than a generic size framework — Netlify's
// own platform limits also apply, this is just a much smaller, deliberate
// bound for what should be a short Test-Console-style payload.
const MAX_REQUEST_BODY_BYTES = 20_000;

// ── Entity ownership verification ────────────────────────────────────────
//
// The Context Builder (AI-1D) already scopes every read by org_id, but
// AITrustedContext's contract is that these ids are ALREADY verified by
// the time it's constructed — honoring that here, not relying on the
// Context Builder's own scoping to make an unverified id merely harmless.
// A minimal `select("id")` — never the full row.
async function verifyEntityBelongsToOrg(
  table: "contacts" | "leads" | "projects",
  id: string,
  orgId: string,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin.from(table).select("id").eq("id", id).eq("org_id", orgId).maybeSingle();
  if (error) throw new Error(`Could not verify ${table} ownership.`);
  return !!data;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: HEADERS, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  if (!serviceRoleConfigured) {
    console.error("[ai-orchestrate] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing");
    return json(500, { error: "Server misconfigured." });
  }

  // ── Authentication / trusted org resolution ─────────────────────────
  // The ONLY trust boundary in this file. request.body is never consulted
  // for org/user identity — see this file's header.
  const authHeader = event.headers.authorization;
  const resolved = await resolveOrgFromBearerToken(supabaseAdmin, authHeader);
  if (!resolved) return json(401, { error: "Unauthorized" });
  const { userId, orgId } = resolved;

  // ── Request size / parsing ──────────────────────────────────────────
  const rawBody = event.body ?? "";
  if (Buffer.byteLength(rawBody, "utf8") > MAX_REQUEST_BODY_BYTES) {
    return json(400, { error: "Request body too large." });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody || "{}");
  } catch {
    return json(400, { error: "Invalid JSON." });
  }

  const parseResult = requestSchema.safeParse(parsedJson);
  if (!parseResult.success) {
    return json(400, { error: "Invalid request.", details: parseResult.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
  }
  const requestBody = parseResult.data;

  // ── Entity ownership verification (authenticated, not yet trusted) ──
  try {
    if (requestBody.context?.contactId) {
      const ok = await verifyEntityBelongsToOrg("contacts", requestBody.context.contactId, orgId);
      if (!ok) return json(400, { error: "contactId does not reference a contact in your organization." });
    }
    if (requestBody.context?.leadId) {
      const ok = await verifyEntityBelongsToOrg("leads", requestBody.context.leadId, orgId);
      if (!ok) return json(400, { error: "leadId does not reference a lead in your organization." });
    }
    if (requestBody.context?.projectId) {
      const ok = await verifyEntityBelongsToOrg("projects", requestBody.context.projectId, orgId);
      if (!ok) return json(400, { error: "projectId does not reference a project in your organization." });
    }
  } catch (err) {
    console.error("[ai-orchestrate] entity ownership verification failed:", err);
    return json(500, { error: "Could not verify request context." });
  }

  // ── Normalize into AIChannelEvent (untrusted content, typed shape) ──
  const normalizedEvent: AIChannelEvent = {
    eventId: requestBody.event.eventId ?? randomUUID(),
    claimedOrganizationId: requestBody.event.claimedOrganizationId,
    channel: requestBody.event.channel,
    eventType: requestBody.event.eventType,
    externalConversationId: requestBody.event.externalConversationId,
    externalMessageId: requestBody.event.externalMessageId,
    identity: requestBody.event.identity,
    content: requestBody.event.content,
    metadata: requestBody.event.metadata,
    occurredAt: requestBody.event.occurredAt,
  };

  // ── Construct AITrustedContext (server-owned values only) ───────────
  // actorType "user": this endpoint is authenticated-human-initiated
  // (the Test Console), matching agentic/types.ts's Actor shape exactly.
  // autonomyLevel is fixed at 1 ("Recommend" — the lowest defined level,
  // per agentic/types.ts's AUTONOMY_LEVEL_LABELS), NEVER read from the
  // request body: AI-1F performs no tool execution regardless of this
  // value, so the lowest safe level is also sufficient — this is a
  // temporary AI-1G choice, to be revisited once real orchestrated tool
  // use needs a higher level deliberately granted per agent/org.
  const trustedContext: AITrustedContext = {
    orgId,
    actor: { actorType: "user", actorId: userId, source: "ai_orchestrate_http" },
    userId,
    contactId: requestBody.context?.contactId,
    leadId: requestBody.context?.leadId,
    projectId: requestBody.context?.projectId,
    conversationKey: requestBody.context?.conversationKey,
    autonomyLevel: 1,
  };

  // ── Orchestrate ──────────────────────────────────────────────────────
  // No context building, routing, prompt construction, model calls, or
  // execution-lifecycle writes happen in this file — all of that is
  // orchestrateAI()'s responsibility (lib/ai/orchestrator.ts).
  try {
    const result = await orchestrateAI({ supabase: supabaseAdmin, event: normalizedEvent, trustedContext });
    const statusCode = result.status === "failed" ? 500 : 200;
    return json(statusCode, result);
  } catch (err) {
    // orchestrateAI() is documented to never throw — reaching here means
    // something outside its own contract went wrong. Never forward the
    // real error to the caller.
    console.error("[ai-orchestrate] orchestrateAI threw unexpectedly:", err);
    return json(500, { error: "AI Center could not process this event." });
  }
};
