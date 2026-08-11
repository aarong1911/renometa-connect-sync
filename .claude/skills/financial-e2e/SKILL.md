---
name: financial-e2e
description: >
  The manual, step-by-step verification checklist for accounting/payment
  workflows in RenoMeta Connect — starting-state capture, operational
  verification, journal verification, report reconciliation, and negative-
  path testing. Use whenever a financial feature (invoices, payments,
  expenses, vendor bills, vendor payments, reversals, credits, refunds) is
  ready for manual end-to-end verification — typically right after
  `verification`'s static checks pass.
---

# Financial E2E Verification — RenoMeta Connect

TypeScript compiling and the build succeeding is not evidence a financial workflow is correct. Use this checklist for any accounting/payment change before calling it done — and hand it to the user as their manual test plan when you can't run the app yourself (see `verification`).

## 1 — Establish starting state

Record, before touching anything: document/transaction status, total, paid, balance, the relevant A/R or A/P figure, project revenue/COGS if project-linked, and the balances of every account the action will touch.

## 2 — Perform exactly one controlled action

Issue an invoice, record a payment, create an expense, post a vendor bill, pay a vendor bill, reverse an expense/payment/bill, create a credit — one action, a simple recognizable test amount ($100, $200), never a duplicate charge just to "see what happens."

## 3 — Verify operational state

The record exists, with the right status, amount, paid amount, remaining balance, and the right project/vendor/customer link.

## 4 — Verify the journal entry

Find the posted entry for this event (by `source_type`/`source_id`/`posting_key` if you have SQL access, or via the accounting UI). Confirm: it exists, debit account is right, credit account is right, both amounts are right, project dimension is right, it references the right source document. **Debits must equal credits** on every entry, always.

## 5 — Verify the operational accounting summary

Whichever of these the action touches must reflect it: A/R, A/P, A/R aging, A/P aging, collected, outstanding, expenses this month.

## 6 — Verify reports

Project Profitability, P&L, Balance Sheet, Trial Balance — whichever are relevant. **Trial Balance must remain balanced** after every single test, with no exceptions.

## 7 — Verify at least one invalid/negative path

Pick whichever applies: overpayment, duplicate posting, a webhook delivered twice, a duplicate reversal attempt, paying an already-reversed bill, reversing an already-reversed item, editing an immutable posted record, posting into a closed period. Expected result every time: **cleanly rejected**, no duplicate operational row, no duplicate journal entry.

## 8 — If the feature supports reversal, verify it specifically

- the original record and its history are still there, unedited
- the reversal record/journal entry exists and references the original
- debit/credit are the exact mirror of the original
- the operational balance (amount_paid, status) returns to the correct value
- every report nets correctly (the original + reversal together produce the same numbers as if neither had happened)
- Trial Balance remains balanced

## 9 — Report evidence honestly

State separately: code validation (tsc/build), runtime validation (did you actually run `netlify dev` and click through it, or not), DB migration status (applied/unapplied), manual E2E results (what you personally observed vs. what's left for the user), and any path you didn't test. Never describe accounting behavior you didn't actually observe as verified — see `verification`'s honest-claims rule.

## Related skills

- `accounting-integrity` — the architecture this checklist is verifying
- `database-migrations` — applied/unapplied migration reporting
- `verification` — the general (non-financial) end-of-task validation process
