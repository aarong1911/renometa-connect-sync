// netlify/functions/lib/google-ads-campaign-attribution.ts
//
// Campaign-reporting-specific appointment attribution — used ONLY by
// google-ads-campaign-crm-outcomes.ts. Deliberately a SEPARATE, STRICTER
// rule from resolveGoogleAdsConversionMilestone()'s appointment_booked
// branch (lib/google-ads-conversion-events.ts), never a modification of
// it — that resolver answers "did this exact milestone happen for THIS
// ONE already-validated lead", where a contact-level fallback is safe
// because it's always evaluated in the context of a single specific lead.
// Campaign reporting is a different question: it aggregates MANY leads at
// once, and if a contact has Google-Ads-attributed leads spread across
// different campaigns (or even multiple leads within the very same
// campaign), a contact-only appointment becomes genuinely ambiguous —
// which lead, and therefore which campaign, actually earns credit for it?
// This module's rule is: prefer undercounting to double-counting, always.
// No heuristic tie-breaking (latest lead, lead status, campaign name
// priority) is ever used to resolve that ambiguity — an ambiguous
// contact-only appointment is simply never attributed to any campaign.

export interface CampaignAppointmentRow {
  id: string;
  entity_type: string | null;
  entity_id: string | null;
  contact_id: string | null;
}

export interface CampaignAttributedLead {
  id: string;
  contact_id: string | null;
}

/**
 * Resolves the set of unique appointment IDs attributable to one
 * campaign's lead set, under the campaign-reporting-safe rule:
 *
 *   1. EXACT LINK WINS, unconditionally — an appointment with
 *      entity_type='lead' and a non-null entity_id is attributed to
 *      whichever lead it's actually linked to, full stop. If that lead is
 *      one of this campaign's leads, it counts for this campaign; if it's
 *      linked to some OTHER lead entirely, it does NOT count for this
 *      campaign, and — critically — it is NEVER reconsidered via the
 *      contact-only fallback below, even if it happens to share a contact
 *      with one of this campaign's leads. An appointment that already has
 *      a definitive home never gets a second, competing attribution.
 *
 *   2. CONTACT-ONLY FALLBACK — only reached for an appointment with no
 *      exact lead entity link at all. Attributed to a campaign lead only
 *      if ALL of:
 *        a. the appointment's contact_id matches that lead's contact_id, AND
 *        b. that contact_id maps to EXACTLY ONE Google-Ads-attributed
 *           lead in `googleAttributedLeadCountByContact` — a count the
 *           caller computes from EVERY google_ads_lead_submissions row
 *           for this org+customer (never limited to just this campaign's
 *           leads), so it reflects whether the contact has any OTHER
 *           Google-attributed lead anywhere, in any campaign.
 *      If the contact maps to 2+ Google-attributed leads — whether those
 *      leads belong to different campaigns or the very same one being
 *      queried — every contact-only appointment for that contact is
 *      rejected as ambiguous, for every campaign.
 *
 * Always returns unique appointment IDs (a Set) — an appointment can
 * never be counted more than once, however many of the input rows or
 * campaign leads it happens to match against internally.
 */
export function resolveCampaignAttributedAppointmentIds(
  appointments: CampaignAppointmentRow[],
  campaignLeads: CampaignAttributedLead[],
  googleAttributedLeadCountByContact: Map<string, number>,
): Set<string> {
  const campaignLeadIds = new Set(campaignLeads.map((l) => l.id));

  const matched = new Set<string>();
  for (const a of appointments) {
    const hasExactLeadLink = a.entity_type === "lead" && !!a.entity_id;
    if (hasExactLeadLink) {
      // Exact link present — this appointment already has a definitive
      // home. Count it for this campaign only if that home IS one of
      // this campaign's leads; never fall through to the contact
      // fallback below regardless of the outcome.
      if (campaignLeadIds.has(a.entity_id as string)) matched.add(a.id);
      continue;
    }

    if (!a.contact_id) continue;
    const matchingLead = campaignLeads.find((l) => l.contact_id === a.contact_id);
    if (!matchingLead) continue;

    const globalGoogleLeadCount = googleAttributedLeadCountByContact.get(a.contact_id) ?? 0;
    if (globalGoogleLeadCount === 1) {
      matched.add(a.id);
    }
    // globalGoogleLeadCount !== 1 (0 shouldn't happen here since we just
    // found a matching campaign lead for this contact, but 2+ means the
    // contact has other Google-attributed leads too) — ambiguous, reject.
  }
  return matched;
}
