// src/lib/sales/types.ts

export type LostReason =
  | "Budget"
  | "Timing"
  | "Scope"
  | "Competitor"
  | "No response";

export type DealStatus = "open" | "won" | "lost";

export type DealActivityType =
  | "created"
  | "updated"
  | "stage_changed"
  | "owner_changed"
  | "value_changed"
  | "won"
  | "lost"
  | "note_added"
  | "contact_linked"
  | "contact_unlinked"
  | "account_linked"
  | "account_unlinked"
  | "file_added"
  | "task_created"
  | "estimate_created"
  | "appointment_created"
  | "custom";

export type SalesPipeline = {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type StageOutcome = "open" | "won" | "lost";

export type SalesPipelineStage = {
  id: string;
  pipelineId: string;
  name: string;
  slug: string;
  position: number;
  probability: number;
  color: string;
  outcome: StageOutcome;
  createdAt: string;
  updatedAt: string;
};

export type DealContactSummary = {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  companyId: string | null;
  companyName: string | null;
  avatarKey: string | null;
  avatarUrl: string | null;
};

export type DealAccountSummary = {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
};

export type DealOwnerSummary = {
  id: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
};

export type DealContact = {
  id: string;
  orgId: string;
  dealId: string;
  contactId: string;
  relationshipTitle: string | null;
  role: string | null;
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
  contact?: DealContactSummary | null;
};

export type DealActivity = {
  id: string;
  orgId: string;
  dealId: string;
  activityType: DealActivityType | string;
  title: string;
  description: string | null;
  actorId: string | null;
  actorName: string | null;
  metadata: Record<string, unknown>;
  occurredAt: string;
  createdAt: string;
};

export type Deal = {
  id: string;
  orgId: string;
  leadId: string | null;
  pipelineId: string;
  stageId: string;
  stage: string;
  stageName: string;
  stageColor: string;
  stagePosition: number;
  status: DealStatus;

  name: string;
  description: string | null;
  value: number;
  probability: number;
  expectedClose: string;
  actualCloseDate: string | null;

  contactId: string;
  contactName: string;
  contactAvatarKey: string | null;
  contactAvatarUrl: string | null;
  email: string;
  phone: string;
  address: string;

  companyId: string | null;
  companyName: string;
  companySlug: string | null;
  companyLogoUrl: string | null;

  ownerId?: string;
  owner: string;
  ownerInitials: string;
  ownerAvatarUrl: string | null;

  source: string | null;
  serviceType: string | null;
  budget: string | null;
  timeline: string | null;
  projectAddress: string | null;
  nextActivityAt: string | null;
  nextActivityTitle: string | null;
  tags: string[];

  lostReason?: LostReason;
  lostAt?: string;
  notes: string | null;
  customFields: Record<string, unknown>;

  ageDays: number;
  createdAt: string;
  updatedAt: string;
  stageOrder: number;

  primaryContact?: DealContactSummary | null;
  account?: DealAccountSummary | null;
  ownerProfile?: DealOwnerSummary | null;
};

export type CreateDealInput = {
  name: string;
  description?: string | null;

  contactId?: string | null;
  contactName?: string;
  email?: string;
  phone?: string;
  address?: string;

  companyId?: string | null;

  pipelineId?: string | null;
  stageId?: string | null;
  stage?: string | null;

  value?: number;
  probability?: number;
  expectedClose?: string | null;
  ownerId?: string | null;
  ownerName?: string;

  source?: string | null;
  serviceType?: string | null;
  budget?: string | null;
  timeline?: string | null;
  projectAddress?: string | null;
  nextActivityAt?: string | null;
  nextActivityTitle?: string | null;
  tags?: string[];

  leadId?: string | null;
  notes?: string | null;
  customFields?: Record<string, unknown>;
};

export type UpdateDealInput = Partial<
  Pick<
    Deal,
    | "name"
    | "description"
    | "value"
    | "probability"
    | "expectedClose"
    | "ownerId"
    | "source"
    | "serviceType"
    | "budget"
    | "timeline"
    | "projectAddress"
    | "nextActivityAt"
    | "nextActivityTitle"
    | "tags"
    | "notes"
    | "contactId"
    | "companyId"
  >
> & {
  stage?: string;
  stageId?: string;
  status?: DealStatus;
  lostReason?: LostReason | null;
  customFields?: Record<string, unknown>;
};

export type AddDealInput = CreateDealInput;