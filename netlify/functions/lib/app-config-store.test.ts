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

  const previousContext = process.env.CONTEXT;
  process.env.CONTEXT = "production";
  try {
    assert.equal(resolveEnvironment(), "production");
    const write = await setAppConfig(client, "TEST_DB_KEY_1", "plaintext-secret-value");
    assert.equal(write.ok, true);

    const value = await getAppConfig(client, "TEST_DB_KEY_1");
    assert.equal(value, "plaintext-secret-value");
  } finally {
    process.env.CONTEXT = previousContext;
  }
});

test("getAppConfigs batches multiple cache misses into one query", async () => {
  const { getAppConfigs, setAppConfig } = await import("./app-config-store.ts");
  const { client, getBatchSelectCount } = createFakeSupabase();

  process.env.CONTEXT = "branch-deploy";
  try {
    await setAppConfig(client, "TEST_BATCH_A", "value-a", "branch-deploy");
    await setAppConfig(client, "TEST_BATCH_B", "value-b", "branch-deploy");

    const result = await getAppConfigs(client, ["TEST_BATCH_A", "TEST_BATCH_B", "TEST_BATCH_MISSING"]);
    assert.equal(result.TEST_BATCH_A, "value-a");
    assert.equal(result.TEST_BATCH_B, "value-b");
    assert.equal(result.TEST_BATCH_MISSING, null);
    assert.equal(getBatchSelectCount(), 1, "all misses must be covered by a single query");
  } finally {
    delete process.env.CONTEXT;
  }
});

test("a warm cache hit does not re-query the DB", async () => {
  const { getAppConfig, setAppConfig } = await import("./app-config-store.ts");
  const { client, getSingleSelectCount } = createFakeSupabase();

  process.env.CONTEXT = "deploy-preview";
  try {
    await setAppConfig(client, "TEST_CACHE_KEY", "cached-value", "deploy-preview");
    const first = await getAppConfig(client, "TEST_CACHE_KEY");
    const countAfterFirst = getSingleSelectCount();
    const second = await getAppConfig(client, "TEST_CACHE_KEY");
    assert.equal(first, "cached-value");
    assert.equal(second, "cached-value");
    assert.equal(getSingleSelectCount(), countAfterFirst, "second read must be served from cache");
  } finally {
    delete process.env.CONTEXT;
  }
});

test("setAppConfig invalidates the cache so the next read sees the new value", async () => {
  const { getAppConfig, setAppConfig } = await import("./app-config-store.ts");
  const { client } = createFakeSupabase();

  process.env.CONTEXT = "production";
  try {
    await setAppConfig(client, "TEST_ROTATE_KEY", "old-value");
    assert.equal(await getAppConfig(client, "TEST_ROTATE_KEY"), "old-value");

    await setAppConfig(client, "TEST_ROTATE_KEY", "new-value");
    assert.equal(await getAppConfig(client, "TEST_ROTATE_KEY"), "new-value");
  } finally {
    delete process.env.CONTEXT;
  }
});

test("deleteAppConfig invalidates the cache so the next read returns null", async () => {
  const { getAppConfig, setAppConfig, deleteAppConfig } = await import("./app-config-store.ts");
  const { client } = createFakeSupabase();

  process.env.CONTEXT = "production";
  try {
    await setAppConfig(client, "TEST_DELETE_KEY", "to-be-deleted");
    assert.equal(await getAppConfig(client, "TEST_DELETE_KEY"), "to-be-deleted");

    const del = await deleteAppConfig(client, "TEST_DELETE_KEY");
    assert.equal(del.ok, true);
    assert.equal(await getAppConfig(client, "TEST_DELETE_KEY"), null);
  } finally {
    delete process.env.CONTEXT;
  }
});

test("a missing key becomes visible shortly after being seeded (short negative cache)", async () => {
  const { getAppConfig, setAppConfig } = await import("./app-config-store.ts");
  const { client } = createFakeSupabase();

  process.env.CONTEXT = "production";
  try {
    assert.equal(await getAppConfig(client, "TEST_LATE_SEED_KEY"), null);
    await setAppConfig(client, "TEST_LATE_SEED_KEY", "arrived-late");
    assert.equal(
      await getAppConfig(client, "TEST_LATE_SEED_KEY"),
      "arrived-late",
      "setAppConfig must invalidate any negative cache entry immediately, not wait out the miss TTL",
    );
  } finally {
    delete process.env.CONTEXT;
  }
});
