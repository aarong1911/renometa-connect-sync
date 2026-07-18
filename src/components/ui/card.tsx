import * as React from "react";

import { cn } from "@/lib/utils";

// Global card visual system (applies everywhere this primitive is used —
// Leads, Contacts, Companies, Pipeline, Financials, Estimates, AI Center,
// Inbox, Tasks, Calendar, Projects, Reviews, Reports, Marketing, Files,
// Integrations, Settings, etc.): white surface, 16px radius, a slightly
// stronger border than the previous default, and a very subtle shadow
// instead of the old heavier default `shadow` utility.
//
// No hover animation here on purpose — this base primitive is used for
// both static panels and clickable list cards across the app, and "lift on
// hover" should only apply to cards that are actually interactive. Add
// `card-hover-interactive` (or an equivalent explicit className) at the
// specific call sites that are clickable rather than forcing motion onto
// every card everywhere.
const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-2xl border border-[#E2E8F0] dark:border-border bg-card text-card-foreground shadow-[0_1px_3px_rgba(15,23,42,0.04)] transition-[box-shadow,border-color] duration-200",
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = "Card";

// Same #FAF3E4 (bg-gold-soft — already the app's branded warm-cream token,
// with its own dark-mode variant) background + separator on every card
// header app-wide — only the icon (set by each page, not by this
// primitive) should differ by category. Header text itself stays dark,
// never tinted. Padding/height are left to flow with content (many
// existing CardHeader usages have a title + multi-line description), so
// this only adds the shared background/border treatment rather than
// forcing a fixed compact height — pages that want the exact 44-48px
// icon+title+action bar use the more specific header pattern (see
// SectionCard in routes/index.tsx).
const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("flex flex-col space-y-1.5 p-6 bg-gold-soft border-b border-[#E5E7EB] dark:border-border rounded-t-2xl", className)}
      {...props}
    />
  ),
);
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("font-semibold leading-none tracking-tight", className)}
      {...props}
    />
  ),
);
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
  ),
);
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
  ),
);
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex items-center p-6 pt-0", className)} {...props} />
  ),
);
CardFooter.displayName = "CardFooter";

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
