---
name: accounting-integrity
description: >
  The RenoMeta Connect double-entry accounting architecture — journal
  immutability, the reversal (not edit) correction model, canonical posting
  events for invoices/expenses/vendor bills/vendor payments, append-only
  payment reversal, idempotency, concurrency/locking, and the financial
  reports that must stay reconciled. Use for ANY work touching invoices,
  invoice payments, expenses, vendor bills, vendor payments, credits,
  refunds, journal entries, Project Profitability, P&L, Balance Sheet,
  Trial Balance, A/R, or A/P.
---

# Accounting Integrity — RenoMeta Connect

## Canonical model

```
Operational event (invoice issued, expense recorded, bill posted, payment made)
  -> trusted Netlify function (validates org/account/amount server-side)
  -> canonical accounting posting helper (netlify/lib/accounting.ts)
  -> post_journal_entry() RPC (the ONLY way a balanced entry gets posted)
  -> accounting_journal_entries / accounting_journal_entry_lines
  -> financial reports (derived, read-only queries over posted lines)
```

Operational tables (`invoices`, `expenses`, `vendor_bills`, `vendor_payments`, ...) are business workflow records. `accounting_journal_entries`/`accounting_journal_entry_lines` are accounting history. **The GL is not an editable CRUD table** — nothing outside `post_journal_entry()`/`reverse_journal_entry()` writes to it, and neither is reachable by anything but `service_role`.

## Journal immutability

Never:
- edit a posted journal entry's lines, amounts, accounts, or dimensions
- delete a posted journal entry or its lines
- "fix" accounting by overwriting a posted entry

Every correction is: **original posted entry stays exactly as posted, forever** + **a new posted reversing entry**. Both remain visible in every report, netting to zero automatically.

## The reversal principle

- `reverse_journal_entry()` creates a NEW entry that swaps every original line's debit and credit exactly, preserving account/project/contact dimensions and reusing `post_journal_entry()` for the actual insert (inherits its balance check, numbering, and idempotency for free).
- **Reverse the exact original entry** — never reconstruct what the entry "should" look like from today's account-mapping logic (e.g. today's `payment_method`). Posting logic can change over time; the original entry is what actually happened.
- Source identity for a reversal is derived from the entry being reversed (`source_type`, `source_id` of the original), never accepted from the caller — a caller should only ever say *which entry* to reverse, never relabel what it's reversing.
- A reversal requires a non-blank reason.
- A reversal entry cannot itself be reversed (check the real `reversed_entry_id` relationship, not description text).
- The original entry's `status` never changes (it stays `'posted'` forever) — the relationship column (`reversed_entry_id`, original → reversal) is the "this was reversed" signal. Every report already includes non-draft statuses, so this requires no report-side special-casing.

## Canonical posting events (current)

| Event | Debit | Credit |
|---|---|---|
| Invoice issued | Accounts Receivable | Construction/Change Order Revenue |
| Customer payment | Undeposited Funds | Accounts Receivable |
| Direct expense | Expense/COGS account | Operating Bank or Credit Cards |
| Vendor bill posted | Expense/COGS account(s) | Accounts Payable |
| Vendor payment | Accounts Payable | Operating Bank or Credit Cards |

Reversals swap every side of the above exactly.

## Canonical payment ledgers

- Customer: `invoice_payments`
- Vendor: `vendor_payments`

**Append-only.** Never mutate a historical succeeded payment row to simulate a correction — insert a new reversal row instead (`reverses_payment_id` → original). The original row stays immutable and visible forever.

Effective amount paid on a bill/invoice:
```
SUM(amount) WHERE status = 'succeeded'
  minus successful reversal rows (reverses_payment_id is not null)
```
This formula must be identical everywhere it's computed — the RPC that inserts a new payment (overpayment guard), the trigger that maintains the cached `amount_paid` column, and the immutability trigger that validates any write to that cached column all have to agree, or a reversal can get silently rejected or the cache can silently desync. When you touch one, re-audit the other two.

## Backward status transitions are legitimate, but only when ledger-derived

A payment reversal can legitimately move a bill `paid → partial` or `partial → open` — reversing a payment is not the same as "arbitrary status edit," and blocking all backward transitions breaks reversal. But don't just open up backward transitions generally either. The correct DB-level rule: a status/`amount_paid` change is only accepted if it **exactly matches a canonical recalculation from the payment ledger** (same formula as above), computed inside the immutability trigger itself — never trust a caller-supplied backward value on its own.

## Financial invariants

- Assets = Liabilities + Equity
- Trial Balance: total debits = total credits, always
- A/R operational totals reconcile to GL A/R; A/P operational totals reconcile to GL A/P
- COGS/direct-cost categories (materials, labor, subcontractors, equipment, other direct project costs) must never be classified as generic operating expenses — this is what makes Project Profitability real instead of fabricated
- A reversed **document** (bill, expense, and the equivalent invoice/credit-memo workflow on the customer side) is excluded from A/P/A/R aging and outstanding totals because it no longer represents an active payable/receivable at all — that exclusion is a status check, not a balance calculation.
- A **payment** reversal is different: it is not itself "excluded from aging." An append-only payment-reversal row changes the bill/invoice's *effective amount paid*, and aging/outstanding is then recalculated from that effective balance the normal way — the same formula used everywhere else (see "Canonical payment ledgers" above). A reversed payment on an otherwise-active bill makes that bill reappear in aging with a larger balance; it does not get hidden.
- Never add a UI-only aging exclusion to compensate for balance math that doesn't already account for reversals — if aging looks wrong after a reversal, the bug is in the effective-balance calculation, not in what the aging view chooses to filter out. Aging must always reconcile to the accounting ledger by construction, driven by the canonical effective balance, never patched at the display layer.

## Reporting

- Project Profitability, P&L, Balance Sheet, and Trial Balance are all derived from posted `accounting_journal_entry_lines` — there is exactly one calculation path. Do not build a second, parallel profitability/PNL calculation from operational tables; if the ledger already reflects a reversal/credit correctly, the report needs no special-casing for it.
- General Ledger queries include every **non-draft** status (not just `'posted'`) so that an original and its reversal both stay visible and net to zero.

## Period safety

- Never post into a closed accounting period.
- If correcting a transaction from a closed period, the original stays untouched; the reversal posts into the current open period (this falls out for free — `post_journal_entry()` already validates the period for the date it's given).

## Idempotency

Assume every financial write can be retried, every webhook can repeat, every function can be invoked twice.

- Every posted entry is keyed on `(org_id, source_type, source_id, posting_key)` — reused, never reinvented per event type.
- DB uniqueness (unique/partial-unique indexes) is the real backstop, not just "the RPC checks first."
- Provider transaction/payment-intent IDs are the idempotency key for anything touching Stripe.

## Concurrency

For any monetary write against a parent balance (bill, invoice):

- lock the canonical parent row (`select ... for update`) before reading its balance
- **use the same lock order everywhere** — every function touching the same bill/invoice must lock the same row first, in the same order, or you get either a silent race (a later write clobbers an earlier one's cached total) or a deadlock. When adding a new write path, check what every existing path already locks and in what order before writing the new one.
- recompute the effective balance under that lock, not from a value read before the lock was acquired
- enforce overpayment/overreversal at the DB/RPC level — never trust the frontend's number

## Financial amount trust

The browser is never authoritative for: amount to charge, payment/refund limits, `org_id`, account mapping, payable/receivable balance. The server resolves the authenticated user's org and re-derives every amount from canonical rows before writing anything. See `secure-backend` for the general (non-financial) version of this rule.

## Before finishing any financial change, check impact on

General Ledger · Project Profitability · P&L · Balance Sheet · Trial Balance · A/R or A/P (whichever side you touched) · the operational record's own balance/status field.

## Related skills

- `database-migrations` — how to actually write/harden the migrations this architecture depends on
- `financial-e2e` — how to manually verify a change like this actually works end to end
- `secure-backend` — general trust-boundary rules this skill specializes for money
