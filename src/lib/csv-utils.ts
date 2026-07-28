// src/lib/csv-utils.ts
//
// Stage 9.5 — shared CSV parsing/escaping foundation. Consolidates the
// near-identical parseCSVLine/escapeCSV/downloadCSV/parseCSVPreview logic
// that used to be hand-copied in leads-csv.ts and contacts-csv.ts (both
// already proven reliable in production), rather than replacing them with
// a new library. Extends that proven logic with: UTF-8 BOM stripping,
// header normalization, and row-numbered parse limits used by the
// import-preview step (Priority 3/11).

/** Strips a UTF-8 BOM if present — Excel commonly prepends one on export. */
export function stripBOM(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function escapeCSV(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n") || val.includes("\r")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

/**
 * Builds a downloadable CSV Blob URL and triggers a browser download.
 * `withBOM` prepends a UTF-8 BOM so Excel opens the file with correct
 * encoding for non-ASCII characters — off by default to match prior
 * behavior, opt-in for exports that want it (Priority 10).
 */
export function downloadCSV(csv: string, filename: string, withBOM = false): void {
  const content = withBOM ? "﻿" + csv : csv;
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Quote-aware single-line CSV parser — handles `""` escaped quotes. */
export function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ",") { result.push(current.trim()); current = ""; }
      else { current += ch; }
    }
  }
  result.push(current.trim());
  return result;
}

/** Splits raw file text into non-empty logical lines, handling \r\n, \r, and \n. */
export function splitCSVLines(text: string): string[] {
  return stripBOM(text).split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
}

export function normalizeHeaderLabel(h: string): string {
  return h.toLowerCase().trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

export type CSVPreview = { headers: string[]; preview: string[][]; totalRows: number };

/** Large-file guardrails (Priority 11). */
export const CSV_MAX_PREVIEW_ROWS = 5000;
export const CSV_MAX_SYNC_IMPORT_ROWS = 1000;
export const CSV_WARN_ROW_THRESHOLD = 500;

/**
 * Parses just the header + a short sample for the mapping-preview UI.
 * `totalRows` reflects the real row count up to CSV_MAX_PREVIEW_ROWS —
 * rows beyond that are not read at all (never silently truncated without
 * saying so; callers should surface totalRows === CSV_MAX_PREVIEW_ROWS as
 * "at least this many" when the file could be larger).
 */
export function parseCSVPreview(csv: string, sampleSize = 3): CSVPreview {
  const lines = splitCSVLines(csv);
  if (lines.length === 0) return { headers: [], preview: [], totalRows: 0 };
  const headers = parseCSVLine(lines[0]);
  const dataLines = lines.slice(1, 1 + CSV_MAX_PREVIEW_ROWS);
  const preview = dataLines.slice(0, sampleSize).map(parseCSVLine);
  return { headers, preview, totalRows: dataLines.length };
}

/** Row-numbered parse error — row is 1-indexed against the original file (header = row 1). */
export type RowError = { row: number; field?: string; message: string };

export function formatRowError(e: RowError): string {
  return e.field ? `Row ${e.row}: ${e.field} — ${e.message}` : `Row ${e.row}: ${e.message}`;
}
