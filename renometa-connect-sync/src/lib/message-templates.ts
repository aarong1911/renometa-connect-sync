// Shared message templates + merge tag resolver used by /inbox composer
// and /settings/templates editor.

export type MessageChannel = "email" | "sms";

export type SharedMessageTemplate = {
  id: string;
  name: string;
  channel: MessageChannel;
  category: string;
  description: string;
  subject?: string;
  body: string;
  uses: number;
  starred: boolean;
};

export const messageTemplates: SharedMessageTemplate[] = [
  {
    id: "m1", name: "New lead — welcome", channel: "email", category: "Welcome",
    description: "First touch within 5 minutes of an inbound lead.",
    subject: "Thanks for reaching out, {{first_name}}!",
    body: "Hi {{first_name}},\n\nThanks for considering {{company_name}} for your {{project_type}} project at {{project_address}}. I'd love to schedule a 15-min discovery call to learn more about your goals.\n\nWhat times work best this week?\n\n— {{owner_name}}",
    uses: 482, starred: true,
  },
  {
    id: "m2", name: "Estimate follow-up (3 day)", channel: "email", category: "Follow-up",
    description: "Sent 3 days after estimate delivery if no response.",
    subject: "Quick check on your {{project_type}} estimate",
    body: "Hi {{first_name}},\n\nJust circling back on the {{project_type}} estimate I sent ({{estimate_total}}). Happy to walk you through any line item or adjust scope.\n\nWould a quick call Thursday or Friday work?\n\n— {{owner_name}}",
    uses: 318, starred: true,
  },
  {
    id: "m3", name: "Deposit reminder", channel: "email", category: "Billing",
    description: "Friendly nudge for outstanding deposits.",
    subject: "Reserve your start date — deposit due {{deposit_due}}",
    body: "Hi {{first_name}},\n\nWe're holding {{start_date}} for your {{project_type}}. To lock it in, we need the {{deposit_amount}} deposit by {{deposit_due}}.\n\nPay securely here: [payment link]\n\n— {{owner_name}}",
    uses: 164, starred: false,
  },
  {
    id: "m4", name: "Project complete — review request", channel: "email", category: "Reputation",
    description: "Sent at substantial completion to invite a Google review.",
    subject: "It was a pleasure, {{first_name}} 🛠️",
    body: "Hi {{first_name}},\n\nWe loved working on your {{project_type}} at {{project_address}}. If you have 60 seconds, a quick Google review helps us keep doing what we love:\n\n[review link]\n\nThanks again!\n— {{owner_name}}",
    uses: 96, starred: false,
  },
  {
    id: "m5", name: "Speed-to-lead text", channel: "sms", category: "Welcome",
    description: "Auto-text within 60 seconds of new lead.",
    body: "Hey {{first_name}}, this is {{owner_name}} from {{company_name}}. Got your inquiry for {{project_type}} — got 5 min for a quick chat? Reply YES and I'll call.",
    uses: 612, starred: true,
  },
  {
    id: "m6", name: "Site visit reminder", channel: "sms", category: "Scheduling",
    description: "Day-before SMS reminder with arrival window.",
    body: "Reminder: {{owner_name}} from {{company_name}} will be at {{project_address}} tomorrow between 9–10am. Reply RESCHED to change.",
    uses: 287, starred: false,
  },
  {
    id: "m7", name: "Appointment confirmed", channel: "sms", category: "Scheduling",
    description: "Confirms a freshly booked site visit.",
    body: "Confirmed! {{owner_name}} will see you at {{project_address}} on {{start_date}}. Reply with any questions — talk soon, {{first_name}}.",
    uses: 201, starred: false,
  },
  // ── Email: Scheduling ──
  {
    id: "m8", name: "Estimate appointment confirmation", channel: "email", category: "Scheduling",
    description: "Confirms a scheduled estimate visit with address and arrival window.",
    subject: "Confirmed: On-site estimate at {{project_address}} on {{appointment_date}}",
    body: "Hi {{first_name}},\n\nYour free on-site estimate is confirmed:\n\n📅 Date: {{appointment_date}}\n🕙 Time: {{appointment_time}}\n📍 Address: {{project_address}}\n\n{{owner_name}} from {{company_name}} will be there. Feel free to reply here if anything changes.\n\nSee you then!\n— {{owner_name}}",
    uses: 203, starred: true,
  },
 
  // ── SMS: Billing ──
  {
    id: "m9", name: "Invoice due soon", channel: "sms", category: "Billing",
    description: "Reminder 48 hours before invoice due date.",
    body: "Hi {{first_name}}, your invoice for {{project_type}} ({{invoice_total}}) is due on {{due_date}}. Pay here: {{payment_link}} — {{company_name}}",
    uses: 145, starred: false,
  },
  {
    id: "m10", name: "Deposit received thanks", channel: "sms", category: "Billing",
    description: "Confirms deposit and locks in start date.",
    body: "Got your deposit — thank you, {{first_name}}! You're locked in for {{start_date}}. We'll be in touch before then. — {{owner_name}}, {{company_name}}",
    uses: 98, starred: false,
  },
 
  // ── SMS: Follow-up ──
  {
    id: "m11", name: "Estimate follow-up (3 day)", channel: "sms", category: "Follow-up",
    description: "Quick text 3 days after estimate if no response.",
    body: "Hey {{first_name}}, just checking in on the estimate I sent for your {{project_type}}. Any questions? Reply here or call {{owner_phone}}. — {{owner_name}}",
    uses: 267, starred: true,
  },
  {
    id: "m12", name: "Post-visit follow-up", channel: "sms", category: "Follow-up",
    description: "Same-day follow-up after an on-site estimate visit.",
    body: "Great meeting you today, {{first_name}}! I'll send the detailed estimate within 24 hours. Any questions in the meantime? — {{owner_name}}, {{company_name}}",
    uses: 189, starred: false,
  },
 
  // ── SMS: Reputation ──
  {
    id: "m13", name: "Review request — Google", channel: "sms", category: "Reputation",
    description: "Quick review ask at project completion.",
    body: "Hi {{first_name}}, it was great working on your {{project_type}}! If you have 60 sec, a Google review means a lot: {{review_link}} — {{owner_name}}, {{company_name}}",
    uses: 312, starred: true,
  },
  {
    id: "m14", name: "Referral ask", channel: "sms", category: "Reputation",
    description: "Referral request sent 2 weeks after project close.",
    body: "Hey {{first_name}}, hope you're loving the new {{project_type}}! Know anyone else who could use our help? We always take great care of referrals. — {{company_name}}",
    uses: 74, starred: false,
  },
 
  // ── Email: Billing (additional) ──
  {
    id: "m15", name: "Progress invoice sent", channel: "email", category: "Billing",
    description: "Notifies client of a new progress draw invoice.",
    subject: "Progress invoice #{{invoice_number}} — {{project_type}} at {{project_address}}",
    body: "Hi {{first_name}},\n\nAttached is progress invoice #{{invoice_number}} for {{invoice_total}} covering work completed through {{invoice_date}}.\n\nPay securely here: [payment link]\n\nThank you!\n— {{owner_name}}",
    uses: 211, starred: false,
  },
 
  // ── Email: Follow-up (additional) ──
  {
    id: "m16", name: "No-response re-engagement", channel: "email", category: "Follow-up",
    description: "Final follow-up 14 days after estimate with no response.",
    subject: "Still thinking it over? — {{project_type}} estimate",
    body: "Hi {{first_name}},\n\nI know timing isn't always right — just wanted to leave the door open. Your {{project_type}} estimate is still valid through {{expiry_date}}.\n\nIf anything's changed or you'd like a revised scope, just say the word.\n\n— {{owner_name}}",
    uses: 87, starred: false,
  },
 
  // ── Email: Scheduling (additional) ──
  {
    id: "m17", name: "Reschedule request", channel: "email", category: "Scheduling",
    description: "Sent when an appointment needs to move.",
    subject: "Rescheduling your {{appointment_type}} — {{project_address}}",
    body: "Hi {{first_name}},\n\nI need to reschedule our {{appointment_type}} that was set for {{original_date}}. I apologize for any inconvenience.\n\nHere are a few times that work on my end:\n• {{option_1}}\n• {{option_2}}\n• {{option_3}}\n\nDoes any of those work? Or suggest a time that's better for you.\n\n— {{owner_name}}",
    uses: 43, starred: false,
  },
];

export type MergeContext = Partial<{
  first_name: string;
  last_name: string;
  project_address: string;
  project_type: string;
  owner_name: string;
  company_name: string;
  deposit_amount: string;
  start_date: string;
  estimate_total: string;
  deposit_due: string;
}>;

export function resolveMergeTags(text: string, ctx: MergeContext): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (full, key: string) => {
    const v = (ctx as Record<string, string | undefined>)[key];
    return v ?? full;
  });
}

// Debug log entry produced by composers when a template is inserted.
// Tracks whether subject/body were replaced, appended, or left alone.
export type TemplateInsertLog = {
  ts: string;
  surface: "inbox" | "project-comms";
  templateId: string;
  templateName: string;
  channel: MessageChannel;
  mode: "replace" | "append";
  subjectAction: "replace" | "append" | "noop" | "n/a";
  bodyAction: "replace" | "append" | "noop";
  /** Best-effort current user (e.g. composer's "from" identity or project owner). */
  userName?: string;
  /** Project slug when the insertion happened on a project page. */
  clientSlug?: string;
};

// Persistence for the composer debug log so users can review prior
// Replace/Append/no-op decisions across page refreshes.
import { useEffect, useState } from "react";

const LOG_MAX = 20;
const LOG_EVENT = "template-insert-log-change";

function logKey(surface: TemplateInsertLog["surface"]): string {
  return `composer.templateInsertLog.${surface}`;
}

function readLog(surface: TemplateInsertLog["surface"]): TemplateInsertLog[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(logKey(surface));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is TemplateInsertLog =>
      !!e && typeof e === "object" && typeof (e as TemplateInsertLog).ts === "string"
    );
  } catch {
    return [];
  }
}

function writeLog(surface: TemplateInsertLog["surface"], entries: TemplateInsertLog[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(logKey(surface), JSON.stringify(entries.slice(0, LOG_MAX)));
    window.dispatchEvent(new CustomEvent(LOG_EVENT, { detail: { surface } }));
  } catch {
    // ignore quota errors
  }
}

/**
 * Persistent template-insertion debug log, scoped per surface.
 * Returns [entries, append, clear].
 */
export function usePersistentInsertLog(
  surface: TemplateInsertLog["surface"],
): [TemplateInsertLog[], (entry: TemplateInsertLog) => void, () => void] {
  const [entries, setEntries] = useState<TemplateInsertLog[]>(() => readLog(surface));

  useEffect(() => {
    const sync = (e: Event) => {
      const detail = (e as CustomEvent).detail as { surface?: string } | undefined;
      if (detail?.surface && detail.surface !== surface) return;
      setEntries(readLog(surface));
    };
    const storageSync = (e: StorageEvent) => {
      if (e.key === logKey(surface)) setEntries(readLog(surface));
    };
    window.addEventListener(LOG_EVENT, sync);
    window.addEventListener("storage", storageSync);
    return () => {
      window.removeEventListener(LOG_EVENT, sync);
      window.removeEventListener("storage", storageSync);
    };
  }, [surface]);

  const append = (entry: TemplateInsertLog) => {
    const next = [entry, ...readLog(surface)].slice(0, LOG_MAX);
    writeLog(surface, next);
    setEntries(next);
  };

  const clear = () => {
    writeLog(surface, []);
    setEntries([]);
  };

  return [entries, append, clear];
}
