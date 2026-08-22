// netlify/functions/lib/google-ads-campaign-lead-ids.ts
//
// Shared campaign -> lead_id resolution, extracted from
// google-ads-campaign-crm-outcomes.ts (Step 1 of that endpoint) so a
// second endpoint (google-ads-campaign-leads.ts, used for the Leads page
// deep-link filter) can resolve the exact same lead_id set without
// duplicating the matching rule. This is NOT a new or different
// attribution rule — it is the existing, unchanged one: campaign_id match
// is authoritative; campaign_name is ONLY consulted for a submission row
// that has no campaign_id at all (never as an override for a row that
// already has a real, different campaign_id).

export interface CampaignSubmissionRow {
  lead_id: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
}

export interface CampaignLeadIdResolution {
  leadIds: string[];
  attributionMode: "campaign_id" | "campaign_name_fallback" | null;
}

export function resolveCampaignAttributedLeadIds(
  submissions: CampaignSubmissionRow[],
  campaignId: string,
  campaignName: string,
): CampaignLeadIdResolution {
  let usedCampaignIdMatch = false;
  let usedCampaignNameFallback = false;
  const matchedLeadIds = new Set<string>();

  for (const s of submissions) {
    if (!s.lead_id) continue;
    if (campaignId && s.campaign_id === campaignId) {
      matchedLeadIds.add(s.lead_id);
      usedCampaignIdMatch = true;
    } else if (!s.campaign_id && campaignName && s.campaign_name === campaignName) {
      matchedLeadIds.add(s.lead_id);
      usedCampaignNameFallback = true;
    }
  }

  return {
    leadIds: [...matchedLeadIds],
    attributionMode: usedCampaignIdMatch ? "campaign_id" : (usedCampaignNameFallback ? "campaign_name_fallback" : null),
  };
}
