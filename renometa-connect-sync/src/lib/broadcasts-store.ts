// Mock-only Broadcasts store. Persists to localStorage; reactive via useSyncExternalStore.
import { useSyncExternalStore } from "react";
import { mockContacts, mockDeals, mockProjects } from "./mock-data";

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

// ---- Segment counts derived from mock data ----
function countQualified() {
  return mockDeals.filter((d) =>
    ["qualified", "site-visit", "proposal", "negotiation"].includes(d.stage),
  ).length;
}
function countColdEstimates() {
  // proposal stage with ageDays >= 7 = "cold estimate"
  return mockDeals.filter((d) => d.stage === "proposal" && d.ageDays >= 7).length;
}
function countActiveClients() {
  return mockProjects.filter(
    (p) => p.status === "active" && p.stage !== "completed",
  ).length;
}
function countPastClients() {
  return mockProjects.filter((p) => p.stage === "completed").length;
}
function countLostDeals() {
  return mockDeals.filter((d) => d.stage === "lost").length;
}
function countAllLeads() {
  return mockDeals.filter((d) => !["won", "lost"].includes(d.stage)).length;
}

export const segments: Segment[] = [
  {
    id: "all_contacts",
    name: "All contacts",
    description: "Every contact in your workspace.",
    channel: "any",
    count: mockContacts.length,
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

export function getSegment(id: SegmentId): Segment {
  return segments.find((s) => s.id === id) ?? segments[0];
}

// ---- Seed data ----
function seedBroadcasts(): Broadcast[] {
  const now = Date.now();
  const day = 86400000;
  const iso = (offset: number) => new Date(now + offset).toISOString();
  return [
    {
      id: "bc_1",
      name: "Spring kitchen promo — 10% off",
      channel: "email",
      segmentId: "past_clients",
      segmentName: getSegment("past_clients").name,
      subject: "Spring kitchen specials at {{company_name}} 🌿",
      body: "Hi {{first_name}},\n\nSpring is the perfect time to refresh your kitchen. Through May, we're offering 10% off cabinetry upgrades for past clients.\n\nReply to this email and we'll set up a quick design call.\n\n— {{owner_name}}",
      status: "sent",
      createdAt: iso(-12 * day),
      sentAt: iso(-10 * day),
      fromName: "Renometa",
      stats: {
        recipients: 18,
        delivered: 18,
        opens: 14,
        clicks: 6,
        replies: 3,
        bounces: 0,
        unsubscribes: 1,
      },
    },
    {
      id: "bc_2",
      name: "Cold estimate re-engagement",
      channel: "email",
      segmentId: "cold_estimates",
      segmentName: getSegment("cold_estimates").name,
      subject: "Still thinking it over, {{first_name}}?",
      body: "Hi {{first_name}},\n\nJust circling back on your {{project_type}} estimate. Happy to walk you through any line item or adjust scope to your budget.\n\nA quick 10-min call this week?\n\n— {{owner_name}}",
      status: "sent",
      createdAt: iso(-6 * day),
      sentAt: iso(-5 * day),
      fromName: "Renometa",
      stats: {
        recipients: 7,
        delivered: 7,
        opens: 5,
        clicks: 2,
        replies: 2,
        bounces: 0,
        unsubscribes: 0,
      },
    },
    {
      id: "bc_3",
      name: "Review request — completed projects",
      channel: "sms",
      segmentId: "past_clients",
      segmentName: getSegment("past_clients").name,
      body: "Hey {{first_name}}, it's {{owner_name}} from {{company_name}}. If you have 60s, a quick Google review would mean a lot 🙏 [link]",
      status: "scheduled",
      createdAt: iso(-1 * day),
      scheduledFor: iso(2 * day),
      fromName: "Renometa",
      stats: {
        recipients: getSegment("past_clients").count,
        delivered: 0,
        opens: 0,
        clicks: 0,
        replies: 0,
        bounces: 0,
        unsubscribes: 0,
      },
    },
  ];
}

// ---- Reactive store ----
let state: Broadcast[] = load();
const listeners = new Set<() => void>();

function load(): Broadcast[] {
  if (typeof window === "undefined") return seedBroadcasts();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const seed = seedBroadcasts();
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
      return seed;
    }
    return JSON.parse(raw) as Broadcast[];
  } catch {
    return seedBroadcasts();
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

function fakeStats(recipients: number): BroadcastStats {
  const delivered = Math.max(0, recipients - Math.round(recipients * 0.02));
  const opens = Math.round(delivered * (0.45 + Math.random() * 0.3));
  const clicks = Math.round(opens * (0.15 + Math.random() * 0.2));
  const replies = Math.round(opens * (0.05 + Math.random() * 0.1));
  return {
    recipients,
    delivered,
    opens,
    clicks,
    replies,
    bounces: recipients - delivered,
    unsubscribes: Math.round(delivered * 0.01),
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
    stats = fakeStats(seg.count);
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
