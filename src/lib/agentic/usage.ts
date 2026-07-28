// src/lib/agentic/usage.ts
//
// Phase 9.6 — Priority 14. Provider-neutral usage/cost tracking. ONE
// central pricing table (per Priority 14: "do not hardcode model prices
// into many files" — the existing run-agent.ts hardcodes a haiku rate
// inline and mis-prices sonnet-model agents, per the Phase 9.6 audit; this
// module exists so that mistake isn't repeated for agentic executions).
//
// All costs produced here are ESTIMATES. No provider used in this stack
// exposes exact invoiced billing via API response, so `isEstimated` is
// always true and UI must never present this as an invoice.

import type { SupabaseClient } from "@supabase/supabase-js";

// USD per 1M tokens. Update here — nowhere else — when pricing changes.
const PRICING_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "claude-sonnet-5": { input: 3.0, output: 15.0 },
  "claude-opus-4-8": { input: 15.0, output: 75.0 },
};

const FALLBACK_PRICING = { input: 1.0, output: 5.0 };

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const rate = PRICING_PER_MILLION_TOKENS[model] ?? FALLBACK_PRICING;
  return (inputTokens / 1_000_000) * rate.input + (outputTokens / 1_000_000) * rate.output;
}

export type RecordUsageInput = {
  orgId: string;
  agentInstanceId?: string | null;
  executionId?: string | null;
  executionStepId?: string | null;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  toolCallCount?: number;
  latencyMs?: number;
};

export async function recordUsageEvent(supabase: SupabaseClient, input: RecordUsageInput) {
  const inputTokens = input.inputTokens ?? 0;
  const outputTokens = input.outputTokens ?? 0;
  const estimatedCostUsd = estimateCostUsd(input.model, inputTokens, outputTokens);

  const { error } = await supabase.from("agent_usage_events").insert({
    org_id: input.orgId,
    agent_instance_id: input.agentInstanceId ?? null,
    execution_id: input.executionId ?? null,
    execution_step_id: input.executionStepId ?? null,
    provider: input.provider,
    model: input.model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cached_tokens: input.cachedTokens ?? 0,
    tool_call_count: input.toolCallCount ?? 0,
    latency_ms: input.latencyMs ?? null,
    estimated_cost_usd: estimatedCostUsd,
    is_estimated: true,
  });

  if (error) console.error("[agentic/usage] recordUsageEvent failed:", error);
  return estimatedCostUsd;
}

/** en-US currency formatting per Priority 14 — use this everywhere a cost is shown, not ad hoc toFixed() calls. */
export function formatEstimatedCostUsd(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(amount);
}
