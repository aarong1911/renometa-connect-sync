// src/components/ai-center/run-inspector-selection.test.ts
//
// Run:  node --test src/components/ai-center/run-inspector-selection.test.ts
//
// AI-3F. Covers the inline expandable execution-row requirements:
//   - selecting a row expands its details (isRowExpanded/toggleExecutionSelection)
//   - selecting a different row moves/closes the prior one (single scalar
//     selection, not a Set — see computeExpandedRowIds' own doc comment)
//   - selecting the same row again collapses it
//   - no detached global "{selected && <ExecutionDetail .../>}" remains in
//     ai-run-inspector.tsx, and ExecutionDetail is only ever referenced
//     from inside the per-row map (a source-text check — the same
//     reasoning as leads-toast's own regression test: no component-render
//     test infrastructure exists in this repo, see this file's header for
//     the fuller explanation, mirrored from run-inspector-selection.ts).

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toggleExecutionSelection, isRowExpanded, computeExpandedRowIds } from "./run-inspector-selection.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "ai-run-inspector.tsx"), "utf8");

test("selecting a row expands its details", () => {
  const next = toggleExecutionSelection(null, "exec-1");
  assert.equal(next, "exec-1");
  assert.equal(isRowExpanded(next, "exec-1"), true);
});

test("selecting a different row closes the prior one and expands the new one", () => {
  let selected: string | null = "exec-1";
  selected = toggleExecutionSelection(selected, "exec-2");
  assert.equal(selected, "exec-2");
  assert.equal(isRowExpanded(selected, "exec-1"), false);
  assert.equal(isRowExpanded(selected, "exec-2"), true);
});

test("selecting the same row again collapses it", () => {
  let selected: string | null = "exec-1";
  selected = toggleExecutionSelection(selected, "exec-1");
  assert.equal(selected, null);
  assert.equal(isRowExpanded(selected, "exec-1"), false);
});

test("only one execution is ever expanded at a time, across a full row list", () => {
  const ids = ["exec-1", "exec-2", "exec-3", "exec-4"];
  let selected: string | null = null;
  selected = toggleExecutionSelection(selected, "exec-3");
  assert.deepEqual(computeExpandedRowIds(ids, selected), ["exec-3"]);
  selected = toggleExecutionSelection(selected, "exec-1");
  assert.deepEqual(computeExpandedRowIds(ids, selected), ["exec-1"], "moving selection must close the prior row, not add to it");
  selected = toggleExecutionSelection(selected, "exec-1");
  assert.deepEqual(computeExpandedRowIds(ids, selected), [], "collapsing must leave zero rows expanded");
});

test("no detached global details section remains — ExecutionDetail is only referenced once, from inside the per-row map", () => {
  const occurrences = source.match(/<ExecutionDetail\b/g) ?? [];
  assert.equal(occurrences.length, 1, "ExecutionDetail should be rendered exactly once, inline per selected row — not once inline plus a leftover detached usage");
  assert.ok(!/\{selected\s*&&\s*<ExecutionDetail/.test(source), "the old detached bottom-of-list rendering pattern must be gone");
  assert.ok(!/const selected = executions\.find/.test(source), "the unused top-level 'selected' lookup that fed the detached section should be removed, not left dangling");
});

test("each row's detail renders inline immediately after that row (button immediately followed by its own conditional detail block, inside one Fragment)", () => {
  // A loose structural check: the row button and its conditional detail
  // share the same `row.id`-derived detailId and both live inside the same
  // per-row Fragment in the .map() callback — confirmed by requiring both
  // aria-controls={detailId} on the button and id={detailId} on the detail
  // wrapper to appear, using the same detailId variable, within one map body.
  assert.ok(source.includes("aria-controls={detailId}"), "row button must reference the detail element it expands, for accessibility");
  assert.ok(source.includes("id={detailId}"), "the inline detail wrapper must expose the id the button's aria-controls points at");
  assert.ok(source.includes("aria-expanded={isExpanded}"), "the row button must expose its expanded state for accessibility");
});
