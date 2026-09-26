// netlify/functions/lib/gmail-sent-reconcile.ts
//
// Immediate persistence + later reconciliation of outbound emails sent from
// Conversations (send-inbox-message.ts, Gmail SMTP via nodemailer).
//
// Identifiers — kept strictly separate:
//   - RFC Message-ID   nodemailer's `sendResult.messageId` ("<…@…>"). Stored,
//                      normalized (see normalizeRfcMessageId), in
//                      gmail_messages.rfc_message_id — the reconciliation key
//                      (UNIQUE per org where not null).
//   - provider_message_id  the same nodemailer value, informational only
//                      (never used for matching).
//   - gmail_messages.id    PRIMARY KEY. Temporary "smtp:<normalized id>" for a
//                      row created at send time; becomes the real Gmail API
//                      message id once gmail-sync.ts imports the same message.
//   - thread_id        NOT NULL. Reply -> the existing Gmail thread id.
//                      Brand-new email -> "smtp-thread:<normalized id>"; when
//                      Gmail sync later returns the real thread id, its
//                      upsert overwrites thread_id on the (re-keyed) row.
//
// Ordering guarantee (unique (org_id, rfc_message_id)): the sync must re-key
// the temporary row to the real Gmail id BEFORE its upsert, so the row is
// updated in place and two rows with the same Message-ID never coexist.

import type { SupabaseClient } from "@supabase/supabase-js";

export const SMTP_SENT_ID_PREFIX = "smtp:";
export const SMTP_THREAD_ID_PREFIX = "smtp-thread:";

/** Canonical "<id@host>" form: trimmed, exactly one pair of angle brackets. */
export function normalizeRfcMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const inner = raw.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
  return inner ? `<${inner}>` : null;
}

export type SmtpSentEmailInput = {
  orgId: string;
  messageId: string;
  threadId?: string | null;
  fromEmail: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string | null;
  references?: string | null;
  now?: Date;
};

export function buildSmtpSentRow(input: SmtpSentEmailInput): Record<string, unknown> | null {
  const rfcId = normalizeRfcMessageId(input.messageId);
  if (!rfcId) return null;
  const bare = rfcId.slice(1, -1);
  return {
    id: `${SMTP_SENT_ID_PREFIX}${bare}`,
    org_id: input.orgId,
    thread_id: input.threadId || `${SMTP_THREAD_ID_PREFIX}${bare}`,
    internal_date: (input.now ?? new Date()).toISOString(),
    snippet: input.body,
    // The full text that was actually sent (send-inbox-message.ts sends it as
    // text/plain), so the thread shows the whole message immediately and it
    // survives the later re-key to the real Gmail id (see reconcileSmtpSentRows).
    body_text: input.body,
    from_email: input.fromEmail,
    to_emails: [input.to],
    subject: input.subject,
    // The Conversations reader derives direction from the SENT label.
    labels: ["SENT"],
    direction: "out",
    rfc_message_id: rfcId,
    in_reply_to: input.inReplyTo ?? null,
    references_header: input.references ?? null,
    provider_message_id: rfcId,
  };
}

/**
 * Called ONLY after sendMail() succeeded. Never throws: the email is already
 * delivered, so a failure here must be reported as persisted:false, not as a
 * send failure (which would invite a duplicate resend).
 */
export async function persistSmtpSentEmail(
  supabase: SupabaseClient,
  input: SmtpSentEmailInput,
): Promise<{ persisted: boolean }> {
  const row = buildSmtpSentRow(input);
  if (!row) return { persisted: false };
  try {
    let { error } = await supabase.from("gmail_messages").insert(row);
    if (error && error.code !== "23505" && /body_text/i.test(error.message ?? "")) {
      // The body_text migration has not been applied yet: persist without it
      // rather than lose the immediate-outbound row (snippet still holds the text).
      const { body_text: _omit, ...withoutBody } = row as Record<string, unknown>;
      ({ error } = await supabase.from("gmail_messages").insert(withoutBody));
    }
    // 23505: this Message-ID/id is already stored — the row exists.
    if (error && error.code !== "23505") {
      console.error("[gmail-sent-reconcile] insert failed:", error.message);
      return { persisted: false };
    }
    return { persisted: true };
  } catch (e: any) {
    console.error("[gmail-sent-reconcile] insert threw:", e?.message);
    return { persisted: false };
  }
}

/**
 * Re-keys temporary SMTP rows to the real Gmail id for messages in this sync
 * batch. Org-isolated, outbound-only (SENT label + smtp: id), idempotent,
 * no-op when nothing matches.
 */
export async function reconcileSmtpSentRows(
  supabase: SupabaseClient,
  orgId: string,
  fetchedRows: Array<{ id: string; rfc_message_id?: string | null; direction?: string | null; body_text?: string | null }>,
): Promise<{ rekeyed: number; failed: number }> {
  const realIdByRfc = new Map<string, string>();
  const fetchedByRealId = new Map<string, { body_text?: string | null }>();
  for (const r of fetchedRows) {
    const key = normalizeRfcMessageId(r.rfc_message_id);
    if (key && r.direction === "out" && !r.id.startsWith(SMTP_SENT_ID_PREFIX)) {
      realIdByRfc.set(key, r.id);
      fetchedByRealId.set(r.id, r);
    }
  }
  if (realIdByRfc.size === 0) return { rekeyed: 0, failed: 0 };

  const { data: existing, error } = await supabase
    .from("gmail_messages")
    .select("id, rfc_message_id, labels, body_text")
    .eq("org_id", orgId)
    .in("rfc_message_id", [...realIdByRfc.keys()]);
  if (error) {
    console.error("[gmail-sent-reconcile] lookup failed:", error.message);
    return { rekeyed: 0, failed: 0 };
  }

  let rekeyed = 0;
  let failed = 0;
  for (const row of (existing ?? []) as Array<{ id: string; rfc_message_id: string; labels?: string[] | null; body_text?: string | null }>) {
    const realId = realIdByRfc.get(row.rfc_message_id);
    const isTempOutbound = row.id.startsWith(SMTP_SENT_ID_PREFIX) && Array.isArray(row.labels) && row.labels.includes("SENT");
    if (!realId || row.id === realId || !isTempOutbound) continue;
    // The batch's upsert (gmail-sync.ts) rewrites body_text from Gmail. If Gmail
    // yielded no text for this message, keep the text we stored at send time
    // instead of overwriting it with an empty value.
    const incoming = fetchedByRealId.get(realId);
    if (incoming && !incoming.body_text && row.body_text) incoming.body_text = row.body_text;
    const { error: updErr } = await supabase
      .from("gmail_messages")
      .update({ id: realId })
      .eq("org_id", orgId)
      .eq("id", row.id);
    if (updErr) {
      console.error("[gmail-sent-reconcile] re-key failed:", updErr.message);
      failed++;
    } else {
      rekeyed++;
    }
  }
  return { rekeyed, failed };
}
