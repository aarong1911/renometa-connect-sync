// src/lib/agentic/handlers.ts
//
// Phase 9.6 proof-of-concept action handlers — the ONLY four actions that
// are actually executable this phase (per action-registry.ts). Every
// handler:
//   - takes the org id from ActionContext (server-resolved), never from
//     its own input — every query is `.eq("org_id", ctx.orgId)`.
//   - is bounded (small selects, small limits) — no full-table scans, no
//     full conversation dumps.
//   - returns { ok, output } or { ok:false, error } — never throws past
//     action-executor.ts, which is what turns a thrown/returned error into
//     a recorded execution-step failure.
//
// These are plain functions, not React hooks and not tied to any specific
// Supabase client instance — action-executor.ts (running inside a Netlify
// function, using the service-role client) calls them directly. Nothing
// here is called from a React component.

import type { ActionHandler } from "./types";
import { createLeadLinkedTask } from "./lead-tasks";
import { sendTwilioSms } from "./sms-transport";
import { sendWhatsAppText } from "./whatsapp-transport";
import {
  resolveOrgTimezone,
  validateSlotAvailability,
  getAvailableSlots,
  type SlotCandidate,
} from "./scheduling-availability";
// Scheduling foundation (code-review correction): scheduling-availability.ts
// now lives in THIS directory (src/lib/agentic/), not
// netlify/functions/lib/ — see that file's own header for why. This handler
// does NOT invoke the post-booking lifecycle (confirmation email + owner
// notification) itself — that call stays entirely on the
// netlify/functions/ side, in agent-approve-action.ts, right after this
// handler's result is verified (see that file's schedule_appointment case
// in verifyActionSuccess + the call immediately after). This keeps
// src/lib/agentic's one real invariant intact: nothing in this tree ever
// needs a Node-only package (nodemailer, in appointment-post-booking.ts's
// case) that a future accidental browser-reachable import could silently
// try to drag into the Vite build.

type LeadContextInput = { leadId: string };
type LeadContextOutput = {
  lead: { id: string; status: string; source: string | null; assignedTo: string | null; createdAt: string };
  contact: { id: string; name: string; email: string | null; phone: string | null } | null;
  recentNotes: { id: string; content: string; createdAt: string }[];
};

export const getLeadContext: ActionHandler<LeadContextInput, LeadContextOutput> = async (ctx, input) => {
  const { data: lead, error: leadError } = await ctx.supabase
    .from("leads")
    .select("id, status, source, assigned_to, contact_id, created_at")
    .eq("id", input.leadId)
    .eq("org_id", ctx.orgId)
    .maybeSingle();

  if (leadError) return { ok: false, error: "Could not load lead." };
  if (!lead) return { ok: false, error: "Lead not found in this organization." };

  let contact: LeadContextOutput["contact"] = null;
  if (lead.contact_id) {
    const { data: contactRow } = await ctx.supabase
      .from("contacts")
      .select("id, full_name, email, phone")
      .eq("id", lead.contact_id)
      .eq("org_id", ctx.orgId)
      .maybeSingle();
    if (contactRow) {
      contact = { id: contactRow.id, name: contactRow.full_name ?? "Unknown", email: contactRow.email, phone: contactRow.phone };
    }
  }

  // Bounded — last 5 notes only, never a full history dump.
  const { data: notes } = await ctx.supabase
    .from("notes")
    .select("id, content, created_at")
    .eq("org_id", ctx.orgId)
    .eq("entity_type", "lead")
    .eq("entity_id", input.leadId)
    .order("created_at", { ascending: false })
    .limit(5);

  return {
    ok: true,
    output: {
      lead: {
        id: lead.id,
        status: lead.status ?? "new",
        source: lead.source,
        assignedTo: lead.assigned_to,
        createdAt: lead.created_at,
      },
      contact,
      recentNotes: (notes ?? []).map((n: any) => ({ id: n.id, content: n.content, createdAt: n.created_at })),
    },
  };
};

type CreateFollowUpTaskInput = {
  leadId: string;
  title: string;
  dueDate?: string;
  priority?: "low" | "medium" | "high" | "urgent";
  assignedTo?: string | null;
};
type CreateFollowUpTaskOutput = { taskId: string };

/**
 * Phase 10.1 — creates a REAL task linked to the lead (tasks.entity_type
 * = "lead", entity_id = leadId), replacing the Phase 9.6 tagged-note
 * stand-in now that a lead can have a task without a project (see
 * lead-tasks.ts / the Phase 10.1 migration). Does not also write the old
 * note.
 */
export const createFollowUpTask: ActionHandler<CreateFollowUpTaskInput, CreateFollowUpTaskOutput> = async (ctx, input) => {
  try {
    const { taskId } = await createLeadLinkedTask(ctx.supabase, {
      orgId: ctx.orgId,
      leadId: input.leadId,
      title: input.title,
      dueDate: input.dueDate ?? null,
      priority: input.priority,
      assignedTo: input.assignedTo,
      actor: ctx.actor,
    });
    return { ok: true, output: { taskId } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not create the follow-up task." };
  }
};

type AddInternalNoteInput = { targetEntityType: "lead" | "contact" | "deal" | "company"; targetEntityId: string; content: string };
type AddInternalNoteOutput = { noteId: string };

export const addInternalNote: ActionHandler<AddInternalNoteInput, AddInternalNoteOutput> = async (ctx, input) => {
  // Content is always tagged so a human reading the Notes tab later can
  // tell this wasn't organically typed by a person (Priority 2 — never
  // represent an automated action as if a human performed it).
  const tag = ctx.actor.actorType === "agent" ? "[Agent]" : ctx.actor.actorType === "user" ? "[Agent draft, added by user]" : `[${ctx.actor.actorType}]`;
  const content = `${tag} ${input.content}`;

  const { data, error } = await ctx.supabase
    .from("notes")
    .insert({
      org_id: ctx.orgId,
      entity_type: input.targetEntityType,
      entity_id: input.targetEntityId,
      content,
      created_by: ctx.actor.actorType === "user" ? ctx.actor.actorId : null,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: "Could not add the note." };
  return { ok: true, output: { noteId: data.id } };
};

type SendSmsInput = { contactId: string; body: string };
type SendSmsOutput = { providerMessageId: string | null };

/**
 * AI-2A. The real handler behind the `send_sms` action — previously
 * `isExecutable: false` with no handler (see action-registry.ts's own
 * comment). Only reachable through the existing Gen-2 pipeline
 * (executeStep()/executeApprovedStep() in action-executor.ts), which by
 * this point has already: validated input against sendSmsInput (contactId
 * + body only — no phone/orgId field exists on that schema for a model to
 * supply), checked emergency pause, checked outbound consent
 * (checkOutboundConsent() — SMS fails closed unless
 * marketing_contact_preferences.sms_status === "eligible"), and — because
 * send_sms.requiresApproval is unconditionally true — gone through a real
 * human approval (agent-approve-action.ts, which itself is owner/admin-
 * gated). This handler performs NO policy checks of its own; it trusts
 * that executeStep()/executeApprovedStep() already ran them, exactly like
 * every other handler in this file.
 *
 * Recipient binding: the destination phone number is ALWAYS resolved
 * server-side from `input.contactId` (looked up in `contacts`, scoped to
 * `ctx.orgId`) — there is no phone field on SendSmsInput for a model or
 * caller to supply, so there is nothing to override even if one tried.
 * Twilio credentials are read the same way send-inbox-message.ts already
 * does (organizations.integration_settings.twilio, per-org) — no new
 * credential-storage convention introduced.
 */
export const sendSms: ActionHandler<SendSmsInput, SendSmsOutput> = async (ctx, input) => {
  const { data: contact, error: contactError } = await ctx.supabase
    .from("contacts")
    .select("id, phone")
    .eq("id", input.contactId)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (contactError) return { ok: false, error: "Could not load recipient contact." };
  if (!contact?.phone) return { ok: false, error: "Recipient contact has no phone number on file." };

  const recipientPhone = contact.phone;
  // AI-2C.1: transport extracted to sms-transport.ts (shared with the
  // deterministic HELP compliance reply) — this handler's own
  // responsibility is now just contact resolution + persistence, exactly
  // as before.
  const sendResult = await sendTwilioSms(ctx.supabase, ctx.orgId, recipientPhone, input.body);
  if (!sendResult.ok) return { ok: false, error: sendResult.error };
  const providerMessageId = sendResult.providerMessageId;

  const { error: insertErr } = await ctx.supabase.from("sms_meta_messages").insert({
    org_id: ctx.orgId,
    contact_id: input.contactId,
    channel: "sms",
    direction: "out",
    body: input.body,
    from_address: recipientPhone,
    provider_message_id: providerMessageId,
  });
  if (insertErr) {
    // The send already succeeded — losing the local history row is a
    // lesser problem than reporting a false failure (same tradeoff
    // send-inbox-message.ts already makes for its own SMS persistence).
    console.error("[agentic/handlers] sendSms sms_meta_messages insert failed:", insertErr.message);
  }

  return { ok: true, output: { providerMessageId } };
};

type SendWhatsappInput = { contactId: string; body: string };
type SendWhatsappOutput = { providerMessageId: string | null };

/**
 * AI-2E. The real handler behind the `send_whatsapp` action — modeled
 * directly on sendSms above. Only reachable through the existing Gen-2
 * pipeline (executeStep()/executeApprovedStep()), which by this point has
 * already: validated input against sendWhatsappInput (contactId + body
 * only — no phone/connection field for a model to supply), checked
 * emergency pause, checked outbound eligibility (checkOutboundConsent()'s
 * WhatsApp branch — action-executor.ts — which fails closed unless the
 * contact has an open 24-hour reactive conversation window, i.e. messaged
 * this business recently; see that function for why WhatsApp cannot reuse
 * SMS's marketing_contact_preferences model), and — because
 * send_whatsapp.requiresApproval is unconditionally true in AI-2E — gone
 * through a real human approval (agent-approve-action.ts, owner/admin-
 * gated). This handler performs NO policy checks of its own; it trusts
 * that executeStep()/executeApprovedStep() already ran them, exactly like
 * sendSms.
 *
 * Recipient binding: the destination phone is ALWAYS resolved server-side
 * from `input.contactId` (looked up in `contacts`, scoped to
 * `ctx.orgId`) — there is no phone/connection field on SendWhatsappInput
 * for a model or caller to supply. Only ever sends `type: "text"` (see
 * whatsapp-transport.ts) — never a template — matching AI-2E's explicit
 * "reactive free-form replies only" scope.
 */
export const sendWhatsapp: ActionHandler<SendWhatsappInput, SendWhatsappOutput> = async (ctx, input) => {
  const { data: contact, error: contactError } = await ctx.supabase
    .from("contacts")
    .select("id, phone")
    .eq("id", input.contactId)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (contactError) return { ok: false, error: "Could not load recipient contact." };
  if (!contact?.phone) return { ok: false, error: "Recipient contact has no phone number on file." };

  const recipientPhone = contact.phone;
  const sendResult = await sendWhatsAppText(ctx.supabase, ctx.orgId, recipientPhone, input.body);
  if (!sendResult.ok) return { ok: false, error: sendResult.error };
  const providerMessageId = sendResult.providerMessageId;

  const { error: insertErr } = await ctx.supabase.from("sms_meta_messages").insert({
    org_id: ctx.orgId,
    contact_id: input.contactId,
    channel: "whatsapp",
    direction: "out",
    body: input.body,
    from_address: recipientPhone,
    provider_message_id: providerMessageId,
  });
  if (insertErr) {
    // The send already succeeded — same tradeoff sendSms makes above.
    console.error("[agentic/handlers] sendWhatsapp sms_meta_messages insert failed:", insertErr.message);
  }

  return { ok: true, output: { providerMessageId } };
};

type DraftCustomerReplyInput = { leadId: string; tone: "friendly" | "formal" };
type DraftCustomerReplyOutput = { draft: string; isStub: true };

/**
 * Deterministic, provider-free draft — Phase 9.6 is architecture proof
 * only (Priority 16 explicitly permits a stub here rather than a real
 * model call). This NEVER sends anything; it only produces text for a
 * human to review as a proposed_input on an approval request, or for
 * direct display in the proof-of-concept UI. `isStub: true` is always
 * returned so no caller can mistake this for a production AI draft.
 */
export const draftCustomerReply: ActionHandler<DraftCustomerReplyInput, DraftCustomerReplyOutput> = async (ctx, input) => {
  const { data: lead } = await ctx.supabase
    .from("leads")
    .select("id, contact_id")
    .eq("id", input.leadId)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (!lead) return { ok: false, error: "Lead not found in this organization." };

  let name = "there";
  if (lead.contact_id) {
    const { data: contact } = await ctx.supabase
      .from("contacts")
      .select("full_name")
      .eq("id", lead.contact_id)
      .eq("org_id", ctx.orgId)
      .maybeSingle();
    if (contact?.full_name) name = contact.full_name.split(" ")[0];
  }

  const draft = input.tone === "formal"
    ? `Dear ${name}, thank you for your interest — a member of our team will follow up shortly to discuss your project in more detail.`
    : `Hi ${name}, thanks for reaching out! We'd love to learn more about your project — a member of our team will be in touch soon.`;

  return { ok: true, output: { draft, isStub: true } };
};

// ── Scheduling foundation (Phases 1-3) ──────────────────────────────────
//
// Canonical appointment_type values — matches the live DB CHECK constraint
// (appointments_appointment_type_check, 20260807_calendar_appointments_
// completion.sql) and src/lib/appointment-status.ts's AppointmentType
// union EXACTLY. Defined locally here, not imported from
// appointment-status.ts, because that file also imports lucide-react
// (icon components) for its UI label/color maps — pulling that into this
// server-only handler module would be a pointless bundle/dependency
// widening for the sake of 7 string literals. If these two lists ever
// drift, appointment-status.ts (the UI's own canonical reference) and the
// DB constraint are BOTH the real source of truth this list must keep
// matching — not a new, third, independent vocabulary.
const APPOINTMENT_TYPES = ["consultation", "estimate", "site_visit", "service", "follow_up", "internal", "other"] as const;
type AppointmentTypeValue = (typeof APPOINTMENT_TYPES)[number];

const APPOINTMENT_ENTITY_TYPES = ["lead", "contact", "company", "deal", "project"] as const;
type AppointmentEntityTypeValue = (typeof APPOINTMENT_ENTITY_TYPES)[number];

const ENTITY_TABLE_BY_TYPE: Record<AppointmentEntityTypeValue, string> = {
  lead: "leads",
  contact: "contacts",
  company: "companies",
  deal: "deals",
  project: "projects",
};

/** Defense-in-depth re-check of appointments.validate_appointment_assignee()
 * (same org_memberships/profiles union the DB trigger itself uses) — gives
 * a clean handler-level error message; the DB trigger remains the actual,
 * final authority regardless of what this returns. */
async function assigneeBelongsToOrg(ctx: { supabase: ActionHandlerSupabase }, orgId: string, assignedTo: string): Promise<boolean> {
  const [{ data: membership }, { data: profile }] = await Promise.all([
    ctx.supabase.from("org_memberships").select("member_id").eq("member_id", assignedTo).eq("org_id", orgId).maybeSingle(),
    ctx.supabase.from("profiles").select("id").eq("id", assignedTo).eq("organization_id", orgId).maybeSingle(),
  ]);
  return !!membership || !!profile;
}

/** Defense-in-depth re-check of appointments.validate_appointment_entity_link()
 * — same per-type same-org existence check the DB trigger performs. */
async function entityBelongsToOrg(
  ctx: { supabase: ActionHandlerSupabase },
  orgId: string,
  entityType: AppointmentEntityTypeValue,
  entityId: string,
): Promise<boolean> {
  const table = ENTITY_TABLE_BY_TYPE[entityType];
  const { data } = await ctx.supabase.from(table).select("id").eq("id", entityId).eq("org_id", orgId).maybeSingle();
  return !!data;
}

/** Narrow structural type for the two helpers above — avoids importing the
 * full SupabaseClient type into this section redundantly (ActionContext
 * already supplies it; this is just for the helper functions' own params). */
type ActionHandlerSupabase = Parameters<ActionHandler>[0]["supabase"];

function describeUnavailableSlot(
  status: "conflict" | "outside_business_hours" | "invalid_range" | "in_past" | "availability_check_failed",
): string {
  switch (status) {
    case "conflict":
      return "The requested time is no longer available.";
    case "outside_business_hours":
      return "The requested time is outside business hours.";
    case "invalid_range":
      return "The requested appointment time range is invalid.";
    case "in_past":
      return "The requested time has already passed.";
    case "availability_check_failed":
      // The FAIL CLOSED path (see scheduling-availability.ts's own header)
      // — a database error, invalid timezone, or malformed input means
      // availability could not be verified at all. This is deliberately
      // the SAME customer-facing message as every other unavailable
      // reason: never reveal "our availability system is broken" to an
      // end customer, and never let an internal error message leak
      // through an approval/response path. Full detail is still logged
      // server-side by validateSlotAvailability() itself.
      return "The requested time is no longer available.";
    default:
      return "The requested time is no longer available.";
  }
}

type ScheduleAppointmentInput = {
  contactId: string;
  startsAt: string;
  durationMinutes: number;
  appointmentType: AppointmentTypeValue;
  title: string;
  assignedTo?: string | null;
  entityType?: AppointmentEntityTypeValue | null;
  entityId?: string | null;
  location?: string | null;
};
type ScheduleAppointmentOutput = { appointmentId: string; startsAt: string; endsAt: string; timeZone: string };

/**
 * Scheduling foundation — Phase 3. The real schedule_appointment handler,
 * replacing the previous isExecutable:false placeholder (see
 * action-registry.ts's own comment on this action). Implements every
 * safety requirement from this phase's own spec, in order:
 *   1. validate org (ctx.orgId — server-resolved, never from input)
 *   2. validate contact belongs to org
 *   3. resolve org timezone (fail closed — organizations.timezone only,
 *      never a browser/device value, never a silent UTC default, and —
 *      code-review correction — never a model-supplied override either:
 *      this handler no longer accepts a timeZone input field at all, so
 *      there is no path by which a caller can make a booking resolve to
 *      any timezone other than this org's own configured one)
 *   4. validate appointment type against the canonical set
 *   5. validate assignee, if present (defense-in-depth; DB trigger is the
 *      final authority either way)
 *   6. validate entity linkage, if present (same defense-in-depth posture)
 *   7. derive end time deterministically (start + durationMinutes)
 *   8. check start < end
 *   9. re-check slot availability IMMEDIATELY before insert — this call
 *      happens whether this handler is reached via executeStep() (an
 *      auto-executing path, not used by this action since requiresApproval
 *      is unconditional) or executeApprovedStep() (the real path — invoked
 *      the INSTANT a human clicks Approve, so this re-check is genuinely
 *      "immediately before insert," not merely "at proposal time")
 *  10. fails CLOSED on ANY availability-lookup problem — see
 *      describeUnavailableSlot()'s own comment
 *  11. inserts exactly one appointment row
 *  12. idempotency is the EXISTING agent_action_idempotency mechanism
 *      (action-executor.ts) — this handler adds nothing extra; see this
 *      phase's own report for why that mechanism is sufficient
 *  13. appointments' own existing triggers (log_appointment_activity,
 *      validate_appointment_assignee, validate_appointment_entity_link)
 *      run automatically on this INSERT — untouched, unbypassed
 *  14. denormalizes contact_name/contact_phone/contact_email onto the row
 *      (what the post-booking lifecycle reads) — the lifecycle ITSELF is
 *      invoked by agent-approve-action.ts, not here (code-review
 *      correction: keeps this handler's module free of a Node-only
 *      nodemailer dependency — see this file's own header)
 */
export const scheduleAppointment: ActionHandler<ScheduleAppointmentInput, ScheduleAppointmentOutput> = async (ctx, input) => {
  const { data: contact, error: contactError } = await ctx.supabase
    .from("contacts")
    .select("id, full_name, email, phone")
    .eq("id", input.contactId)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (contactError) return { ok: false, error: "Could not load contact." };
  if (!contact) return { ok: false, error: "Contact not found in this organization." };

  // Code-review correction: timezone is ALWAYS the org's own configured
  // value, with no model-controlled override path. organizations.timezone
  // is the single source of truth for every appointment, regardless of
  // creation path (Voice, Calendar, or this action) — see this handler's
  // own header comment and action-registry.ts's scheduleAppointmentInput.
  const tz = await resolveOrgTimezone({ supabase: ctx.supabase }, ctx.orgId);
  if (tz.status !== "resolved") {
    // FAIL CLOSED — no UTC/fallback default. See
    // scheduling-availability.ts's resolveOrgTimezone() for the full
    // reasoning; this is the handler-level consequence of that rule.
    return { ok: false, error: "Could not resolve the organization's timezone." };
  }
  const timeZone: string = tz.timeZone;

  if (!APPOINTMENT_TYPES.includes(input.appointmentType)) {
    return { ok: false, error: "Invalid appointment type." };
  }

  if (input.assignedTo) {
    const belongs = await assigneeBelongsToOrg(ctx, ctx.orgId, input.assignedTo);
    if (!belongs) return { ok: false, error: "Assignee is not a member of this organization." };
  }

  // Code-review correction: entityType/entityId must be supplied TOGETHER
  // or NOT AT ALL. The previous `?? "contact"` / `?? input.contactId`
  // defaulting silently mispaired an inconsistent partial input instead
  // of rejecting it — e.g. a caller supplying only entityType: "lead"
  // (no entityId) would have been silently treated as linking to
  // input.contactId AS A LEAD RECORD, validating a contact id against the
  // leads table under a type the caller never actually confirmed, which
  // can only ever fail to match by coincidence rather than by design.
  // Explicit, deliberate pairing only: either both fields are omitted
  // (defaults to {entityType: "contact", entityId: input.contactId}, the
  // one default pairing that's actually self-consistent), or both are
  // provided and used exactly as given — nothing in between.
  if ((input.entityType != null) !== (input.entityId != null)) {
    return { ok: false, error: "entityType and entityId must be provided together, or both omitted." };
  }
  const entityType = input.entityType ?? "contact";
  const entityId = input.entityId ?? input.contactId;
  const entityOk = await entityBelongsToOrg(ctx, ctx.orgId, entityType, entityId);
  if (!entityOk) return { ok: false, error: "Linked record not found in this organization." };

  const start = new Date(input.startsAt);
  if (isNaN(start.getTime())) return { ok: false, error: "Invalid start time." };
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes <= 0 || input.durationMinutes > 480) {
    return { ok: false, error: "Invalid appointment duration." };
  }
  const end = new Date(start.getTime() + input.durationMinutes * 60_000);
  if (!(start.getTime() < end.getTime())) return { ok: false, error: "Invalid appointment time range." };

  // ── THE non-negotiable re-check — see this function's own doc comment.
  const availability = await validateSlotAvailability(
    { supabase: ctx.supabase },
    { orgId: ctx.orgId, start: start.toISOString(), end: end.toISOString(), timeZone, assignedTo: input.assignedTo ?? null },
  );
  if (availability.status !== "available") {
    return { ok: false, error: describeUnavailableSlot(availability.status) };
  }

  // KNOWN, DOCUMENTED RESIDUAL RACE WINDOW (reported, not silently
  // ignored — see this phase's own report): between the availability
  // re-check above and this INSERT, a genuinely concurrent booking
  // request for an overlapping slot could still slip through — there is
  // no DB-level UNIQUE constraint across (org_id, scheduled_at) to catch
  // this (appointments intentionally allows legitimate parallel bookings
  // for different assignees). This is the SAME residual exposure
  // voice-scheduling.ts's own booking path has today; closing it fully
  // would need a dedicated DB-level exclusion constraint or advisory lock,
  // which this phase's own scope explicitly does not call for.
  const { data: inserted, error: insertError } = await ctx.supabase
    .from("appointments")
    .insert({
      org_id: ctx.orgId,
      title: input.title,
      appointment_type: input.appointmentType,
      status: "scheduled",
      source: "ai_chat",
      scheduled_at: start.toISOString(),
      ends_at: end.toISOString(),
      duration_min: input.durationMinutes,
      time_zone: timeZone,
      assigned_to: input.assignedTo ?? null,
      entity_type: entityType,
      entity_id: entityId,
      contact_id: input.contactId,
      // Denormalized onto the appointment row itself — this is what
      // agent-approve-action.ts's post-booking lifecycle call (triggered
      // right after this handler returns, outside this file — see this
      // file's own header) actually reads to send the confirmation email
      // (it does NOT join back to contacts). Matches the exact convention
      // Voice/manual booking already use (contact_name/contact_phone/
      // contact_email as real, directly-set columns).
      contact_name: contact.full_name ?? null,
      contact_phone: contact.phone ?? null,
      contact_email: contact.email ?? null,
      address: input.location ?? null,
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    return { ok: false, error: "Could not create the appointment." };
  }

  const appointmentId = inserted.id as string;

  // NOTE: the post-booking lifecycle (confirmation email + owner/assignee
  // notification) is deliberately NOT called from this handler — see this
  // file's own header. It is invoked by agent-approve-action.ts
  // immediately after this handler's result is verified, on the
  // netlify/functions/ side, where appointment-post-booking.ts's
  // nodemailer dependency belongs. A booking still succeeds here
  // independently of whether that later step runs or fails.
  return { ok: true, output: { appointmentId, startsAt: start.toISOString(), endsAt: end.toISOString(), timeZone } };
};

type GetAvailabilityInput = {
  date: string;
  durationMinutes: number;
  assignedTo?: string | null;
  appointmentType?: AppointmentTypeValue | null;
};
type GetAvailabilityOutput = { slots: SlotCandidate[]; timeZone: string };

/**
 * Scheduling foundation — Phase 1/3 wiring. Read-only (riskLevel "read",
 * never mutates, never contacts the customer — see action-registry.ts).
 * Deliberately NOT wired into any agent prompt yet (the real Scheduling
 * Agent is a later phase) — this exists so the availability core is
 * directly, manually testable through the SAME action-executor pipeline
 * every other action goes through, without any routing/handoff change.
 * Fails closed exactly like scheduleAppointment: any
 * availability_check_failed from the core becomes a plain handler error,
 * never an empty-but-implicitly-"nothing available" result that could be
 * misread as authoritative.
 */
export const getAvailability: ActionHandler<GetAvailabilityInput, GetAvailabilityOutput> = async (ctx, input) => {
  const tz = await resolveOrgTimezone({ supabase: ctx.supabase }, ctx.orgId);
  if (tz.status !== "resolved") {
    return { ok: false, error: "Could not resolve the organization's timezone." };
  }
  if (input.appointmentType && !APPOINTMENT_TYPES.includes(input.appointmentType)) {
    return { ok: false, error: "Invalid appointment type." };
  }
  const result = await getAvailableSlots(
    { supabase: ctx.supabase },
    {
      orgId: ctx.orgId,
      date: input.date,
      durationMinutes: input.durationMinutes,
      timeZone: tz.timeZone,
      assignedTo: input.assignedTo ?? null,
      appointmentType: input.appointmentType ?? null,
    },
  );
  if (result.status !== "ok") {
    return { ok: false, error: "Could not determine availability." };
  }
  return { ok: true, output: { slots: result.slots, timeZone: tz.timeZone } };
};

type GetAppointmentTypesOutput = { appointmentTypes: AppointmentTypeValue[] };

/** Read-only. Returns the one canonical server-side appointment-type set —
 * see APPOINTMENT_TYPES's own comment for why this is never a second,
 * divergent list. No DB query — the DB CHECK constraint IS this list. */
export const getAppointmentTypes: ActionHandler<Record<string, never>, GetAppointmentTypesOutput> = async () => {
  return { ok: true, output: { appointmentTypes: [...APPOINTMENT_TYPES] } };
};
