export type ConnectMethod = "oauth" | "apikey" | "link";

export type CategoryId =
  | "communication"
  | "calendars"
  | "forms"
  | "esign"
  | "payments"
  | "accounting"
  | "files"
  | "ads-leads"
  | "reviews"
  | "procurement";

export interface Integration {
  id: string;
  name: string;
  vendor: string;
  description: string;
  connectMethod: ConnectMethod;
  category: CategoryId;
  syncBadges: string[];
  automations?: string[];
  connected: boolean;
}

export const CATEGORIES: { id: CategoryId | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "communication", label: "Communication" },
  { id: "calendars", label: "Calendars" },
  { id: "forms", label: "Forms" },
  { id: "esign", label: "E-Sign" },
  { id: "payments", label: "Payments" },
  { id: "accounting", label: "Accounting" },
  { id: "files", label: "Files" },
  { id: "ads-leads", label: "Ads/Leads" },
  { id: "reviews", label: "Reviews" },
  { id: "procurement", label: "Procurement" },
];

export const INTEGRATIONS: Integration[] = [
  // Communication
  { id: "gmail", name: "Gmail", vendor: "Google", description: "Send email from your own Gmail address. Requires a Gmail App Password (Google Account → Security → 2-Step Verification → App passwords).", connectMethod: "apikey", category: "communication", syncBadges: ["Emails", "Attachments"], automations: ["Auto-log email threads to deals"], connected: false },
  { id: "twilio", name: "Twilio", vendor: "Twilio", description: "Business SMS/MMS & calls with tracking.", connectMethod: "apikey", category: "communication", syncBadges: ["SMS", "Calls", "Recordings"], automations: ["Instant SMS to new leads", "48/24/1-hour appointment reminders", "Missed call text-back"], connected: false },
  { id: "whatsapp", name: "WhatsApp Business (Cloud API)", vendor: "Meta", description: "Two-way WhatsApp in your Inbox. Templates for outreach & reminders.", connectMethod: "oauth", category: "communication", syncBadges: ["WhatsApp", "Media", "Templates"], automations: ["Appointment reminders via WhatsApp", "Review request 7 days after close"], connected: false },
  { id: "fb-messenger", name: "Facebook Messenger", vendor: "Meta", description: "Page DMs flow into your Inbox and attach to contacts/deals.", connectMethod: "oauth", category: "communication", syncBadges: ["Messages", "Media"], connected: false },
  { id: "instagram-direct", name: "Instagram Direct", vendor: "Meta", description: "Handle Instagram DMs in the Inbox; convert DMs to leads.", connectMethod: "oauth", category: "communication", syncBadges: ["Messages", "Media"], connected: false },
  { id: "slack", name: "Slack", vendor: "Slack", description: "Notifications and deal updates in your Slack workspace.", connectMethod: "oauth", category: "communication", syncBadges: ["Messages", "Notifications"], automations: ["Post deal stage changes to channel"], connected: false },
  // Calendars
  { id: "google-calendar", name: "Google Calendar", vendor: "Google", description: "Two-way event sync & invites.", connectMethod: "oauth", category: "calendars", syncBadges: ["Events"], automations: ["Create event on Appointment Scheduled"], connected: false },
  { id: "calendly", name: "Calendly", vendor: "Calendly", description: "Let prospects book consultations.", connectMethod: "oauth", category: "calendars", syncBadges: ["Bookings"], automations: ["Auto confirmations & reminders"], connected: false },
  // Forms
  { id: "native-form", name: "Native Form (Embed)", vendor: "RenoMeta", description: "Embed our lead form on your site.", connectMethod: "link", category: "forms", syncBadges: ["Leads"], automations: ["Instant SMS to new leads"], connected: false },
  { id: "jotform", name: "Jotform", vendor: "Jotform", description: "Flexible forms with file uploads.", connectMethod: "apikey", category: "forms", syncBadges: ["Leads", "Files"], connected: false },
  // E-Sign
  { id: "docusign", name: "DocuSign", vendor: "DocuSign", description: "Industry-standard e-signature.", connectMethod: "oauth", category: "esign", syncBadges: ["Documents", "Statuses"], automations: ["Move deal to Signed when completed", "Auto-send contract when estimate accepted"], connected: false },
  // Payments
  { id: "stripe", name: "Stripe", vendor: "Stripe", description: "Collect deposits & final payments.", connectMethod: "apikey", category: "payments", syncBadges: ["Payments", "Refunds"], automations: ["Move to Closed when paid"], connected: false },
  { id: "paypal", name: "PayPal", vendor: "PayPal", description: "In-person & online payments.", connectMethod: "oauth", category: "payments", syncBadges: ["Payments"], connected: false },
  // Accounting
  { id: "quickbooks", name: "QuickBooks Online", vendor: "Intuit", description: "Sync customers, estimates, invoices & payments.", connectMethod: "oauth", category: "accounting", syncBadges: ["Customers", "Invoices", "Payments"], connected: false },
  // Files
  { id: "google-drive", name: "Google Drive", vendor: "Google", description: "Project folders, photos & proposal PDFs.", connectMethod: "oauth", category: "files", syncBadges: ["Files", "Folders"], connected: false },
  // Ads/Leads
  { id: "meta-ads", name: "Meta Ads Manager", vendor: "Meta", description: "Connect your ad account to create and manage campaigns from RenoMeta Connect.", connectMethod: "oauth", category: "ads-leads", syncBadges: ["Campaigns", "Ad Sets"], automations: ["Create Ad Campaign (AI Tools)"], connected: false },
  { id: "meta-lead-ads", name: "Meta Lead Ads", vendor: "Meta", description: "Pipe Facebook/Instagram ad leads into the New Lead stage with attribution.", connectMethod: "oauth", category: "ads-leads", syncBadges: ["Leads", "Source", "Campaign"], automations: ["Instant SMS to new leads", "Auto-assign to salesperson"], connected: false },
  { id: "google-ads", name: "Google Ads Lead Forms", vendor: "Google", description: "Capture Google Ads Lead Form submissions with campaign attribution.", connectMethod: "oauth", category: "ads-leads", syncBadges: ["Leads", "Source", "Campaign"], automations: ["Instant SMS to new leads", "Send booking link automatically"], connected: false },
  { id: "angi", name: "Angi", vendor: "Angi", description: "Ingest Angi leads with source attribution.", connectMethod: "link", category: "ads-leads", syncBadges: ["Leads", "Source"], automations: ["Instant SMS to new leads"], connected: false },
  { id: "thumbtack", name: "Thumbtack", vendor: "Thumbtack", description: "Sync Thumbtack leads and message threads.", connectMethod: "link", category: "ads-leads", syncBadges: ["Leads", "Messages"], connected: false },
  // Reviews
  { id: "google-business", name: "Google Business Profile", vendor: "Google", description: "Request & track Google reviews after jobs.", connectMethod: "oauth", category: "reviews", syncBadges: ["Reviews", "Ratings"], automations: ["Auto send review request 7 days after close"], connected: false },
  // Procurement
  { id: "home-depot", name: "Home Depot Pro", vendor: "The Home Depot", description: "Link purchase history and receipts for jobs.", connectMethod: "link", category: "procurement", syncBadges: ["Orders", "Receipts"], connected: false },
];