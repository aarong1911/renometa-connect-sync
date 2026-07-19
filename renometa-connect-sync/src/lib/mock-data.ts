// src/lib/mock-data.ts
// Mock renovation-industry data shared across features.
export type Contact = {
  id: string;
  name: string;
  email: string;
  phone: string;
  address?: string;
  company: string;
  tags: string[];
  owner: string;
  lastActivity: string;
  createdAt: string;
  // Platform-scoped messaging identifiers — only set once a contact has
  // messaged in via Messenger/Instagram (see
  // supabase/migrations/004_contacts_meta_identifiers.sql). Not phone
  // numbers or usernames; outbound sends use these as the recipient id.
  messenger_psid?: string;
  instagram_igsid?: string;
};

export type LostReason = "Budget" | "Timing" | "Scope" | "Competitor" | "No response";

export type Deal = {
  id: string;
  name: string;
  contactId: string;
  contactName: string;
  value: number;
  stage: string;
  expectedClose: string;
  owner: string;
  ownerInitials: string;
  ownerId?: string;
  ageDays: number;
  lostReason?: LostReason;
  lostAt?: string;
  email?: string;
  phone?: string;
  address?: string;
};

// ============= PROJECTS =============
export type ProjectStage =
  | "estimating"
  | "contracted"
  | "pre-construction"
  | "in-progress"
  | "punch-list"
  | "completed";

export type ProjectStatus = "active" | "on-hold" | "cancelled";

export type ProjectType =
  | "Kitchen"
  | "Bath"
  | "Whole Home"
  | "Addition"
  | "Basement"
  | "Outdoor"
  | "Primary Suite";

export type Project = {
  id: string;
  slug: string; // client-name based
  name: string;
  client: string;
  clientEmail: string;
  clientPhone: string;
  address: string;
  projectNumber: string;
  type: ProjectType;
  stage: ProjectStage;
  status: ProjectStatus;
  ownerInitials: string;
  ownerName: string;
  ownerColor: string;
  budget: number;
  spent: number;
  invoiced: number;
  paid: number;
  approvedCO: number;
  progress: number; // 0..100
  ageDays: number; // days in current stage
  startDate: string;
  targetEnd: string;
  squareFootage: number;
  paymentTerms: string;
  siteAccess: string;
  workingHours: string;
  contractValue: number;
  scopeSummary: string;
  nextMilestone: string;
  // off-pipeline metadata
  pausedFromStage?: ProjectStage;
  pauseReason?: string;
  onHoldDays?: number;
  cancelledDate?: string;
  cancelReason?: string;
  cancelTag?: "Scope change" | "Budget" | "Timing" | "Client decision";
  lostValue?: number;
  // archived
  archived?: boolean;
  completedDate?: string;
  finalValue?: number;
  margin?: number;
  rating?: number;
  // misc
  banner?: "over-budget" | "stuck" | null;
  bannerLabel?: string;
};

export type ProjectTask = {
  id: string;
  projectId: string;
  title: string;
  status: "not-started" | "in-progress" | "overdue" | "completed" | "on-hold";
  due: string;
  assigneeInitials: string;
  assigneeColor: string;
};

export type Subcontractor = {
  id: string;
  projectId: string;
  trade: string;
  company: string;
  contact: string;
  phone: string;
  scheduled: string;
  insurance: { status: "current" | "expiring"; exp: string };
  status: string;
};

export type TeamMember = {
  id: string;
  projectId: string;
  name: string;
  initials: string;
  color: string;
  role: string;
};

export type Selection = {
  id: string;
  projectId: string;
  room: string;
  item: string;
  spec: string;
  vendor: string;
  price: number;
  client: "Approved" | "Pending";
  status: string;
};

export type ProjectDocument = {
  id: string;
  projectId: string;
  name: string;
  category: "Contract" | "Blueprint" | "Permit" | "Photos" | "Other";
  uploaded: string;
  size: string;
  shared: boolean;
};

export type Permit = {
  id: string;
  projectId: string;
  type: string;
  number: string;
  status: "Approved" | "Rough passed" | "Final pending" | "Pending";
  detail: string;
};

export type ProjectInvoice = {
  id: string;
  projectId: string;
  number: string;
  description: string;
  sent: string | null;
  due: string | null;
  amount: number;
  status: "Paid" | "Sent" | "Overdue" | "Draft";
  daysOverdue?: number;
};

export type ProjectActivity = {
  id: string;
  projectId: string;
  who: string;
  initials: string;
  color: string;
  what: string;
  when: string;
  type: "task" | "invoice" | "upload" | "message" | "payment";
};

// ============= EXISTING TYPES =============
export type Task = {
  id: string;
  projectId: string;
  title: string;
  assignee: string;
  assigneeInitials: string;
  due: string;
  status: "todo" | "in_progress" | "review" | "done";
  priority: "low" | "med" | "high";
  recurrence?: "none" | "daily" | "weekly" | "biweekly" | "monthly";
  /** Optional ISO date — stop generating instances after this date (inclusive). */
  recurrenceEndDate?: string;
  /** Optional total number of occurrences (including this instance). */
  recurrenceCount?: number;
  /** Internal counter — which occurrence in the series this instance is (1-based). */
  recurrenceIndex?: number;
};

export type Conversation = {
  id: string;
  contactId: string;
  contactName: string;
  channel: "email" | "sms" | "voice" | "whatsapp" | "messenger" | "instagram";
  preview: string;
  unread: boolean;
  lastAt: string;
  /** Caller's raw phone number — set for voice conversations so SMS/call targets the right number */
  callerPhone?: string;
};

export type Message = {
  id: string;
  conversationId: string;
  channel: "email" | "sms" | "voice" | "whatsapp" | "messenger" | "instagram";
  direction: "in" | "out";
  body: string;
  at: string;
};

export type WorkflowCategory = "Sales" | "Operations" | "Finance" | "Marketing" | "Client Care";

export type WorkflowNodeKind =
  | "trigger"
  | "send-sms"
  | "send-email"
  | "wait"
  | "condition"
  | "create-task"
  | "update-stage"
  | "internal-note"
  | "webhook";

export type WorkflowNode = {
  id: string;
  kind: WorkflowNodeKind;
  title: string;
  subtitle?: string;
};

export type WorkflowRun = {
  id: string;
  workflowId: string;
  contact: string;
  startedAt: string;
  durationMs: number;
  status: "success" | "failed" | "running";
  failedAtNodeId?: string;
};

export type Workflow = {
  id: string;
  name: string;
  status: "active" | "paused" | "draft";
  trigger: string;
  lastRun: string;
  successRate: number;
  runs: number;
  category: WorkflowCategory;
  folder: string;
  owner: string;
  ownerInitials: string;
  description: string;
  nodes: WorkflowNode[];
};

export type WorkflowTemplate = {
  id: string;
  name: string;
  category: WorkflowCategory;
  description: string;
  steps: number;
  installs: number;
  trigger: string;
  featured?: boolean;
};

export type Estimate = {
  id: string;
  number: string;
  client: string;
  amount: number;
  status: "Draft" | "Sent" | "Viewed" | "Accepted" | "Declined";
  issued: string;
};

export type Invoice = {
  id: string;
  number: string;
  client: string;
  amount: number;
  status: "Draft" | "Sent" | "Viewed" | "Paid" | "Overdue";
  due: string;
};

export type Payment = {
  id: string;
  invoice: string;
  client: string;
  amount: number;
  method: "ACH" | "Card" | "Check" | "Wire";
  receivedAt: string;
  /** Optional. When omitted, treated as "Received" for backwards compatibility. */
  status?: "Received" | "Scheduled";
  /** For scheduled payments: when the milestone is expected. */
  dueDate?: string;
  /** Optional milestone label (e.g. "Deposit", "Progress payment"). */
  milestoneLabel?: string;
};

const owners = ["Alex Romero", "Priya Shah", "Jamal Burke", "Mei Lin", "Sara Holt"];
const ownerInitials = ["AR", "PS", "JB", "ML", "SH"];

const firstNames = [
  "Sarah", "Mark", "Emily", "James", "Laura", "Michael", "Jessica", "David",
  "Rachel", "Tom", "Olivia", "Daniel", "Sophie", "Ethan", "Mia", "Lucas",
  "Ava", "Noah", "Isabella", "Liam", "Charlotte", "Mason", "Amelia", "Logan", "Harper",
];
const lastNames = [
  "Jenkins", "Thompson", "Carter", "Smith", "Curtis", "Peterson", "Nguyen", "O'Brien",
  "Davies", "Rivera", "Washington", "Becker", "Holloway", "Tanaka", "Klein",
  "Morales", "Reyes", "Singh", "Park", "Andersen", "Hayes", "Lowe", "Cohen", "Walsh", "Cross",
];
const companies = [
  "Maplewood Estates", "Riverbend Homes", "Cedar & Co. Builders", "BlueStone Living",
  "Northwind Properties", "Heritage Renovations", "Summit Residential", "Iron Oak Group",
];
const tagsPool = ["VIP", "Referral", "Repeat", "Web Lead", "Cold", "Past Due", "High Value"];

function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length];
}

function isoDaysAgo(d: number): string {
  const base = Date.UTC(2026, 3, 18);
  return new Date(base - d * 86_400_000).toISOString();
}

export const mockContacts: Contact[] = Array.from({ length: 25 }, (_, i) => ({
  id: `c_${i + 1}`,
  name: `${pick(firstNames, i)} ${pick(lastNames, i + 3)}`,
  email: `${pick(firstNames, i).toLowerCase()}.${pick(lastNames, i + 3).toLowerCase().replace("'", "")}@example.com`,
  phone: `(${200 + (i % 700)}) ${100 + (i * 7) % 900}-${1000 + (i * 13) % 9000}`,
  company: pick(companies, i),
  tags: [pick(tagsPool, i), pick(tagsPool, i + 2)].filter((v, idx, a) => a.indexOf(v) === idx),
  owner: pick(owners, i),
  lastActivity: isoDaysAgo(i % 30),
  createdAt: isoDaysAgo(30 + (i * 5) % 200),
}));

export const pipelineStages = [
  { id: "new", name: "New" },
  { id: "qualified", name: "Qualified" },
  { id: "site-visit", name: "Site Visit" },
  { id: "proposal", name: "Proposal" },
  { id: "negotiation", name: "Negotiation" },
  { id: "won", name: "Won" },
  { id: "lost", name: "Lost" },
] as const;

const dealTypes = [
  "Kitchen Remodel", "Master Bath Remodel", "Whole-Home Renovation", "Basement Finish",
  "Deck & Patio", "Roof Replacement", "Addition", "Garage Conversion",
  "Window Replacement", "Exterior Refresh",
];

export const mockDeals: Deal[] = Array.from({ length: 40 }, (_, i) => {
  const contact = mockContacts[i % mockContacts.length];
  const ownerIdx = i % owners.length;
  return {
    id: `d_${i + 1}`,
    name: `${pick(dealTypes, i)} — ${contact.name.split(" ")[1]}`,
    contactId: contact.id,
    contactName: contact.name,
    value: 4500 + ((i * 1873) % 95000),
    stage: pipelineStages[i % pipelineStages.length].id,
    expectedClose: isoDaysAgo(-((i % 45) + 5)),
    owner: owners[ownerIdx],
    ownerInitials: ownerInitials[ownerIdx],
    ageDays: (i * 3) % 28,
  };
});

// ============= PROJECTS DATA =============
export const projectStages: { id: ProjectStage; name: string; sub: string; color: string }[] = [
  { id: "estimating", name: "Estimating", sub: "Proposal / bid in progress", color: "muted" },
  { id: "contracted", name: "Contracted", sub: "Signed, deposit received", color: "primary" },
  { id: "pre-construction", name: "Pre-Construction", sub: "Permits · materials · scheduling", color: "amber" },
  { id: "in-progress", name: "In Progress", sub: "Active on-site work", color: "success" },
  { id: "punch-list", name: "Punch List", sub: "Final items · walkthrough", color: "warning" },
  { id: "completed", name: "Completed", sub: "Closed out", color: "success" },
];

const ownerPalette = [
  { initials: "RM", name: "Ron Marquez", color: "bg-purple-100 text-purple-700" },
  { initials: "JT", name: "Jamal Turner", color: "bg-emerald-100 text-emerald-700" },
  { initials: "DK", name: "Dani Kim", color: "bg-rose-100 text-rose-700" },
  { initials: "MR", name: "Maya Rivera", color: "bg-orange-100 text-orange-700" },
  { initials: "TC", name: "Tom Chen", color: "bg-amber-100 text-amber-700" },
  { initials: "SH", name: "Sara Holt", color: "bg-sky-100 text-sky-700" },
];

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

type Seed = {
  client: string;
  type: ProjectType;
  city: string;
  stage: ProjectStage;
  status: ProjectStatus;
  budget: number;
  ageDays: number;
  progress: number;
  ownerIdx: number;
  banner?: Project["banner"];
  bannerLabel?: string;
};

const projectSeeds: Seed[] = [
  // Estimating (4)
  { client: "Sarah Johnson", type: "Kitchen", city: "Austin, TX", stage: "estimating", status: "active", budget: 42000, ageDays: 3, progress: 0, ownerIdx: 0 },
  { client: "Carlos Rivera", type: "Bath", city: "Round Rock", stage: "estimating", status: "active", budget: 28500, ageDays: 1, progress: 0, ownerIdx: 1 },
  { client: "Lisa Park", type: "Addition", city: "South Austin", stage: "estimating", status: "active", budget: 180000, ageDays: 5, progress: 0, ownerIdx: 0 },
  { client: "Tan Nguyen", type: "Outdoor", city: "Pflugerville", stage: "estimating", status: "active", budget: 22000, ageDays: 2, progress: 0, ownerIdx: 1 },
  // Contracted (3)
  { client: "Michael Chen", type: "Whole Home", city: "West Lake Hills", stage: "contracted", status: "active", budget: 320000, ageDays: 4, progress: 5, ownerIdx: 3 },
  { client: "Emma Mitchell", type: "Bath", city: "Cedar Park", stage: "contracted", status: "active", budget: 54000, ageDays: 6, progress: 8, ownerIdx: 1 },
  { client: "Raj Patel", type: "Kitchen", city: "Leander", stage: "contracted", status: "active", budget: 68000, ageDays: 2, progress: 10, ownerIdx: 2 },
  // Pre-Construction (4)
  { client: "David Thompson", type: "Addition", city: "Georgetown", stage: "pre-construction", status: "active", budget: 195000, ageDays: 14, progress: 25, ownerIdx: 3, banner: "stuck", bannerLabel: "14d stuck" },
  { client: "Maria Garcia", type: "Basement", city: "Buda", stage: "pre-construction", status: "active", budget: 85000, ageDays: 7, progress: 30, ownerIdx: 2 },
  { client: "Ben Williams", type: "Kitchen", city: "Lakeway", stage: "pre-construction", status: "active", budget: 58000, ageDays: 3, progress: 35, ownerIdx: 1 },
  { client: "Chidi Okafor", type: "Primary Suite", city: "Dripping Springs", stage: "pre-construction", status: "active", budget: 115000, ageDays: 5, progress: 40, ownerIdx: 3 },
  // In Progress (5)
  { client: "James Anderson", type: "Kitchen", city: "Round Rock", stage: "in-progress", status: "active", budget: 48000, ageDays: 22, progress: 65, ownerIdx: 3 },
  { client: "Soo-Yun Kim", type: "Bath", city: "Austin", stage: "in-progress", status: "active", budget: 32000, ageDays: 11, progress: 40, ownerIdx: 4 },
  { client: "Kate Murphy", type: "Outdoor", city: "Bee Cave", stage: "in-progress", status: "active", budget: 145000, ageDays: 25, progress: 25, ownerIdx: 2, banner: "over-budget", bannerLabel: "Over budget" },
  { client: "Robert & Linda Harris", type: "Primary Suite", city: "Austin", stage: "in-progress", status: "active", budget: 94400, ageDays: 34, progress: 80, ownerIdx: 0 },
  { client: "Patricia Lowe", type: "Whole Home", city: "Westlake", stage: "in-progress", status: "active", budget: 240000, ageDays: 18, progress: 55, ownerIdx: 3 },
  // Punch List (2)
  { client: "Grace Taylor", type: "Bath", city: "Kyle", stage: "punch-list", status: "active", budget: 38000, ageDays: 4, progress: 92, ownerIdx: 0 },
  { client: "Mark Brooks", type: "Basement", city: "Manor", stage: "punch-list", status: "active", budget: 72000, ageDays: 6, progress: 95, ownerIdx: 2 },
  // Completed (3 active board entries — recently completed)
  { client: "Anita Walsh", type: "Kitchen", city: "Cedar Park", stage: "completed", status: "active", budget: 56000, ageDays: 2, progress: 100, ownerIdx: 1 },
  { client: "Eli Cohen", type: "Bath", city: "Austin", stage: "completed", status: "active", budget: 41000, ageDays: 5, progress: 100, ownerIdx: 4 },
  { client: "Amelia Cross", type: "Outdoor", city: "Buda", stage: "completed", status: "active", budget: 31000, ageDays: 1, progress: 100, ownerIdx: 1 },
];

// On-hold projects (off pipeline)
const onHoldSeeds: (Seed & { pausedFrom: ProjectStage; pauseReason: string; onHoldDays: number })[] = [
  { client: "Kate Sullivan", type: "Bath", city: "Austin", stage: "pre-construction", status: "on-hold", budget: 62000, ageDays: 12, progress: 22, ownerIdx: 0, pausedFrom: "pre-construction", pauseReason: "Client awaiting HELOC approval", onHoldDays: 12 },
  { client: "Ed Morales", type: "Kitchen", city: "Round Rock", stage: "in-progress", status: "on-hold", budget: 71000, ageDays: 8, progress: 50, ownerIdx: 1, pausedFrom: "in-progress", pauseReason: "Cabinet backorder from manufacturer", onHoldDays: 8 },
  { client: "Scott Davis", type: "Basement", city: "Pflugerville", stage: "pre-construction", status: "on-hold", budget: 95000, ageDays: 21, progress: 18, ownerIdx: 2, pausedFrom: "pre-construction", pauseReason: "HOA variance review pending", onHoldDays: 21 },
];

// Cancelled projects
const cancelledSeeds: (Seed & { cancelledDate: string; cancelReason: string; cancelTag: NonNullable<Project["cancelTag"]>; lostValue: number })[] = [
  { client: "Lin Baker", type: "Outdoor", city: "Austin", stage: "estimating", status: "cancelled", budget: 24000, ageDays: 10, progress: 0, ownerIdx: 1, cancelledDate: isoDaysAgo(10), cancelReason: "Client decided on pergola instead", cancelTag: "Scope change", lostValue: 24000 },
  { client: "Pete Ellis", type: "Bath", city: "Cedar Park", stage: "contracted", status: "cancelled", budget: 38000, ageDays: 20, progress: 0, ownerIdx: 2, cancelledDate: isoDaysAgo(20), cancelReason: "Couldn't meet contractor's minimum", cancelTag: "Budget", lostValue: 38000 },
];

// Archived (completed >30 days)
const archivedSeeds: { client: string; type: ProjectType; completed: string; finalValue: number; margin: number; rating: number; ownerIdx: number }[] = [
  { client: "Alex Henderson", type: "Kitchen", completed: "Mar 14, 2026", finalValue: 62400, margin: 24.1, rating: 5, ownerIdx: 0 },
  { client: "Sasha Novak", type: "Bath", completed: "Mar 2, 2026", finalValue: 48700, margin: 22.8, rating: 5, ownerIdx: 1 },
  { client: "Morgan Bailey", type: "Basement", completed: "Feb 21, 2026", finalValue: 79200, margin: 14.2, rating: 4, ownerIdx: 2 },
  { client: "Miguel Ortiz", type: "Addition", completed: "Feb 9, 2026", finalValue: 172500, margin: 19.4, rating: 5, ownerIdx: 3 },
  { client: "Huy Pham", type: "Kitchen", completed: "Jan 28, 2026", finalValue: 84300, margin: 21.7, rating: 5, ownerIdx: 4 },
  { client: "Whitney Cole", type: "Outdoor", completed: "Jan 15, 2026", finalValue: 34100, margin: 26.5, rating: 5, ownerIdx: 1 },
];

function makeProject(seed: Seed, idx: number, extra: Partial<Project> = {}): Project {
  const owner = ownerPalette[seed.ownerIdx];
  const slug = slugify(seed.client);
  const projectNumber = `PRJ-2026-${String(100 + idx).padStart(4, "0")}`;
  const spent = Math.round(seed.budget * (seed.progress / 100) * 0.92);
  const invoiced = Math.round(seed.budget * Math.min(seed.progress / 100 + 0.05, 1) * 0.85);
  const paid = Math.round(invoiced * 0.78);
  return {
    id: `proj_${idx}_${slug}`,
    slug,
    name: `${seed.client.split(" ")[0]}'s ${seed.type}`,
    client: seed.client,
    clientEmail: `${slug.replace(/-/g, ".")}@example.com`,
    clientPhone: `(512) 555-${1000 + (idx * 137) % 9000}`,
    address: `${1200 + idx * 47} ${pick(["Shoal Creek", "Travis Heights", "Mueller", "Tarrytown", "Hyde Park"], idx)} Blvd, ${seed.city}`,
    projectNumber,
    type: seed.type,
    stage: seed.stage,
    status: seed.status,
    ownerInitials: owner.initials,
    ownerName: owner.name,
    ownerColor: owner.color,
    budget: seed.budget,
    spent,
    invoiced,
    paid,
    approvedCO: Math.round(seed.budget * 0.025),
    progress: seed.progress,
    ageDays: seed.ageDays,
    startDate: isoDaysAgo(seed.ageDays + 14),
    targetEnd: isoDaysAgo(-((100 - seed.progress) / 3)),
    squareFootage: 280 + (idx * 73) % 1200,
    paymentTerms: "Progress billing, Net 15",
    siteAccess: `Lockbox · Code ${4000 + idx * 17}`,
    workingHours: "7:30am – 4:00pm, M–F",
    contractValue: seed.budget - 2400,
    scopeSummary:
      "Full gut remodel of primary bedroom and en-suite bath. New walk-in closet built out into existing guest bedroom (wall relocation). Heated tile floors, custom walk-in shower with frameless glass, freestanding soaking tub, double vanity with quartz top. Electrical and plumbing updated to code.",
    nextMilestone: pick(["Cabinet install", "Final inspection", "Drywall complete", "Punch walkthrough", "Permit approval"], idx),
    banner: seed.banner ?? null,
    bannerLabel: seed.bannerLabel,
    ...extra,
  };
}

const activeProjects: Project[] = projectSeeds.map((s, i) => makeProject(s, i));

const onHoldProjects: Project[] = onHoldSeeds.map((s, i) =>
  makeProject(s, 100 + i, {
    pausedFromStage: s.pausedFrom,
    pauseReason: s.pauseReason,
    onHoldDays: s.onHoldDays,
  }),
);

const cancelledProjects: Project[] = cancelledSeeds.map((s, i) =>
  makeProject(s, 200 + i, {
    cancelledDate: s.cancelledDate,
    cancelReason: s.cancelReason,
    cancelTag: s.cancelTag,
    lostValue: s.lostValue,
  }),
);

const archivedProjects: Project[] = archivedSeeds.map((seed, i) => {
  const baseSeed: Seed = {
    client: seed.client,
    type: seed.type,
    city: "Austin",
    stage: "completed",
    status: "active",
    budget: seed.finalValue,
    ageDays: 60,
    progress: 100,
    ownerIdx: seed.ownerIdx,
  };
  return makeProject(baseSeed, 300 + i, {
    archived: true,
    completedDate: seed.completed,
    finalValue: seed.finalValue,
    margin: seed.margin,
    rating: seed.rating,
  });
});

export const mockProjects: Project[] = [
  ...activeProjects,
  ...onHoldProjects,
  ...cancelledProjects,
  ...archivedProjects,
];

// ============= PROJECT SUB-DATA (for detail page) =============
function tasksFor(projectId: string): ProjectTask[] {
  const titles = [
    ["Tile installation — shower walls", "completed", -1],
    ["Cabinet install", "completed", -4],
    ["Drywall + finishing", "completed", -9],
    ["Electrical rough-in", "completed", -15],
    ["Plumbing rough-in", "completed", -16],
    ["Demo existing", "completed", -28],
    ["Framing modifications", "completed", -22],
    ["Trim carpentry — baseboards & casing", "in-progress", 4],
    ["Paint touch-ups", "in-progress", 5],
    ["Coordinate glass shower door delivery", "overdue", -2],
    ["Install medicine cabinets", "not-started", 3],
    ["Grout shower tile", "not-started", 2],
    ["Final electrical trim-out", "completed", -7],
    ["Mirror + accessory install", "not-started", 8],
    ["Punch walkthrough", "not-started", 10],
    ["Client walkthrough", "not-started", 12],
  ] as const;
  return titles.map(([title, status, dueOffset], i) => {
    const owner = ownerPalette[i % ownerPalette.length];
    return {
      id: `${projectId}_t_${i}`,
      projectId,
      title: title as string,
      status: status as ProjectTask["status"],
      due: isoDaysAgo(-(dueOffset as number)),
      assigneeInitials: owner.initials,
      assigneeColor: owner.color,
    };
  });
}

function subsFor(projectId: string): Subcontractor[] {
  return [
    { id: `${projectId}_s1`, projectId, trade: "Electrical", company: "Rodriguez Electric", contact: "Miguel Rodriguez", phone: "(512) 555-4401", scheduled: "Mar 28 – Apr 3", insurance: { status: "current", exp: "11/26" }, status: "Complete" },
    { id: `${projectId}_s2`, projectId, trade: "Plumbing", company: "Central Texas Plumbing", contact: "Tom Chen", phone: "(512) 555-8823", scheduled: "Apr 1 – Apr 6, Apr 22", insurance: { status: "current", exp: "3/27" }, status: "Rough-in done" },
    { id: `${projectId}_s3`, projectId, trade: "Tile", company: "Stone Creek Tile", contact: "Priya Patel", phone: "(512) 555-7712", scheduled: "Apr 12 – Apr 17", insurance: { status: "current", exp: "9/26" }, status: "Complete" },
    { id: `${projectId}_s4`, projectId, trade: "HVAC", company: "AirTemp Solutions", contact: "James Kim", phone: "(512) 555-3390", scheduled: "Apr 24", insurance: { status: "expiring", exp: "5/15" }, status: "Scheduled" },
    { id: `${projectId}_s5`, projectId, trade: "Glass", company: "Lone Star Glass", contact: "Kate Foster", phone: "(512) 555-2257", scheduled: "Apr 20", insurance: { status: "current", exp: "2/27" }, status: "Install Apr 20" },
  ];
}

function teamFor(projectId: string): TeamMember[] {
  return [
    { id: `${projectId}_tm1`, projectId, name: "Ron Marquez", initials: "RM", color: "bg-purple-100 text-purple-700", role: "Project Manager · Owner" },
    { id: `${projectId}_tm2`, projectId, name: "Jamal Turner", initials: "JT", color: "bg-emerald-100 text-emerald-700", role: "Lead Carpenter" },
  ];
}

function selectionsFor(projectId: string): Selection[] {
  return [
    { id: `${projectId}_sel1`, projectId, room: "Primary Bathroom", item: "Vanity cabinets", spec: 'Custom maple shaker, White Oak finish, 72"', vendor: "Austin Cabinet Co.", price: 4800, client: "Approved", status: "Installed" },
    { id: `${projectId}_sel2`, projectId, room: "Primary Bathroom", item: "Countertop", spec: "Calacatta Gold quartz, mitered edge", vendor: "Stone Gallery", price: 3200, client: "Approved", status: "Installed" },
    { id: `${projectId}_sel3`, projectId, room: "Primary Bathroom", item: "Floor tile", spec: 'Porcelain 12×24, "Urban Concrete" matte', vendor: "Stone Creek Tile", price: 2880, client: "Approved", status: "Installed" },
    { id: `${projectId}_sel4`, projectId, room: "Primary Bathroom", item: "Faucets & fixtures", spec: "Kohler Purist, matte black", vendor: "Ferguson", price: 1640, client: "Approved", status: "Delivered" },
    { id: `${projectId}_sel5`, projectId, room: "Primary Bathroom", item: "Medicine cabinets", spec: 'Robern Uplift LED, 24" × 2', vendor: "Build.com", price: 1920, client: "Approved", status: "Arriving Apr 21" },
    { id: `${projectId}_sel6`, projectId, room: "Primary Bathroom", item: "Shower door", spec: 'Custom frameless, 3/8" clear glass', vendor: "Lone Star Glass", price: 3800, client: "Approved", status: "In production" },
    { id: `${projectId}_sel7`, projectId, room: "Primary Bedroom", item: "Ceiling fan", spec: 'Minka-Aire Concept III, 54" matte black', vendor: "Lamps Plus", price: 620, client: "Approved", status: "Installed" },
    { id: `${projectId}_sel8`, projectId, room: "Primary Bedroom", item: "Paint", spec: 'Benjamin Moore "Classic Gray" eggshell', vendor: "Sherwin Williams", price: 1780, client: "Approved", status: "In progress" },
    { id: `${projectId}_sel9`, projectId, room: "Walk-in Closet", item: "Closet system", spec: "California Closets custom, white oak veneer", vendor: "California Closets", price: 4000, client: "Pending", status: "Awaiting approval" },
  ];
}

function docsFor(projectId: string): ProjectDocument[] {
  return [
    { id: `${projectId}_d1`, projectId, name: "Harris_Contract_signed.pdf", category: "Contract", uploaded: "Mar 10, 2026", size: "1.2 MB", shared: true },
    { id: `${projectId}_d2`, projectId, name: "Change_Order_01.pdf", category: "Contract", uploaded: "Apr 2, 2026", size: "340 KB", shared: true },
    { id: `${projectId}_d3`, projectId, name: "Proposed_Floor_Plan_v3.dwg", category: "Blueprint", uploaded: "Feb 28, 2026", size: "4.8 MB", shared: true },
    { id: `${projectId}_d4`, projectId, name: "Building_Permit_2026-0341.pdf", category: "Permit", uploaded: "Mar 8, 2026", size: "820 KB", shared: false },
    { id: `${projectId}_d5`, projectId, name: "Site Photos — Apr 17 (8)", category: "Photos", uploaded: "Apr 17, 2026", size: "24 MB", shared: true },
  ];
}

function permitsFor(projectId: string): Permit[] {
  return [
    { id: `${projectId}_p1`, projectId, type: "Building Permit", number: "#2026-0341-B", status: "Approved", detail: "Issued Mar 8, 2026" },
    { id: `${projectId}_p2`, projectId, type: "Electrical Permit", number: "#2026-0341-E", status: "Rough passed", detail: "Rough inspection passed Apr 4" },
    { id: `${projectId}_p3`, projectId, type: "Plumbing Permit", number: "#2026-0341-P", status: "Final pending", detail: "Final inspection scheduled Apr 22" },
  ];
}

function invoicesFor(projectId: string, projectNumber: string): ProjectInvoice[] {
  const num = projectNumber.replace("PRJ-", "INV-");
  return [
    { id: `${projectId}_i1`, projectId, number: `${num}-01`, description: "Deposit — 20%", sent: "Mar 12", due: "Mar 27", amount: 18400, status: "Paid" },
    { id: `${projectId}_i2`, projectId, number: `${num}-02`, description: "Progress draw #1 — Demo + framing", sent: "Mar 28", due: "Apr 12", amount: 19620, status: "Paid" },
    { id: `${projectId}_i3`, projectId, number: `${num}-03`, description: "Progress draw #2 — Rough-ins + drywall", sent: "Apr 4", due: "Apr 19", amount: 18400, status: "Overdue", daysOverdue: 6 },
    { id: `${projectId}_i4`, projectId, number: `${num}-04`, description: "Progress draw #3 — Tile + cabinets", sent: "Apr 17", due: "May 2", amount: 18400, status: "Sent" },
    { id: `${projectId}_i5`, projectId, number: `${num}-05`, description: "Final — upon completion", sent: null, due: null, amount: 19580, status: "Draft" },
  ];
}

function activityFor(projectId: string): ProjectActivity[] {
  return [
    { id: `${projectId}_a1`, projectId, who: "Jamal Turner", initials: "JT", color: "bg-emerald-100 text-emerald-700", what: "completed Tile installation — shower walls", when: "2 hours ago", type: "task" },
    { id: `${projectId}_a2`, projectId, who: "System", initials: "+", color: "bg-sky-100 text-sky-700", what: "Invoice sent for $18,400 — Progress draw #4", when: "Yesterday, 4:22 PM", type: "invoice" },
    { id: `${projectId}_a3`, projectId, who: "Ron Marquez", initials: "RM", color: "bg-purple-100 text-purple-700", what: "uploaded 8 site photos", when: "Yesterday, 2:15 PM", type: "upload" },
    { id: `${projectId}_a4`, projectId, who: "Robert Harris", initials: "RH", color: "bg-blue-100 text-blue-700", what: 'replied via SMS: "Looks amazing! When will the glass door install be?"', when: "Apr 16, 10:30 AM", type: "message" },
    { id: `${projectId}_a5`, projectId, who: "Payment", initials: "$", color: "bg-emerald-100 text-emerald-700", what: "received — $18,400 from Harris Progress Draw #3", when: "Apr 14, 9:02 AM", type: "payment" },
  ];
}

export const projectTasks: Record<string, ProjectTask[]> = {};
export const projectSubs: Record<string, Subcontractor[]> = {};
export const projectTeam: Record<string, TeamMember[]> = {};
export const projectSelections: Record<string, Selection[]> = {};
export const projectDocuments: Record<string, ProjectDocument[]> = {};
export const projectPermits: Record<string, Permit[]> = {};
export const projectInvoices: Record<string, ProjectInvoice[]> = {};
export const projectActivities: Record<string, ProjectActivity[]> = {};

mockProjects.forEach((p) => {
  projectTasks[p.id] = tasksFor(p.id);
  projectSubs[p.id] = subsFor(p.id);
  projectTeam[p.id] = teamFor(p.id);
  projectSelections[p.id] = selectionsFor(p.id);
  projectDocuments[p.id] = docsFor(p.id);
  projectPermits[p.id] = permitsFor(p.id);
  projectInvoices[p.id] = invoicesFor(p.id, p.projectNumber);
  projectActivities[p.id] = activityFor(p.id);
});

export function getProjectBySlug(slug: string): Project | undefined {
  return mockProjects.find((p) => p.slug === slug);
}

// ============= EXISTING DATA (unchanged) =============
const taskTitles = [
  "Demo existing cabinets", "Order quartz countertops", "Schedule electrical rough-in",
  "Drywall + skim coat", "Tile backsplash install", "Paint walls + trim",
  "Final plumbing connections", "Punch list walkthrough", "Permit submission",
  "Cabinet delivery coordination", "Subfloor inspection", "Lighting fixture selection",
];

export const mockTasks: Task[] = Array.from({ length: 30 }, (_, i) => {
  const ownerIdx = i % owners.length;
  return {
    id: `t_${i + 1}`,
    projectId: mockProjects[i % mockProjects.length].id,
    title: pick(taskTitles, i),
    assignee: owners[ownerIdx],
    assigneeInitials: ownerInitials[ownerIdx],
    due: isoDaysAgo(-((i * 2) % 21) - 1),
    status: (["todo", "in_progress", "review", "done"] as const)[i % 4],
    priority: (["low", "med", "high"] as const)[i % 3],
  };
});

export const mockConversations: Conversation[] = Array.from({ length: 14 }, (_, i) => {
  const contact = mockContacts[i];
  const channels: Conversation["channel"][] = ["email", "sms", "voice"];
  const previews = [
    "Thanks — looking forward to the site visit on Thursday.",
    "Could we push the kitchen demo back one day?",
    "Approved the cabinet selections, please proceed.",
    "Quick question about the tile sample you sent.",
    "Sounds good. I'll wire the deposit today.",
    "Voicemail: 1m 12s — call me back when you can.",
  ];
  return {
    id: `cv_${i + 1}`,
    contactId: contact.id,
    contactName: contact.name,
    channel: channels[i % 3],
    preview: pick(previews, i),
    unread: i < 4,
    lastAt: isoDaysAgo(i % 7),
  };
});

export const mockMessages: Message[] = mockConversations.flatMap((cv, ci) => {
  const channels: Message["channel"][] = ["email", "sms", "voice"];
  return Array.from({ length: 5 }, (_, mi) => ({
    id: `m_${ci}_${mi}`,
    conversationId: cv.id,
    channel: channels[(ci + mi) % 3],
    direction: mi % 2 === 0 ? "in" : "out",
    body: [
      "Hi — wanted to confirm next steps on the kitchen scope.",
      "Sure, I can have the updated estimate over by EOD.",
      "Perfect. Also, can we add the pantry build-out?",
      "Yes — adds about $4,200. I'll revise and resend.",
      "Approved. Let's lock in the start date.",
    ][mi],
    at: isoDaysAgo(7 - mi),
  }));
});

export const mockWorkflows: Workflow[] = [
  {
    id: "w_1", name: "New lead → Welcome SMS + Email", status: "active",
    trigger: "Lead created", lastRun: isoDaysAgo(0), successRate: 98, runs: 1247,
    category: "Sales", folder: "Lead Intake", owner: "Alex Romero", ownerInitials: "AR",
    description: "Greets new website leads instantly with a personalized SMS and follow-up email, then assigns to the on-call sales rep.",
    nodes: [
      { id: "n1", kind: "trigger", title: "Lead created", subtitle: "Source: Website form" },
      { id: "n2", kind: "send-sms", title: "Send welcome SMS", subtitle: "Hi {{first_name}}, thanks for reaching out…" },
      { id: "n3", kind: "wait", title: "Wait 5 minutes" },
      { id: "n4", kind: "send-email", title: "Send intro email", subtitle: "Template: New Lead Welcome" },
      { id: "n5", kind: "create-task", title: "Assign to rep", subtitle: "Round-robin · Sales team" },
    ],
  },
  {
    id: "w_2", name: "Estimate sent → Follow-up in 3 days", status: "active",
    trigger: "Estimate sent", lastRun: isoDaysAgo(0), successRate: 94, runs: 612,
    category: "Sales", folder: "Estimates", owner: "Priya Shah", ownerInitials: "PS",
    description: "Nudges prospects who received an estimate but haven't responded.",
    nodes: [
      { id: "n1", kind: "trigger", title: "Estimate sent" },
      { id: "n2", kind: "wait", title: "Wait 3 days" },
      { id: "n3", kind: "condition", title: "Estimate viewed?", subtitle: "If not viewed → SMS, else → Email" },
      { id: "n4", kind: "send-sms", title: "Reminder SMS" },
      { id: "n5", kind: "send-email", title: "Soft check-in email" },
    ],
  },
  {
    id: "w_3", name: "Project won → Create project + kickoff tasks", status: "active",
    trigger: "Deal moved to Won", lastRun: isoDaysAgo(1), successRate: 100, runs: 89,
    category: "Operations", folder: "Project Kickoff", owner: "Jamal Burke", ownerInitials: "JB",
    description: "Spawns a project record, kickoff tasks, and a welcome packet when a deal closes.",
    nodes: [
      { id: "n1", kind: "trigger", title: "Deal stage = Won" },
      { id: "n2", kind: "update-stage", title: "Create project", subtitle: "Stage: Pre-Construction" },
      { id: "n3", kind: "create-task", title: "Kickoff checklist", subtitle: "8 tasks assigned to PM" },
      { id: "n4", kind: "send-email", title: "Send welcome packet" },
    ],
  },
  {
    id: "w_4", name: "Invoice overdue → Reminder + late fee", status: "active",
    trigger: "Invoice 7d overdue", lastRun: isoDaysAgo(0), successRate: 88, runs: 142,
    category: "Finance", folder: "Collections", owner: "Mei Lin", ownerInitials: "ML",
    description: "Escalates overdue invoices: friendly nudge → firm reminder → late fee assessment.",
    nodes: [
      { id: "n1", kind: "trigger", title: "Invoice 7d overdue" },
      { id: "n2", kind: "send-email", title: "Friendly reminder" },
      { id: "n3", kind: "wait", title: "Wait 5 days" },
      { id: "n4", kind: "condition", title: "Still unpaid?" },
      { id: "n5", kind: "internal-note", title: "Notify finance" },
    ],
  },
  {
    id: "w_5", name: "Project complete → Review request", status: "paused",
    trigger: "Project status: Completed", lastRun: isoDaysAgo(4), successRate: 76, runs: 64,
    category: "Client Care", folder: "Reviews", owner: "Sara Holt", ownerInitials: "SH",
    description: "Asks happy clients for a Google review 3 days after project completion.",
    nodes: [
      { id: "n1", kind: "trigger", title: "Project completed" },
      { id: "n2", kind: "wait", title: "Wait 3 days" },
      { id: "n3", kind: "send-email", title: "Review request email" },
    ],
  },
  {
    id: "w_6", name: "Cold lead → Re-engagement drip", status: "draft",
    trigger: "Lead inactive 30d", lastRun: "—", successRate: 0, runs: 0,
    category: "Marketing", folder: "Nurture", owner: "Alex Romero", ownerInitials: "AR",
    description: "Tries to revive cold leads with a 4-touch drip over 21 days.",
    nodes: [
      { id: "n1", kind: "trigger", title: "Lead inactive 30d" },
      { id: "n2", kind: "send-email", title: "Touch 1: Case study" },
      { id: "n3", kind: "wait", title: "Wait 7 days" },
      { id: "n4", kind: "send-sms", title: "Touch 2: Quick check-in" },
    ],
  },
];

export const mockWorkflowTemplates: WorkflowTemplate[] = [
  { id: "t_1", name: "Instant lead response (SMS + Email)", category: "Sales", description: "Reply to new leads in under 60 seconds with a personalized text and email.", steps: 5, installs: 2840, trigger: "Lead created", featured: true },
  { id: "t_2", name: "Estimate signed → Project kickoff", category: "Operations", description: "Auto-create project, assign PM, send welcome packet, and book kickoff call.", steps: 7, installs: 1620, trigger: "Estimate accepted", featured: true },
  { id: "t_3", name: "Overdue invoice escalation", category: "Finance", description: "Friendly nudge → firm reminder → late fee → finance handoff.", steps: 6, installs: 1190 , trigger: "Invoice overdue"},
  { id: "t_4", name: "Project complete → Google review", category: "Client Care", description: "Ask for a 5-star Google review 3 days after handoff.", steps: 3, installs: 980, trigger: "Project completed", featured: true },
  { id: "t_5", name: "Quarterly check-in for past clients", category: "Marketing", description: "Stay top-of-mind for repeat work and referrals.", steps: 4, installs: 612, trigger: "Quarterly schedule" },
  { id: "t_6", name: "No-show booking recovery", category: "Sales", description: "Re-engage prospects who missed their consult.", steps: 5, installs: 540, trigger: "Booking missed" },
  { id: "t_7", name: "Subcontractor weekly status request", category: "Operations", description: "Ping subs every Friday for status updates on active jobs.", steps: 3, installs: 410, trigger: "Friday 9am" },
  { id: "t_8", name: "Birthday & anniversary touch", category: "Client Care", description: "Personalized message on key client dates.", steps: 2, installs: 380, trigger: "Date matches" },
];

export const mockWorkflowRuns: WorkflowRun[] = Array.from({ length: 40 }, (_, i) => {
  const wf = mockWorkflows[i % mockWorkflows.length];
  const statuses: WorkflowRun["status"][] = ["success", "success", "success", "success", "success", "success", "success", "success", "failed", "running"];
  return {
    id: `run_${i + 1}`,
    workflowId: wf.id,
    contact: mockContacts[i % mockContacts.length].name,
    startedAt: isoDaysAgo(i % 14),
    durationMs: 800 + ((i * 1313) % 9000),
    status: statuses[i % statuses.length],
    failedAtNodeId: statuses[i % statuses.length] === "failed" ? wf.nodes[1]?.id : undefined,
  };
});

export const mockEstimates: Estimate[] = Array.from({ length: 14 }, (_, i) => ({
  id: `e_${i + 1}`,
  number: `EST-${4200 + i}`,
  client: mockContacts[i].name,
  amount: 8400 + ((i * 3217) % 70000),
  status: (["Draft", "Sent", "Viewed", "Accepted", "Declined"] as const)[i % 5],
  issued: isoDaysAgo((i * 2) % 30),
}));

export const mockInvoices: Invoice[] = Array.from({ length: 16 }, (_, i) => ({
  id: `i_${i + 1}`,
  number: `INV-${7800 + i}`,
  client: mockContacts[i].name,
  amount: 5200 + ((i * 2891) % 60000),
  status: (["Draft", "Sent", "Viewed", "Paid", "Paid", "Overdue"] as const)[i % 6],
  due: isoDaysAgo(-((i * 3) % 30) + 5),
}));

export const mockPayments: Payment[] = Array.from({ length: 12 }, (_, i) => ({
  id: `pay_${i + 1}`,
  invoice: `INV-${7800 + i}`,
  client: mockContacts[i].name,
  amount: 4200 + ((i * 1987) % 30000),
  method: (["ACH", "Card", "Check", "Wire"] as const)[i % 4],
  receivedAt: isoDaysAgo(3 + i * 7 + ((i * 5) % 4)),
}));

export const pipelineVelocityData = Array.from({ length: 12 }, (_, i) => ({
  week: `W${i + 1}`,
  value: 28000 + Math.round(Math.sin(i / 1.5) * 12000) + i * 1800,
  deals: 4 + Math.round(Math.abs(Math.sin(i)) * 6),
}));

export const recentActivity = [
  { id: 1, who: "Sarah Jenkins", what: "signed proposal for Kitchen Remodel", when: "12 min ago", type: "deal" },
  { id: 2, who: "Mark Thompson", what: "submitted a new lead via website", when: "48 min ago", type: "lead" },
  { id: 3, who: "Emily Carter", what: "paid invoice INV-7834 ($12,400)", when: "2 hr ago", type: "payment" },
  { id: 4, who: "James Smith", what: "replied to your email", when: "3 hr ago", type: "email" },
  { id: 5, who: "Laura Curtis", what: "marked job #JD-7890 complete", when: "Yesterday", type: "project" },
  { id: 6, who: "Workflow", what: "sent 12 follow-up SMS messages", when: "Yesterday", type: "automation" },
];

export const upcomingTasks = [
  { id: 1, title: "Site visit: 14 Elm St.", time: "Today · 10:00 AM", priority: "high" },
  { id: 2, title: "Send proposal to Thorne Residence", time: "Today · 2:30 PM", priority: "med" },
  { id: 3, title: "Follow up: Becker bath remodel", time: "Tomorrow · 9:00 AM", priority: "med" },
  { id: 4, title: "Order cabinets for Miller kitchen", time: "Wed · 11:00 AM", priority: "low" },
  { id: 5, title: "Review Q4 forecast", time: "Fri · 4:00 PM", priority: "low" },
];

// ============= COMPANIES =============
export type CompanyType = "Builder/GC" | "Architect" | "Designer" | "Vendor" | "Subcontractor";
export type CompanyStatus = "active" | "prospect" | "inactive";

export type Company = {
  id: string;
  slug: string;
  name: string;
  type: CompanyType;
  status: CompanyStatus;
  owner: string;
  city: string;
  state: string;
  website: string;
  phone: string;
  email: string;
  employees: number;
  yearFounded: number;
  rating: number; // 0-5
  tags: string[];
  contactsCount: number;
  openDeals: number;
  pipelineValue: number;
  ytdRevenue: number;
  lifetimeRevenue: number;
  lastActivity: string;
  createdAt: string;
  notes: string;
  trades?: string[]; // for subcontractors/vendors
};

const _companySeeds: Array<{ name: string; type: CompanyType; city: string; state: string; trades?: string[] }> = [
  { name: "Beacon Hill Builders", type: "Builder/GC", city: "Boston", state: "MA" },
  { name: "Northstar Construction", type: "Builder/GC", city: "Minneapolis", state: "MN" },
  { name: "Granite Peak Homes", type: "Builder/GC", city: "Denver", state: "CO" },
  { name: "Coastal Crafted", type: "Builder/GC", city: "San Diego", state: "CA" },
  { name: "Foxwood Custom Homes", type: "Builder/GC", city: "Austin", state: "TX" },
  { name: "Atelier Mira", type: "Architect", city: "Brooklyn", state: "NY" },
  { name: "Studio Verre", type: "Architect", city: "Portland", state: "OR" },
  { name: "Linework Architects", type: "Architect", city: "Chicago", state: "IL" },
  { name: "Hewn & Hollow", type: "Architect", city: "Asheville", state: "NC" },
  { name: "Form Field Design", type: "Designer", city: "Los Angeles", state: "CA" },
  { name: "House of Marlow", type: "Designer", city: "Nashville", state: "TN" },
  { name: "Tonic Interiors", type: "Designer", city: "Seattle", state: "WA" },
  { name: "Apex Cabinetry Co.", type: "Vendor", city: "Grand Rapids", state: "MI", trades: ["Cabinets", "Millwork"] },
  { name: "Sierra Stone & Tile", type: "Vendor", city: "Phoenix", state: "AZ", trades: ["Tile", "Stone"] },
  { name: "Lumen Lighting Supply", type: "Vendor", city: "Dallas", state: "TX", trades: ["Lighting", "Fixtures"] },
  { name: "Heritage Hardwoods", type: "Vendor", city: "Charlotte", state: "NC", trades: ["Flooring"] },
  { name: "Northwind HVAC", type: "Subcontractor", city: "Madison", state: "WI", trades: ["HVAC"] },
  { name: "Ironclad Electric", type: "Subcontractor", city: "Pittsburgh", state: "PA", trades: ["Electrical"] },
  { name: "Riverbed Plumbing", type: "Subcontractor", city: "Sacramento", state: "CA", trades: ["Plumbing"] },
  { name: "Trueline Drywall", type: "Subcontractor", city: "Salt Lake City", state: "UT", trades: ["Drywall", "Paint"] },
  { name: "Cornerstone Masonry", type: "Subcontractor", city: "Richmond", state: "VA", trades: ["Masonry", "Stone"] },
  { name: "Evergreen Landscaping", type: "Subcontractor", city: "Eugene", state: "OR", trades: ["Landscape", "Hardscape"] },
];

const _companyOwners = ["Maria Chen", "James Park", "Priya Shah", "David Liu"];
const _statusCycle: CompanyStatus[] = ["active", "active", "active", "prospect", "active", "inactive"];

export const mockCompanies: Company[] = _companySeeds.map((s, i) => {
  const slug = slugify(s.name);
  const status = _statusCycle[i % _statusCycle.length];
  const baseRev = (s.type === "Builder/GC" ? 480 : s.type === "Architect" ? 240 : s.type === "Designer" ? 180 : 120) * 1000;
  return {
    id: `comp-${i + 1}`,
    slug,
    name: s.name,
    type: s.type,
    status,
    owner: _companyOwners[i % _companyOwners.length],
    city: s.city,
    state: s.state,
    website: `https://${slug}.com`,
    phone: `(${200 + i}) 555-${String(1000 + i * 17).slice(-4)}`,
    email: `hello@${slug}.com`,
    employees: 4 + ((i * 7) % 80),
    yearFounded: 1985 + ((i * 3) % 38),
    rating: 3.4 + ((i * 0.31) % 1.6),
    tags: s.trades ?? (s.type === "Builder/GC" ? ["Repeat", "Premium"] : s.type === "Architect" ? ["Modern", "Referral"] : ["Boutique"]),
    contactsCount: 1 + ((i * 5) % 9),
    openDeals: status === "inactive" ? 0 : (i % 4),
    pipelineValue: status === "inactive" ? 0 : baseRev * (0.4 + ((i % 5) * 0.18)),
    ytdRevenue: status === "prospect" ? 0 : baseRev * (0.6 + ((i % 6) * 0.2)),
    lifetimeRevenue: baseRev * (1.2 + ((i % 8) * 0.4)),
    lastActivity: isoDaysAgo((i * 2) % 28),
    createdAt: isoDaysAgo(120 + i * 18),
    notes: `${s.name} — ${s.type === "Builder/GC" ? "Strong repeat partner; refers high-end remodels." : s.type === "Architect" ? "Frequent collaborator on modern builds." : s.type === "Designer" ? "Specifies premium finishes." : "Reliable trade partner."}`,
    trades: s.trades,
  };
});

export function getCompanyBySlug(slug: string): Company | undefined {
  return mockCompanies.find((c) => c.slug === slug);
}

// ============= LEADS =============
export type LeadSource = "Website" | "Referral" | "Angi" | "Thumbtack" | "Google Ads" | "Walk-in" | "Social Media";
export type LeadStatus = "new" | "contacted" | "qualified" | "converted" | "lost";
export type LeadScore = "hot" | "warm" | "cold";

export type Lead = {
  id: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  source: LeadSource;
  status: LeadStatus;
  score: LeadScore;
  projectType: string;
  estimatedBudget: number;
  notes: string;
  owner: string;
  ownerInitials: string;
  createdAt: string;
  lastActivity: string;
  convertedDealId?: string;
};

const LEAD_SOURCES: LeadSource[] = ["Website", "Referral", "Angi", "Thumbtack", "Google Ads", "Walk-in", "Social Media"];
const LEAD_STATUSES: LeadStatus[] = ["new", "contacted", "qualified", "converted", "lost"];
const LEAD_SCORES: LeadScore[] = ["hot", "warm", "cold"];
const LEAD_PROJECT_TYPES = ["Kitchen Remodel", "Bath Remodel", "Whole Home Renovation", "Basement Finish", "Addition", "Outdoor Living", "Primary Suite"];

const leadSeeds = [
  { name: "Marcus Webb", email: "marcus.webb@email.com", phone: "(512) 555-0143", address: "1420 Elm St, Austin TX", source: 0, status: 0, score: 0, project: 0, budget: 45000, owner: "Alex Romero" },
  { name: "Dana Trujillo", email: "dana.t@email.com", phone: "(512) 555-0287", address: "805 Oak Ridge Dr, Round Rock TX", source: 1, status: 1, score: 0, project: 1, budget: 28000, owner: "Priya Shah" },
  { name: "Kevin Osei", email: "k.osei@email.com", phone: "(512) 555-0391", address: "2311 Magnolia Ave, Cedar Park TX", source: 2, status: 0, score: 1, project: 2, budget: 120000, owner: "Jamal Burke" },
  { name: "Rachel Stein", email: "r.stein@email.com", phone: "(512) 555-0455", address: "776 Birch Ln, Pflugerville TX", source: 3, status: 2, score: 0, project: 3, budget: 55000, owner: "Alex Romero" },
  { name: "Tom Nguyen", email: "tom.n@email.com", phone: "(512) 555-0519", address: "1033 Pecan Blvd, Lakeway TX", source: 4, status: 1, score: 1, project: 4, budget: 85000, owner: "Mei Lin" },
  { name: "Lisa Fernandez", email: "lisaf@email.com", phone: "(512) 555-0602", address: "438 Willow Creek Rd, Georgetown TX", source: 0, status: 0, score: 2, project: 5, budget: 15000, owner: "Sara Holt" },
  { name: "James Olawale", email: "j.olawale@email.com", phone: "(512) 555-0778", address: "2090 Sunset Dr, Bee Cave TX", source: 5, status: 3, score: 0, project: 0, budget: 62000, owner: "Priya Shah" },
  { name: "Carla Mendes", email: "carla.m@email.com", phone: "(512) 555-0834", address: "157 Cypress Point, Dripping Springs TX", source: 1, status: 2, score: 1, project: 6, budget: 38000, owner: "Jamal Burke" },
  { name: "Brian Park", email: "b.park@email.com", phone: "(512) 555-0912", address: "621 Spruce Hill Ave, Leander TX", source: 6, status: 4, score: 2, project: 1, budget: 22000, owner: "Alex Romero" },
  { name: "Nina Alvarez", email: "nina.a@email.com", phone: "(512) 555-0067", address: "3405 Redwood Ct, Manor TX", source: 2, status: 0, score: 0, project: 2, budget: 95000, owner: "Mei Lin" },
  { name: "Derek Simmons", email: "derek.s@email.com", phone: "(512) 555-1100", address: "888 Maple Ln, Buda TX", source: 4, status: 1, score: 1, project: 3, budget: 47000, owner: "Sara Holt" },
  { name: "Priya Kapoor", email: "p.kapoor@email.com", phone: "(512) 555-1234", address: "245 Juniper Way, Kyle TX", source: 3, status: 0, score: 0, project: 4, budget: 73000, owner: "Jamal Burke" },
];

export const mockLeads: Lead[] = leadSeeds.map((s, i) => {
  const initials = s.owner.split(" ").map((p) => p[0]).join("");
  return {
    id: `lead-${i + 1}`,
    name: s.name,
    email: s.email,
    phone: s.phone,
    address: s.address,
    source: LEAD_SOURCES[s.source],
    status: LEAD_STATUSES[s.status],
    score: LEAD_SCORES[s.score],
    projectType: LEAD_PROJECT_TYPES[s.project],
    estimatedBudget: s.budget,
    notes: "",
    owner: s.owner,
    ownerInitials: initials,
    createdAt: isoDaysAgo(3 + i * 4),
    lastActivity: isoDaysAgo(i % 7),
  };
});