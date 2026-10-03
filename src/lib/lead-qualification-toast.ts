// src/lib/lead-qualification-toast.ts
//
// AI-3E (toast UX fix). Pure, dependency-free toast content/options for the
// Leads page's "Run Lead Qualification" success toast — extracted out of
// leads.tsx so its copy, duration, and navigation target are unit-testable
// without mounting the Leads route.
//
// ROOT CAUSE #1, duration (audited, not guessed): sonner@2.0.7 (the version
// actually installed — see package.json/pnpm-lock) defaults every toast to
// its internal `TOAST_LIFETIME = 4000` (4 seconds) when no `duration` is
// passed — confirmed by reading node_modules/sonner's own bundled source,
// not assumed from docs. The previous toast call passed no `duration`, so
// it used that 4s default. Fixed by passing an explicit longer duration
// below. This alone was NOT sufficient, though — see #2.
//
// ROOT CAUSE #2, the actual click-blocking mechanism (found on re-audit,
// after duration alone did not fix it — read from the installed packages'
// own source, not assumed):
//   - z-index was checked and ruled out: sonner's own CSS sets
//     `[data-sonner-toaster]{z-index:999999999}` vs. the Sheet's
//     overlay/content at `z-50` (sheet.tsx) — the toast always renders
//     visually above the Sheet.
//   - aria-hidden was checked and ruled out: @radix-ui/react-dialog hides
//     sibling DOM content while open via aria-hidden's `hideOthers()`
//     (confirmed in its own source — it calls `hideOthers(content)`, never
//     `suppressOthers`/`inertOthers`), which only sets `aria-hidden="true"`,
//     never the native `inert` attribute — that alone never blocks clicks.
//   - THE REAL MECHANISM: @radix-ui/react-dialog's `DialogContentModal` —
//     used whenever a Dialog/Sheet is `modal` (the default; sheet.tsx never
//     overrides it) — renders its `DismissableLayer` with
//     `disableOutsidePointerEvents: true`. Reading
//     @radix-ui/react-dismissable-layer's own source: when that prop is
//     true, it sets `document.body.style.pointerEvents = "none"` for as
//     long as the layer is mounted, and re-enables `pointer-events: auto`
//     ONLY on its own layer's DOM node (the Sheet's content) via an inline
//     style — no other element gets that opt-back-in unless it registers
//     itself as a `DismissableLayerBranch`. Sonner's toaster is a completely
//     separate portal that never does this, and its own CSS never sets
//     `pointer-events: auto` on the visible toast (only on a
//     `[data-visible=false]` — i.e. already-dismissed — toast). So the
//     toast inherits `pointer-events: none` from `body` and is genuinely,
//     structurally unclickable for as long as ANY modal Sheet/Dialog is
//     open anywhere in the app — not a timing race, not a z-index/aria
//     issue, a real CSS-inheritance consequence of Radix's own modal
//     pointer-event isolation.
//
// FIX: per product preference, the Leads page now closes the Lead Sheet
// (via `onOpenChange(false)`) on a true successful run BEFORE calling
// `toast.success(...)` — once the Sheet unmounts, DismissableLayer's own
// cleanup effect restores `body.style.pointerEvents`, so the toast becomes
// fully interactive. This is Option A from the fix priority list: closing
// the modal that was disabling pointer events, rather than touching sonner,
// Radix, or any other Sheet/Dialog's behavior globally (Option C, the
// explicitly least-preferred and un-done option here).

export const LEAD_QUALIFICATION_TOAST_MESSAGE =
  "Lead Qualification ran. View it in AI Center → Test Console.";

/** 12s — well inside the requested 10-15s range. Long enough that a person
 * doesn't have to race the timeout to find and click "View" (sonner also
 * pauses this countdown on hover, so an engaged user gets even longer). */
export const LEAD_QUALIFICATION_TOAST_DURATION_MS = 12000;

/** The exact navigate() argument shape ai-center.tsx's own validateSearch()
 * accepts for its Test Console tab (confirmed against ai-center.tsx, not
 * assumed) — kept as one literal so the toast and any future direct link
 * can never drift out of sync with each other. */
export const LEAD_QUALIFICATION_TOAST_DESTINATION = {
  to: "/ai-center",
  search: { tab: "console" as const },
} as const;

/**
 * Builds the sonner `toast.success(message, options)` second-argument
 * object for the Run Lead Qualification success toast, binding the app's
 * own `navigate` function into the action's onClick. Kept as a pure
 * function (no React, no sonner import) so `duration`/the action's
 * navigation target are directly assertable in a unit test rather than only
 * via a JSX/DOM-level toast render.
 */
export function buildLeadQualificationSuccessToastOptions(
  navigate: (destination: typeof LEAD_QUALIFICATION_TOAST_DESTINATION) => unknown,
) {
  return {
    duration: LEAD_QUALIFICATION_TOAST_DURATION_MS,
    action: {
      label: "View",
      onClick: () => {
        navigate(LEAD_QUALIFICATION_TOAST_DESTINATION);
      },
    },
  };
}

/** The subset of runLeadQualification()'s real result statuses this
 * decision cares about — kept narrow rather than importing the client's
 * full result union, so this file stays dependency-free. */
export type LeadQualificationResultStatusForDrawerClose = "error" | "skipped" | "awaiting_approval" | "recommendation";

/**
 * Whether the Lead drawer (Sheet) should be closed for a given
 * runLeadQualification() outcome. Pure so the exact close/no-close decision
 * per status is unit-testable without mounting the Leads route or a Sheet.
 *
 * Only a true, non-approval-gated success ("recommendation") closes the
 * drawer — this is both the requested product behavior (the operation is
 * genuinely complete, nothing more to see in the drawer) and the fix for
 * the toast's "View" action being unclickable while the Sheet stays open
 * (see this file's header for the confirmed root cause). error/skipped
 * never close (nothing completed, or the person may want to retry/fix
 * something without losing their place). awaiting_approval never closes
 * either — its toast has no "View" action to unblock, and the approval
 * step itself still happens later elsewhere, so there is no "fully done"
 * moment here the way there is for a plain recommendation.
 */
export function shouldCloseLeadDrawerForResult(status: LeadQualificationResultStatusForDrawerClose): boolean {
  return status === "recommendation";
}
