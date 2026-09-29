// src/lib/lead-qualification-toast.ts
//
// AI-3E (toast UX fix). Pure, dependency-free toast content/options for the
// Leads page's "Run Lead Qualification" success toast — extracted out of
// leads.tsx so its copy, duration, and navigation target are unit-testable
// without mounting the Leads route.
//
// ROOT CAUSE (audited, not guessed): sonner@2.0.7 (the version actually
// installed — see package.json/pnpm-lock) defaults every toast to its
// internal `TOAST_LIFETIME = 4000` (4 seconds) when no `duration` is passed
// — confirmed by reading node_modules/sonner's own bundled source, not
// assumed from docs. The previous toast call passed no `duration`, so it
// used that 4s default. That fully explains BOTH reported symptoms as the
// SAME root cause: the toast disappearing "too quickly" IS the reason the
// action was "not reliably clickable" — the user was racing a 4s window
// from the moment the toast appeared.
//
// This was NOT a Sheet-overlay/pointer-events/z-index bug — that was
// investigated and ruled out, not assumed away:
//   - sonner's own CSS sets `[data-sonner-toaster]{z-index:999999999}`,
//     versus the Sheet's overlay/content at `z-50` (sheet.tsx) — the toast
//     always renders visually and interactively above the Sheet.
//   - @radix-ui/react-dialog (the Sheet's underlying primitive) hides other
//     DOM content while open via aria-hidden's `hideOthers()` (confirmed by
//     reading node_modules/@radix-ui/react-dialog's own source — it calls
//     `hideOthers(content)`, not `suppressOthers`/`inertOthers`), which only
//     sets `aria-hidden="true"` on siblings, never the native `inert`
//     attribute. `aria-hidden` alone does not disable pointer events or
//     click handling in a standard browser — it is a screen-reader signal
//     only. There is no CSS rule anywhere in this repo that maps
//     `[aria-hidden]` to `pointer-events: none` (also confirmed).
// So the real, sole fix is a longer explicit `duration` — not any overlay
// masking or Sheet/Toaster remounting change.

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
