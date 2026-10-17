// src/lib/ai-estimate-proposal.ts
//
// Estimate Assistant Foundation — pure display helpers for an approval row
// whose action is create_estimate_draft / add_estimate_line_items. The
// Approvals tab shows the reviewer WHAT is being proposed (a title and the
// line-item STRUCTURE) and states plainly that no prices or quantities are
// included, so approving is never mistaken for approving a price.
//
// Pure and defensive: `proposed_input` is jsonb read back from the database,
// so every field is validated rather than cast. Imports nothing (no
// Supabase), so it is trivially unit-testable.

export const ESTIMATE_ACTION_KEYS = ["create_estimate_draft", "add_estimate_line_items"] as const;
export type EstimateActionKey = (typeof ESTIMATE_ACTION_KEYS)[number];

export function isEstimateActionKey(actionKey: string): actionKey is EstimateActionKey {
  return (ESTIMATE_ACTION_KEYS as readonly string[]).includes(actionKey);
}

export type EstimateProposalView = {
  kind: "create" | "add";
  /** Present for a draft proposal only. */
  title?: string;
  scope?: string;
  itemNames: string[];
};

const MAX_SHOWN_ITEMS = 25;

export function readEstimateProposal(actionKey: string, proposedInput: unknown): EstimateProposalView | undefined {
  if (!isEstimateActionKey(actionKey)) return undefined;
  const input = proposedInput && typeof proposedInput === "object" ? (proposedInput as Record<string, unknown>) : {};
  const rawItems = Array.isArray(input.items) ? input.items : [];
  const itemNames = rawItems
    .map((i) => (i && typeof i === "object" && typeof (i as { name?: unknown }).name === "string" ? ((i as { name: string }).name.trim()) : ""))
    .filter((n) => n.length > 0)
    .slice(0, MAX_SHOWN_ITEMS);
  if (actionKey === "create_estimate_draft") {
    return {
      kind: "create",
      title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : undefined,
      scope: typeof input.scope === "string" && input.scope.trim() ? input.scope.trim() : undefined,
      itemNames,
    };
  }
  return { kind: "add", itemNames };
}

/** The one-line disclosure shown under every estimate approval. */
export const ESTIMATE_PROPOSAL_DISCLOSURE =
  "Line items are created unpriced — no prices, quantities, tax, discounts or deposits are included. Nothing is sent to the customer.";
