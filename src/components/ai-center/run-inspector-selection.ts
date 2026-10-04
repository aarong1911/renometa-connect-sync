// src/components/ai-center/run-inspector-selection.ts
//
// AI-3F (inline execution-details fix). Pure, dependency-free selection
// logic for the AI Run Inspector's "click a row to expand its details
// directly underneath it" behavior — extracted so the toggle/single-
// expansion invariant is unit-testable without any React rendering
// infrastructure (this repo has none configured: no vitest/jsdom/
// testing-library, no existing *.test.tsx anywhere — every test in this
// codebase is a plain `node --test` unit test against pure or esbuild-
// bundled logic; see the AI Center test suites under
// netlify/functions/lib/ai/ for the established convention this follows).
//
// The component (ai-run-inspector.tsx) holds selection as a single scalar
// `selectedId: string | null` and derives each row's expanded state as
// `row.id === selectedId` directly in its render — which structurally
// guarantees "only one row expanded at a time" by construction (a single
// value can equal at most one row id). computeExpandedRowIds() below
// re-states that same derivation as a pure function so the invariant is
// directly assertable in a test, rather than trusted by inspection alone.

/**
 * Given the currently-selected execution id and the id of the row just
 * clicked, returns the NEW selectedId: clicking the already-expanded row
 * collapses it (returns null); clicking any other row expands that one
 * instead (returns its id) — replacing whichever row was previously
 * expanded, never adding to it.
 */
export function toggleExecutionSelection(currentSelectedId: string | null, clickedId: string): string | null {
  return currentSelectedId === clickedId ? null : clickedId;
}

/** True when `rowId` is the one row whose details should render expanded. */
export function isRowExpanded(selectedId: string | null, rowId: string): boolean {
  return selectedId === rowId;
}

/**
 * Given the full list of row ids currently rendered and the current
 * selection, returns exactly which ids are expanded — always 0 or 1 ids
 * (assuming unique row ids, which agent_executions.id — a uuid primary
 * key — always is), never more. Exists purely to make "only one execution
 * expanded at a time" an assertable property rather than an assumption.
 */
export function computeExpandedRowIds(rowIds: readonly string[], selectedId: string | null): string[] {
  return rowIds.filter((id) => isRowExpanded(selectedId, id));
}
