// netlify/functions/marketing-unsubscribe.ts
//
// Public (no-login) email-unsubscribe endpoint. Per Phase 14.1 spec this
// must NEVER be an enumerable link like ?contactId=<uuid> — the only thing
// a recipient's browser ever sees is an opaque, unpredictable token minted
// into marketing_unsubscribe_tokens at send time (see
// marketing-campaign-process-queue.ts, which mints one per sent email via
// crypto.randomBytes).
//
// GET  ?token=xxx  -> resolves the token and returns an HTML confirmation
//                     PAGE (contact/org name + a "Confirm unsubscribe"
//                     button). Deliberately never mutates on GET — email
//                     clients, corporate mail gateways, and link-safety
//                     scanners routinely prefetch/HEAD-probe every URL in
//                     an email via GET, and a GET that unsubscribed on
//                     contact would let a scanner silently unsubscribe
//                     real recipients who never clicked anything. This is
//                     the actual root cause of the Phase 14.1 real-E2E
//                     bug found in manual testing: the email footer links
//                     directly to this GET endpoint with no page/script
//                     anywhere in the app that ever followed up with the
//                     POST that performs the real mutation — a human
//                     opening the link in a browser only ever saw the raw
//                     JSON this GET handler used to return, and nothing
//                     ever wrote to marketing_contact_preferences. The fix
//                     is this GET handler now returning a real, self-
//                     contained HTML page with a plain <form method="POST">
//                     (no JS/build step/separate route required) so a
//                     human click reliably reaches the POST branch below.
// POST { token }   -> marks the contact unsubscribed via
//                     marketing_contact_preferences (the dedicated
//                     service-role-owned preference table — see the
//                     pre-apply hardening pass; this endpoint never writes
//                     to `contacts` itself), consumes the token. Accepts
//                     both a JSON body (`{"token":"..."}`, for any future
//                     programmatic caller) and a standard HTML form POST
//                     (`application/x-www-form-urlencoded`, what the GET
//                     page's <form> submits) — response format mirrors
//                     whichever the caller used (JSON in, JSON out; form
//                     in, HTML confirmation page out), so a plain-HTML
//                     form submission never dead-ends on an unrendered
//                     JSON blob the way the original bug did.
//
// Idempotent by design: a token that was already used returns 200 with
// alreadyUnsubscribed/ok:true on a repeat GET/POST (double-click, browser
// back+resubmit) rather than a confusing error — it is only ever a 404 when
// the token never existed or has genuinely expired, which are the only
// cases that indicate something is actually wrong.
//
// Scope: unsubscribes EMAIL only. Never touches sms_status — the two
// channels are independent per spec; SMS opt-out is handled exclusively by
// the inbound Twilio STOP webhook (marketing-sms-inbound.ts).

import type { Handler, HandlerEvent } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
// This page is reached from a real recipient's inbox and mutates account
// preference state — it must never be cached by the browser/any
// intermediary (a cached "Confirm unsubscribe" or "You've been
// unsubscribed" page could show stale state on back/forward), must never
// be sniffed as anything other than HTML, and never leaks the referring
// URL (which contains the opaque token) onward via a Referer header if
// this page ever linked out anywhere.
const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const CORS = JSON_HEADERS; // kept for the few remaining JSON-only responses (errors, OPTIONS)

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Inline SVG icons only — no external image/font/script requests, so this
// public, unauthenticated page has zero third-party dependencies.
const ICONS: Record<"success" | "info" | "error", string> = {
  success: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
  info: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`,
  error: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
};
const ICON_BG: Record<"success" | "info" | "error", string> = { success: "#16a34a", info: "#64748b", error: "#dc2626" };

// Single branded page shell for every state this endpoint can render
// (confirm-prompt, success, already-unsubscribed, invalid link, server
// error) — one template so they can never visually drift from each other.
// System-font stack only (no external font requests); light background,
// centered card, restrained border, no third-party scripts.
function renderPage(opts: {
  icon: "success" | "info" | "error";
  heading: string;
  supporting: string;
  secondary?: string;
  footer?: string;
  formToken?: string; // presence renders a "Confirm unsubscribe" button that POSTs this token
}, statusCode = 200): { statusCode: number; headers: typeof HTML_HEADERS; body: string } {
  const { icon, heading, supporting, secondary, footer, formToken } = opts;
  return {
    statusCode,
    headers: HTML_HEADERS,
    body: `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(heading)}</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #f6f7f8; padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #111827;
  }
  .card {
    width: 100%; max-width: 400px; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06); padding: 36px 28px; text-align: center;
  }
  .icon {
    width: 52px; height: 52px; border-radius: 50%; background: ${ICON_BG[icon]};
    display: flex; align-items: center; justify-content: center; margin: 0 auto 20px;
  }
  h1 { font-size: 19px; font-weight: 600; margin: 0 0 10px; color: #111827; }
  p.supporting { font-size: 14px; line-height: 1.55; color: #4b5563; margin: 0 0 8px; }
  p.secondary { font-size: 13px; line-height: 1.5; color: #9ca3af; margin: 0; }
  form { margin-top: 22px; }
  button {
    background: #111827; color: #fff; border: none; border-radius: 8px;
    padding: 11px 22px; font-size: 14px; font-weight: 500; cursor: pointer; width: 100%;
  }
  button:hover { background: #1f2937; }
  .footer { margin-top: 24px; font-size: 11px; color: #c1c5cb; letter-spacing: 0.02em; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${ICONS[icon]}</div>
    <h1>${escapeHtml(heading)}</h1>
    <p class="supporting">${supporting}</p>
    ${secondary ? `<p class="secondary">${secondary}</p>` : ""}
    ${formToken ? `<form method="POST" action="">
      <input type="hidden" name="token" value="${escapeHtml(formToken)}" />
      <button type="submit">Confirm unsubscribe</button>
    </form>` : ""}
    ${footer ? `<div class="footer">${escapeHtml(footer)}</div>` : ""}
  </div>
</body>
</html>`,
  };
}

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function resolveToken(token: string) {
  const { data, error } = await supabaseAdmin
    .from("marketing_unsubscribe_tokens")
    .select("id, org_id, contact_id, channel, used_at, expires_at")
    .eq("token", token)
    .maybeSingle();
  if (error || !data) return null;
  if (data.channel !== "email") return null; // this endpoint only ever handles email tokens
  if (new Date(data.expires_at) < new Date()) return null;
  return data; // used_at may already be set — caller decides how to respond
}

// A plain HTML <form> (no JS) always POSTs as application/x-www-form-urlencoded
// — that's how the GET confirmation page below submits. A JSON body is only
// ever sent by a programmatic/future caller. Branching the RESPONSE format
// to match this is what makes the confirm-page flow actually usable by a
// human: a form submission that got a JSON body back would just render as
// unstyled text in the browser, which is functionally the same dead end as
// the original bug (a technically-successful response a human can't act on).
function parsePostBody(event: HandlerEvent): { token: string | undefined; isForm: boolean } {
  const contentType = (event.headers["content-type"] ?? event.headers["Content-Type"] ?? "").toLowerCase();
  const raw = event.body ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return { token: new URLSearchParams(raw).get("token") ?? undefined, isForm: true };
  }
  try {
    return { token: JSON.parse(raw || "{}").token, isForm: false };
  } catch {
    return { token: undefined, isForm: false };
  }
}

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

  const postBody = event.httpMethod === "POST" ? parsePostBody(event) : null;
  const isForm = !!postBody?.isForm;
  const token = event.httpMethod === "GET" ? event.queryStringParameters?.token : postBody?.token;

  if (!token || typeof token !== "string") {
    return isForm
      ? renderPage({ icon: "error", heading: "This unsubscribe link is no longer valid", supporting: "We couldn't update your email preferences using this link." }, 400)
      : { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "token is required" }) };
  }

  const resolved = await resolveToken(token);
  if (!resolved) {
    return event.httpMethod === "GET" || isForm
      ? renderPage({ icon: "error", heading: "This unsubscribe link is no longer valid", supporting: "We couldn't update your email preferences using this link." }, 404)
      : { statusCode: 404, headers: CORS, body: JSON.stringify({ error: "This unsubscribe link is invalid or has expired" }) };
  }

  if (event.httpMethod === "GET") {
    const [{ data: contact }, { data: org }, { data: pref }] = await Promise.all([
      supabaseAdmin.from("contacts").select("full_name").eq("id", resolved.contact_id).maybeSingle(),
      supabaseAdmin.from("organizations").select("name").eq("id", resolved.org_id).maybeSingle(),
      supabaseAdmin.from("marketing_contact_preferences").select("email_unsubscribed").eq("contact_id", resolved.contact_id).maybeSingle(),
    ]);
    const alreadyUnsubscribed = !!resolved.used_at || !!pref?.email_unsubscribed;
    const orgName = org?.name?.trim() || "this sender"; // renderPage() escapes — pass raw, not pre-escaped

    // GET never mutates (see the file header note on why) — the "Confirm
    // unsubscribe" button below is what actually reaches the POST branch
    // on a real human click. Never exposes the token visibly, never shows
    // database IDs/technical detail — only the contact/org display names
    // needed for a human to recognize what they're confirming.
    if (alreadyUnsubscribed) {
      return renderPage({
        icon: "info",
        heading: "You're already unsubscribed",
        supporting: `You are already unsubscribed from marketing emails from ${escapeHtml(orgName)}.`,
        footer: orgName,
      });
    }
    return renderPage({
      icon: "info",
      heading: "Confirm unsubscribe",
      supporting: `Unsubscribe ${escapeHtml(contact?.full_name?.trim() || "this address")} from marketing emails from ${escapeHtml(orgName)}?`,
      footer: orgName,
      formToken: token,
    });
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // Fetched once, reused by both remaining POST outcomes below (idempotent
  // repeat and real success) — only ever display names, never IDs, and
  // only fetched for the form-page response path (the JSON path has no
  // use for them).
  const displayNames = isForm
    ? await (async () => {
        const [{ data: contact }, { data: org }] = await Promise.all([
          supabaseAdmin.from("contacts").select("full_name").eq("id", resolved.contact_id).maybeSingle(),
          supabaseAdmin.from("organizations").select("name").eq("id", resolved.org_id).maybeSingle(),
        ]);
        return { contactName: contact?.full_name?.trim() || "You", orgName: org?.name?.trim() || "this sender" };
      })()
    : null;

  // Idempotent repeat: this exact token already did its job. Report success
  // rather than re-running the write or erroring — a second click/submit
  // should feel like it worked, not like something broke.
  if (resolved.used_at) {
    return isForm
      ? renderPage({
          icon: "info",
          heading: "You're already unsubscribed",
          supporting: `You are already unsubscribed from marketing emails from ${escapeHtml(displayNames!.orgName)}.`,
          footer: displayNames!.orgName,
        })
      : { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, alreadyUnsubscribed: true }) };
  }

  const nowIso = new Date().toISOString();
  const { error: upsertErr } = await supabaseAdmin
    .from("marketing_contact_preferences")
    .upsert(
      { org_id: resolved.org_id, contact_id: resolved.contact_id, email_unsubscribed: true, email_unsubscribed_at: nowIso },
      { onConflict: "contact_id" },
    );
  if (upsertErr) {
    // The endpoint must never report success when this write failed — see
    // the Phase 14.1 real-E2E bug this task fixes. Both response formats
    // return a failure status; nothing downstream of this branch runs.
    console.error("[marketing-unsubscribe] preferences upsert failed:", upsertErr.message);
    return isForm
      ? renderPage({ icon: "error", heading: "We couldn't update your preferences", supporting: "Please try again later." }, 500)
      : { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Could not process unsubscribe — try again" }) };
  }

  const { error: tokenUpdateErr } = await supabaseAdmin
    .from("marketing_unsubscribe_tokens")
    .update({ used_at: nowIso })
    .eq("id", resolved.id);
  if (tokenUpdateErr) {
    // The unsubscribe itself already succeeded — losing the "used" marker
    // only risks a future idempotent no-op re-running the same upsert, not
    // a false report to the recipient. Surface it for observability only.
    console.error("[marketing-unsubscribe] token mark-used failed (unsubscribe still succeeded):", tokenUpdateErr.message);
  }

  return isForm
    ? renderPage({
        icon: "success",
        heading: "You've been unsubscribed",
        supporting: `${escapeHtml(displayNames!.contactName)}, you will no longer receive marketing emails from ${escapeHtml(displayNames!.orgName)}.`,
        secondary: "Your email preferences have been updated successfully.",
        footer: displayNames!.orgName,
      })
    : { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
};
