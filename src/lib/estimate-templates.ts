// Shared estimate templates used by /financials/estimates "Start from template"
// flow and /settings/templates editor.

export type EstimateLine = { name: string; qty: number; unit: string; price: number };

export type SharedEstimateTemplate = {
  id: string;
  name: string;
  category: string;
  description: string;
  projectType: string;
  markup: number; // percent
  lines: EstimateLine[];
  notes: string;
  uses: number;
  starred: boolean;
};

export const estimateTemplates: SharedEstimateTemplate[] = [
  {
    id: "e1", name: "Kitchen — Mid-range remodel", category: "Kitchen",
    description: "Standard 150 sqft kitchen with semi-custom cabinets and quartz.",
    projectType: "Kitchen", markup: 22,
    lines: [
      { name: "Demo & disposal", qty: 1, unit: "lot", price: 3800 },
      { name: "Semi-custom cabinetry", qty: 22, unit: "lf", price: 480 },
      { name: "Quartz countertops", qty: 48, unit: "sf", price: 95 },
      { name: "Tile backsplash + install", qty: 32, unit: "sf", price: 28 },
      { name: "Plumbing rough + finish", qty: 1, unit: "lot", price: 4200 },
      { name: "Electrical rough + finish", qty: 1, unit: "lot", price: 3600 },
      { name: "Appliance install", qty: 1, unit: "lot", price: 1200 },
      { name: "Painting (kitchen + adj. dining)", qty: 1, unit: "lot", price: 2400 },
      { name: "Project management", qty: 1, unit: "lot", price: 4800 },
    ],
    notes: "Excludes flooring, structural changes, and appliance cost. 50% deposit, 40% midpoint, 10% completion.",
    uses: 142, starred: true,
  },
  {
    id: "e2", name: "Primary bath — full gut", category: "Bath",
    description: "100 sqft primary bath with tile shower, freestanding tub, double vanity.",
    projectType: "Bath", markup: 25,
    lines: [
      { name: "Demo & disposal", qty: 1, unit: "lot", price: 2800 },
      { name: "Plumbing reroute + finish", qty: 1, unit: "lot", price: 5400 },
      { name: "Curbless shower assembly + waterproofing", qty: 1, unit: "lot", price: 4200 },
      { name: "Floor + wall tile install", qty: 220, unit: "sf", price: 18 },
      { name: "Double vanity install", qty: 1, unit: "ea", price: 1800 },
      { name: "Freestanding tub install", qty: 1, unit: "ea", price: 1400 },
      { name: "Heated floor mat + thermostat", qty: 1, unit: "lot", price: 1800 },
      { name: "Project management", qty: 1, unit: "lot", price: 3600 },
    ],
    notes: "Tile and fixtures supplied by owner. 14-week lead time on vanity.",
    uses: 88, starred: false,
  },
  {
    id: "e3", name: "Single-story addition — 400 sqft", category: "Addition",
    description: "400 sqft slab-on-grade addition, framed, dried-in, finished.",
    projectType: "Addition", markup: 20,
    lines: [
      { name: "Site prep + foundation", qty: 1, unit: "lot", price: 28000 },
      { name: "Framing + sheathing", qty: 400, unit: "sf", price: 38 },
      { name: "Roofing + flashing", qty: 1, unit: "lot", price: 9200 },
      { name: "Windows + exterior doors", qty: 1, unit: "lot", price: 7400 },
      { name: "MEP rough", qty: 1, unit: "lot", price: 14800 },
      { name: "Insulation + drywall", qty: 400, unit: "sf", price: 14 },
      { name: "Interior finish + paint", qty: 1, unit: "lot", price: 12400 },
      { name: "Permits + inspections", qty: 1, unit: "lot", price: 3800 },
      { name: "Project management", qty: 1, unit: "lot", price: 14000 },
    ],
    notes: "Excludes flooring and HVAC equipment. 12–14 week schedule from permit.",
    uses: 31, starred: false,
  },
  {
    id: "e4", name: "Deck — 320 sqft composite", category: "Outdoor",
    description: "Pressure-treated frame with composite decking, aluminum railing, and stairs.",
    projectType: "Deck", markup: 22,
    lines: [
      { name: "Permits + design", qty: 1, unit: "lot", price: 1200 },
      { name: "Footings + posts", qty: 8, unit: "ea", price: 320 },
      { name: "Pressure-treated framing", qty: 320, unit: "sf", price: 18 },
      { name: "Composite decking + fasteners", qty: 320, unit: "sf", price: 22 },
      { name: "Aluminum railing system", qty: 56, unit: "lf", price: 78 },
      { name: "Stairs (4 risers) + landing", qty: 1, unit: "lot", price: 2400 },
      { name: "Project management", qty: 1, unit: "lot", price: 2800 },
    ],
    notes: "Excludes lighting, gas line, and demo of existing deck. 3–4 week schedule.",
    uses: 54, starred: false,
  },
  {
    id: "e5", name: "Roof replacement — asphalt shingle", category: "Roofing",
    description: "Tear-off and re-roof up to 24 squares with architectural shingles.",
    projectType: "Roofing", markup: 18,
    lines: [
      { name: "Tear-off + dump fees", qty: 24, unit: "sq", price: 95 },
      { name: "Underlayment + ice & water shield", qty: 24, unit: "sq", price: 65 },
      { name: "Architectural shingles + install", qty: 24, unit: "sq", price: 380 },
      { name: "Drip edge + flashing", qty: 1, unit: "lot", price: 1200 },
      { name: "Ridge vent (continuous)", qty: 42, unit: "lf", price: 14 },
      { name: "Pipe boots + step flashing", qty: 1, unit: "lot", price: 600 },
      { name: "Project management", qty: 1, unit: "lot", price: 1800 },
    ],
    notes: "Includes 30-year manufacturer warranty + 5-year workmanship. Excludes deck repair beyond 2 sheets.",
    uses: 76, starred: true,
  },
  {
    id: "e6", name: "Basement finish — 800 sqft", category: "Basement",
    description: "Open-plan basement with bedroom, full bath, and rec room.",
    projectType: "Basement", markup: 22,
    lines: [
      { name: "Framing + insulation", qty: 800, unit: "sf", price: 16 },
      { name: "Egress window + cut", qty: 1, unit: "ea", price: 4200 },
      { name: "Plumbing rough + finish (bath)", qty: 1, unit: "lot", price: 6800 },
      { name: "Electrical rough + finish", qty: 1, unit: "lot", price: 5200 },
      { name: "HVAC supply + return", qty: 1, unit: "lot", price: 3800 },
      { name: "Drywall + paint", qty: 800, unit: "sf", price: 9 },
      { name: "LVP flooring + base", qty: 800, unit: "sf", price: 7 },
      { name: "Bath tile + fixtures install", qty: 1, unit: "lot", price: 4400 },
      { name: "Project management", qty: 1, unit: "lot", price: 6400 },
    ],
    notes: "Excludes vanity, fixtures, and flooring material upgrades. 8–10 week schedule.",
    uses: 41, starred: false,
  },
  {
    id: "e7", name: "Whole-home interior repaint", category: "Painting",
    description: "2,400 sqft home — walls, ceilings, trim, and doors.",
    projectType: "Painting", markup: 15,
    lines: [
      { name: "Surface prep + patching", qty: 1, unit: "lot", price: 2400 },
      { name: "Walls — 2 coats", qty: 2400, unit: "sf", price: 2.6 },
      { name: "Ceilings — flat white", qty: 2400, unit: "sf", price: 1.4 },
      { name: "Trim + baseboards", qty: 1100, unit: "lf", price: 3.2 },
      { name: "Interior doors (paint both sides)", qty: 14, unit: "ea", price: 110 },
      { name: "Mask, drop, cleanup", qty: 1, unit: "lot", price: 1200 },
      { name: "Project management", qty: 1, unit: "lot", price: 1600 },
    ],
    notes: "Owner selects colors from supplier deck. 5–7 working days, occupied home.",
    uses: 112, starred: false,
  },
];

export function estimateTemplateSubtotal(t: SharedEstimateTemplate): number {
  return t.lines.reduce((s, l) => s + l.qty * l.price, 0);
}

export function estimateTemplateTotal(t: SharedEstimateTemplate): number {
  return Math.round(estimateTemplateSubtotal(t) * (1 + t.markup / 100));
}
