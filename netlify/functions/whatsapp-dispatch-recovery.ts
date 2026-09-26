/**
 * whatsapp-dispatch-recovery.ts
 * Netlify Scheduled Function (every 2 minutes — see netlify.toml).
 *
 * Safety net for inbound WhatsApp messages whose fire-and-forget dispatch to
 * ai-whatsapp-orchestrate-background never started. It only re-drives that
 * SAME internal endpoint; it never runs the AI or touches approvals. See
 * lib/meta-whatsapp-recovery.ts for the recoverable-message definition and
 * the safety argument.
 *
 * Scheduled functions run only on published deploys, are not invokable through
 * a production URL, and receive the body {"next_run": "<ISO>"}; they have a 30 s
 * execution limit, which the sweep stays well inside (see the recovery lib).
 * The handler accepts only that scheduled shape or the internal secret; it
 * never trusts the User-Agent.
 */

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { dispatchWhatsAppOrchestrationChecked } from "./lib/meta-whatsapp-inbound";
import { RECOVERY_DISPATCH_TIMEOUT_MS, isAuthorizedSweepRequest, runWhatsAppDispatchRecovery } from "./lib/meta-whatsapp-recovery";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

export const handler: Handler = async (event) => {
  if (!isAuthorizedSweepRequest(event.headers ?? {}, event.body, process.env.AI_WHATSAPP_INTERNAL_DISPATCH_SECRET)) {
    console.error("[whatsapp-recovery] rejected unauthenticated invocation.", { userAgent: event.headers?.["user-agent"] });
    return { statusCode: 403, body: "" };
  }
  try {
    const summary = await runWhatsAppDispatchRecovery(supabaseAdmin, {
      dispatch: (payload) => dispatchWhatsAppOrchestrationChecked(payload, { timeoutMs: RECOVERY_DISPATCH_TIMEOUT_MS }),
    });
    return { statusCode: 200, body: JSON.stringify(summary) };
  } catch (err) {
    console.error("[whatsapp-recovery] sweep crashed:", err instanceof Error ? err.message : err);
    return { statusCode: 500, body: "error" };
  }
};
