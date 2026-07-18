// src/lib/stage-colors.ts
//
// Deterministic fallback color for pipeline/deal stage ids that aren't
// one of the known default stages (new/qualified/site-visit/proposal/
// negotiation/won/lost) — i.e. an org-custom stage. Previously every
// custom stage fell back to the same flat gray in every place stage
// colors are rendered (Pipeline board, Command Center Live Pipeline +
// Sales Pipeline Snapshot, Reports, Analytics), so multiple custom
// stages were visually indistinguishable. This hashes the stage id so
// each custom stage gets its own stable color across reloads/reorders,
// without changing the colors already assigned to the known stages in
// each context.
//
// This is separate from the StageColor enum in lib/pipelines.ts, which
// belongs to the local custom-pipeline builder (already stable-by-id).

export type StageColorToken = { hex: string; bgClass: string; textClass: string };

// No red/destructive in this rotation on purpose — that hue reads as
// "lost/danger" everywhere else in the app, so an arbitrary open stage
// landing on it by hash (as "negotiation" and "closed-won" both did) reads
// as a mistake even though it's just a color pick. Gold fills that slot
// instead.
const PALETTE: StageColorToken[] = [
  { hex: "#3b82f6", bgClass: "bg-primary", textClass: "text-primary" },
  { hex: "#10b981", bgClass: "bg-success", textClass: "text-success" },
  { hex: "#f59e0b", bgClass: "bg-warning", textClass: "text-warning" },
  { hex: "#8b5cf6", bgClass: "bg-chart-5", textClass: "text-chart-5" },
  { hex: "#D9AB57", bgClass: "bg-gold", textClass: "text-gold" },
  { hex: "#06b6d4", bgClass: "bg-chart-2", textClass: "text-chart-2" },
];

function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Fixed colors for the common named stages (contacted / new lead / site
// visit / qualified) so they read consistently across the donut, legend,
// Sales Pipeline Snapshot, and the main Pipeline page — independent of the
// hash palette below, which previously could (and did) collide two
// different stages onto the same "warning/orange" slot. Keyed on a
// normalized id (lowercased, punctuation stripped) so "site-visit",
// "site_visit", and "site visit scheduled" all resolve the same way.
const ORANGE: StageColorToken = { hex: "#EA580C", bgClass: "bg-orange", textClass: "text-orange" };
const GREEN: StageColorToken = { hex: "#10b981", bgClass: "bg-success", textClass: "text-success" };

const KNOWN_STAGE_COLORS: Record<string, StageColorToken> = {
  contacted: { hex: "#3b82f6", bgClass: "bg-primary", textClass: "text-primary" }, // blue
  new: ORANGE,
  newlead: ORANGE,
  sitevisit: GREEN,
  sitevisitscheduled: GREEN,
  qualified: { hex: "#8b5cf6", bgClass: "bg-chart-5", textClass: "text-chart-5" }, // purple
  // "Negotiation" previously landed on the hash palette's red slot — pulled
  // out explicitly so an active, still-open stage never reads as "lost".
  negotiation: ORANGE,
};

function normalizeStageKey(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Stable (not random, not index-based) color for a stage id — known named
 * stages get a fixed color; anything else (a fully custom stage) falls back
 * to the hash palette. */
export function fallbackStageColor(stageId: string): StageColorToken {
  const known = KNOWN_STAGE_COLORS[normalizeStageKey(stageId)];
  if (known) return known;
  return PALETTE[hashSeed(stageId) % PALETTE.length];
}
