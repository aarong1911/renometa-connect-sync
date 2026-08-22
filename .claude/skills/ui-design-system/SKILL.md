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

- heavy dark UI as a default surface
- black primary CTA buttons
- excessive gradients or shadows
- visual clutter, duplicate actions, decorative elements that don't carry information

**Warm-neutral secondary controls are intentional, not an exception.** RenoMeta Global UI Interaction System pass established `#FAF3E4` (via the `--control-neutral*` tokens, `neutral` Button variant, and Tabs' active state) as the canonical warm-neutral treatment for secondary/navigation controls — see "Interaction principles" and "Neutral/secondary control system" below. This supersedes an earlier blanket "avoid beige backgrounds" rule; the distinction now is semantic hierarchy (primary/destructive/status stay visually distinct — see below), not "no warm neutral anywhere."

## Interaction principles (RenoMeta Global UI Interaction System)

1. Every enabled, genuinely clickable element shows `cursor: pointer`. This is enforced globally (see `src/styles.css`'s `@layer base` cursor rule, scoped to `button:not(:disabled)`, `a[href]`, `[role="button"]`, `[role="tab"]`, `[role="menuitem"]`, `[role="option"]`, native form controls, and Radix collection items) and in the shared `Button`/`TabsTrigger` components directly — you should rarely need to add `cursor-pointer` by hand.
2. Disabled interactive controls never show a pointer — they get `cursor: not-allowed` (or inherit the browser default via `pointer-events-none`). Never leave a disabled control with a lingering pointer cursor.
3. Prefer semantic elements — `<button>`, `<a>`/`Link`, `Tabs`/`TabsTrigger`, `SelectTrigger`, `DropdownMenuItem` — over a clickable plain `<div>`/`<span>` with an `onClick`. If something behaves like a button, make it a `<button>` (or `Button asChild` wrapping a `Link`), not a styled div.
4. Neutral/secondary controls use the warm-neutral system below — never a one-off `bg-[#FAF3E4]` in a feature file.
5. Primary actions (Add Lead, Save, Create Campaign, Send, Confirm) keep the RenoMeta primary/blue treatment (`Button` `default` variant) — never demoted to neutral just for consistency's sake.
6. Destructive actions (Delete, Remove, Disconnect, Reverse) keep `variant="destructive"` — never beige-washed.
7. Status is communicated with badges (`StatusBadge`/`Badge`), never a button styled to look like a status pill.
8. Tabs/segmented controls across the app share one pattern (the shared `Tabs`/`TabsTrigger`/`TabsList` component) — never a per-page reimplementation of "active tab" styling.
9. Reuse shared `Button` variants (`default`/`secondary`/`outline`/`ghost`/`destructive`/`link`/`neutral`) rather than inventing a custom class string for a control that already has a home in one of these variants.
10. Hover/focus/disabled states must be intentional and consistent — never remove `focus-visible:ring-*` for visual cleanliness; keyboard navigation and screen-reader focus must keep working.
11. A clickable table/list row shows `cursor-pointer` (add it explicitly on the row/cell, since a `<tr>`/`<div>` row isn't covered by the global button/link/role selectors); a non-clickable row keeps the normal cursor.
12. Never apply `cursor-pointer` to static text, plain labels, or purely decorative elements just because they're near an interactive control.

## Tabs / segmented controls — spacing and identity

A live consistency pass found every Tabs group in the app touching with zero gap between triggers (`TabsList` had no `gap` class). Fixed once in the shared component, not per page:

- `TabsList` uses `gap-1.5` — the one canonical segmented-control spacing value app-wide (CRM Campaigns/Paid Ads, Google Ads/Meta Ads, Overview/Ad Groups, Keywords/Search Terms, and any future Tabs usage). Never add per-feature `ml-1`/`mr-1` margins to fake a gap — fix it in `src/components/ui/tabs.tsx` if it's ever wrong again.
- RenoMeta tabs are **not** a connected/joined segmented-control design (no shared border between adjacent triggers) — each trigger is its own rounded control with real space around it. Don't reintroduce a touching/connected look.
- Action-button groups (sibling `Button`s in a toolbar) use a different, slightly looser spacing convention: `gap-2` on the parent flex container, never per-button margins. Tabs (`gap-1.5`) and action-button rows (`gap-2`) are deliberately two different, consistent values — don't blend them.
- Active tab = `data-[state=active]:bg-control-neutral` + matching border + `shadow-sm`; inactive tab = transparent/muted with the shared hover feedback. This is defined once in `TabsTrigger` — never override active-tab background/border per page.

## Secondary-button variant discipline

A live pass found visually-equivalent secondary actions (Sync leads, Refresh, Refresh Actions, View in CRM Leads) using a mix of `variant="outline"` and `variant="ghost"` — inconsistent even though they're all the same semantic role. The rule going forward:

- Any action that is genuinely a secondary/neutral navigation-or-operational action (Sync, Refresh, Retry, View CRM Leads, Back-as-a-button, etc.) uses `variant="neutral"` — not `outline`, not `ghost`, not a bespoke class string.
- `outline` still exists for a plain bordered control that intentionally should NOT carry the warm-neutral treatment (rare — most "secondary" cases should be `neutral` now).
- `ghost` is reserved for genuinely low-emphasis/dev-only actions (e.g. "Inject Test Lead", "Create Test Event") that should not visually compete with real secondary controls — these share one look (`variant="ghost"` + `className="text-muted-foreground"`), never a mix of plain-text-looking and button-looking dev controls side by side.
- Before adding a new secondary button, check whether an existing sibling control in the same feature area already establishes the pattern — copy its variant exactly rather than picking a new one.

## Neutral/secondary control system (`#FAF3E4`)

- Canonical warm-neutral color lives as CSS variables in `src/styles.css`: `--control-neutral` (`#FAF3E4` in light mode, a muted dark-warm `oklch` in dark mode), `--control-neutral-hover`, `--control-neutral-foreground`, `--control-neutral-border` — mapped through `@theme inline` to `--color-control-neutral*` so Tailwind utilities (`bg-control-neutral`, `text-control-neutral-foreground`, `border-control-neutral-border`, `hover:bg-control-neutral-hover`) work directly.
- `#FAF3E4` itself is defined in exactly ONE place (the `:root` token in `src/styles.css`) — never hardcode `bg-[#FAF3E4]` (or any other literal hex approximating it) in a route/component file. If you need the warm-neutral treatment, use the `neutral` Button variant or the token classes, not a literal color.
- Use it for: neutral/secondary buttons and small navigation CTAs (e.g. "View CRM Leads", "View in CRM Leads"), the active state of Tabs/segmented controls, toggle-like navigation controls, and filter/action controls where a beige treatment reads as "secondary action" rather than "data-entry field."
- Do NOT use it for: primary CTAs, destructive actions, status badges, or ordinary form inputs/`SelectTrigger`s (those keep their existing white/light input styling — a filter dropdown is a data-entry control, not a navigation button, even though both must show pointer on hover).

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
- Neutral/secondary navigation CTAs (see "Neutral/secondary control system" above) use `variant="neutral"` — not `outline`, not a hand-rolled beige class string.
- Button styling stays consistent across pages — reuse `@/components/ui/button`, don't invent a one-off styled button.
- Common secondary controls of the same visual weight (e.g. "View CRM Leads" and "Refresh") should share the same `size` — don't let one page's button end up a different height/padding/radius than its sibling elsewhere in the app for no semantic reason.

## UI component inventory (what governs what)

| Role | Component | Notes |
|---|---|---|
| Primary button | `Button` (`default` variant) — `@/components/ui/button` | Blue accent. Add Lead, Save, Create, Send, Confirm. |
| Neutral/secondary button | `Button` (`neutral` variant) | `#FAF3E4` warm-neutral system. Navigation CTAs like "View CRM Leads". |
| Outline button | `Button` (`outline` variant) | White/background-colored bordered button — distinct from `neutral`; use when the page wants a plain bordered control, not the warm-neutral treatment. |
| Ghost/plain-text button | `Button` (`ghost` variant) | Low-emphasis actions (e.g. "Clear", dev-only controls). |
| Destructive button | `Button` (`destructive` variant) | Delete/Remove/Disconnect/Reverse. |
| Tabs / segmented control | `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` — `@/components/ui/tabs` | Active state uses `control-neutral` tokens app-wide. |
| Select / dropdown trigger | `Select`/`SelectTrigger` — `@/components/ui/select` | Form/filter control — keeps its own white/light input styling, not the neutral-button treatment. |
| Menu item | `DropdownMenuItem`/`ContextMenuItem` — `@/components/ui/dropdown-menu` etc. | |
| Clickable table/list row | Plain `<tr>`/`<div>` row with an explicit `cursor-pointer` + `onClick` | Not covered by the global selector rule — add `cursor-pointer` on the row itself. |
| Icon-only button | `Button` (`size="icon"`) | Keeps the shared Button's focus/disabled/cursor behavior; don't hand-roll an icon button from a bare `<button>`. |
| Status indicator | `StatusBadge`/`Badge` — `@/components/ui/status-badge`, `@/components/ui/badge` | Never a button styled as a badge. |

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

## Before building any new interactive control

1. Check the component inventory above for an existing primitive that already does this job — `Button` variant, `Tabs`, `Select`, `DropdownMenuItem`, a clickable-row pattern.
2. Reuse the existing variant/component rather than styling a new one-off control.
3. Don't invent a custom button color/background unless there's a genuine semantic need (primary/destructive/status are the only sanctioned departures from the shared variants).
4. Confirm the control shows `cursor: pointer` when enabled — the global rule (`src/styles.css`) and shared `Button`/`TabsTrigger` components cover semantic elements automatically; a custom clickable row/div still needs it added explicitly.
5. Confirm the disabled state is visibly muted and never shows a pointer cursor.
6. Confirm keyboard reachability and `focus-visible` behavior still work — don't strip focus rings for visual cleanliness.
7. Test the control at 100% and 90% browser zoom before considering it done.
