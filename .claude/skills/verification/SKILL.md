---
name: verification
description: >
  The mandatory end-of-task validation process for RenoMeta Connect — static
  validation commands, netlify dev vs pnpm dev, git status/commit
  discipline, and the honest-claims rule (never say "tested"/"working" for
  something that wasn't actually run). Use before declaring any
  implementation task complete.
---

# Verification — RenoMeta Connect

## Standard validation for any meaningful code change

```bash
pnpm exec tsc --noEmit
$LASTEXITCODE

pnpm build
$LASTEXITCODE

git diff --check
```

Run all three. Report the actual exit codes, not "it looked fine."

## Running the app

RenoMeta Connect runs locally via:

```bash
netlify dev     # Vite + Netlify Functions, :9999, requires Node 20
```

`pnpm dev` only starts Vite — it does **not** run Netlify functions, so it cannot be used to test anything under `netlify/functions/`. Don't substitute it for `netlify dev` and then describe backend behavior as verified.

If the current environment can't run `netlify dev` (e.g. a sandbox pinned to Node 24 while the project requires Node 20), say so plainly and don't attempt it anyway. State clearly that runtime verification did not happen and why.

## Git discipline

Never `commit`, `push`, `merge`, `rebase`, or `reset` unless the user explicitly asks for that specific action in this turn. A prior approval doesn't carry forward to a new change.

At the end of implementation work, inspect:

```bash
git status --short
```

Report created files, modified files, and any untracked/temporary artifacts. Never let the following end up staged or committed: `.env`, Stripe event dumps, webhook payload captures, credentials, tokens, secrets.

## Once a migration is applied, it's historical

The moment the user confirms a migration has actually been applied to Supabase, it becomes historical and must not be edited again — same rule as a posted journal entry, same reasoning as "never `git commit --amend` a pushed commit." Any bug found after that point goes into a **new** migration, never back into the applied one.

Example: `20260823_....sql` gets applied → a bug is found in it later → the fix is `20260824_....sql`, not an edit to `20260823`.

Before editing any migration file, confirm with the user (or from context) whether it has been applied yet — see `database-migrations` for the full applied-vs-unapplied ruleset and naming convention.

## Honest claims

Don't say "fully tested," "working," or "complete" unless that specific testing actually happened in this session. Use precise language instead:

- "static validation passed (`tsc`, `build`, `diff --check`)"
- "build passed; runtime not tested — `netlify dev` unavailable in this environment"
- "migration remains unapplied — SQL not run against the live database"
- "manual E2E pending — see the steps below"

If you didn't watch it happen, don't claim it happened.

## No fake mutation

Don't create test financial records, test contacts, test companies, or any other real-looking data automatically unless explicitly instructed. Give the user a concrete, minimal manual test plan instead (see `financial-e2e` for the accounting-specific version of this).

## Related skills

- `financial-e2e` — the accounting-specific manual verification checklist that goes beyond `tsc`/`build`
- `database-migrations` — migration-specific "applied vs unapplied" reporting requirements
