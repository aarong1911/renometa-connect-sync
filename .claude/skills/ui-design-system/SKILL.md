---
name: ui-design-system
description: >
  RenoMeta Connect's visual design language — light/minimal/Linear-inspired
  SaaS aesthetic, color usage, button/card/page-layout conventions, financial
  table and status-badge semantics, and the "search for an existing pattern
  first" rule. Use whenever building or editing any UI: routes, pages,
  modals, drawers, tables, cards, or components under src/components or
  src/routes.
---

# UI Design System — RenoMeta Connect

## Overall aesthetic

Light, minimal, sophisticated, modern SaaS — Linear-inspired. Avoid:

- beige/warm-gray backgrounds
- heavy dark UI as a default surface
- black primary CTA buttons
- excessive gradients or shadows
- visual clutter, duplicate actions, decorative elements that don't carry information

## Backgrounds

- White as the primary surface.
- A very light neutral page background only when a section genuinely needs separation from the page around it.
- Subtle borders between cards/sections rather than heavy shadows to create separation.

## Color

RenoMeta accent colors are used sparingly, purposefully:

- hierarchy (what matters most on this screen)
- status (badges, KPI tiles)
- icons
- charts
- the one or two truly primary actions on a page

Don't turn a page into a saturated wall of color — color is a signal, not decoration.

## Buttons

- Primary buttons use the approved RenoMeta/blue accent treatment (`Button` default variant) — never a plain black primary button.
- Destructive actions (reversals, deletes) use `variant="destructive"`, and only appear where the action is genuinely destructive/irreversible-feeling — a reversal button is destructive-styled even though it's technically additive (it posts a new entry), because the user experience is "this undoes something."
- Button styling stays consistent across pages — reuse `@/components/ui/button`, don't invent a one-off styled button.

## Cards

- Consistent border radius and spacing (`Card` from `@/components/ui/card`).
- Restrained shadow or none — a subtle border does most of the separation work.
- Clear heading hierarchy inside a card (label → value → sub-label pattern for KPI tiles, already established across `financials.tsx`/`financials.expenses.tsx`).
- Avoid nesting cards inside cards unless the information hierarchy genuinely requires it (e.g. a line-items table inside a bill detail sheet is fine; a card-in-a-card purely for visual grouping usually isn't).

## Page layout

The established shape (see `financials.expenses.tsx`, `financials.tsx`) is:

1. Page heading + one-line supporting description
2. Primary action button(s), top-right
3. KPI row (when relevant)
4. Tabs / segmented control (when a page has sub-views)
5. Search/filter bar
6. Table or list
7. Detail drawer/sheet on row click, not a full navigation

Don't invent a new page skeleton per module — extend this shape.

## Financial UI

- Currency right-aligned, `tabular-nums`, formatted via `formatMoney`/`formatCompactMoney` (`@/lib/format`) — never a raw `${n}`.
- Dates via `formatDateOnlyShort`/`formatDateOnly` — never re-derive date formatting inline.
- Status badges have consistent semantics across every financial entity:

  | Status | Meaning |
  |---|---|
  | Draft | Not yet posted, freely editable |
  | Open | Posted, nothing paid yet |
  | Partial | Posted, partially paid |
  | Paid | Posted, fully paid |
  | Overdue | Open/partial past due date (client-side overlay, not always a stored status — check the relevant store before assuming it's a DB value) |
  | Reversed | Posted then reversed — terminal, excluded from aging/outstanding totals |
  | Cancelled | Never posted, abandoned |

- Never show a destructive "delete" action for anything that has ever been posted to the ledger — offer "Reverse" instead (see `accounting-integrity`), and only when the operational record is actually eligible (check its real status server-side, don't just hide the button and trust that).

## Responsive layout

The app must stay usable at 100% and 90% browser zoom. Respect viewport height — avoid layouts that get vertically cut off; prefer internal scroll containers (`overflow-y-auto` inside a fixed-height drawer/sheet) over letting content overflow the viewport.

## People / avatars

Where contacts, leads, or team members appear, use the established `ContactAvatar` component (`@/components/ui/contact-avatar`) rather than stock photography or ad hoc initials rendering.

## Search for an existing pattern first

Before inventing a new component shape, grep the repo for something that already does the same job:

- Modal: `@/components/ui/dialog` + existing modals like `NewExpenseModal`, `NewBillModal`
- Drawer/detail view: `@/components/ui/sheet` + `BillDetailSheet`, `ExpenseDetailSheet`
- Confirm-with-reason flow: `ReversalReasonDialog` (reused across expense/bill/payment reversal — don't build a fourth copy of "confirm with a required reason")
- Data table: the `grid grid-cols-[...]` header + `<ul>`/`<li>` row pattern already used throughout `financials.*.tsx`
- Form controls: `@/components/ui/{input,select,label,textarea}`

Reuse the established pattern unless there's a clear, stated reason to improve the shared one (and if you do improve it, improve it in place so every consumer benefits, rather than forking).
