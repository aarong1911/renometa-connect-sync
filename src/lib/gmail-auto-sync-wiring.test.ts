// src/lib/gmail-auto-sync-wiring.test.ts
//
// Run:  node --test src/lib/gmail-auto-sync-wiring.test.ts
//
// The repo has no component/DOM test harness (no jsdom/testing-library), so the
// React wiring in inbox.tsx and the controller's render-stability contract can't
// be exercised by mounting a component. These are source-level invariant checks
// for the two specific regressions this feature has already had once (the old
// experimental branch gated auto-sync on `gmailAccountEmail` instead of the real
// connection state) and must not have again — they fail loudly if the wiring
// ever regresses, rather than passing silently. The BEHAVIORAL side of the
// connected-state / interval / refetch logic is covered by gmail-auto-sync.test.ts
// against the real controller.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const inbox = readFileSync(new URL("../routes/inbox.tsx", import.meta.url), "utf8");
const hook = readFileSync(new URL("./use-gmail-auto-sync.ts", import.meta.url), "utf8");

test("1+2. auto-sync is gated on the real connected flag, never on optional display fields (avatar/email)", () => {
  const m = inbox.match(/useGmailAutoSync\(\{\s*enabled:\s*([a-zA-Z0-9_.]+),/);
  assert.ok(m, "useGmailAutoSync({ enabled: ... }) call not found");
  assert.equal(m![1], "gmailConnected", "must gate on the connection-status flag, not an optional profile field");
  assert.doesNotMatch(m![1], /Email|Picture|Avatar/i);
  // gmailConnected itself must come from the connection-status response's
  // `connected` field, not be inferred from accountEmail/accountPictureUrl.
  assert.match(inbox, /setGmailConnected\(status\.connected === true\)/);
});

test("8. the auto-sync controller is created once (useMemo with an empty dependency array) — never recreated on a normal render", () => {
  const m = hook.match(/const controller = useMemo\(\s*\(\)\s*=>[\s\S]*?\}\),\s*(\[[^\]]*\]),?\s*\);/);
  assert.ok(m, "useMemo(() => createGmailAutoSync(...), [...]) not found");
  assert.equal(m![1].replace(/\s/g, ""), "[]", "a non-empty dep array would tear down and rebuild the interval/listeners on unrelated renders");
});

test("9. \"Last synced\" only advances from the auto-sync controller's own onSynced callback (a real completed server sync)", () => {
  const m = inbox.match(/onSynced:\s*\(result, source\)\s*=>\s*\{\s*setGmailLastSyncAt\(new Date\(\)\.toISOString\(\)\);/);
  assert.ok(m, "setGmailLastSyncAt must be the first thing onSynced does, so it can only fire once gmail-auto-sync.ts has confirmed { ok: true }");
});
