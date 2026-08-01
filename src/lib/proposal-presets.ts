// src/lib/proposal-presets.ts
//
// Phase 10.4 — shared, read-only, application-level starter content for the
// four Proposal Content fields (Customer Note / Exclusions / Assumptions /
// Terms). These are plain in-repo constants, not a database table — every
// organization sees the exact same three presets per category, and no
// organization can mutate them (the only way to "edit" one is to copy its
// text into an org-owned row via proposal-templates-store.ts, which is a
// completely independent copy from that point on).
//
// General business content only — explicitly NOT legal advice and makes no
// compliance claim; organizations are expected to review/edit before use.

export type ProposalPresetCategory = "customer_note" | "exclusions" | "assumptions" | "terms";

export const PROPOSAL_PRESET_CATEGORIES: ProposalPresetCategory[] = [
  "customer_note", "exclusions", "assumptions", "terms",
];

export const PROPOSAL_PRESET_CATEGORY_LABELS: Record<ProposalPresetCategory, string> = {
  customer_note: "Customer Note", exclusions: "Exclusions", assumptions: "Assumptions", terms: "Terms",
};

export type ProposalPreset = { id: string; category: ProposalPresetCategory; name: string; content: string };

export const SHARED_PRESETS: ProposalPreset[] = [
  // ── Customer Note ──
  {
    id: "customer_note.friendly_professional", category: "customer_note", name: "Friendly & Professional",
    content: "Thank you for the opportunity to provide this estimate for your project. This proposal outlines the recommended scope, materials, pricing, and expected project requirements. Please review the details and contact us with any questions or requested changes.",
  },
  {
    id: "customer_note.detailed_summary", category: "customer_note", name: "Detailed Project Summary",
    content: "Thank you for considering us for your project. This estimate summarizes the proposed scope of work, anticipated materials, pricing, allowances, and project conditions based on the information currently available. Please review each section carefully and let us know if you would like any changes or additional options included.",
  },
  {
    id: "customer_note.short_direct", category: "customer_note", name: "Short & Direct",
    content: "Thank you for the opportunity to provide this estimate. Please review the proposed scope, pricing, and terms below. Contact us with any questions or requested changes.",
  },
  // ── Exclusions ──
  {
    id: "exclusions.standard_construction", category: "exclusions", name: "Standard Construction Exclusions",
    content: "This proposal excludes permit fees, architectural or engineering services, hidden structural damage, mold or asbestos remediation, utility upgrades, appliance purchases, and work not specifically listed in the scope. Any additional work will require written approval and may result in a revised estimate.",
  },
  {
    id: "exclusions.remodeling", category: "exclusions", name: "Remodeling Exclusions",
    content: "This proposal excludes concealed damage, structural repairs not visible during the initial review, hazardous-material remediation, code-required upgrades discovered after work begins, permit or professional-design fees unless specifically listed, and owner-supplied materials or appliances. Work outside the approved scope will be treated as additional work.",
  },
  {
    id: "exclusions.service_repair", category: "exclusions", name: "Service & Repair Exclusions",
    content: "This proposal covers only the services and repairs specifically described. It excludes concealed defects, unrelated system failures, replacement of components not listed, permit fees, emergency or after-hours work, and repairs made necessary by conditions discovered after service begins.",
  },
  // ── Assumptions ──
  {
    id: "assumptions.standard_site_conditions", category: "assumptions", name: "Standard Site Conditions",
    content: "Pricing assumes normal site access, standard working hours, existing utilities in serviceable condition, and no concealed damage behind walls, floors, or ceilings. Schedule and pricing may change if site conditions differ from the information currently available.",
  },
  {
    id: "assumptions.remodeling_project", category: "assumptions", name: "Remodeling Project Assumptions",
    content: "Pricing assumes the existing structure is suitable for the proposed work, demolition will not reveal major structural or environmental issues, customer selections will be finalized on schedule, and materials will remain available within the stated allowances.",
  },
  {
    id: "assumptions.scheduling_material", category: "assumptions", name: "Scheduling & Material Assumptions",
    content: "The proposed schedule assumes timely approvals, normal material availability, reasonable site access, and no delays caused by weather, inspections, utility interruptions, customer changes, or backordered products. Pricing may be adjusted when substitutions or additional work are required.",
  },
  // ── Terms ──
  {
    id: "terms.standard_payment", category: "terms", name: "Standard Payment Terms",
    content: "This estimate is valid for 30 days. Work will be scheduled after written approval and receipt of the required deposit. The remaining balance will be due according to the payment schedule shown in the final agreement. Changes to the approved scope may affect price and completion time.",
  },
  {
    id: "terms.deposit_progress", category: "terms", name: "Deposit & Progress Payment Terms",
    content: "This proposal is valid for 30 days. Scheduling begins after approval and receipt of the required deposit. Progress payments will be due as stated in the payment schedule, with the remaining balance due upon substantial completion. Additional work requires written authorization.",
  },
  {
    id: "terms.short_form", category: "terms", name: "Short-Form Proposal Terms",
    content: "This estimate is valid for 30 days. Approval confirms acceptance of the listed scope and pricing. A deposit may be required before scheduling. Changes, delays, or unforeseen conditions may require revised pricing or completion dates.",
  },
];

export function sharedPresetsForCategory(category: ProposalPresetCategory): ProposalPreset[] {
  return SHARED_PRESETS.filter(p => p.category === category);
}

export function findSharedPreset(id: string): ProposalPreset | undefined {
  return SHARED_PRESETS.find(p => p.id === id);
}
