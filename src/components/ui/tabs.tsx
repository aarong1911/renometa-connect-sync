import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      // RenoMeta Global UI Interaction System — gap-1.5 is the one shared
      // segmented-control spacing value for every Tabs usage in the app
      // (CRM Campaigns/Paid Ads, Google Ads/Meta Ads, Overview/Ad Groups,
      // Keywords/Search Terms, etc.). RenoMeta tabs are NOT a connected
      // segmented-control design — adjacent triggers must never visually
      // touch. Fixed here, once, rather than per-page margins.
      "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-muted p-1 text-muted-foreground",
      className,
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      // RenoMeta Global UI Interaction System — the active tab uses the
      // same warm-neutral control-neutral tokens as the `neutral` Button
      // variant, so Overview/Ad Groups, Keywords/Search Terms, CRM
      // Campaigns/Paid Ads etc. all read as one shared tab family instead
      // of each page inventing its own active-state color.
      "inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 data-[state=active]:bg-control-neutral data-[state=active]:text-control-neutral-foreground data-[state=active]:shadow-sm data-[state=active]:border data-[state=active]:border-control-neutral-border",
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
