// src/components/integrations/stripe-setup-instructions.tsx
//
// Compact "How to connect Stripe" block shown in the Stripe integration drawer, immediately before the credential form.
// Presentation only: it renders static copy and one external link. It never reads, receives or displays a secret key, and it does
// not touch the save flow or any payment logic.

import { ExternalLink } from "lucide-react";

/** Stripe's official API keys page (Developers → API keys). */
export const STRIPE_API_KEYS_URL = "https://dashboard.stripe.com/apikeys";

export const STRIPE_SETUP_STEPS = [
  "Open your Stripe Dashboard.",
  "Go to Developers → API keys.",
  "Copy the Secret key — not the Publishable key.",
  "Use an sk_live_… key for real payments. Use sk_test_… only for testing.",
  "Paste it below and click Save Credentials.",
] as const;

export const STRIPE_SETUP_SECURITY_NOTE = "Your Stripe secret key is stored securely and is never shown again after saving.";

export function StripeSetupInstructions() {
  return (
    <div className="space-y-2 rounded-md border border-border bg-secondary/40 p-3" data-testid="stripe-setup-instructions">
      <p className="text-xs font-medium">How to connect Stripe</p>
      <ol className="list-decimal space-y-0.5 pl-4 text-[11px] text-muted-foreground">
        {STRIPE_SETUP_STEPS.map((step) => <li key={step}>{step}</li>)}
      </ol>
      <a
        href={STRIPE_API_KEYS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-[11px] font-medium text-primary underline-offset-2 hover:underline"
      >
        <ExternalLink className="h-3 w-3" />
        Open Stripe API Keys
      </a>
      <p className="text-[11px] text-muted-foreground">{STRIPE_SETUP_SECURITY_NOTE}</p>
    </div>
  );
}
