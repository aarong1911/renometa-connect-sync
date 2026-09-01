// netlify/functions/conversation-message-state.ts
//
// The ONLY authorized way to change sms_meta_messages.is_read or
// .deleted_at. Replaces the browser-side
//   supabase.from("sms_meta_messages").update(...)
// call that used to live in src/lib/sms-meta-conversations.ts.
//
// WHY THIS FUNCTION EXISTS (live-database finding, not a hypothetical):
// sms_meta_messages has RLS enabled with exactly ONE policy — SELECT only
// (sms_meta_messages_select_own_org). But a live grants query found `anon`
// AND `authenticated` both still hold table-level UPDATE privilege on this
// table, independent of RLS. With no UPDATE policy, every row's RLS check
// for UPDATE evaluates to "no policy matches" — Postgres RLS defaults deny,
// so the old client-side .update({ is_read: true }) call was likely just
// silently failing in production (a real, live contributor to "sidebar
// Conversations = 5 while Unread folder = 0": local optimistic state
// flipped in the browser, but the persisted row never actually changed).
// Adding an UPDATE *policy* to fix that would have been worse: RLS can
// restrict which ROWS a caller may touch, but NOT which COLUMNS a single
// UPDATE statement changes — combined with the pre-existing grant, any
// org-scoped UPDATE policy would let an authenticated browser client
// directly rewrite body/channel/direction/contact_id/from_address/
// provider_message_id/meta/created_at on any row in their own org, not
// just flip is_read. So: no RLS policy is added for this. This function
// uses the service-role client (which bypasses RLS entirely by design,
// same as every other write path in this codebase — see
// netlify-supabase-functions.skill) and only ever writes exactly the one
// column each action needs, via a fixed, narrow UPDATE — never a
// caller-supplied field list. There is no generic/arbitrary update action
// here and there must never be one.
//
// AUTH PATTERN: reused verbatim from resolveOrgFromBearerToken (see
// smtp-config-status.ts for the canonical example of this exact shape) —
// org_id is ALWAYS derived server-side from the caller's JWT
// (profiles.organization_id, org_memberships fallback), never trusted from
// the request body. Every query below additionally filters by that
// server-derived org_id, so a request naming a real message_id/contact_id
// that belongs to a different org matches zero rows rather than leaking
// cross-org state.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const CHANNELS = ["sms", "whatsapp", "messenger", "instagram"] as const;
type Channel = (typeof CHANNELS)[number];
function isChannel(value: unknown): value is Channel {
  return typeof value === "string" && (CHANNELS as readonly string[]).includes(value);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ReqBody = {
  action?: "mark_conversation_read" | "mark_conversation_unread" | "delete_message" | string;
  contact_id?: string;
  channel?: string;
  message_id?: string;
};

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // ── Authenticate + resolve org server-side (never from the body) ───────
  const resolved = await resolveOrgFromBearerToken(supabaseAdmin, event.headers.authorization);
  if (!resolved) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized" }) };
  }
  const { orgId } = resolved;

  let reqBody: ReqBody;
  try {
    reqBody = event.body ? JSON.parse(event.body) : {};
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  // ── A. mark_conversation_read ───────────────────────────────────────────
  // Flips is_read on inbound, currently-unread, not-deleted messages for
  // ONE (org, contact, channel) conversation. Never touches direction='out'
  // rows (they can't be unread — see the check below and
  // sms-meta-conversations.ts's own original comment to the same effect).
  if (reqBody.action === "mark_conversation_read") {
    const { contact_id, channel } = reqBody;
    if (typeof contact_id !== "string" || !UUID_RE.test(contact_id)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "contact_id is required" }) };
    }
    if (!isChannel(channel)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "channel is required" }) };
    }

    // NO deleted_at predicate here — supabase/migrations/
    // 20260908_sms_meta_messages_soft_delete.sql (which adds that column)
    // is still UNAPPLIED. This query previously included
    // `.is("deleted_at", null)`, which made EVERY mark_conversation_read
    // call fail server-side ("column deleted_at does not exist" — a
    // genuine Postgres error, not an RLS/auth failure), returned as a 500
    // the client already treats as a normal failure (logged, swallowed,
    // no retry) — i.e. this one line was the actual, complete root cause
    // of "reading a conversation never persists is_read". Confirmed fixed
    // by removing it. Re-add `.is("deleted_at", null)` ONLY after that
    // migration is applied and confirmed live.
    const { error, count } = await supabaseAdmin
      .from("sms_meta_messages")
      .update({ is_read: true }, { count: "exact" })
      .eq("org_id", orgId)
      .eq("contact_id", contact_id)
      .eq("channel", channel)
      .eq("direction", "in")
      .eq("is_read", false);

    if (error) {
      // Safe diagnostics only — action name, channel, error message/code.
      // Never the message body, JWT, or any token.
      console.error("[conversation-message-state] mark_conversation_read failed:", {
        channel, code: (error as any).code, message: error.message,
      });
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Could not mark conversation as read" }) };
    }

    console.log("[conversation-message-state] mark_conversation_read ok:", { channel, updated: count ?? 0 });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, updated: count ?? 0 }) };
  }

  // ── A2. mark_conversation_unread ────────────────────────────────────────
  // Message-based unread semantics (matching mark_conversation_read/
  // unreadCount everywhere else in this app): does NOT reset every
  // historical message — only the single MOST RECENT inbound message in
  // this (org, contact, channel) conversation is flipped back to
  // is_read=false, so unreadCount becomes exactly 1. Outbound messages are
  // never touched (mirrors mark_conversation_read's own direction='in'
  // restriction). If the conversation has no inbound message at all, this
  // is a safe, explicit no-op (200 with updated: 0) rather than fabricating
  // unread state on a row that was never actually unread-capable.
  if (reqBody.action === "mark_conversation_unread") {
    const { contact_id, channel } = reqBody;
    if (typeof contact_id !== "string" || !UUID_RE.test(contact_id)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "contact_id is required" }) };
    }
    if (!isChannel(channel)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "channel is required" }) };
    }

    // Find the latest inbound message id first — no deleted_at predicate,
    // same reason as mark_conversation_read above (column doesn't exist
    // yet; the migration adding it is still unapplied).
    const { data: latestInbound, error: findErr } = await supabaseAdmin
      .from("sms_meta_messages")
      .select("id")
      .eq("org_id", orgId)
      .eq("contact_id", contact_id)
      .eq("channel", channel)
      .eq("direction", "in")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (findErr) {
      console.error("[conversation-message-state] mark_conversation_unread lookup failed:", {
        channel, code: (findErr as any).code, message: findErr.message,
      });
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Could not mark conversation as unread" }) };
    }
    if (!latestInbound) {
      // No inbound message exists in this conversation at all — nothing
      // to mark unread. Explicit no-op, not an error.
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, updated: 0 }) };
    }

    const { error: updateErr, count } = await supabaseAdmin
      .from("sms_meta_messages")
      .update({ is_read: false }, { count: "exact" })
      .eq("id", latestInbound.id)
      .eq("org_id", orgId);

    if (updateErr) {
      console.error("[conversation-message-state] mark_conversation_unread update failed:", {
        channel, code: (updateErr as any).code, message: updateErr.message,
      });
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Could not mark conversation as unread" }) };
    }

    console.log("[conversation-message-state] mark_conversation_unread ok:", { channel, updated: count ?? 0 });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, updated: count ?? 0 }) };
  }

  // ── B. delete_message ───────────────────────────────────────────────────
  // CRM-local soft delete ONLY — sets deleted_at, never issues a real SQL
  // DELETE, never calls any provider API. This does not unsend, recall, or
  // remove the message from Instagram/Messenger/WhatsApp/the SMS carrier;
  // it only stops it from being shown in RenoMeta. The org_id filter below
  // is what makes this "resolve the message under the caller's authorized
  // org first" — a message_id belonging to a different org simply matches
  // zero rows, never a cross-org write and never a distinguishable error
  // (same "not found" either way, so this can't be used to probe whether an
  // id exists in another org).
  if (reqBody.action === "delete_message") {
    // TEMPORARILY DISABLED: supabase/migrations/
    // 20260908_sms_meta_messages_soft_delete.sql (adds deleted_at) is still
    // UNAPPLIED. The real implementation (below, in
    // runDeleteMessage — never called right now) needs that column and
    // would otherwise 500 with a genuine "column does not exist" error —
    // the same class of bug just fixed in mark_conversation_read above.
    // The client-side "Delete message" menu item is also not rendered
    // right now for the same reason (see MessageBubble in inbox.tsx).
    // Switch this back to `return runDeleteMessage(orgId, reqBody)` only
    // after the migration is applied and confirmed live.
    return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: "Message deletion is not enabled yet" }) };
  }

  return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Unknown action" }) };
};

// CRM-local soft delete — sets deleted_at, never issues a real SQL DELETE,
// never calls any provider API. This does not unsend, recall, or remove
// the message from Instagram/Messenger/WhatsApp/the SMS carrier; it only
// stops it from being shown in RenoMeta. The org_id filter is what makes
// this "resolve the message under the caller's authorized org first" — a
// message_id belonging to a different org simply matches zero rows, never
// a cross-org write and never a distinguishable error (same "not found"
// either way, so this can't be used to probe whether an id exists in
// another org).
//
// NOT CALLED right now — see the `delete_message` branch above, disabled
// until the deleted_at migration is applied. Kept here, fully written, so
// re-enabling later is a one-line change instead of rewriting this.
async function runDeleteMessage(orgId: string, reqBody: ReqBody) {
  const { message_id } = reqBody;
  if (typeof message_id !== "string" || !UUID_RE.test(message_id)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "message_id is required" }) };
  }

  const { data, error } = await supabaseAdmin
    .from("sms_meta_messages")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", message_id)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[conversation-message-state] delete_message failed:", error.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Could not delete this message" }) };
  }
  if (!data) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: "Message not found" }) };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, id: data.id }) };
}
