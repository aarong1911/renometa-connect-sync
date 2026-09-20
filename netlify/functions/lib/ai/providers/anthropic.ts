// netlify/functions/lib/ai/providers/anthropic.ts
//
// AI Center — Phase AI-1. The Anthropic implementation of ModelProvider.
// This is the ONLY file in AI Center that should know Anthropic's request/
// response JSON shape, its endpoint, or its header conventions.
//
// Reliability note (do not "simplify" this away): calling
// https://api.anthropic.com/v1/messages via the Netlify Functions runtime's
// global `fetch` hangs under `netlify dev` on Windows + Node 24 — the
// lambda-local bootstrap intercepts fetch/https to that host. The existing
// AI Center v1 code (netlify/functions/run-tool.mjs, netlify/functions/
// run-agent.ts) works around this by shelling out to a short-lived child
// Node process, which runs completely outside lambda-local's interception
// and calls the same endpoint with the same headers. That workaround is
// reproduced here unchanged (see callAnthropicMessages()) — replacing it
// with a direct top-level `fetch()` would silently break local development
// again, per the documented gotcha in CLAUDE.md ("Node 24 + netlify dev").
//
// This file must never: touch Supabase, resolve organizations, execute CRM
// operations, execute AI actions/tools, send communications, or compute
// token pricing (see src/lib/agentic/usage.ts for that).

import { execFile } from "node:child_process";
import {
  type ModelMessage,
  type ModelMessageRole,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  ModelProviderConfigError,
  ModelProviderEmptyResponseError,
  ModelProviderHttpError,
  ModelProviderMalformedResponseError,
} from "./model-provider";

const PROVIDER_NAME = "anthropic";

/** Anthropic's required API version header. This is a wire-protocol
 * constant (like an HTTP version), not a model choice — it does not belong
 * in the same category as a model id and is not expected to change without
 * a deliberate, repo-wide review of the Messages API contract. */
const ANTHROPIC_API_VERSION = "2023-06-01";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

/** Child-process call timeout. Matches the value already proven reliable in
 * run-tool.mjs / run-agent.ts. */
const CHILD_PROCESS_TIMEOUT_MS = 55_000;
const CHILD_PROCESS_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export interface AnthropicProviderOptions {
  /** Overrides process.env.ANTHROPIC_API_KEY — mainly for future unit
   * tests, so this provider never has to read process.env directly in a
   * test environment. In production callers should simply omit this. */
  apiKey?: string;
}

/**
 * Creates a ModelProvider backed by Anthropic's Messages API.
 *
 * The API key is resolved once, at creation time, from `options.apiKey` or
 * `process.env.ANTHROPIC_API_KEY` — never read anywhere else in this file,
 * never logged, and never included in any thrown error's message.
 */
export function createAnthropicProvider(options: AnthropicProviderOptions = {}): ModelProvider {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;

  return {
    name: PROVIDER_NAME,
    async run(request: ModelRequest): Promise<ModelResponse> {
      if (!apiKey) {
        throw new ModelProviderConfigError(
          PROVIDER_NAME,
          "ANTHROPIC_API_KEY is not configured.",
        );
      }
      validateRequest(request);

      const requestBody: AnthropicMessagesRequestBody = {
        model: request.model,
        max_tokens: request.maxTokens,
        messages: request.messages.map(toAnthropicMessage),
      };
      if (request.system) requestBody.system = request.system;
      if (request.temperature !== undefined) requestBody.temperature = request.temperature;

      const { status, body } = await callAnthropicMessages(requestBody, apiKey);

      if (status < 200 || status >= 300) {
        throw new ModelProviderHttpError(
          PROVIDER_NAME,
          status,
          extractErrorMessage(body, status),
        );
      }

      return parseAnthropicResponse(body, request.model);
    },
  };
}

function validateRequest(request: ModelRequest): void {
  if (!request.model) {
    throw new ModelProviderConfigError(PROVIDER_NAME, "ModelRequest.model is required.");
  }
  if (!request.messages?.length) {
    throw new ModelProviderConfigError(
      PROVIDER_NAME,
      "ModelRequest.messages must contain at least one message.",
    );
  }
  if (!Number.isFinite(request.maxTokens) || request.maxTokens <= 0) {
    throw new ModelProviderConfigError(
      PROVIDER_NAME,
      "ModelRequest.maxTokens must be a positive number.",
    );
  }
}

function toAnthropicMessage(message: ModelMessage): AnthropicMessage {
  return { role: message.role, content: message.content };
}

// ── Anthropic-specific wire types (kept private to this file) ─────────────

interface AnthropicMessage {
  role: ModelMessageRole;
  content: string;
}

interface AnthropicMessagesRequestBody {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  temperature?: number;
}

interface AnthropicContentBlock {
  type?: string;
  text?: string;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface AnthropicErrorBody {
  error?: { type?: string; message?: string };
}

interface AnthropicMessagesResponseBody {
  id?: string;
  model?: string;
  stop_reason?: string;
  content?: AnthropicContentBlock[];
  usage?: AnthropicUsage;
}

function extractErrorMessage(body: unknown, status: number): string {
  const errorBody = body as AnthropicErrorBody | undefined;
  const message = errorBody?.error?.message;
  return typeof message === "string" && message.length > 0
    ? message
    : `Anthropic API returned HTTP ${status}.`;
}

function parseAnthropicResponse(body: unknown, requestedModel: string): ModelResponse {
  if (!body || typeof body !== "object") {
    throw new ModelProviderMalformedResponseError(
      PROVIDER_NAME,
      "Anthropic response body was not a JSON object.",
    );
  }

  const parsed = body as AnthropicMessagesResponseBody;

  if (parsed.content !== undefined && !Array.isArray(parsed.content)) {
    throw new ModelProviderMalformedResponseError(
      PROVIDER_NAME,
      "Anthropic response 'content' was present but not an array.",
    );
  }

  const text = (parsed.content ?? [])
    .filter((block): block is AnthropicContentBlock & { text: string } =>
      block?.type === "text" && typeof block.text === "string" && block.text.length > 0,
    )
    .map((block) => block.text)
    .join("");

  if (!text) {
    throw new ModelProviderEmptyResponseError(
      PROVIDER_NAME,
      "Anthropic response contained no usable text content.",
    );
  }

  return {
    text,
    model: parsed.model ?? requestedModel,
    stopReason: parsed.stop_reason,
    usage: {
      inputTokens: parsed.usage?.input_tokens ?? 0,
      outputTokens: parsed.usage?.output_tokens ?? 0,
    },
    provider: PROVIDER_NAME,
    providerRequestId: parsed.id,
  };
}

// ── Child-process transport ─────────────────────────────────────────────
//
// Reproduces the exact workaround already proven in run-tool.mjs and
// run-agent.ts: a short-lived `node --input-type=module -e <script>` child
// process makes the real HTTP call, because lambda-local intercepts
// fetch/https to api.anthropic.com from inside the Netlify Functions
// runtime process itself (Windows + Node 24). The request body and API key
// are passed via env vars (base64-encoded body, to sidestep any shell
// escaping) rather than command-line arguments, so neither ever appears in
// a process listing or shell history.

interface AnthropicChildProcessResult {
  status: number;
  body: unknown;
}

function callAnthropicMessages(
  requestBody: AnthropicMessagesRequestBody,
  apiKey: string,
): Promise<AnthropicChildProcessResult> {
  return new Promise((resolve, reject) => {
    const encodedBody = Buffer.from(JSON.stringify(requestBody)).toString("base64");

    const script = `
const body = Buffer.from(process.env.__AI_BODY, "base64").toString();
const r = await fetch(${JSON.stringify(ANTHROPIC_MESSAGES_URL)}, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": process.env.__AI_KEY,
    "anthropic-version": ${JSON.stringify(ANTHROPIC_API_VERSION)},
  },
  body,
});
process.stdout.write(JSON.stringify({ status: r.status, body: await r.json() }));
`.trim();

    execFile(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        // Deliberately scoped to only the two vars the script needs, on top
        // of the parent env (the child still needs PATH etc. to run node)
        // — never pass anything else the script doesn't reference.
        env: { ...process.env, __AI_BODY: encodedBody, __AI_KEY: apiKey },
        timeout: CHILD_PROCESS_TIMEOUT_MS,
        maxBuffer: CHILD_PROCESS_MAX_BUFFER_BYTES,
        encoding: "utf8",
      },
      (err, stdout) => {
        if (err) {
          // execFile's error can include the full invoked command in some
          // Node versions; the API key is only ever passed via env, never
          // as an argument, so it cannot appear here.
          reject(
            new ModelProviderHttpError(
              PROVIDER_NAME,
              0,
              `Anthropic request failed before receiving a response: ${err.message ?? "unknown error"}`,
              { cause: err },
            ),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout) as AnthropicChildProcessResult);
        } catch (parseError) {
          reject(
            new ModelProviderMalformedResponseError(
              PROVIDER_NAME,
              `Could not parse Anthropic child-process output: ${stdout.slice(0, 300)}`,
              { cause: parseError },
            ),
          );
        }
      },
    );
  });
}
