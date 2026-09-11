// scripts/seed-app-config-secrets.mjs
//
// One-off script: encrypts an EXPLICITLY named set of key/value pairs and
// upserts them into app_config_secrets for one TARGET deployment
// environment. This is for deliberately promoting confirmed-good values
// into the shared table (e.g. copying real production credentials in) —
// it never reads the whole .env file wholesale, since most of a
// developer's .env should stay local-only (picked up automatically by
// app-config-store.ts's process.env override), not get pushed to a
// shared environment.
//
// Usage:
//   node scripts/seed-app-config-secrets.mjs <environment> KEY1 KEY2=value2 ...
//
//   <environment>  one of: production | deploy-preview | branch-deploy |
//                  development — must match app-config-store.ts's
//                  resolveEnvironment() output for the target deploy
//                  context.
//   KEY            reads the CURRENT value of KEY from your local .env
//                  (bare name — no "=").
//   KEY=value      supplies the value inline instead of reading .env
//                  (e.g. for a value that only lives in a password
//                  manager, not your local .env).
//
// Every key to migrate must be named explicitly on the command line — this
// script refuses to run with zero keys rather than defaulting to "migrate
// everything."
//
// Example:
//   node scripts/seed-app-config-secrets.mjs production STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET
//
// Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and ENCRYPTION_KEY to
// already be set in your shell env or local .env (this script reads .env
// itself for those three plus any bare KEY args, so having them in .env is
// enough).
//
// Safe to re-run: upserts on the (environment, key) primary key.
//
// CRYPTO COMPATIBILITY: this repo has no ts-node/tsx runner configured
// (only the `typescript` package itself, used solely for `tsc --noEmit`),
// so this plain Node .mjs script cannot `import` the TypeScript helper in
// netlify/functions/lib/gmail-token-crypto.ts directly. Its encryptToBytea
// is reproduced byte-for-byte below instead, verified line-by-line against
// the source: AES-256-GCM, key = SHA-256(ENCRYPTION_KEY), iv(12) random,
// then "\x" + hex(base64(iv || authTag(16) || ciphertext)). Keep this in
// sync with gmail-token-crypto.ts if that format ever changes — it is the
// single source of truth for the app itself; this is a deliberate,
// documented duplication for a script that runs outside the TS build.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const VALID_ENVIRONMENTS = ["production", "deploy-preview", "branch-deploy", "development"];

function loadDotEnv(path) {
  const env = {};
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return env;
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

// Byte-for-byte match of gmail-token-crypto.ts's encryptToBytea — see the
// CRYPTO COMPATIBILITY note above for why this is duplicated here instead
// of imported.
function encryptToBytea(plaintext, encKey) {
  const key = crypto.createHash("sha256").update(encKey).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const inner = Buffer.concat([iv, tag, ciphertext]).toString("base64");
  const hex = Buffer.from(inner, "utf8").toString("hex");
  return "\\x" + hex;
}

async function main() {
  const [environment, ...rawArgs] = process.argv.slice(2);

  if (!environment || !VALID_ENVIRONMENTS.includes(environment)) {
    console.error(
      `Usage: node scripts/seed-app-config-secrets.mjs <environment> KEY1 KEY2=value2 ...\n` +
        `<environment> must be one of: ${VALID_ENVIRONMENTS.join(", ")}`,
    );
    process.exit(1);
  }
  if (rawArgs.length === 0) {
    console.error("No keys named — refusing to run. Pass one or more KEY or KEY=value arguments explicitly.");
    process.exit(1);
  }

  // fileURLToPath, NOT new URL(...).pathname — on Windows the latter
  // produces a leading-slash path like "/C:/Users/..." that silently
  // breaks readFileSync.
  const dotEnv = loadDotEnv(fileURLToPath(new URL("../.env", import.meta.url)));
  const env = { ...dotEnv, ...process.env }; // real shell env wins over .env

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const encKey = env.ENCRYPTION_KEY;
  if (!supabaseUrl || !serviceKey || !encKey) {
    console.error("Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or ENCRYPTION_KEY (shell env or .env).");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const rows = [];
  const missing = [];
  for (const arg of rawArgs) {
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
    const value = inlineValue !== undefined ? inlineValue : env[key];
    if (value === undefined || value === "") {
      missing.push(key);
      continue;
    }
    rows.push({
      environment,
      key,
      encrypted_value: encryptToBytea(value, encKey),
      updated_at: new Date().toISOString(),
    });
  }

  if (missing.length > 0) {
    console.warn(`Skipping ${missing.length} key(s) with no value found (.env or inline):`, missing.join(", "));
  }
  if (rows.length === 0) {
    console.log("Nothing to migrate.");
    return;
  }

  console.log(`About to upsert ${rows.length} key(s) into app_config_secrets for environment "${environment}":`);
  for (const row of rows) console.log(`  - ${row.key}`);

  const { error } = await supabase.from("app_config_secrets").upsert(rows, { onConflict: "environment,key" });
  if (error) {
    console.error("Upsert failed:", error.message);
    process.exit(1);
  }

  console.log(`\nDone. Migrated ${rows.length} key(s) into app_config_secrets (environment="${environment}").`);
  console.log(
    "Next: for any function still reading these via process.env, switch it to getAppConfig()/getAppConfigs()," +
      " verify, THEN remove the corresponding vars from Netlify for this environment.",
  );
}

main();
