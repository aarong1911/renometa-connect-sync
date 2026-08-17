// src/lib/marketing-built-in-templates.ts
//
// Phase 14.1 — curated, application-level starter Campaign templates.
// These are product presets shipped in source code, NOT rows in
// `public.marketing_templates` — they are never inserted into the
// database (no seed script, no service_role, no per-org copies), never
// appear in Marketing → Templates (that CRUD list stays user-created
// templates only), and selecting one is a one-time copy into the
// Campaign draft's own subject/body — never a live binding back to this
// file, and never written into `campaigns.template_id` (that column is a
// real FK into `marketing_templates`; a built-in id like
// "builtin-sms-appointment-reminder" must never be stored there — see
// the selection-state handling in src/routes/marketing.tsx).
//
// IDs are deliberately NOT UUID-shaped so they can never be confused with
// (or accidentally satisfy validation for) a real marketing_templates.id.

export type BuiltInMarketingTemplate = {
  id: string;
  name: string;
  channel: "email" | "sms";
  subject?: string;
  body: string;
  category?: string;
};

export const BUILT_IN_MARKETING_TEMPLATES: BuiltInMarketingTemplate[] = [
  // ---------- SMS ----------
  {
    id: "builtin-sms-appointment-reminder",
    name: "Appointment Reminder",
    channel: "sms",
    category: "Follow-up",
    body: "Hi {{first_name}}, this is a reminder from {{company_name}} about your upcoming appointment. Reply if you have any questions.",
  },
  {
    id: "builtin-sms-estimate-follow-up",
    name: "Estimate Follow-Up",
    channel: "sms",
    category: "Follow-up",
    body: "Hi {{first_name}}, just following up from {{company_name}} about your estimate. Let us know if you have any questions or would like to move forward.",
  },
  {
    id: "builtin-sms-past-customer-reactivation",
    name: "Past Customer Reactivation",
    channel: "sms",
    category: "Reactivation",
    body: "Hi {{first_name}}, it's {{company_name}}. We're checking in to see if there's anything we can help you with around your home.",
  },
  {
    id: "builtin-sms-review-request",
    name: "Review Request",
    channel: "sms",
    category: "Customer Care",
    body: "Hi {{first_name}}, thank you for choosing {{company_name}}. We'd appreciate your feedback about your experience with us.",
  },
  {
    id: "builtin-sms-seasonal-promotion",
    name: "Seasonal Promotion",
    channel: "sms",
    category: "Promotion",
    body: "Hi {{first_name}}, {{company_name}} is offering a seasonal promotion for past customers. Reply if you'd like more details.",
  },
  {
    id: "builtin-sms-missed-call-follow-up",
    name: "Missed Call Follow-Up",
    channel: "sms",
    category: "Follow-up",
    body: "Hi {{first_name}}, this is {{company_name}} following up after we missed your call. How can we help?",
  },

  // ---------- Email ----------
  {
    id: "builtin-email-estimate-follow-up",
    name: "Estimate Follow-Up",
    channel: "email",
    category: "Follow-up",
    subject: "Following up on your estimate",
    body: "Hi {{first_name}},\n\nI wanted to follow up from {{company_name}} regarding your estimate.\n\nIf you have any questions or would like to discuss next steps, just reply to this email and we'll be happy to help.\n\nBest,\n{{company_name}}",
  },
  {
    id: "builtin-email-past-customer-reactivation",
    name: "Past Customer Reactivation",
    channel: "email",
    category: "Reactivation",
    subject: "How can {{company_name}} help?",
    body: "Hi {{first_name}},\n\nIt's been a little while since we worked together, so we wanted to check in.\n\nIf you have another project coming up or need help with your home, we'd be glad to hear from you.\n\nBest,\n{{company_name}}",
  },
  {
    id: "builtin-email-seasonal-promotion",
    name: "Seasonal Promotion",
    channel: "email",
    category: "Promotion",
    subject: "A seasonal update from {{company_name}}",
    body: "Hi {{first_name}},\n\nWe're reaching out to let you know about current seasonal services and promotions available from {{company_name}}.\n\nReply to this email if you'd like more information.\n\nBest,\n{{company_name}}",
  },
  {
    id: "builtin-email-review-request",
    name: "Review Request",
    channel: "email",
    category: "Customer Care",
    subject: "How did we do?",
    body: "Hi {{first_name}},\n\nThank you for choosing {{company_name}}.\n\nWe'd appreciate hearing about your experience. Your feedback helps us continue improving our service.\n\nBest,\n{{company_name}}",
  },
  {
    id: "builtin-email-project-check-in",
    name: "Project Check-In",
    channel: "email",
    category: "Customer Care",
    subject: "Checking in on your project",
    body: "Hi {{first_name}},\n\nWe wanted to check in and see how things are going.\n\nIf you have any questions or there's anything {{company_name}} can help with, just reply to this email.\n\nBest,\n{{company_name}}",
  },
  {
    id: "builtin-email-new-service-announcement",
    name: "New Service Announcement",
    channel: "email",
    category: "Promotion",
    subject: "Something new from {{company_name}}",
    body: "Hi {{first_name}},\n\nWe wanted to let you know that {{company_name}} is now offering an additional service that may be useful to you.\n\nReply to this email if you'd like more information.\n\nBest,\n{{company_name}}",
  },
];

export function getBuiltInMarketingTemplates(channel: "email" | "sms"): BuiltInMarketingTemplate[] {
  return BUILT_IN_MARKETING_TEMPLATES.filter((t) => t.channel === channel);
}

export function isBuiltInMarketingTemplateId(id: string): boolean {
  return id.startsWith("builtin-");
}
