// Bundling entry for the src/lib email tests (see gmail-auto-sync.test.ts and
// gmail-conversations.test.ts): exposes the real production modules that import
// through the "@/..." alias.
export { syncViaGmailServer } from "@/lib/use-gmail-auto-sync";
export { createGmailAutoSync } from "@/lib/gmail-auto-sync";
export { fetchGmailConversations } from "@/lib/gmail-conversations";
