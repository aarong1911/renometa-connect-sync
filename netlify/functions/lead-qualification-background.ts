/// <reference types="node" />
// netlify/functions/lead-qualification-background.ts
//
// Live Lead Qualification — Phase AI-3C. The durable background dispatch
// endpoint for `lead_created`, same platform convention (filename suffix
// "-background": Netlify returns 202 immediately, keeps running up to 15
// minutes) and same trust-boundary shape as
// ai-whatsapp-orchestrate-background.ts. Fired (never awaited past its own
// 202) by lib/ai/lead-created-hook.ts from every real lead-creation path —
// see that file's header for why provider webhooks must never wait on this.
//
// This handler is deliberately THIN: internal-secret verification, payload
// shape validation, constructing the real service-role client. All actual
// logic (org/lead revalidation, policy, dispatch) lives in
// lib/ai/lead-qualification-background.ts's processLeadQualificationBackground(),
// injectable for testing against the fake Supabase client — same split
// meta-whatsapp-background.ts established.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";
import { processLeadQualificationBackground, isValidLeadQualificationBackgroundPayload } from "./lib/ai/lead-qualification-background";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

function secretsMatch(expected: string, provided: string): boolean {
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");
  if (expectedBuf.length !== providedBuf.length) return false;
  try {
    return timingSafeEqual(expectedBuf, providedBuf);
  } catch {
    return false;
  }
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "" };

  const expectedSecret = process.env.AI_LEAD_QUALIFICATION_INTERNAL_DISPATCH_SECRET;
  const providedSecret = event.headers["x-internal-secret"] ?? event.headers["X-Internal-Secret"];
  if (!expectedSecret || !providedSecret || !secretsMatch(expectedSecret, providedSecret)) {
    console.error("[lead-qualification-background] rejected request with missing/invalid internal secret.");
    return { statusCode: 403, body: "" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, body: "" };
  }
  if (!isValidLeadQualificationBackgroundPayload(payload)) {
    console.error("[lead-qualification-background] malformed payload.");
    return { statusCode: 400, body: "" };
  }

  const result = await processLeadQualificationBackground(payload, { supabase: supabaseAdmin });
  return { statusCode: result.statusCode, body: "" };
};
