// netlify/functions/lib/sms-reply-mode.ts
//
// AI-2D — Simple AI SMS Reply Mode. The ENTIRE user-facing setting: may AI
// reply automatically to someone who just texted us, or must a human
// review first? Stored at organizations.ai_center_settings.smsReplies.mode
// (additive jsonb key, no migration — same column AI-1M's emergencyPaused
// and AI-2C.1's smsCompliance.helpReply already live on).
//
// This is deliberately NOT a general autonomy/policy-engine setting — see
// the ai-center skill and this pass's own report for why it must stay
// narrowly scoped to "AI-generated replies to a trusted inbound SMS
// conversation" and nothing else (no proactive sends, no campaigns, no
// other action types). The actual scope enforcement lives in
// src/lib/agentic/action-executor.ts's `autoApprovedSmsReply` parameter
// (hardcoded to only ever affect the `send_sms` action key) and in
// ai-twilio-sms-orchestrate-background.ts (the only caller that ever sets
// it, and only for a verified reactive inbound SMS reply) — this file is
// just the settings read/parse, not an enforcement point itself.

import type { SupabaseClient } from "@supabase/supabase-js";

export type SmsReplyMode = "review" | "automatic";

/**
 * Defensive parse — fail closed to "review" for anything that isn't
 * EXACTLY the literal string "automatic": missing value, wrong type,
 * unrecognized future value, malformed object. There is no "unsafe"
 * direction to fail open toward here; every non-"automatic" outcome
 * preserves the current, already-shipped review-and-approve flow.
 */
export function parseSmsReplyMode(smsRepliesValue: unknown): SmsReplyMode {
  if (smsRepliesValue && typeof smsRepliesValue === "object" && !Array.isArray(smsRepliesValue)) {
    const mode = (smsRepliesValue as Record<string, unknown>).mode;
    if (mode === "automatic") return "automatic";
  }
  return "review";
}

/**
 * Loads the org's current SMS reply mode fresh from the database — never
 * cached, never read once at the top of a long-running orchestration.
 * Callers on the send path (ai-twilio-sms-orchestrate-background.ts) MUST
 * call this AFTER model generation completes, immediately before deciding
 * how to route the send, specifically so a mode change that happens while
 * the model is still "thinking" is honored rather than a stale value
 * captured before generation started (see this pass's "POLICY RACE"
 * report section). A read failure fails closed to "review", matching
 * policy-resolver.ts's own fail-closed convention for emergencyPaused.
 */
export async function loadSmsReplyMode(supabase: SupabaseClient, orgId: string): Promise<SmsReplyMode> {
  const { data, error } = await supabase
    .from("organizations")
    .select("ai_center_settings")
    .eq("id", orgId)
    .maybeSingle();
  if (error) {
    console.error("[sms-reply-mode] loadSmsReplyMode lookup failed — failing safe (review):", error);
    return "review";
  }
  const settings = data?.ai_center_settings;
  const smsReplies =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).smsReplies
      : undefined;
  return parseSmsReplyMode(smsReplies);
}
