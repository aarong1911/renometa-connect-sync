// src/lib/agentic/events.ts
//
// Phase 9.6 — Priority 10. Normalized event contract for future agent
// triggers. This phase defines the full event-type vocabulary but wires up
// only ONE producer (`manual.run_requested`, emitted by the proof-of-
// concept flow) — every other event type below is a name reservation for
// future phases, not yet fired by any table trigger. Do not wire the rest
// up without a matching consumer; an unread event stream is just as dead
// as workflow_trigger_queue was found to be (see Phase 9.6 audit).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Actor } from "./types";

export const AGENT_EVENT_TYPES = [
  "lead.created", "lead.updated", "lead.unassigned", "lead.inactive", "lead.converted",
  "conversation.message_received", "conversation.needs_reply", "conversation.replied",
  "deal.created", "deal.stage_changed", "deal.stale", "deal.won", "deal.lost",
  "task.overdue", "task.completed",
  "appointment.created", "appointment.unconfirmed", "appointment.cancelled", "appointment.completed",
  "estimate.sent", "estimate.viewed", "estimate.awaiting_response", "estimate.accepted", "estimate.declined", "estimate.expired",
  "invoice.overdue", "payment.failed", "payment.received",
  "schedule.daily", "schedule.hourly", "manual.run_requested",
] as const;
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export const EVENT_SCHEMA_VERSION = 1;

export type AgentEventInput = {
  orgId: string;
  eventType: AgentEventType;
  entityType?: string;
  entityId?: string;
  actor: Actor;
  payload?: Record<string, unknown>;
  /** Recommended: `${eventType}:${entityId}:${occurredAtBucket}` so the same real-world occurrence can't double-fire. */
  idempotencyKey?: string;
};

/**
 * Writes one normalized event row. Returns the inserted row, or null if an
 * idempotency conflict means this exact event was already recorded (not
 * an error — just a no-op).
 */
export async function emitAgentEvent(supabase: SupabaseClient, input: AgentEventInput) {
  const { data, error } = await supabase
    .from("agent_events")
    .insert({
      org_id: input.orgId,
      event_type: input.eventType,
      schema_version: EVENT_SCHEMA_VERSION,
      entity_type: input.entityType ?? null,
      entity_id: input.entityId ?? null,
      actor_type: input.actor.actorType,
      actor_id: input.actor.actorId,
      payload: input.payload ?? {},
      idempotency_key: input.idempotencyKey ?? null,
    })
    .select("*")
    .maybeSingle();

  if (error) {
    // A duplicate idempotency_key is expected/benign (unique violation,
    // Postgres code 23505) — anything else is a real failure the caller
    // should see.
    if ((error as { code?: string }).code === "23505") return null;
    throw error;
  }
  return data;
}
