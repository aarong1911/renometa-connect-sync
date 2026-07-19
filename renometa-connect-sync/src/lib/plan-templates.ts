// Shared project plan templates used by /settings/templates and the
// "Apply plan template" action on a Project's Schedule tab.

export type PlanTask = { name: string; phase: string; days: number; trade?: string };

export type SharedPlanTemplate = {
  id: string;
  name: string;
  category: string;
  description: string;
  projectType: string;
  durationDays: number;
  tasks: PlanTask[];
  uses: number;
  starred: boolean;
};

export const planTemplates: SharedPlanTemplate[] = [
  {
    id: "p1", name: "Kitchen remodel — 8 week", category: "Kitchen",
    description: "Standard kitchen with semi-custom cabinets.",
    projectType: "Kitchen", durationDays: 56, uses: 67, starred: true,
    tasks: [
      { name: "Pre-construction meeting", phase: "Pre-con", days: 1 },
      { name: "Order cabinets + countertops", phase: "Pre-con", days: 1 },
      { name: "Demo & disposal", phase: "Demo", days: 2, trade: "Labor" },
      { name: "Plumbing rough", phase: "Rough-in", days: 2, trade: "Plumbing" },
      { name: "Electrical rough", phase: "Rough-in", days: 2, trade: "Electrical" },
      { name: "Drywall + paint prep", phase: "Finish prep", days: 4, trade: "Drywall" },
      { name: "Cabinet install", phase: "Install", days: 3, trade: "Carpentry" },
      { name: "Countertop template + install", phase: "Install", days: 7 },
      { name: "Backsplash tile", phase: "Finish", days: 2, trade: "Tile" },
      { name: "Plumbing + electrical finish", phase: "Finish", days: 2 },
      { name: "Appliance install", phase: "Finish", days: 1 },
      { name: "Punch list + walkthrough", phase: "Closeout", days: 2 },
    ],
  },
  {
    id: "p2", name: "Bathroom remodel — 4 week", category: "Bath",
    description: "Hall bath with tub-to-shower conversion.",
    projectType: "Bath", durationDays: 28, uses: 48, starred: false,
    tasks: [
      { name: "Demo & disposal", phase: "Demo", days: 1, trade: "Labor" },
      { name: "Plumbing reroute", phase: "Rough-in", days: 2, trade: "Plumbing" },
      { name: "Electrical updates", phase: "Rough-in", days: 1, trade: "Electrical" },
      { name: "Shower pan + waterproofing", phase: "Rough-in", days: 2, trade: "Tile" },
      { name: "Drywall + skim", phase: "Finish prep", days: 3, trade: "Drywall" },
      { name: "Tile install", phase: "Finish", days: 5, trade: "Tile" },
      { name: "Vanity + fixtures install", phase: "Finish", days: 2, trade: "Plumbing" },
      { name: "Paint + trim", phase: "Finish", days: 2 },
      { name: "Punch list", phase: "Closeout", days: 1 },
    ],
  },
  {
    id: "p3", name: "Whole home — 16 week", category: "Whole Home",
    description: "Full interior renovation, staying in scope.",
    projectType: "Whole Home", durationDays: 112, uses: 12, starred: false,
    tasks: [
      { name: "Pre-construction & permitting", phase: "Pre-con", days: 14 },
      { name: "Demo (all rooms)", phase: "Demo", days: 7 },
      { name: "Structural framing changes", phase: "Frame", days: 10, trade: "Carpentry" },
      { name: "MEP rough (all trades)", phase: "Rough-in", days: 14 },
      { name: "Insulation + drywall", phase: "Finish prep", days: 12, trade: "Drywall" },
      { name: "Flooring install", phase: "Finish", days: 8, trade: "Flooring" },
      { name: "Cabinetry + millwork", phase: "Finish", days: 10, trade: "Carpentry" },
      { name: "Tile + stone", phase: "Finish", days: 12, trade: "Tile" },
      { name: "Paint + trim", phase: "Finish", days: 10 },
      { name: "MEP finish + appliances", phase: "Finish", days: 8 },
      { name: "Final inspections + punch", phase: "Closeout", days: 7 },
    ],
  },
  {
    id: "p4", name: "Single-story addition — 14 week", category: "Addition",
    description: "400 sqft slab-on-grade addition from permit to closeout.",
    projectType: "Addition", durationDays: 98, uses: 22, starred: false,
    tasks: [
      { name: "Permits + survey", phase: "Pre-con", days: 14 },
      { name: "Excavation + footings", phase: "Site", days: 5, trade: "Excavation" },
      { name: "Foundation + slab pour", phase: "Site", days: 6, trade: "Concrete" },
      { name: "Framing + sheathing", phase: "Frame", days: 10, trade: "Carpentry" },
      { name: "Roofing + flashing", phase: "Frame", days: 4, trade: "Roofing" },
      { name: "Windows + exterior doors", phase: "Frame", days: 3, trade: "Carpentry" },
      { name: "MEP rough (all trades)", phase: "Rough-in", days: 10 },
      { name: "Insulation + drywall", phase: "Finish prep", days: 8, trade: "Drywall" },
      { name: "Interior finish + paint", phase: "Finish", days: 14 },
      { name: "MEP finish", phase: "Finish", days: 6 },
      { name: "Siding + exterior trim", phase: "Exterior", days: 8, trade: "Siding" },
      { name: "Final inspections + punch", phase: "Closeout", days: 10 },
    ],
  },
  {
    id: "p5", name: "Composite deck — 3 week", category: "Outdoor",
    description: "320 sqft composite deck with railing and stairs.",
    projectType: "Deck", durationDays: 18, uses: 38, starred: false,
    tasks: [
      { name: "Permits + design sign-off", phase: "Pre-con", days: 4 },
      { name: "Layout + footing dig", phase: "Site", days: 2, trade: "Labor" },
      { name: "Footings poured + cured", phase: "Site", days: 3, trade: "Concrete" },
      { name: "Posts + framing", phase: "Frame", days: 3, trade: "Carpentry" },
      { name: "Composite deck boards", phase: "Install", days: 2, trade: "Carpentry" },
      { name: "Railing system", phase: "Install", days: 1 },
      { name: "Stairs + landing", phase: "Install", days: 2, trade: "Carpentry" },
      { name: "Final inspection + walkthrough", phase: "Closeout", days: 1 },
    ],
  },
  {
    id: "p6", name: "Roof replacement — 1 week", category: "Roofing",
    description: "Tear-off and re-roof, 24 squares architectural shingle.",
    projectType: "Roofing", durationDays: 5, uses: 61, starred: true,
    tasks: [
      { name: "Material delivery + site prep", phase: "Pre-con", days: 1 },
      { name: "Tear-off + dump", phase: "Demo", days: 1, trade: "Roofing" },
      { name: "Deck inspection + repair", phase: "Frame", days: 1, trade: "Carpentry" },
      { name: "Underlayment + flashing", phase: "Install", days: 1, trade: "Roofing" },
      { name: "Shingle install + ridge vent", phase: "Install", days: 1, trade: "Roofing" },
    ],
  },
  {
    id: "p7", name: "Basement finish — 9 week", category: "Basement",
    description: "800 sqft basement with bedroom, full bath, and rec room.",
    projectType: "Basement", durationDays: 60, uses: 19, starred: false,
    tasks: [
      { name: "Permits + layout", phase: "Pre-con", days: 7 },
      { name: "Egress window cut + install", phase: "Site", days: 3 },
      { name: "Framing + insulation", phase: "Frame", days: 7, trade: "Carpentry" },
      { name: "Plumbing rough (bath)", phase: "Rough-in", days: 3, trade: "Plumbing" },
      { name: "Electrical rough", phase: "Rough-in", days: 3, trade: "Electrical" },
      { name: "HVAC supply + return", phase: "Rough-in", days: 2, trade: "HVAC" },
      { name: "Inspections — rough", phase: "Rough-in", days: 1 },
      { name: "Drywall + paint", phase: "Finish prep", days: 8, trade: "Drywall" },
      { name: "Bath tile + fixtures", phase: "Finish", days: 5, trade: "Tile" },
      { name: "LVP flooring + base", phase: "Finish", days: 4, trade: "Flooring" },
      { name: "Trim + interior doors", phase: "Finish", days: 4, trade: "Carpentry" },
      { name: "MEP finish", phase: "Finish", days: 3 },
      { name: "Final inspections + punch", phase: "Closeout", days: 10 },
    ],
  },
  {
    id: "p8", name: "Whole-home repaint — 1 week", category: "Painting",
    description: "2,400 sqft interior repaint, occupied home.",
    projectType: "Painting", durationDays: 6, uses: 84, starred: false,
    tasks: [
      { name: "Walkthrough + color confirm", phase: "Pre-con", days: 1 },
      { name: "Surface prep + patching", phase: "Prep", days: 1, trade: "Painting" },
      { name: "Mask + drop cloths", phase: "Prep", days: 1, trade: "Painting" },
      { name: "Ceilings + walls — coat 1", phase: "Paint", days: 1, trade: "Painting" },
      { name: "Walls — coat 2 + trim", phase: "Paint", days: 1, trade: "Painting" },
      { name: "Touch-ups + cleanup", phase: "Closeout", days: 1 },
    ],
  },
];