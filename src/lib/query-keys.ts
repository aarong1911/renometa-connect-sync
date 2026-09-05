// src/lib/query-keys.ts
//
// Canonical TanStack Query key factory (Platform State Sync Phase S0/S1).
// One place defines every query key used by Query-backed data in this app
// — call sites use `queryKeys.<domain>(orgId)` rather than writing out
// `["conversations", orgId]` by hand, so a key can never be mistyped/
// duplicated-with-a-typo between where it's fetched and where it's
// invalidated (the single most common way a query cache silently stops
// working).
//
// Deliberately starts with ONLY the keys S0/S1 (Conversations) actually
// need, plus the two foundation keys (`contacts`, `leads`) Conversations
// itself reads via existing shared stores (not migrated to Query yet — see
// sms-meta-conversations.ts/gmail-conversations.ts/inbox.tsx's Lead-badge
// derivation for how those are still consumed directly from
// contacts-store.ts/leads-store.ts). Every other domain from the
// platform-wide audit (projects, tasks, appointments, deals/pipeline,
// invoices, etc.) is intentionally NOT here yet — add a key only when that
// domain is actually migrated (S2+), not preemptively.
//
// Kept coarse per the audit's own guidance: one key per domain per org for
// list-level data, not one per filter/tab. `conversations` is the one
// domain with real internal structure (see below) because Inbox itself
// already composes three genuinely separate server sources (SMS/Meta,
// Gmail, Voice) into one list — the key structure mirrors that existing
// domain split rather than inventing a new one.

export const queryKeys = {
  // Platform State Sync Phase S5D — Organization profile (organizations
  // table: name/logo/branding/settings). Declared since S0 as the agreed
  // future shape; actually Query-backed as of S5D — see organization.ts.
  organization: (orgId: string) => ["organization", orgId] as const,

  // NOT YET migrated to Query in S1 — contacts-store.ts/leads-store.ts stay
  // useSyncExternalStore singletons for now (see the S1 report's "temporary
  // boundaries" section). These two keys are declared here as the
  // agreed-upon future shape so a later phase doesn't have to invent them,
  // and so nothing outside this file needs to know that boundary exists.
  contacts: (orgId: string) => ["contacts", orgId] as const,
  leads: (orgId: string) => ["leads", orgId] as const,

  // Platform State Sync Phase S5A — Companies / Accounts. ONE key per org:
  // the whole org's company list. Named `companies` to match the table, the
  // store file (companies-store.ts) and the public hook (`useCompanies`) —
  // "Accounts" is only the UI label for this same data, so there is NO
  // separate `accounts` key/cache (that would be two caches for one set of
  // rows). The Accounts list page, the Contacts page's account column,
  // Estimates/Projects/entity-picker account dropdowns, and the duplicate-
  // candidate check all derive from this single list client-side. The
  // account detail route still loads its row by slug via
  // `fetchCompanyBySlug` (authoritative, can't wait for the list) but that
  // read now warms/patches this same cache.
  companies: (orgId: string) => ["companies", orgId] as const,

  // Platform State Sync Phase S5B — Account detail relationship data. Each
  // is scoped by (orgId, companyId) — one Account detail page's worth of
  // data, not the whole org — so opening a different Account never shares
  // a cache entry with another one, but the leading ["<name>", orgId]
  // prefix still lets the realtime bridge invalidate "every open Account
  // detail's notes/activities/contacts" in one call without knowing which
  // companyId is currently on screen in any tab (TanStack's default prefix
  // matching). Full Contact rows are deliberately NOT duplicated into
  // companyContacts — it holds only the company_contacts association
  // (relationship_title/is_primary); the route joins it against the
  // already-shared `queryKeys.contacts(orgId)` list. See
  // src/lib/company-relations.ts.
  companyContacts: (orgId: string, companyId: string) => ["companyContacts", orgId, companyId] as const,
  companyNotes: (orgId: string, companyId: string) => ["companyNotes", orgId, companyId] as const,
  companyActivities: (orgId: string, companyId: string) => ["companyActivities", orgId, companyId] as const,

  // Platform State Sync Phase S5C — Files (public.project_files metadata,
  // despite the table name this is the whole org's document library, not
  // just per-project attachments — project_id is nullable ("Workspace"
  // files)). ONE key per org: files-store.ts's `useFiles()` is the single
  // caller of this domain — there is no per-entity file panel anywhere in
  // the app today (Project Photos uses the same table but its own
  // separate, already-working module — project-photos.ts — deliberately
  // left alone, see the S5C report), so a targeted filesForEntity(...) key
  // would be speculative. Client-side filter/search/sort over this one
  // list, same as before.
  files: (orgId: string) => ["files", orgId] as const,

  // Platform State Sync Phase S5D — Organization / Team / Permissions.
  // Team roster (org_memberships + profiles join, active members only) and
  // organization invitations (pending/roster-only, team invites — never
  // portal invites, which carry a project_id) are TWO separate keys/
  // fetches even though `useTeam()` still returns ONE merged array (its
  // pre-S5D public shape, preserved) — kept apart so inviting someone only
  // invalidates `organizationInvitations`, not the whole team roster, and
  // vice versa (see organization.ts / the S5D report's invalidation
  // matrix). `memberPermissions` is scoped per (org, member) — the
  // Permissions settings page only ever needs the one currently-selected
  // member's overrides, never every member's rows at once.
  teamMembers: (orgId: string) => ["teamMembers", orgId] as const,
  organizationInvitations: (orgId: string) => ["organizationInvitations", orgId] as const,
  memberPermissions: (orgId: string, memberId: string) => ["memberPermissions", orgId, memberId] as const,

  // Platform State Sync Phase S4A — Deals / Pipeline. ONE key per org whose
  // Query payload is the co-loaded bundle `{ deals, pipelines, stages }`
  // (deals-store.ts): a Deal can't be mapped without its stage, and every
  // screen that reads deals also reads stages, so they share one fetch and
  // one cache entry rather than three keys that would always invalidate
  // together anyway. Stage columns are derived client-side from this one
  // list — never a query per stage.
  deals: (orgId: string) => ["deals", orgId] as const,

  // Platform State Sync Phase S4B — Projects. One key per org; the Projects
  // page derives its status-grouped board columns/filters client-side from
  // this single list (never a query per status). See projects-store.ts.
  projects: (orgId: string) => ["projects", orgId] as const,

  // Platform State Sync Phase S4C — Tasks. One key per org; the Tasks board
  // columns, list filters, overdue/due-soon views, project groups, the
  // Command Center's Today's Tasks + Needs Attention (atomic tasks) + its
  // Projects rollup, and every entity Task panel are all derived
  // client-side from this single list (never a query per status/filter).
  // See tasks-store.ts.
  tasks: (orgId: string) => ["tasks", orgId] as const,

  // Platform State Sync Phase S4D — Calendar / Appointments. One key per
  // org: the whole org's appointment list. Every Calendar view (day / week
  // / month / agenda), every entity Appointments panel (Contact / Lead /
  // Deal / Project / Account), and the Appointment detail sheet are all
  // derived client-side from this single list (never a query per date /
  // view / entity). Tasks stay their own S4C query — Calendar composes the
  // two client-side. See appointments-store.ts.
  appointments: (orgId: string) => ["appointments", orgId] as const,

  conversations: {
    /**
     * Prefix/parent key — never used as an actual useQuery key itself
     * (nothing fetches "all conversation sources" as one request). Exists
     * so a broad invalidation (e.g. "something changed that could affect
     * any conversation source") can invalidate every conversations.* query
     * in one call, relying on TanStack Query's default prefix matching:
     * invalidateQueries({queryKey: queryKeys.conversations.all(orgId)})
     * matches conversations.sms/.gmail/.voice too, since their keys all
     * extend this same array.
     */
    all: (orgId: string) => ["conversations", orgId] as const,
    /** SMS/WhatsApp/Messenger/Instagram — sms_meta_messages, grouped by (contact_id, channel). See sms-meta-conversations.ts. */
    sms: (orgId: string) => ["conversations", orgId, "sms"] as const,
    /** Email — gmail_messages, CRM-matched threads grouped by contact_id, unmatched senders kept per-thread. See gmail-conversations.ts. */
    gmail: (orgId: string) => ["conversations", orgId, "gmail"] as const,
    /** Voice — voice_calls, grouped by contact/caller number. See voice-conversations.ts. */
    voice: (orgId: string) => ["conversations", orgId, "voice"] as const,
    /**
     * Reserved for a future per-thread message query (lazy-loaded messages
     * for one open conversation instead of the whole org's history in one
     * shot). NOT backed by an actual separate useQuery in S1 — today's
     * sms/gmail/voice queries still return their conversation list AND
     * every message together in one payload, exactly as before this
     * migration. Declared now so the key shape is settled before anything
     * depends on it.
     */
    messages: (orgId: string, contactId: string, channel: string) =>
      ["conversationMessages", orgId, contactId, channel] as const,
  },

  /** Archive/star state (conversation_states table). Table-level key only — the hook that reads it (useConversationArchiveStates/useConversationStarStates) is NOT Query-backed yet in S1; see report boundary. */
  conversationStates: (orgId: string) => ["conversationStates", orgId] as const,

  /**
   * Reserved — NOT backed by its own useQuery/fetch in S1. Unread counts
   * are still derived client-side from queryKeys.conversations.sms(orgId)'s
   * already-loaded data (same as before this migration — see
   * unreadCount on Conversation, folderCounts in inbox.tsx, and the
   * sidebar badge), which is strictly cheaper than a second server round
   * trip for the same information. Declared and invalidated alongside the
   * sms query by the realtime bridge for forward compatibility only (a
   * harmless no-op today since nothing observes this exact key yet).
   */
  unreadMessages: (orgId: string) => ["unreadMessages", orgId] as const,

  // Platform State Sync Phase S2B — Command Center. Deliberately COARSER
  // than the "one key per widget" shape suggested in that phase's own task
  // brief: the underlying fetch code shares date-boundary computation
  // (monthStart, sparkStart, org-timezone "today") and, for
  // recentActivity/attention specifically, shares raw result sets
  // (allEstimateRows feeds both the Estimates-adjacent stat AND the
  // Recent Activity feed AND Needs Attention's stale-estimate detection).
  // Splitting those into fully separate queries would either duplicate
  // that fetch (re-introducing the exact "same data, independent copies"
  // problem this migration exists to remove) or require restructuring
  // several already-correct, heavily-commented derivations under time
  // pressure with no live environment to verify against. Grouped instead
  // by what already shares one fetch — see the S2B report for the full
  // reasoning and the "widgets consolidated" list.
  dashboard: {
    /**
     * KPI row (New Leads/Active Projects/Revenue/Bookings Today counts +
     * trends), all five sparklines, Next Booking, Recent Activity, and the
     * data Needs Attention's estimate/task-staleness checks read — every
     * piece of the former single mount-only useEffect in index.tsx EXCEPT
     * Pipeline Pulse (see dashboard.pipelinePulse below, now its own
     * dynamic-period query) and the AI Center card's fixed-14-day voice
     * call count (kept alongside since it isn't part of the new dynamic
     * period feature).
     */
    summary: (orgId: string) => ["dashboard", orgId, "summary"] as const,
    /**
     * Pipeline Pulse — parameterized by the user's selected timeline
     * (7d/14d/30d/90d/year), a genuinely dynamic dimension the summary
     * query above has no equivalent of. A different period is a different
     * cached entry, so switching periods after already having viewed one
     * doesn't refetch if the user switches back.
     */
    pipelinePulse: (orgId: string, period: string) => ["dashboard", orgId, "pipelinePulse", period] as const,
  },
};
