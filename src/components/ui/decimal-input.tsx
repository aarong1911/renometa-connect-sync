// src/components/ui/decimal-input.tsx
//
// Phase 10.4 — one shared numeric-entry component for quantity/price/tax/
// discount/deposit fields, replacing bare `<input type="number">`. Native
// number inputs were the source of the browser spinner arrows, aggressive
// reformatting, and clipped/narrow rendering flagged in live testing.
//
// Renders type="text" + inputMode="decimal" (real mobile numeric keyboard,
// full control over formatting/cursor) with parsing that:
//   - keeps the raw string the caller owns (never silently appends .00 —
//     "1" stays "1", not "1.0")
//   - rejects letters, "-", "+", "e"/"E", and extra decimal points as the
//     user types (no NaN, no exponent notation, no negatives)
//   - clamps to `max` only on blur, never mid-keystroke (no cursor jumps)
//   - normalizes a trailing "." or leading zeros ("007" -> "7") on blur
import * as React from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

function sanitize(raw: string, allowNegative: boolean): string {
  let v = raw.replace(/[eE+]/g, "");
  if (!allowNegative) v = v.replace(/-/g, "");
  else v = (v.match(/^-?/)?.[0] ?? "") + v.slice(v.startsWith("-") ? 1 : 0).replace(/-/g, "");
  // Keep digits and at most one decimal point.
  const negPrefix = allowNegative && v.startsWith("-") ? "-" : "";
  const rest = negPrefix ? v.slice(1) : v;
  const cleaned = rest.replace(/[^\d.]/g, "");
  const firstDot = cleaned.indexOf(".");
  const noExtraDots = firstDot === -1 ? cleaned : cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
  return negPrefix + noExtraDots;
}

function normalizeOnBlur(raw: string, max?: number): string {
  if (raw === "" || raw === "-") return "";
  let n = Number(raw);
  if (Number.isNaN(n)) return "";
  if (max !== undefined) n = Math.min(n, max);
  // Preserve up to what the user typed (don't force trailing zeros) —
  // just re-stringify to drop things like a trailing "." or leading zeros.
  return String(n);
}

export const DecimalInput = React.forwardRef<
  HTMLInputElement,
  {
    value: string;
    onChange: (next: string) => void;
    max?: number;
    allowNegative?: boolean;
    className?: string;
    placeholder?: string;
    id?: string;
    disabled?: boolean;
    "aria-label"?: string;
    "aria-invalid"?: boolean;
    onFocus?: React.FocusEventHandler<HTMLInputElement>;
    onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  }
>(({ value, onChange, max, allowNegative = false, className, onFocus, onKeyDown, ...rest }, ref) => {
  return (
    <Input
      ref={ref}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      value={value}
      onChange={(e) => onChange(sanitize(e.target.value, allowNegative))}
      onBlur={(e) => onChange(normalizeOnBlur(e.target.value, max))}
      onFocus={(e) => { e.target.select(); onFocus?.(e); }}
      onKeyDown={(e) => {
        // Block the characters number inputs otherwise silently accept
        // (exponent notation, extra sign chars) at the keystroke level too,
        // not just via sanitize-after-the-fact.
        if (["e", "E", "+"].includes(e.key) || (!allowNegative && e.key === "-")) e.preventDefault();
        onKeyDown?.(e);
      }}
      className={cn("tabular-nums", className)}
      {...rest}
    />
  );
});
DecimalInput.displayName = "DecimalInput";
