// netlify/functions/lib/app-config-store.test.ts
//
// Run:  node --test netlify/functions/lib/app-config-store.test.ts
// (Node 20.6+/22/24 native TypeScript type-stripping + built-in test
//  runner — same convention as voice-scheduling.test.ts. No dependencies,
//  no DB — the Supabase client is an in-memory fake.)
//
// Covers:
//   1  process.env override wins immediately, without any DB query
//   2  DB path: environment + key lookup, encrypt/decrypt round trip
//   3  getAppConfigs batches multiple cache misses into ONE query
//   4  a warm-cache hit does not re-query the DB
//   5  setAppConfig invalidates the cache so the next read sees the new value
//   6  deleteAppConfig invalidates the cache so the next read returns null
//   7  a miss is not cached for the full TTL (becomes visible shortly after seeding)

import assert from "node:assert/strict";
import test from "node:test";

process.env.ENCRYPTION_KEY = "test-encryption-key-for-app-config-store-tests";

type Row = { environment: string; key: string; encrypted_value: string; updated_at: string };

function createFakeSupabase(initialRows: Row[] = []) {
  const rows: Row[] = [...initialRows];
  let singleSelectCount = 0;
  let batchSelectCount = 0;

  const client: any = {
    from(table: string) {
      assert.equal(table, "app_config_secrets");
      return {
        select() {
          const filters: Record<string, string> = {};
          const chain: any = {
            eq(col: string, val: string) {
              filters[col] = val;
              return chain;
            },
            in(_col: string, vals: string[]) {
              batchSelectCount++;
              const matched = rows.filter((r) => r.environment === filters.environment && vals.includes(r.key));
              return Promise.resolve({
                data: matched.map((r) => ({ key: r.key, encrypted_value: r.encrypted_value })),
                error: null,
              });
            },
            maybeSingle() {
              singleSelectCount++;
              const found = rows.find((r) => r.environment === filters.environment && r.key === filters.key);
              return Promise.resolve({ data: found ? { encrypted_value: found.encrypted_value } : null, error: null });
            },
          };
          return chain;
        },
        upsert(data: Row | Row[]) {
          const items = Array.isArray(data) ? data : [data];
          for (const item of items) {
            const idx = rows.findIndex((r) => r.environment === item.environment && r.key === item.key);
            if (idx >= 0) rows[idx] = item;
            else rows.push(item);
          }
          return Promise.resolve({ error: null });
        },
        delete() {
          const filters: Record<string, string> = {};
          const chain: any = {
            error: null,
            eq(col: string, val: string) {
              filters[col] = val;
              if (filters.environment && filters.key) {
                const idx = rows.findIndex((r) => r.environment === filters.environment && r.key === filters.key);
                if (idx >= 0) rows.splice(idx, 1);
              }
              return chain;
            },
          };
          return chain;
        },
      };
    },
  };

  return {
    client,
    rows,
    getSingleSelectCount: () => singleSelectCount,
    getBatchSelectCount: () => batchSelectCount,
  };
}

test("process.env override wins immediately, without any DB query", async () => {
  const { getAppConfig } = await import("./app-config-store.ts");
  const { client, getSingleSelectCount } = createFakeSupabase();

  process.env.TEST_OVERRIDE_KEY = "override-value";
  try {
    const value = await getAppConfig(client, "TEST_OVERRIDE_KEY");
    assert.equal(value, "override-value");
    assert.equal(getSingleSelectCount(), 0, "override path must never hit the DB");
  } finally {
    delete process.env.TEST_OVERRIDE_KEY;
  }
});

test("DB path: resolves by environment + key, decrypts correctly", async () => {
  const { getAppConfig, setAppConfig, resolveEnvironment } = await import("./app-config-store.ts");
  const { client } = createFakeSupabase();

  const previousAppConfigEnv = process.env.APP_CONFIG_ENV;
  process.env.APP_CONFIG_ENV = "production";
  try {
    assert.equal(resolveEnvironment(), "production");
    const write = await setAppConfig(client, "TEST_DB_KEY_1", "plaintext-secret-value");
    assert.equal(write.ok, true);

    const value = await getAppConfig(client, "TEST_DB_KEY_1");
    assert.equal(value, "plaintext-secret-value");
  } finally {
    if (previousAppConfigEnv === undefined) delete process.env.APP_CONFIG_ENV;
    else process.env.APP_CONFIG_ENV = previousAppConfigEnv;
  }
});

test("getAppConfigs batches multiple cache misses into one query", async () => {
  const { getAppConfigs, setAppConfig } = await import("./app-config-store.ts");
  const { client, getBatchSelectCount } = createFakeSupabase();

  process.env.APP_CONFIG_ENV = "branch-deploy";
  try {
    await setAppConfig(client, "TEST_BATCH_A", "value-a", "branch-deploy");
    await setAppConfig(client, "TEST_BATCH_B", "value-b", "branch-deploy");

    const result = await getAppConfigs(client, ["TEST_BATCH_A", "TEST_BATCH_B", "TEST_BATCH_MISSING"]);
    assert.equal(result.TEST_BATCH_A, "value-a");
    assert.equal(result.TEST_BATCH_B, "value-b");
    assert.equal(result.TEST_BATCH_MISSING, null);
    assert.equal(getBatchSelectCount(), 1, "all misses must be covered by a single query");
  } finally {
    delete process.env.APP_CONFIG_ENV;
  }
});

test("a warm cache hit does not re-query the DB", async () => {
  const { getAppConfig, setAppConfig } = await import("./app-config-store.ts");
  const { client, getSingleSelectCount } = createFakeSupabase();

  process.env.APP_CONFIG_ENV = "deploy-preview";
  try {
    await setAppConfig(client, "TEST_CACHE_KEY", "cached-value", "deploy-preview");
    const first = await getAppConfig(client, "TEST_CACHE_KEY");
    const countAfterFirst = getSingleSelectCount();
    const second = await getAppConfig(client, "TEST_CACHE_KEY");
    assert.equal(first, "cached-value");
    assert.equal(second, "cached-value");
    assert.equal(getSingleSelectCount(), countAfterFirst, "second read must be served from cache");
  } finally {
    delete process.env.APP_CONFIG_ENV;
  }
});

test("setAppConfig invalidates the cache so the next read sees the new value", async () => {
  const { getAppConfig, setAppConfig } = await import("./app-config-store.ts");
  const { client } = createFakeSupabase();

  process.env.APP_CONFIG_ENV = "production";
  try {
    await setAppConfig(client, "TEST_ROTATE_KEY", "old-value");
    assert.equal(await getAppConfig(client, "TEST_ROTATE_KEY"), "old-value");

    await setAppConfig(client, "TEST_ROTATE_KEY", "new-value");
    assert.equal(await getAppConfig(client, "TEST_ROTATE_KEY"), "new-value");
  } finally {
    delete process.env.APP_CONFIG_ENV;
  }
});

test("deleteAppConfig invalidates the cache so the next read returns null", async () => {
  const { getAppConfig, setAppConfig, deleteAppConfig } = await import("./app-config-store.ts");
  const { client } = createFakeSupabase();

  process.env.APP_CONFIG_ENV = "production";
  try {
    await setAppConfig(client, "TEST_DELETE_KEY", "to-be-deleted");
    assert.equal(await getAppConfig(client, "TEST_DELETE_KEY"), "to-be-deleted");

    const del = await deleteAppConfig(client, "TEST_DELETE_KEY");
    assert.equal(del.ok, true);
    assert.equal(await getAppConfig(client, "TEST_DELETE_KEY"), null);
  } finally {
    delete process.env.APP_CONFIG_ENV;
  }
});

test("a missing key becomes visible shortly after being seeded (short negative cache)", async () => {
  const { getAppConfig, setAppConfig } = await import("./app-config-store.ts");
  const { client } = createFakeSupabase();

  process.env.APP_CONFIG_ENV = "production";
  try {
    assert.equal(await getAppConfig(client, "TEST_LATE_SEED_KEY"), null);
    await setAppConfig(client, "TEST_LATE_SEED_KEY", "arrived-late");
    assert.equal(
      await getAppConfig(client, "TEST_LATE_SEED_KEY"),
      "arrived-late",
      "setAppConfig must invalidate any negative cache entry immediately, not wait out the miss TTL",
    );
  } finally {
    delete process.env.APP_CONFIG_ENV;
  }
});

// ── resolveEnvironment() — production Meta OAuth incident (2026-09-19) ──
//
// A real deployed Function (connect.renometa.com's meta-oauth-start.ts)
// resolved to "development" instead of "production" because CONTEXT was
// not reliably present in its actual runtime, even though it was
// genuinely running on Netlify's production infrastructure.
//
// SECURITY CORRECTION (same day): a first fix inferred "production" from
// AWS Lambda-runtime env vars (AWS_LAMBDA_FUNCTION_NAME/AWS_EXECUTION_ENV)
// being present. That was itself unsafe, since deploy-preview and
// branch-deploy Functions also run on Lambda — inferring production from
// a Lambda signal alone could misclassify a non-production deploy as
// production and read real production secrets. The resolver now requires
// an EXPLICIT, deliberately-configured APP_CONFIG_ENV value and fails
// closed to "development" for anything else, including a genuinely
// deployed Lambda with no APP_CONFIG_ENV set at all — see that function's
// own doc comment for the full reasoning. These tests cover every case
// per this pass's own explicit list, replacing the AWS-Lambda-inference
// tests from the superseded first fix.
//
// Each test snapshots and restores every env var it touches so tests
// never leak state into each other regardless of execution order.
const ENV_KEYS_UNDER_TEST = ["CONTEXT", "APP_CONFIG_ENV", "NETLIFY_DEV", "AWS_LAMBDA_FUNCTION_NAME", "AWS_EXECUTION_ENV", "NODE_ENV"] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS_UNDER_TEST) snapshot[key] = process.env[key];
  return snapshot;
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS_UNDER_TEST) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

function clearEnv(): void {
  for (const key of ENV_KEYS_UNDER_TEST) delete process.env[key];
}

test("resolveEnvironment: APP_CONFIG_ENV=production -> production", async () => {
  const { resolveEnvironment } = await import("./app-config-store.ts");
  const snapshot = snapshotEnv();
  try {
    clearEnv();
    process.env.APP_CONFIG_ENV = "production";
    assert.equal(resolveEnvironment(), "production");
  } finally {
    restoreEnv(snapshot);
  }
});

test("resolveEnvironment: APP_CONFIG_ENV=deploy-preview -> deploy-preview", async () => {
  const { resolveEnvironment } = await import("./app-config-store.ts");
  const snapshot = snapshotEnv();
  try {
    clearEnv();
    process.env.APP_CONFIG_ENV = "deploy-preview";
    assert.equal(resolveEnvironment(), "deploy-preview");
  } finally {
    restoreEnv(snapshot);
  }
});

test("resolveEnvironment: APP_CONFIG_ENV=branch-deploy -> branch-deploy", async () => {
  const { resolveEnvironment } = await import("./app-config-store.ts");
  const snapshot = snapshotEnv();
  try {
    clearEnv();
    process.env.APP_CONFIG_ENV = "branch-deploy";
    assert.equal(resolveEnvironment(), "branch-deploy");
  } finally {
    restoreEnv(snapshot);
  }
});

test("resolveEnvironment: NETLIFY_DEV=true -> development", async () => {
  const { resolveEnvironment } = await import("./app-config-store.ts");
  const snapshot = snapshotEnv();
  try {
    clearEnv();
    process.env.NETLIFY_DEV = "true";
    assert.equal(resolveEnvironment(), "development");
  } finally {
    restoreEnv(snapshot);
  }
});

test("resolveEnvironment: no explicit env set -> development", async () => {
  const { resolveEnvironment } = await import("./app-config-store.ts");
  const snapshot = snapshotEnv();
  try {
    clearEnv(); // nothing set at all -- plain local Node execution / tests
    assert.equal(resolveEnvironment(), "development");
  } finally {
    restoreEnv(snapshot);
  }
});

test("resolveEnvironment: SECURITY — AWS_LAMBDA_FUNCTION_NAME alone -> development, NOT production", async () => {
  const { resolveEnvironment } = await import("./app-config-store.ts");
  const snapshot = snapshotEnv();
  try {
    clearEnv();
    // A deploy-preview or branch-deploy Function ALSO sets this (Netlify
    // Functions run on Lambda regardless of context) -- a Lambda signal
    // alone must never be inferred as production.
    process.env.AWS_LAMBDA_FUNCTION_NAME = "renoconnect-meta-oauth-start";
    assert.equal(resolveEnvironment(), "development");
  } finally {
    restoreEnv(snapshot);
  }
});

test("resolveEnvironment: SECURITY — AWS_EXECUTION_ENV alone -> development, NOT production", async () => {
  const { resolveEnvironment } = await import("./app-config-store.ts");
  const snapshot = snapshotEnv();
  try {
    clearEnv();
    process.env.AWS_EXECUTION_ENV = "AWS_Lambda_nodejs20.x";
    assert.equal(resolveEnvironment(), "development");
  } finally {
    restoreEnv(snapshot);
  }
});

test("resolveEnvironment: invalid/unrecognized APP_CONFIG_ENV -> development (fail closed)", async () => {
  const { resolveEnvironment } = await import("./app-config-store.ts");
  const snapshot = snapshotEnv();
  try {
    clearEnv();
    process.env.APP_CONFIG_ENV = "some-unrecognized-value";
    assert.equal(resolveEnvironment(), "development");
  } finally {
    restoreEnv(snapshot);
  }
});

test("resolveEnvironment: legacy CONTEXT=production alone is no longer sufficient -> development (fail closed until APP_CONFIG_ENV is explicitly configured)", async () => {
  const { resolveEnvironment } = await import("./app-config-store.ts");
  const snapshot = snapshotEnv();
  try {
    clearEnv();
    process.env.CONTEXT = "production"; // CONTEXT is no longer consulted at all
    assert.equal(resolveEnvironment(), "development");
  } finally {
    restoreEnv(snapshot);
  }
});

test("resolveEnvironment: APP_CONFIG_ENV wins even if CONTEXT/Lambda vars disagree", async () => {
  const { resolveEnvironment } = await import("./app-config-store.ts");
  const snapshot = snapshotEnv();
  try {
    clearEnv();
    process.env.CONTEXT = "deploy-preview";
    process.env.AWS_LAMBDA_FUNCTION_NAME = "some-function";
    process.env.APP_CONFIG_ENV = "production";
    assert.equal(resolveEnvironment(), "production", "the explicit APP_CONFIG_ENV value is authoritative");
  } finally {
    restoreEnv(snapshot);
  }
});
