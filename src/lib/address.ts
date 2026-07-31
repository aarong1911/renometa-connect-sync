// src/lib/address.ts
//
// One shared address composer for records that store address as separate
// street/city/state/zip columns (e.g. companies) — avoids the malformed,
// duplicate-looking output ("Brooklyn, NY, 11201, USA, Brooklyn, NY 11201")
// that comes from ad-hoc `.filter(Boolean).join(", ")` chains scattered
// across the app. Records that already store one composed address string
// (e.g. contacts.address) need no composition — use that value directly.

export function composeAddress(parts: {
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
}): string {
  const stateZip = [parts.state, parts.zip].filter(Boolean).join(" ").trim();
  const cityStateZip = [parts.city, stateZip].filter(Boolean).join(", ").trim();
  return [parts.street, cityStateZip, parts.country]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(", ");
}
