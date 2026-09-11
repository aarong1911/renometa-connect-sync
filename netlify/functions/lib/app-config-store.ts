// netlify/functions/lib/app-config-store.ts
//
// App-wide (not per-organization) encrypted config/secret storage, read at
// runtime instead of from Netlify environment variables — see
// supabase/migrations/20260911_app_config_secrets.sql for why: Netlify
// bundles every configured env var into every function's Lambda
// environment, and AWS caps that payload at 4KB. This is the sibling of
// org-secret-store.ts, which is per-organization; this one holds
// platform-wide credentials (Stripe, Vapi, Twilio, Google Ads, Meta app
// secret, AWS SES, SMTP, JWT/signing secrets, etc.) shared across the
// whole app, scoped per DEPLOYMENT ENVIRONMENT rather than globally —
// unlike per-org secrets, the same key can legitimately hold a different
// value in production vs. a deploy preview (e.g. distinct Stripe webhook
// endpoints).
//
// Reuses the exact same AES-256-GCM + bytea wire format already used for
// Gmail OAuth tokens and org secrets (gmail-token-crypto.ts) — never a
// second encryption scheme.
//
// Local-override resolution order (checked on every read, inside this
// module, so every caller gets it uniformly):
//   1. process.env[key] explicitly set (non-empty) — return it immediately,
//      no DB call. This is what lets `stripe listen`'s ephemeral, freshly
//      minted STRIPE_WEBHOOK_SECRET win locally every time without ever
//      being written to the shared table.
//   2. Otherwise, look up (resolveEnvironment(), key) in app_config_secrets.
//
// Cold-start/warm-invocation caching: a Lambda container is reused across
// invocations while warm, so this keeps a module-level in-memory cache
// (10 min TTL for hits) to avoid a DB round-trip on every call. Misses are
// cached only briefly (30s) so a value seeded shortly after a failed
// lookup becomes visible quickly rather than waiting out a 10-minute
// negative cache. The cache is per-container — a fresh cold start (or a
// container Netlify spins up elsewhere) always fetches fresh.
//
// Never logs plaintext, ciphertext, or any part of a secret value.

import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptBytea, encryptToBytea } from "./gmail-token-crypto.ts";

const HIT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MISS_TTL_MS = 30 * 1000; // 30 seconds — see header comment

type CacheEntry = { value: string | null; expiresAt: number };
const cache = new Map<string, CacheEntry>();

/** Netlify sets CONTEXT to "production" | "deploy-preview" | "branch-deploy" | "dev". Never resolved from a request/browser parameter. */
export function resolveEnvironment(): string {
  const ctx = process.env.CONTEXT;
  if (ctx === "production") return "production";
  if (ctx === "deploy-preview") return "deploy-preview";
  if (ctx === "branch-deploy") return "branch-deploy";
  return "development"; // netlify dev locally, or unrecognized context
}

function cacheKey(environment: string, key: string): string {
  return `${environment}:${key}`;
}

function getCached(cacheKeyStr: string): { hit: true; value: string | null } | { hit: false } {
  const entry = cache.get(cacheKeyStr);
  if (!entry) return { hit: false };
  if (Date.now() >= entry.expiresAt) {
    cache.delete(cacheKeyStr);
    return { hit: false };
  }
  return { hit: true, value: entry.value };
}

function setCached(cacheKeyStr: string, value: string | null): void {
  const ttl = value === null ? MISS_TTL_MS : HIT_TTL_MS;
  cache.set(cacheKeyStr, { value, expiresAt: Date.now() + ttl });
}

/**
 * Fetch one app-level config/secret value: process.env override first, then
 * (resolveEnvironment(), key) in app_config_secrets. Returns null if unset
 * everywhere or on read/decrypt failure (never throws — callers already
 * handle "not configured" the same way they do for a missing env var).
 */
export async function getAppConfig(
  supabaseAdmin: SupabaseClient,
  key: string,
): Promise<string | null> {
  const override = process.env[key];
  if (override) return override;

  const environment = resolveEnvironment();
  const ckey = cacheKey(environment, key);
  const cached = getCached(ckey);
  if (cached.hit) return cached.value;

  const { data, error } = await supabaseAdmin
    .from("app_config_secrets")
    .select("encrypted_value")
    .eq("environment", environment)
    .eq("key", key)
    .maybeSingle();

  if (error) {
    console.error(`[app-config-store] read failed for "${key}":`, error.message);
    return null;
  }
  if (!data?.encrypted_value) {
    setCached(ckey, null);
    return null;
  }

  try {
    const value = decryptBytea(data.encrypted_value);
    setCached(ckey, value);
    return value;
  } catch (err: any) {
    console.error(`[app-config-store] decrypt failed for "${key}":`, err.message);
    return null;
  }
}

/**
 * Fetch several keys at once (one query covering all cache misses, instead
 * of N) — use this in any handler that needs more than one moved value,
 * e.g. STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET together.
 */
export async function getAppConfigs(
  supabaseAdmin: SupabaseClient,
  keys: string[],
): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  const environment = resolveEnvironment();
  const toFetch: string[] = [];

  for (const key of keys) {
    const override = process.env[key];
    if (override) {
      result[key] = override;
      continue;
    }
    const cached = getCached(cacheKey(environment, key));
    if (cached.hit) {
      result[key] = cached.value;
    } else {
      toFetch.push(key);
    }
  }
  if (toFetch.length === 0) return result;

  const { data, error } = await supabaseAdmin
    .from("app_config_secrets")
    .select("key, encrypted_value")
    .eq("environment", environment)
    .in("key", toFetch);

  if (error) {
    console.error("[app-config-store] batch read failed:", error.message);
    for (const key of toFetch) result[key] = null;
    return result;
  }

  const found = new Set((data ?? []).map((row) => row.key));
  for (const row of data ?? []) {
    try {
      const value = decryptBytea(row.encrypted_value);
      setCached(cacheKey(environment, row.key), value);
      result[row.key] = value;
    } catch (err: any) {
      console.error(`[app-config-store] decrypt failed for "${row.key}":`, err.message);
      result[row.key] = null;
    }
  }
  for (const key of toFetch) {
    if (!found.has(key)) {
      setCached(cacheKey(environment, key), null);
      result[key] = null;
    }
  }
  return result;
}

export async function setAppConfig(
  supabaseAdmin: SupabaseClient,
  key: string,
  plaintext: string,
  environment: string = resolveEnvironment(),
): Promise<{ ok: true } | { ok: false; error: string }> {
  const encrypted = encryptToBytea(plaintext);
  const { error } = await supabaseAdmin
    .from("app_config_secrets")
    .upsert(
      { environment, key, encrypted_value: encrypted, updated_at: new Date().toISOString() },
      { onConflict: "environment,key" },
    );

  if (error) {
    console.error(`[app-config-store] write failed for "${key}":`, error.message);
    return { ok: false, error: "Failed to save config value" };
  }
  cache.delete(cacheKey(environment, key)); // force a fresh read (or fresh cache-miss) next call
  return { ok: true };
}

export async function deleteAppConfig(
  supabaseAdmin: SupabaseClient,
  key: string,
  environment: string = resolveEnvironment(),
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabaseAdmin
    .from("app_config_secrets")
    .delete()
    .eq("environment", environment)
    .eq("key", key);

  if (error) {
    console.error(`[app-config-store] delete failed for "${key}":`, error.message);
    return { ok: false, error: "Failed to delete config value" };
  }
  cache.delete(cacheKey(environment, key));
  return { ok: true };
}
