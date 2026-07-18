// Broadcast records persist to localStorage (no dedicated backend table
// exists yet) and reactively via useSyncExternalStore. Segment counts are
// computed from the real deals/projects/contacts stores — see
// `getSegments()` below.
import { useSyncExternalStore } from "react";
import { getDeals, useDeals } from "./deals-store";
import { getProjects, useProjects } from "./projects-store";
import { getContacts, useContacts } from "./contacts-store";

export type BroadcastChannel = "email" | "sms";
export type BroadcastStatus = "draft" | "scheduled" | "sending" | "sent" | "failed";

export type SegmentId =
  | "all_contacts"
  | "all_leads"
  | "qualified_leads"
  | "cold_estimates"
  | "active_clients"
  | "past_clients"
  | "lost_deals";

export type Segment = {
  id: SegmentId;
  name: string;
  description: string;
  channel: "any" | "email" | "sms";
  count: number;
};

export type BroadcastStats = {
  recipients: number;
  delivered: number;
  opens: number;
  clicks: number;
  replies: number;
  bounces: number;
  unsubscribes: number;
};

export type Broadcast = {
  id: string;
  name: string;
  channel: BroadcastChannel;
  segmentId: SegmentId;
  segmentName: string;
  subject?: string;
  body: string;
  status: BroadcastStatus;
  createdAt: string;
  scheduledFor?: string;
  sentAt?: string;
  stats: BroadcastStats;
  fromName: string;
};

const STORAGE_KEY = "renometa.broadcasts.v1";

// ---- Segment counts derived from the real deals/projects/contacts stores ----
// Computed fresh on each call (not memoized) since deals/projects/contacts
// load asynchronously and this may be called before or after they're ready.
export function getSegments(): Segment[] {
  const deals = getDeals();
  const projects = getProjects();
  const contacts = getContacts();

  const countAllLeads = () => deals.filter((d) => d.stage !== "won" && d.stage !== "lost").length;
  const countQualified = () => deals.filter((d) =>
    ["qualified", "site-visit", "proposal", "negotiation"].includes(d.stage),
  ).length;
  const countColdEstimates = () => deals.filter((d) => d.stage === "proposal" && d.ageDays >= 7).length;
  const countActiveClients = () => projects.filter((p) => p.status !== "completed" && p.status !== "cancelled").length;
  const countPastClients = () => projects.filter((p) => p.status === "completed").length;
  const countLostDeals = () => deals.filter((d) => d.stage === "lost").length;

  return [
    {
      id: "all_contacts",
      name: "All contacts",
      description: "Every contact in your workspace.",
      channel: "any",
      count: contacts.length,
    },
    {
      id: "all_leads",
      name: "All open leads",
      description: "Deals not yet won or lost.",
      channel: "any",
      count: countAllLeads(),
    },
    {
      id: "qualified_leads",
      name: "Qualified leads",
      description: "Qualified, site-visit, proposal, or negotiation stage.",
      channel: "any",
      count: countQualified(),
    },
    {
      id: "cold_estimates",
      name: "Cold estimates",
      description: "Proposals open ≥ 7 days with no movement.",
      channel: "any",
      count: countColdEstimates(),
    },
    {
      id: "active_clients",
      name: "Active project clients",
      description: "Clients with a project in progress.",
      channel: "any",
      count: countActiveClients(),
    },
    {
      id: "past_clients",
      name: "Past clients (completed)",
      description: "Clients with completed projects — great for review asks.",
      channel: "any",
      count: countPastClients(),
    },
    {
      id: "lost_deals",
      name: "Lost deals",
      description: "Re-engagement candidates from lost opportunities.",
      channel: "any",
      count: countLostDeals(),
    },
  ];
}

export function getSegment(id: SegmentId): Segment {
  const segments = getSegments();
  return segments.find((s) => s.id === id) ?? segments[0];
}

/** Reactive segment list — re-renders as the underlying deals/projects/contacts stores load or change. */
export function useSegments(): Segment[] {
  useDeals();
  useProjects();
  useContacts();
  return getSegments();
}

// ---- Reactive store ----
// Starts empty — no dedicated broadcasts table exists yet, so history is
// local to this browser. Previously seeded with three hardcoded "sent"
// campaigns (fake recipient/open/click counts) that appeared for every org.
let state: Broadcast[] = load();
const listeners = new Set<() => void>();

function load(): Broadcast[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Broadcast[]) : [];
  } catch {
    return [];
  }
}

function persist() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore quota errors in mock store
  }
}

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function getSnapshot() {
  return state;
}

export function useBroadcasts(): Broadcast[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ---- Mutations ----
function newId() {
  return `bc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// No real send pipeline (Twilio/email bulk-send) or delivery-tracking
// webhook is wired up for broadcasts yet — marking a broadcast "sent"
// here does not actually send anything. Previously this randomly
// generated plausible-looking delivered/opens/clicks/replies numbers;
// now it honestly reports zero engagement rather than fabricating it.
function initialSentStats(recipients: number): BroadcastStats {
  return {
    recipients,
    delivered: 0,
    opens: 0,
    clicks: 0,
    replies: 0,
    bounces: 0,
    unsubscribes: 0,
  };
}

export type CreateBroadcastInput = {
  name: string;
  channel: BroadcastChannel;
  segmentId: SegmentId;
  subject?: string;
  body: string;
  fromName: string;
  schedule: { kind: "now" } | { kind: "later"; iso: string } | { kind: "draft" };
};

export function createBroadcast(input: CreateBroadcastInput): Broadcast {
  const seg = getSegment(input.segmentId);
  const id = newId();
  const now = new Date().toISOString();
  let status: BroadcastStatus = "draft";
  let sentAt: string | undefined;
  let scheduledFor: string | undefined;
  let stats: BroadcastStats = {
    recipients: seg.count,
    delivered: 0,
    opens: 0,
    clicks: 0,
    replies: 0,
    bounces: 0,
    unsubscribes: 0,
  };

  if (input.schedule.kind === "now") {
    status = "sent";
    sentAt = now;
    stats = initialSentStats(seg.count);
  } else if (input.schedule.kind === "later") {
    status = "scheduled";
    scheduledFor = input.schedule.iso;
  }

  const bc: Broadcast = {
    id,
    name: input.name,
    channel: input.channel,
    segmentId: input.segmentId,
    segmentName: seg.name,
    subject: input.channel === "email" ? input.subject : undefined,
    body: input.body,
    status,
    createdAt: now,
    scheduledFor,
    sentAt,
    stats,
    fromName: input.fromName,
  };

  state = [bc, ...state];
  persist();
  emit();
  return bc;
}

export function deleteBroadcast(id: string) {
  state = state.filter((b) => b.id !== id);
  persist();
  emit();
}

export function duplicateBroadcast(id: string): Broadcast | undefined {
  const src = state.find((b) => b.id === id);
  if (!src) return undefined;
  const copy: Broadcast = {
    ...src,
    id: newId(),
    name: `${src.name} (copy)`,
    status: "draft",
    createdAt: new Date().toISOString(),
    sentAt: undefined,
    scheduledFor: undefined,
    stats: { ...src.stats, delivered: 0, opens: 0, clicks: 0, replies: 0, bounces: 0, unsubscribes: 0 },
  };
  state = [copy, ...state];
  persist();
  emit();
  return copy;
}

export function cancelScheduled(id: string) {
  state = state.map((b) =>
    b.id === id && b.status === "scheduled"
      ? { ...b, status: "draft", scheduledFor: undefined }
      : b,
  );
  persist();
  emit();
}

export const mergeTags = [
  "first_name",
  "last_name",
  "company_name",
  "owner_name",
  "project_type",
  "project_address",
  "estimate_total",
  "start_date",
] as const;

export const sampleMergeContext = {
  first_name: "Sarah",
  last_name: "Johnson",
  company_name: "Renometa Build Co.",
  owner_name: "Alex Rivera",
  project_type: "Kitchen remodel",
  project_address: "1421 Hillside Dr, Austin TX",
  estimate_total: "$48,200",
  start_date: "May 14",
};

export function renderMergeTags(text: string, ctx: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (full, key: string) => ctx[key] ?? full);
}
