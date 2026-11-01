// netlify/functions/lib/integration-config.ts
//
// Pure (no I/O) rules for the per-org API-key integrations stored in
// organizations.integration_settings — shared by integration-config-
// status.ts, integration-config-save.ts and integration-config-disconnect.ts.
//
// Security model: the browser never reads or writes integration_settings
// directly. It only ever sees the redacted shape produced by
// redactIntegrationSettings() — a per-provider `configured` flag plus an
// explicit allowlist of non-secret fields. Secret fields (Twilio authToken,
// Stripe secretKey, Jotform apiKey, legacy Gmail appPassword) never leave
// the server in any form.
//
// Storage location is deliberately unchanged (still the integration_settings
// JSON) so every existing server-side reader — send-inbox-message.ts,
// marketing-campaign-*.ts, lib/twilio-sms-inbound.ts's signature check,
// src/lib/agentic/sms-transport.ts — keeps working with no change.

export type IntegrationFieldSpec = {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  // Returns an error message, or null when valid. Messages never echo the value.
  validate: (value: string) => string | null;
};

const NO_WHITESPACE = /^\S+$/;

// Providers the browser may save/disconnect through integration-config-*.
// Gmail is intentionally absent — its App Password is encrypted in
// organization_integration_secrets and managed by smtp-config-*.ts.
export const INTEGRATION_PROVIDERS: Record<string, { fields: IntegrationFieldSpec[] }> = {
  twilio: {
    fields: [
      {
        key: "accountSid", label: "Account SID", secret: false, required: true,
        validate: (v) => (/^AC[a-f0-9]{32}$/i.test(v) ? null : "Account SID must start with AC followed by 32 hex characters"),
      },
      {
        key: "authToken", label: "Auth Token", secret: true, required: true,
        validate: (v) => (NO_WHITESPACE.test(v) && v.length >= 16 && v.length <= 128 ? null : "Auth Token is not valid"),
      },
      {
        key: "phoneNumber", label: "Phone Number", secret: false, required: true,
        validate: (v) => (/^\+\d{10,15}$/.test(v) ? null : "Phone Number must be E.164 format: +1XXXXXXXXXX"),
      },
    ],
  },
  stripe: {
    fields: [
      {
        key: "secretKey", label: "Secret Key", secret: true, required: true,
        validate: (v) => (/^(sk|rk)_(live|test)_\S{8,}$/.test(v) && v.length >= 20 ? null : "Secret Key must start with sk_live_ or sk_test_"),
      },
    ],
  },
  jotform: {
    fields: [
      {
        key: "apiKey", label: "API Key", secret: true, required: true,
        validate: (v) => (NO_WHITESPACE.test(v) && v.length >= 8 && v.length <= 256 ? null : "API Key is not valid"),
      },
    ],
  },
};

// Non-secret fields the status endpoint may echo back, per settings key.
// Anything not listed here is never returned — including any unknown key a
// future server-side writer adds.
const PUBLIC_FIELDS: Record<string, string[]> = {
  twilio: ["accountSid", "phoneNumber"],
  gmail: ["email"],
};

const SETTINGS_KEY_RE = /^[A-Za-z0-9_]{1,64}$/;

export type IntegrationStatus = { configured: boolean; fields: Record<string, string> };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Redacted view of integration_settings. `configured` uses the same rule the
 * Settings → Integrations page always used (a non-empty object under the
 * key); `fields` carries only allowlisted non-secret string values.
 */
export function redactIntegrationSettings(settings: unknown): Record<string, IntegrationStatus> {
  const out: Record<string, IntegrationStatus> = {};
  if (!isPlainObject(settings)) return out;
  for (const [key, value] of Object.entries(settings)) {
    if (!SETTINGS_KEY_RE.test(key)) continue;
    const configured = isPlainObject(value) && Object.keys(value).length > 0;
    const fields: Record<string, string> = {};
    if (configured) {
      for (const f of PUBLIC_FIELDS[key] ?? []) {
        const v = (value as Record<string, unknown>)[f];
        if (typeof v === "string" && v) fields[f] = v;
      }
    }
    out[key] = { configured, fields };
  }
  return out;
}

export type BuildConfigResult =
  | { ok: true; next: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Builds the next stored object for `provider` from the previously stored
 * object and the submitted fields. A blank secret keeps the previously
 * stored secret; a blank required field with nothing stored is rejected.
 * Unknown submitted keys are ignored. Keys already stored that aren't part
 * of the form (server-written metadata) are preserved.
 */
export function buildProviderConfig(provider: string, prev: unknown, submitted: unknown): BuildConfigResult {
  const spec = INTEGRATION_PROVIDERS[provider];
  if (!spec) return { ok: false, error: "Unsupported integration" };
  if (submitted !== undefined && submitted !== null && !isPlainObject(submitted)) {
    return { ok: false, error: "Invalid fields" };
  }
  const input = (submitted ?? {}) as Record<string, unknown>;
  const previous = isPlainObject(prev) ? prev : {};

  const next: Record<string, unknown> = { ...previous };
  for (const f of spec.fields) {
    const raw = input[f.key];
    if (raw !== undefined && raw !== null && typeof raw !== "string") {
      return { ok: false, error: `${f.label} is not valid` };
    }
    const value = (raw ?? "").trim();
    if (value) {
      const err = f.validate(value);
      if (err) return { ok: false, error: err };
      next[f.key] = value;
      continue;
    }
    const stored = previous[f.key];
    if (f.secret && typeof stored === "string" && stored) continue; // keep existing secret
    if (f.required) return { ok: false, error: `${f.label} is required` };
    delete next[f.key];
  }
  return { ok: true, next };
}

export function isManagedProvider(provider: unknown): provider is string {
  return typeof provider === "string" && Object.prototype.hasOwnProperty.call(INTEGRATION_PROVIDERS, provider);
}
