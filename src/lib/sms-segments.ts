// src/lib/sms-segments.ts
//
// Practical GSM-7 / UCS-2 SMS length + segment counting for CRM display
// purposes. Covers the standard GSM 03.38 basic + extension character
// tables, which is what real carriers use to decide encoding — not a
// full carrier-grade implementation (a few rare edge cases vary by
// carrier), but correct for the overwhelming majority of real SMS text.
//
// Rules implemented:
//   GSM-7:  160 chars for a single segment, 153 per segment once concatenated
//   UCS-2:   70 chars for a single segment,  67 per segment once concatenated
// A message that contains ANY character outside the GSM-7 basic+extension
// tables (e.g. emoji, most non-Latin scripts) forces the whole message to
// UCS-2 — that's how real carriers behave, not a simplification here.

const GSM_7_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";

// Extension-table characters require an ESC (0x1B) prefix before their own
// code — two septets each, not one.
const GSM_7_EXTENDED = "^{}\\[~]|€";

const GSM_7_BASIC_SET = new Set(GSM_7_BASIC);
const GSM_7_EXTENDED_SET = new Set(GSM_7_EXTENDED);

export type SmsEncoding = "GSM-7" | "UCS-2";

export type SmsSegmentInfo = {
  /** Character count as typed (by code point, not UTF-16 code unit). */
  length: number;
  encoding: SmsEncoding;
  /** 0 for an empty message. */
  segments: number;
  /** Limit that applies to each segment once the message spans more than one. */
  perSegmentLimit: number;
  /** Limit for the whole message to still fit in a single segment. */
  singleSegmentLimit: number;
  /** True once the message is unusually long — a soft warning signal, not a hard block. */
  isUnusuallyLong: boolean;
};

function isGsm7Compatible(text: string): boolean {
  for (const ch of text) {
    if (!GSM_7_BASIC_SET.has(ch) && !GSM_7_EXTENDED_SET.has(ch)) return false;
  }
  return true;
}

// Septet count: basic-table chars cost 1 septet, extension-table chars cost 2.
function gsm7SeptetLength(text: string): number {
  let total = 0;
  for (const ch of text) total += GSM_7_EXTENDED_SET.has(ch) ? 2 : 1;
  return total;
}

function computeSegments(units: number, singleLimit: number, perSegmentLimit: number): number {
  if (units === 0) return 0;
  if (units <= singleLimit) return 1;
  return Math.ceil(units / perSegmentLimit);
}

// Soft warning threshold — not a hard block, just flags unusually long
// messages (4+ segments) so the composer can show a caution without ever
// preventing send.
const WARN_AT_SEGMENTS = 4;

export function analyzeSmsLength(text: string): SmsSegmentInfo {
  const length = [...text].length;

  if (isGsm7Compatible(text)) {
    const septets = gsm7SeptetLength(text);
    const singleSegmentLimit = 160;
    const perSegmentLimit = 153;
    const segments = computeSegments(septets, singleSegmentLimit, perSegmentLimit);
    return {
      length,
      encoding: "GSM-7",
      segments,
      perSegmentLimit,
      singleSegmentLimit,
      isUnusuallyLong: segments >= WARN_AT_SEGMENTS,
    };
  }

  const singleSegmentLimit = 70;
  const perSegmentLimit = 67;
  const segments = computeSegments(length, singleSegmentLimit, perSegmentLimit);
  return {
    length,
    encoding: "UCS-2",
    segments,
    perSegmentLimit,
    singleSegmentLimit,
    isUnusuallyLong: segments >= WARN_AT_SEGMENTS,
  };
}
