# Redesign against your REAL app — batch 14 (Calendar, Inbox — after checking, not rebuilding)

## Files → destination
calendar.tsx → src/routes/calendar.tsx
inbox.tsx → src/routes/inbox.tsx

## Important: I checked all three flagged pages against the real code before touching anything

Last time I flagged Calendar, Inbox, and AI Center as needing rebuilds
based on comparing screenshots. Before actually rewriting them, I read
the real source — and two of the three turned out to already be
excellent, real, and in some ways better than Lovable's mock. Rewriting
them to match Lovable exactly would have been a **downgrade**. Here's
what I actually found and did:

## Calendar — one real gap, now fixed

Your calendar already had: a full Week/Day/Month view system, colored
event blocks positioned by time, a **live current-time indicator line**
(Lovable's mock doesn't even have this), and a side panel with real
inline note-editing (saves to Supabase), real call/email links, and
real budget/address per appointment.

The only actual gap: it defaulted to Month view; Lovable defaults to
Week. **Fixed** — one line changed (`useState<ViewMode>("month")` →
`"week"`). Nothing else touched.

## Inbox — added Lovable's two extra context sections, with real data

Your inbox's contact panel already had real Assignment, Tags, Active
Projects, Lifetime Value, and Recent Activity — genuinely more complete
than Lovable's mock. Lovable's panel additionally shows "Open Deals" and
"Upcoming Appointments," which yours didn't have. Added both, backed by
real queries:
- **Open Deals**: real open deals (`stage` not won/lost) for the active
  contact, linking to your real Pipeline page.
- **Upcoming Appointments**: real future appointments for the contact
  from the `appointments` table.

Nothing else in Inbox touched — the composer, templates, folders, tags,
and all real messaging logic are untouched.

## AI Center — no changes made

Checked the real file in full: it already has Lovable's exact structure
— tabs for Autonomous Agents / AI Tools / Voice Agent, agents grouped by
category (Sales, Ops, Financials, Marketing, Internal) as toggleable
cards. This already matches Lovable closely. My earlier note that it was
"table-based with health bars" was wrong — that was a stale assumption
from memory, not something I'd actually verified. Corrected now:
no changes needed.

## How to apply
Drop both files in, restart, hard refresh. No dependency on other batches.
