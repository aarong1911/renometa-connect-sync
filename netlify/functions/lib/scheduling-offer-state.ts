// netlify/functions/lib/scheduling-offer-state.ts
//
// Scheduling foundation — Phase 2. Reads/writes the persisted "which
// appointment slots were most recently offered to this contact, on this
// channel" state — supabase/migrations/20260930_conversation_states_
// scheduling_offer.sql's two new nullable columns on the EXISTING
// conversation_states table (org_id, contact_id, channel — the same
// identity path the Inbox's archive/star feature already uses for every
// non-email channel; see that migration's own audit comment).
//
// WHY THIS EXISTS: a multi-turn scheduling conversation ("Tuesday
// afternoon or Wednesday morning?" -> "Wednesday" -> "9:30 or 11:00?" ->
// "11 works") must resolve the customer's final reply against REAL,
// structured slot data, never against model memory alone. This module is
// the one place that structured offer gets written and read back.
//
// NON-NEGOTIABLE RULE (restated from scheduling-availability.ts, because
// it is the single most important invariant in this whole feature): an
// offer persisted here is NEVER itself proof the slot remains available.
// It exists ONLY to let a later turn correctly identify WHICH slot the
// customer means. Every caller that is about to actually book one of
// these offered slots MUST re-run validateSlotAvailability() immediately
// before writing to `appointments` — this module has no "reserve"/"lock"
// concept at all, by design (see this phase's own scope: no reservation
// locking in Phases 1-3 unless absolutely necessary, and it is not).

import type { SupabaseClient } from "@supabase/supabase-js";
// scheduling-availability.ts now lives under src/lib/agentic/ (see that
// file's own header for why — a code-review correction) — this is the
// correct import direction (netlify/functions/lib -> src/lib/agentic),
// unchanged from every other existing cross-boundary import in this repo.
import type { SlotCandidate } from "../../../src/lib/agentic/scheduling-availability";

export type AvailabilityDeps = { supabase: SupabaseClient };

/** The conversation_states.channel values this module supports. Email is
 * deliberately excluded: email conversations key on
 * external_conversation_key, not contact_id + channel (see
 * 20260726_conversation_states_external_key.sql) — a different identity
 * shape this module does not handle, and scheduling offers over email are
 * out of scope for this phase regardless. */
export const SCHEDULING_OFFER_CHANNELS = ["sms", "whatsapp", "messenger", "instagram", "voice"] as const;
export type SchedulingOfferChannel = (typeof SCHEDULING_OFFER_CHANNELS)[number];

export type PersistedSlotOffer = SlotCandidate;

export type WriteOfferedSlotsParams = {
  orgId: string;
  contactId: string;
  channel: SchedulingOfferChannel;
  slots: PersistedSlotOffer[];
  now?: Date;
};

export type WriteOfferedSlotsResult = { ok: true } | { ok: false; reason: string };

function isValidSlotShape(value: unknown): value is PersistedSlotOffer {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.start === "string" && typeof v.end === "string" && typeof v.timeZone === "string";
}

/**
 * Persists the EXACT set of slots just offered to this contact on this
 * channel — structured, never label-only (see this file's header).
 * Validates shape before writing (no DB-level CHECK exists for this jsonb
 * column — see the migration's own comment for why). Upserts on the
 * EXISTING (org_id, contact_id, channel) partial unique index
 * (conversation_states_org_contact_channel_uq) — the same index/identity
 * every other conversation_states writer (archive/star) already uses for
 * these channels; no new identity concept introduced.
 */
export async function writeOfferedSlots(deps: AvailabilityDeps, params: WriteOfferedSlotsParams): Promise<WriteOfferedSlotsResult> {
  const { orgId, contactId, channel, slots } = params;
  if (!orgId || !contactId) return { ok: false, reason: "orgId and contactId are required" };
  if (!SCHEDULING_OFFER_CHANNELS.includes(channel)) return { ok: false, reason: `unsupported channel: ${channel}` };
  if (!Array.isArray(slots) || slots.length === 0) return { ok: false, reason: "slots must be a non-empty array" };
  if (!slots.every(isValidSlotShape)) return { ok: false, reason: "every slot must have start/end/timeZone" };

  const nowIso = (params.now ?? new Date()).toISOString();
  const { error } = await deps.supabase
    .from("conversation_states")
    .upsert(
      {
        org_id: orgId,
        contact_id: contactId,
        channel,
        scheduling_offered_slots: slots,
        scheduling_offered_at: nowIso,
        updated_at: nowIso,
      },
      { onConflict: "org_id,contact_id,channel" },
    );
  if (error) {
    console.error("[scheduling-offer-state] writeOfferedSlots failed:", error.message);
    return { ok: false, reason: error.message };
  }
  return { ok: true };
}

export type ReadOfferedSlotsResult =
  | { status: "found"; slots: PersistedSlotOffer[]; offeredAt: string }
  | { status: "none" }
  | { status: "error"; reason: string };

/** Reads back the most recently offered slots, if any. `status: "none"`
 * covers both "no row yet" and "a row exists but no offer is currently
 * outstanding" (both new columns null) — callers don't need to
 * distinguish the two, since the effect (no prior offer to resolve
 * against) is identical either way. */
export async function readOfferedSlots(
  deps: AvailabilityDeps,
  params: { orgId: string; contactId: string; channel: SchedulingOfferChannel },
): Promise<ReadOfferedSlotsResult> {
  const { data, error } = await deps.supabase
    .from("conversation_states")
    .select("scheduling_offered_slots, scheduling_offered_at")
    .eq("org_id", params.orgId)
    .eq("contact_id", params.contactId)
    .eq("channel", params.channel)
    .maybeSingle();
  if (error) {
    console.error("[scheduling-offer-state] readOfferedSlots failed:", error.message);
    return { status: "error", reason: error.message };
  }
  const slots = (data as { scheduling_offered_slots: unknown } | null)?.scheduling_offered_slots;
  const offeredAt = (data as { scheduling_offered_at: string | null } | null)?.scheduling_offered_at;
  if (!slots || !offeredAt || !Array.isArray(slots) || slots.length === 0) return { status: "none" };
  if (!slots.every(isValidSlotShape)) {
    // Stored shape no longer matches what this module writes (e.g. a
    // future format change) — fail safe toward "no usable prior offer"
    // rather than handing a caller malformed slot data.
    console.error("[scheduling-offer-state] stored scheduling_offered_slots has an unexpected shape — treating as none.");
    return { status: "none" };
  }
  return { status: "found", slots: slots as PersistedSlotOffer[], offeredAt };
}

/** Clears any outstanding offer — e.g. once the customer's selection has
 * been resolved (successfully or not) and the offer no longer applies.
 * Idempotent: clearing an already-clear row is a harmless no-op. */
export async function clearOfferedSlots(
  deps: AvailabilityDeps,
  params: { orgId: string; contactId: string; channel: SchedulingOfferChannel; now?: Date },
): Promise<WriteOfferedSlotsResult> {
  const nowIso = (params.now ?? new Date()).toISOString();
  const { error } = await deps.supabase
    .from("conversation_states")
    .update({ scheduling_offered_slots: null, scheduling_offered_at: null, updated_at: nowIso })
    .eq("org_id", params.orgId)
    .eq("contact_id", params.contactId)
    .eq("channel", params.channel);
  if (error) {
    console.error("[scheduling-offer-state] clearOfferedSlots failed:", error.message);
    return { ok: false, reason: error.message };
  }
  return { ok: true };
}
