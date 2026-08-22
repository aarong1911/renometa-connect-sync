// netlify/functions/lib/google-ads-ad-group-lead-ids.ts
//
// Ad Group -> lead_id resolution (Ad Group-Level CRM Outcomes phase) —
// the ad-group-scoped counterpart to
// lib/google-ads-campaign-lead-ids.ts's resolveCampaignAttributedLeadIds().
// Deliberately a SEPARATE function rather than a generalized/parameterized
// version of the campaign resolver: the two rules are similar in shape but
// intentionally NOT identical —
//
//   - Campaign attribution has a documented, deliberate campaign_name
//     FALLBACK for a submission row with campaign_id IS NULL (needed for
//     local dev/test fixtures that never recorded a campaign_id).
//   - Ad Group attribution has NO such fallback. Per this phase's explicit
//     product decision (Step 15), ad_group_id exact match is the ONLY
//     accepted attribution path — there is no ad_group_name column on
//     google_ads_lead_submissions at all, and even if there were, name
//     fallback was explicitly rejected as a future addition without an
//     established product rule. A submission row with ad_group_id IS NULL
//     is simply never attributed to any ad group, full stop.
//
// campaignId is still checked as a defense-in-depth cross-check (Step 4):
// ad_group_id is unique within an advertiser already, so in practice this
// second check should never actually exclude a row that ad_group_id alone
// already matched — but a submission row that DOES carry a non-null
// campaign_id is required to match the requested campaignId too, guarding
// against any future data anomaly or cross-campaign ad_group_id reuse. A
// row with campaign_id IS NULL is still accepted on ad_group_id alone
// (the same "conservative but not overly strict" rule the task specifies).

export interface AdGroupSubmissionRow {
  lead_id: string | null;
  campaign_id: string | null;
  ad_group_id: string | null;
}

/**
 * Resolves the exact set of unique CRM lead IDs attributed to one ad group,
 * via google_ads_lead_submissions.ad_group_id exact match only — never via
 * contact, campaign alone, ad group name, keyword, or search term.
 */
export function resolveAdGroupAttributedLeadIds(
  submissions: AdGroupSubmissionRow[],
  campaignId: string,
  adGroupId: string,
): string[] {
  const matched = new Set<string>();
  for (const s of submissions) {
    if (!s.lead_id) continue;
    if (s.ad_group_id !== adGroupId) continue;
    if (s.campaign_id && s.campaign_id !== campaignId) continue;
    matched.add(s.lead_id);
  }
  return [...matched];
}
