// netlify/functions/lib/voice-crm.ts
//
// Small CRM helpers for the Voice AI flow.
//
// The Voice lifecycle is Contact → Lead → Deal → Appointment. A Project is
// created LATER, only through the platform's existing manual conversion /
// approval workflow (deal-detail-drawer "Convert to Project", approved
// estimate) — never automatically from a booked Voice call.

/**
 * Turn the raw service/project phrase the model captured into the clean
 * label the CRM should display on the Lead / Deal.
 *
 *   "full house renovation"           -> "Full house renovation"
 *   "full house renovation estimate"  -> "Full house renovation"
 *   "kitchen renovation estimate"     -> "Kitchen renovation"
 *   "roof replacement appointment"    -> "Roof replacement"
 *   "window replacement consultation" -> "Window replacement"
 *
 * Rules:
 *  - drop a TRAILING generic scheduling suffix that was not part of the
 *    real service name: "estimate", "free estimate", "appointment",
 *    "consultation" (and plurals);
 *  - clean casing: ALL-CAPS or all-lowercase text becomes sentence case;
 *    an intentionally mixed-case name is left as-is apart from ensuring the
 *    first character is capitalized (so "kitchen remodel for ADU" keeps
 *    "ADU");
 *  - never change the service category or the underlying qualification
 *    details — this only touches the display label.
 */
export function normalizeServiceTitle(raw: string | null | undefined): string {
  let s = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return '';

  s = s
    .replace(/(^|[\s,–—-]+)(free\s+)?(estimates?|appointments?|consultations?)$/i, '')
    .trim();
  if (!s) return '';

  const hasLower = /[a-z]/.test(s);
  const hasUpper = /[A-Z]/.test(s);
  if (!hasUpper || !hasLower) s = s.toLowerCase(); // ALL-CAPS or all-lowercase -> sentence case

  return s.charAt(0).toUpperCase() + s.slice(1);
}
