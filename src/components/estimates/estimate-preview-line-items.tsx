// src/components/estimates/estimate-preview-line-items.tsx
//
// The line-item <tbody> rows of Estimates → Preview Proposal
// (EstimateViewDialog in src/routes/estimates.tsx), plus the section
// grouping shared with the print window and the detail sheet.

import { Fragment } from "react";
import { Badge } from "@/components/ui/badge";

export type PreviewLineItem = {
  id: string;
  name: string;
  description: string | null;
  quantity: number;
  unit: string | null;
  unit_price: number;
  total: number;
  optional: boolean;
  is_heading: boolean;
};

export type EstimateSection<T extends PreviewLineItem> = {
  /** Stable React key: the heading row's id, or "section-ungrouped" for items before the first heading. */
  key: string;
  /** The heading row's id (null for the leading ungrouped section). */
  headingId: string | null;
  heading: string | null;
  items: T[];
};

/** Groups a flat item list into sections at each is_heading row — the print/view analogue of the editor's section headings. */
export function groupBySection<T extends PreviewLineItem>(items: T[]): EstimateSection<T>[] {
  const groups: EstimateSection<T>[] = [];
  let current: EstimateSection<T> = { key: "section-ungrouped", headingId: null, heading: null, items: [] };
  for (const it of items) {
    if (it.is_heading) {
      if (current.items.length || current.heading) groups.push(current);
      current = { key: `section-${it.id}`, headingId: it.id, heading: it.name, items: [] };
    } else {
      current.items.push(it);
    }
  }
  if (current.items.length || current.heading) groups.push(current);
  return groups.filter(g => g.items.length > 0 || g.heading);
}

export function EstimatePreviewLineItems({ items, formatMoney }: { items: PreviewLineItem[]; formatMoney: (n: number) => string }) {
  if (items.length === 0) {
    return <tr><td colSpan={4} className="py-6 text-center text-muted-foreground">No line items</td></tr>;
  }
  const groups = groupBySection(items);
  return (
    <>
      {groups.map(g => (
        // The key belongs on the Fragment — the element each map iteration
        // returns. An unkeyed <></> here was the production warning.
        <Fragment key={g.key}>
          {g.heading && <tr key={`heading-${g.headingId}`} className="border-b border-border bg-secondary/40"><td colSpan={4} className="py-1.5 pl-3 pr-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{g.heading}</td></tr>}
          {g.items.map(item => (
            <tr key={item.id} className="border-b border-border last:border-0">
              <td className="py-2 pl-3 pr-2">
                <div className="font-medium">{item.name}{item.optional && <Badge variant="outline" className="ml-1.5 h-4 rounded px-1 text-[9px] align-middle">optional</Badge>}</div>
                {item.description && <div className="text-[11px] text-muted-foreground">{item.description}</div>}
              </td>
              <td className="py-2 pr-2 text-right tabular-nums">{item.quantity}{item.unit ? ` ${item.unit}` : ""}</td>
              <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(item.unit_price)}</td>
              <td className="py-2 pr-3 text-right tabular-nums font-medium">{formatMoney(item.total)}</td>
            </tr>
          ))}
        </Fragment>
      ))}
    </>
  );
}
