// netlify/functions/lib/meta-ads-api.ts
//
// Meta Ads-specific discovery, canonicalization, and selection logic — the
// Meta counterpart to google-ads-api.ts's discoverGoogleAdsAccounts /
// deriveGoogleAdsSelectionState / validateSelectableAdvertiser. Built on
// top of the generic transport in meta-graph-api.ts.

import { metaGraphPaginate } from "./meta-graph-api";

// ── Canonical ad-account ID convention ──────────────────────────────────
// meta_connections.ad_account_id is already persisted WITHOUT the "act_"
// prefix (see meta-oauth-callback.ts: `preferred.id.startsWith("act_") ?
// preferred.id.slice(4) : preferred.id`, and meta-create-ad-campaign.ts's
// `actId` re-add). This module preserves that exact existing convention —
// every MetaAdAccountSummary.id below is numeric-only; toMetaAdAccountGraphId
// re-adds "act_" only where a Graph object path requires it.

export function canonicalMetaAdAccountId(id: string): string {
  return id.startsWith("act_") ? id.slice(4) : id;
}

export function toMetaAdAccountGraphId(canonicalId: string): string {
  return canonicalId.startsWith("act_") ? canonicalId : `act_${canonicalId}`;
}

export interface MetaBusinessSummary {
  id: string;
  name: string | null;
}

export interface MetaAdAccountSummary {
  id: string; // canonical — see above
  name: string | null;
  accountStatus: number | null;
  currency: string | null;
  timezoneName: string | null;
  businessId: string | null;
  businessName: string | null;
}

interface RawAdAccountFields {
  id: string;
  name?: string;
  account_status?: number;
  currency?: string;
  timezone_name?: string;
  business?: { id?: string; name?: string };
}

const AD_ACCOUNT_FIELDS = "id,name,account_status,currency,timezone_name,business{id,name}";

function normalizeAdAccount(raw: RawAdAccountFields): MetaAdAccountSummary {
  return {
    id: canonicalMetaAdAccountId(raw.id),
    name: typeof raw.name === "string" ? raw.name : null,
    accountStatus: typeof raw.account_status === "number" ? raw.account_status : null,
    currency: typeof raw.currency === "string" ? raw.currency : null,
    timezoneName: typeof raw.timezone_name === "string" ? raw.timezone_name : null,
    businessId: raw.business?.id ?? null,
    businessName: raw.business?.name ?? null,
  };
}

export interface MetaAdsDiscoveryResult {
  businesses: MetaBusinessSummary[];
  adAccounts: MetaAdAccountSummary[];
}

// Discovers every ad account the connected token can access via THREE
// routes, since no single route reliably catches every manager/business
// arrangement: directly (/me/adaccounts), plus each accessible Business's
// owned AND client (shared) ad accounts. Deduplicated by canonical numeric
// ad-account ID — the first source to discover a given account wins for
// any field, later sources only fill in gaps left null. A single
// business/edge failing (e.g. missing permission for client_ad_accounts on
// one business) never fails the whole discovery.
export async function discoverMetaAdsAccounts(accessToken: string): Promise<MetaAdsDiscoveryResult> {
  const businessesPage = await metaGraphPaginate<{ id: string; name?: string }>({
    path: "/me/businesses",
    accessToken,
    query: { fields: "id,name" },
  });
  const businesses: MetaBusinessSummary[] = businessesPage.items.map((b) => ({
    id: b.id,
    name: typeof b.name === "string" ? b.name : null,
  }));

  const byId = new Map<string, MetaAdAccountSummary>();
  function merge(account: MetaAdAccountSummary): void {
    const existing = byId.get(account.id);
    if (!existing) {
      byId.set(account.id, account);
      return;
    }
    byId.set(account.id, {
      id: existing.id,
      name: existing.name ?? account.name,
      accountStatus: existing.accountStatus ?? account.accountStatus,
      currency: existing.currency ?? account.currency,
      timezoneName: existing.timezoneName ?? account.timezoneName,
      businessId: existing.businessId ?? account.businessId,
      businessName: existing.businessName ?? account.businessName,
    });
  }

  try {
    const direct = await metaGraphPaginate<RawAdAccountFields>({
      path: "/me/adaccounts",
      accessToken,
      query: { fields: AD_ACCOUNT_FIELDS },
    });
    for (const raw of direct.items) merge(normalizeAdAccount(raw));
  } catch {
    // /me/adaccounts can legitimately fail for a token with only
    // business-scoped access and no personal ad accounts — the business
    // discovery loop below still has a chance to find accounts.
  }

  for (const business of businesses) {
    for (const edge of ["owned_ad_accounts", "client_ad_accounts"] as const) {
      try {
        const page = await metaGraphPaginate<RawAdAccountFields>({
          path: `/${business.id}/${edge}`,
          accessToken,
          query: { fields: AD_ACCOUNT_FIELDS },
        });
        for (const raw of page.items) {
          const normalized = normalizeAdAccount(raw);
          merge({
            ...normalized,
            businessId: normalized.businessId ?? business.id,
            businessName: normalized.businessName ?? business.name,
          });
        }
      } catch {
        // Missing permission for this business/edge — skip, don't fail
        // the whole discovery.
      }
    }
  }

  return { businesses, adAccounts: Array.from(byId.values()) };
}

// ── Selection-state derivation — pure, no I/O ───────────────────────────

export type MetaAdsSelectionState = "connected" | "needs_account_selection" | "needs_account_sync";

export interface MetaAdsSelectionDerivation {
  state: MetaAdsSelectionState;
  /** The account to report as selected this run — null unless state is "connected". */
  selectedAdAccountId: string | null;
  /** True only for the "first connection, exactly one account, nothing previously selected" case — the ONE scenario this module ever recommends auto-persisting. */
  shouldPersistAutoSelection: boolean;
  /** True when a previously-selected account exists but is no longer in the accessible set — the caller should surface this without destructively clearing the stored value. */
  previousSelectionStale: boolean;
}

// Mirrors deriveGoogleAdsSelectionState's rules, adapted for Meta:
//   - an existing, still-accessible selection is always kept (never
//     silently switched to a different account)
//   - a stale existing selection (no longer accessible) is reported via
//     previousSelectionStale rather than acted on — the caller decides
//     whether/when to clear persisted data; this function never mutates
//     anything itself
//   - auto-selection is recommended ONLY when there is no prior selection
//     AND exactly one account is accessible
//   - zero accessible accounts -> needs_account_sync
//   - more than one accessible account with no valid existing selection ->
//     needs_account_selection (explicit choice required)
export function deriveMetaAdsSelectionState(
  accounts: MetaAdAccountSummary[],
  previouslySelectedAdAccountId: string | null,
): MetaAdsSelectionDerivation {
  if (previouslySelectedAdAccountId) {
    const stillAccessible = accounts.some((a) => a.id === previouslySelectedAdAccountId);
    if (stillAccessible) {
      return {
        state: "connected",
        selectedAdAccountId: previouslySelectedAdAccountId,
        shouldPersistAutoSelection: false,
        previousSelectionStale: false,
      };
    }
    return {
      state: accounts.length > 0 ? "needs_account_selection" : "needs_account_sync",
      selectedAdAccountId: null,
      shouldPersistAutoSelection: false,
      previousSelectionStale: true,
    };
  }

  if (accounts.length === 0) {
    return { state: "needs_account_sync", selectedAdAccountId: null, shouldPersistAutoSelection: false, previousSelectionStale: false };
  }
  if (accounts.length === 1) {
    return { state: "connected", selectedAdAccountId: accounts[0].id, shouldPersistAutoSelection: true, previousSelectionStale: false };
  }
  return { state: "needs_account_selection", selectedAdAccountId: null, shouldPersistAutoSelection: false, previousSelectionStale: false };
}

// ── Selection validation — pure, no I/O ─────────────────────────────────

export type MetaAdAccountValidationResult =
  | { ok: true; account: MetaAdAccountSummary }
  | { ok: false; reason: "not_found" };

// Never trusts the request body or a previously-stored ad_account_id — the
// caller must pass a freshly-discovered `accounts` array (see
// discoverMetaAdsAccounts above), same discipline as
// validateSelectableAdvertiser for Google Ads.
export function validateSelectableMetaAdAccount(
  accounts: MetaAdAccountSummary[],
  submittedAdAccountId: string,
): MetaAdAccountValidationResult {
  const canonical = canonicalMetaAdAccountId(submittedAdAccountId);
  const match = accounts.find((a) => a.id === canonical);
  if (!match) return { ok: false, reason: "not_found" };
  return { ok: true, account: match };
}
