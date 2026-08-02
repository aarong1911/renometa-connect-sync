// src/lib/conversations-nav.ts
//
// One shared way to jump to Conversations (/inbox, labeled "Conversations"
// in the sidebar) for a specific Contact — used by the Project detail
// header Message button and Primary Contact "Contact" button so both stay
// consistent, and reusable from Contact/Account/Deal/Task views without
// duplicating the navigation call. Deliberately thin: the actual
// existing-conversation-vs-compose resolution lives in inbox.tsx itself
// (every Contact always has at least a placeholder "start a conversation"
// entry there — see allConversations/placeholderConvs), this helper only
// has to get the right contactId into the URL.
//
// Pushes history (default navigate behavior — no `replace`) so browser
// Back returns to wherever this was called from.

type NavigateFn = (opts: { to: string; search: Record<string, unknown> }) => unknown;

export function openContactConversation(navigate: NavigateFn, contactId: string | null | undefined): boolean {
  if (!contactId) return false;
  navigate({ to: "/inbox", search: { contactId } });
  return true;
}
