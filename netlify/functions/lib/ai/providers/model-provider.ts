// netlify/functions/lib/ai/providers/model-provider.ts
//
// AI Center — Phase AI-1, foundation component #1.
//
// Provider-neutral contract for talking to an LLM. Nothing outside a
// concrete provider implementation (e.g. ./anthropic.ts) should need to
// know which vendor is behind `ModelProvider.run()`, what that vendor's
// request/response JSON looks like, or which HTTP transport it uses.
//
// Per the ai-center skill's "Model Provider Architecture" section: the
// orchestrator, router, tool registry, and agents must depend only on the
// types below — never on an Anthropic- or OpenAI-specific response shape.
//
// This file intentionally contains no Anthropic/OpenAI-specific code, no
// Supabase access, no CRM logic, and no cost/pricing math (pricing lives in
// src/lib/agentic/usage.ts and is applied by the future orchestrator using
// the token counts returned in ModelResponse.usage).

/** A single turn in the conversation sent to the model. System instructions
 * are NOT a message — they go on `ModelRequest.system`, matching how every
 * provider we're likely to support (Anthropic, OpenAI) separates the two. */
export type ModelMessageRole = "user" | "assistant";

export interface ModelMessage {
  role: ModelMessageRole;
  content: string;
}

/** A provider-neutral request to run one model turn. */
export interface ModelRequest {
  /** Provider-specific model identifier (e.g. "claude-haiku-4-5-20251001").
   * Deliberately required and un-defaulted here — model selection is an
   * agent-configuration concern, not something a shared provider layer
   * should decide. See ANTHROPIC_MODEL constant in anthropic.ts for the
   * one narrow exception this task allows. */
  model: string;
  /** System-level instructions/persona for the model. Optional — a bare
   * completion request may omit it. */
  system?: string;
  /** Conversation turns, oldest first. Must contain at least one message. */
  messages: ModelMessage[];
  /** Hard cap on generated tokens. Required so callers make a deliberate
   * choice rather than relying on a provider's own default. */
  maxTokens: number;
  /** Sampling temperature, only if the underlying provider supports it. */
  temperature?: number;
  /** Hints that the caller wants the model's text to be machine-parseable
   * (e.g. JSON). This is advisory only: the provider does not validate,
   * parse, or enforce structure — see this file's header and the
   * anthropic.ts implementation notes. Structured-output validation is the
   * orchestrator/tool layer's responsibility, not the provider's. */
  expectStructuredOutput?: boolean;
  /** Free-form, provider-agnostic metadata for logging/tracing (e.g. a
   * caller-assigned request id). Never used to build URLs, and never
   * forwarded verbatim into provider request bodies. */
  metadata?: Record<string, unknown>;
}

/** Token accounting for a single ModelProvider.run() call. Field names
 * match src/lib/agentic/usage.ts's RecordUsageInput (inputTokens/
 * outputTokens) so the future orchestrator can pass this straight through
 * to recordUsageEvent() without reshaping it. */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

/** A provider-neutral result. Nothing here is Anthropic- or OpenAI-shaped —
 * see each provider file for how its own response JSON is translated into
 * this. */
export interface ModelResponse {
  /** The model's generated text. Guaranteed non-empty — a provider must
   * reject (throw) rather than return a response with no usable text. */
  text: string;
  /** The exact model id the provider actually used. */
  model: string;
  /** Provider-reported reason generation stopped, if available
   * (e.g. Anthropic's "end_turn" / "max_tokens" / "stop_sequence"). Kept as
   * a plain string rather than a provider-specific union so callers don't
   * need to know every vendor's vocabulary. */
  stopReason?: string;
  usage: ModelUsage;
  /** Short provider identifier, e.g. "anthropic". Lets a caller log/branch
   * without importing the concrete provider module. */
  provider: string;
  /** The provider's own request/message id, if it returns one — useful for
   * support escalations. Never contains the API key or any header value. */
  providerRequestId?: string;
}

/** The one interface the rest of AI Center depends on. */
export interface ModelProvider {
  /** Short, stable identifier for this provider (e.g. "anthropic"). */
  readonly name: string;
  run(request: ModelRequest): Promise<ModelResponse>;
}

// ── Typed errors ──────────────────────────────────────────────────────────
//
// Kept provider-neutral and here (not in anthropic.ts) so callers can
// `instanceof`-check them without importing a specific provider's module.

export type ModelProviderErrorCode =
  | "config"
  | "http"
  | "malformed_response"
  | "empty_response";

export abstract class ModelProviderError extends Error {
  abstract readonly code: ModelProviderErrorCode;
  readonly provider: string;

  constructor(provider: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.provider = provider;
    this.name = new.target.name;
  }
}

/** Required configuration (e.g. an API key) is missing or invalid. */
export class ModelProviderConfigError extends ModelProviderError {
  readonly code = "config" as const;
}

/** The provider's HTTP API returned a non-2xx response. `status` is the
 * HTTP status code; `message` is a sanitized, human-readable summary —
 * never the raw response headers (which could include rate-limit or
 * infra details worth keeping out of logs surfaced to end users). */
export class ModelProviderHttpError extends ModelProviderError {
  readonly code = "http" as const;
  readonly status: number;

  constructor(provider: string, status: number, message: string, options?: { cause?: unknown }) {
    super(provider, message, options);
    this.status = status;
  }
}

/** The provider returned a 2xx response, but its body didn't match the
 * shape this implementation knows how to parse. */
export class ModelProviderMalformedResponseError extends ModelProviderError {
  readonly code = "malformed_response" as const;
}

/** The provider returned a well-formed response with no usable generated
 * text (e.g. an empty content array). */
export class ModelProviderEmptyResponseError extends ModelProviderError {
  readonly code = "empty_response" as const;
}
