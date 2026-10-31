// src/components/integrations/integration-icon.tsx
//
// One provider-logo registry for Settings → Integrations (cards and the
// config drawer), keyed by the ids in lib/integrations-data.ts.
//
// Sources, in order of preference:
//   - official multi-color SVGs already in src/assets (Google Ads, Meta)
//   - Simple Icons brand marks via react-icons/si (CC0), drawn in the
//     brand's own color
//   - Tabler (MIT) / Font Awesome brands (CC BY 4.0) via react-icons where
//     Simple Icons no longer ships the mark (Twilio, Slack)
// Providers with no licensed mark available (DocuSign, Jotform, Angi,
// The Home Depot) and unknown ids get the generic fallback — never an
// invented logo.
//
// Logos sit on a white tile in both themes so brand colors keep their
// contrast in dark mode.

import type { ComponentType } from "react";
import { ClipboardList, Link2 } from "lucide-react";
import type { IconType } from "react-icons";
import { FaSlack } from "react-icons/fa";
import {
  SiCalendly, SiGmail, SiGoogle, SiGooglecalendar, SiGoogledrive, SiInstagram, SiMessenger,
  SiPaypal, SiQuickbooks, SiStripe, SiThumbtack, SiWhatsapp,
} from "react-icons/si";
import { TbBrandTwilio } from "react-icons/tb";
import { cn } from "@/lib/utils";
import googleAdsIconUrl from "@/assets/google-ads-icon.svg";
import metaIconUrl from "@/assets/meta-icon.svg";

export type IntegrationIconSpec =
  | { kind: "brand"; Icon: IconType; color: string }
  | { kind: "asset"; src: string }
  | { kind: "glyph"; Icon: ComponentType<{ className?: string }> };

export const INTEGRATION_ICONS: Record<string, IntegrationIconSpec> = {
  gmail: { kind: "brand", Icon: SiGmail, color: "#EA4335" },
  twilio: { kind: "brand", Icon: TbBrandTwilio, color: "#F22F46" },
  whatsapp: { kind: "brand", Icon: SiWhatsapp, color: "#25D366" },
  "fb-messenger": { kind: "brand", Icon: SiMessenger, color: "#0084FF" },
  "instagram-direct": { kind: "brand", Icon: SiInstagram, color: "#E4405F" },
  slack: { kind: "brand", Icon: FaSlack, color: "#4A154B" },
  "google-calendar": { kind: "brand", Icon: SiGooglecalendar, color: "#4285F4" },
  calendly: { kind: "brand", Icon: SiCalendly, color: "#006BFF" },
  // RenoMeta's own embeddable form — a first-party feature, not a provider.
  "native-form": { kind: "glyph", Icon: ClipboardList },
  stripe: { kind: "brand", Icon: SiStripe, color: "#635BFF" },
  paypal: { kind: "brand", Icon: SiPaypal, color: "#003087" },
  quickbooks: { kind: "brand", Icon: SiQuickbooks, color: "#2CA01C" },
  "google-drive": { kind: "brand", Icon: SiGoogledrive, color: "#4285F4" },
  "meta-ads": { kind: "asset", src: metaIconUrl },
  "meta-lead-ads": { kind: "asset", src: metaIconUrl },
  "google-ads": { kind: "asset", src: googleAdsIconUrl },
  thumbtack: { kind: "brand", Icon: SiThumbtack, color: "#009FD9" },
  // Simple Icons has no Business Profile mark; the Google "G" identifies it.
  "google-business": { kind: "brand", Icon: SiGoogle, color: "#4285F4" },
};

export function integrationIconSpec(id: string): IntegrationIconSpec | null {
  return Object.prototype.hasOwnProperty.call(INTEGRATION_ICONS, id) ? INTEGRATION_ICONS[id] : null;
}

const SIZES = {
  sm: { tile: "h-9 w-9 rounded-lg", mark: "h-[18px] w-[18px]" },
  md: { tile: "h-10 w-10 rounded-lg", mark: "h-5 w-5" },
};

/** Decorative — the card/drawer title next to it names the integration. */
export function IntegrationIcon({ id, size = "sm", className }: { id: string; size?: keyof typeof SIZES; className?: string }) {
  const spec = integrationIconSpec(id);
  const s = SIZES[size];
  const isLogo = spec?.kind === "brand" || spec?.kind === "asset";
  return (
    <span
      aria-hidden="true"
      data-integration-icon={spec ? id : "fallback"}
      className={cn(
        "grid shrink-0 place-items-center ring-1",
        s.tile,
        isLogo ? "bg-white ring-black/5 dark:ring-white/10" : "bg-secondary ring-black/5 dark:ring-white/10",
        className,
      )}
    >
      {spec?.kind === "brand" ? (
        <spec.Icon className={s.mark} style={{ color: spec.color }} />
      ) : spec?.kind === "asset" ? (
        <img src={spec.src} alt="" className={cn(s.mark, "object-contain")} />
      ) : spec?.kind === "glyph" ? (
        <spec.Icon className={cn(s.mark, "text-muted-foreground")} />
      ) : (
        <Link2 className={cn(s.mark, "text-muted-foreground")} />
      )}
    </span>
  );
}
