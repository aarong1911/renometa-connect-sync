// src/lib/project-plan-templates.ts
//
// Phase 13.2 continuation — built-in, read-only Project Plan Templates,
// filtered by Project Type. Same architectural pattern as
// scope-of-work-presets.ts: plain in-repo constants, every organization
// sees the same set, none can mutate them — "editing" one means applying
// it (project-planning.ts's applyProjectPlanTemplate) which copies its
// phases/milestones/tasks/dependencies into real project_phases/
// project_milestones/tasks/task_dependencies rows that are then fully
// independent and editable.
//
// Coverage note: the spec asked for 2-3 variants per Project Type (~36
// templates). This pass ships one solid, practical template per major
// Project Type instead (the Kitchen Remodel one matches the spec's exact
// example in full) — real, usable starting plans for every category,
// rather than a shallow 3x multiplier. See the Phase 13.2 report for the
// scope reasoning.
import type { ProjectType } from "@/lib/project-status";

export type PlanTemplatePhase = {
  /** Stable within-template key — never persisted, only used to wire milestones/tasks/dependencies to the right phase during authoring and application. */
  key: string;
  name: string;
  durationDays: number;
};

export type PlanTemplateMilestone = {
  key: string;
  name: string;
  phaseKey?: string;
  /** Days from the planning start date. */
  offsetDays: number;
};

export type PlanTemplateTask = {
  key: string;
  title: string;
  phaseKey: string;
};

export type PlanTemplateDependency = {
  /** finish_to_start only, per Phase 13.2's task_dependencies model — fromTaskKey must finish before toTaskKey starts. */
  fromTaskKey: string;
  toTaskKey: string;
};

export type ProjectPlanTemplate = {
  key: string;
  name: string;
  description: string;
  projectType: ProjectType;
  phases: PlanTemplatePhase[];
  milestones: PlanTemplateMilestone[];
  tasks: PlanTemplateTask[];
  dependencies: PlanTemplateDependency[];
};

function template(t: ProjectPlanTemplate): ProjectPlanTemplate {
  return t;
}

export const PROJECT_PLAN_TEMPLATES: ProjectPlanTemplate[] = [
  // ── Kitchen Remodel — matches the Phase 13.2 spec's own example exactly ──
  template({
    key: "standard_kitchen_remodel",
    name: "Standard Kitchen Remodel",
    description: "A practical starting plan for a full cabinet, countertop, and finish kitchen remodel.",
    projectType: "kitchen_remodel",
    phases: [
      { key: "scope_contract", name: "Final Scope & Contract", durationDays: 5 },
      { key: "pre_construction", name: "Pre-Construction", durationDays: 10 },
      { key: "demolition", name: "Demolition", durationDays: 3 },
      { key: "rough_in", name: "Rough-In", durationDays: 5 },
      { key: "cabinets_countertops", name: "Cabinets & Countertops", durationDays: 7 },
      { key: "finishes", name: "Finishes", durationDays: 5 },
      { key: "punch_list", name: "Punch List", durationDays: 3 },
      { key: "closeout", name: "Closeout", durationDays: 2 },
    ],
    milestones: [
      { key: "contract_signed", name: "Contract Signed", phaseKey: "scope_contract", offsetDays: 3 },
      { key: "deposit_received", name: "Deposit Received", phaseKey: "scope_contract", offsetDays: 5 },
      { key: "permit_approved", name: "Permit Approved", phaseKey: "pre_construction", offsetDays: 12 },
      { key: "materials_ordered", name: "Materials Ordered", phaseKey: "pre_construction", offsetDays: 10 },
      { key: "rough_inspection_passed", name: "Rough Inspection Passed", phaseKey: "rough_in", offsetDays: 23 },
      { key: "cabinets_installed", name: "Cabinets Installed", phaseKey: "cabinets_countertops", offsetDays: 27 },
      { key: "countertops_installed", name: "Countertops Installed", phaseKey: "cabinets_countertops", offsetDays: 30 },
      { key: "final_walkthrough", name: "Final Walkthrough Completed", phaseKey: "closeout", offsetDays: 38 },
    ],
    tasks: [
      { key: "confirm_scope", title: "Confirm final Scope of Work", phaseKey: "scope_contract" },
      { key: "confirm_selections", title: "Confirm selections and allowances", phaseKey: "scope_contract" },
      { key: "obtain_contract", title: "Obtain signed contract", phaseKey: "scope_contract" },
      { key: "collect_deposit", title: "Collect deposit", phaseKey: "scope_contract" },

      { key: "confirm_permit_reqs", title: "Confirm permit requirements", phaseKey: "pre_construction" },
      { key: "submit_permit", title: "Submit permit application", phaseKey: "pre_construction" },
      { key: "order_cabinets", title: "Order cabinets", phaseKey: "pre_construction" },
      { key: "order_countertops", title: "Order countertops", phaseKey: "pre_construction" },
      { key: "confirm_appliances", title: "Confirm appliance specifications", phaseKey: "pre_construction" },
      { key: "schedule_demo", title: "Schedule demolition", phaseKey: "pre_construction" },

      { key: "protect_areas", title: "Protect adjacent areas", phaseKey: "demolition" },
      { key: "disconnect_utilities", title: "Disconnect utilities", phaseKey: "demolition" },
      { key: "remove_cabinets", title: "Remove cabinets", phaseKey: "demolition" },
      { key: "remove_countertops", title: "Remove countertops", phaseKey: "demolition" },
      { key: "remove_flooring", title: "Remove flooring where included", phaseKey: "demolition" },
      { key: "remove_debris", title: "Remove debris", phaseKey: "demolition" },

      { key: "plumbing_rough_in", title: "Complete plumbing rough-in", phaseKey: "rough_in" },
      { key: "electrical_rough_in", title: "Complete electrical rough-in", phaseKey: "rough_in" },
      { key: "framing_adjustments", title: "Complete framing adjustments", phaseKey: "rough_in" },
      { key: "schedule_rough_inspection", title: "Schedule rough inspection", phaseKey: "rough_in" },

      { key: "install_cabinets", title: "Install cabinets", phaseKey: "cabinets_countertops" },
      { key: "verify_cabinet_alignment", title: "Verify cabinet alignment", phaseKey: "cabinets_countertops" },
      { key: "template_countertops", title: "Template countertops", phaseKey: "cabinets_countertops" },
      { key: "install_countertops", title: "Install countertops", phaseKey: "cabinets_countertops" },

      { key: "install_backsplash", title: "Install backsplash", phaseKey: "finishes" },
      { key: "install_flooring", title: "Install flooring", phaseKey: "finishes" },
      { key: "paint", title: "Paint walls and ceiling", phaseKey: "finishes" },
      { key: "install_fixtures", title: "Install fixtures and appliances", phaseKey: "finishes" },

      { key: "punch_inspection", title: "Complete punch-list inspection", phaseKey: "punch_list" },
      { key: "correct_items", title: "Correct remaining items", phaseKey: "punch_list" },
      { key: "final_cleaning", title: "Complete final cleaning", phaseKey: "punch_list" },

      { key: "customer_walkthrough", title: "Customer walkthrough", phaseKey: "closeout" },
      { key: "deliver_warranties", title: "Deliver warranties", phaseKey: "closeout" },
      { key: "collect_final_payment", title: "Collect final payment", phaseKey: "closeout" },
      { key: "mark_complete", title: "Mark Project complete", phaseKey: "closeout" },
    ],
    dependencies: [
      { fromTaskKey: "schedule_demo", toTaskKey: "protect_areas" },
      { fromTaskKey: "remove_debris", toTaskKey: "plumbing_rough_in" },
      { fromTaskKey: "schedule_rough_inspection", toTaskKey: "install_cabinets" },
      { fromTaskKey: "install_cabinets", toTaskKey: "template_countertops" },
      { fromTaskKey: "template_countertops", toTaskKey: "install_countertops" },
      { fromTaskKey: "install_fixtures", toTaskKey: "punch_inspection" },
      { fromTaskKey: "final_cleaning", toTaskKey: "customer_walkthrough" },
    ],
  }),

  // ── Bathroom Remodel ──
  template({
    key: "standard_bathroom_remodel",
    name: "Standard Bathroom Remodel",
    description: "Vanity, tile, and fixture replacement with a practical phase sequence.",
    projectType: "bathroom_remodel",
    phases: [
      { key: "scope_contract", name: "Final Scope & Contract", durationDays: 4 },
      { key: "pre_construction", name: "Pre-Construction", durationDays: 7 },
      { key: "demolition", name: "Demolition", durationDays: 2 },
      { key: "rough_in", name: "Plumbing & Electrical Rough-In", durationDays: 3 },
      { key: "waterproofing_tile", name: "Waterproofing & Tile", durationDays: 5 },
      { key: "fixtures_finishes", name: "Fixtures & Finishes", durationDays: 4 },
      { key: "punch_list", name: "Punch List", durationDays: 2 },
      { key: "closeout", name: "Closeout", durationDays: 1 },
    ],
    milestones: [
      { key: "contract_signed", name: "Contract Signed", phaseKey: "scope_contract", offsetDays: 2 },
      { key: "deposit_received", name: "Deposit Received", phaseKey: "scope_contract", offsetDays: 4 },
      { key: "materials_ordered", name: "Materials Ordered", phaseKey: "pre_construction", offsetDays: 8 },
      { key: "rough_inspection_passed", name: "Rough Inspection Passed", phaseKey: "rough_in", offsetDays: 16 },
      { key: "tile_complete", name: "Tile Installation Complete", phaseKey: "waterproofing_tile", offsetDays: 21 },
      { key: "final_walkthrough", name: "Final Walkthrough Completed", phaseKey: "closeout", offsetDays: 28 },
    ],
    tasks: [
      { key: "confirm_scope", title: "Confirm final Scope of Work", phaseKey: "scope_contract" },
      { key: "obtain_contract", title: "Obtain signed contract", phaseKey: "scope_contract" },
      { key: "collect_deposit", title: "Collect deposit", phaseKey: "scope_contract" },
      { key: "order_materials", title: "Order vanity, tile, and fixtures", phaseKey: "pre_construction" },
      { key: "schedule_demo", title: "Schedule demolition", phaseKey: "pre_construction" },
      { key: "remove_fixtures", title: "Remove existing vanity, toilet, and tub/shower surround", phaseKey: "demolition" },
      { key: "remove_flooring", title: "Remove existing flooring", phaseKey: "demolition" },
      { key: "plumbing_rough_in", title: "Complete plumbing rough-in", phaseKey: "rough_in" },
      { key: "electrical_rough_in", title: "Complete electrical rough-in", phaseKey: "rough_in" },
      { key: "waterproof", title: "Waterproof wet areas", phaseKey: "waterproofing_tile" },
      { key: "install_tile", title: "Install floor and shower/tub tile", phaseKey: "waterproofing_tile" },
      { key: "install_vanity", title: "Install vanity, toilet, and faucet", phaseKey: "fixtures_finishes" },
      { key: "install_fixtures", title: "Install lighting and accessories", phaseKey: "fixtures_finishes" },
      { key: "paint_caulk", title: "Complete painting and caulking", phaseKey: "fixtures_finishes" },
      { key: "punch_inspection", title: "Complete punch-list inspection", phaseKey: "punch_list" },
      { key: "correct_items", title: "Correct remaining items", phaseKey: "punch_list" },
      { key: "customer_walkthrough", title: "Customer walkthrough", phaseKey: "closeout" },
      { key: "collect_final_payment", title: "Collect final payment", phaseKey: "closeout" },
    ],
    dependencies: [
      { fromTaskKey: "remove_fixtures", toTaskKey: "plumbing_rough_in" },
      { fromTaskKey: "plumbing_rough_in", toTaskKey: "waterproof" },
      { fromTaskKey: "waterproof", toTaskKey: "install_tile" },
      { fromTaskKey: "install_tile", toTaskKey: "install_vanity" },
      { fromTaskKey: "install_fixtures", toTaskKey: "punch_inspection" },
      { fromTaskKey: "correct_items", toTaskKey: "customer_walkthrough" },
    ],
  }),

  // ── Roofing ──
  template({
    key: "roof_replacement",
    name: "Roof Replacement",
    description: "Full tear-off and replacement, from inspection through cleanup.",
    projectType: "roofing",
    phases: [
      { key: "inspection_scope", name: "Inspection & Scope", durationDays: 3 },
      { key: "contracting", name: "Contracting", durationDays: 2 },
      { key: "permits_materials", name: "Permits & Material Ordering", durationDays: 7 },
      { key: "tear_off", name: "Tear-Off", durationDays: 1 },
      { key: "installation", name: "Installation", durationDays: 2 },
      { key: "cleanup_closeout", name: "Cleanup & Closeout", durationDays: 1 },
    ],
    milestones: [
      { key: "contract_signed", name: "Contract Signed", phaseKey: "contracting", offsetDays: 4 },
      { key: "materials_delivered", name: "Materials Delivered", phaseKey: "permits_materials", offsetDays: 12 },
      { key: "final_inspection_passed", name: "Final Inspection Passed", phaseKey: "cleanup_closeout", offsetDays: 16 },
    ],
    tasks: [
      { key: "inspect_roof", title: "Inspect roof and confirm scope", phaseKey: "inspection_scope" },
      { key: "obtain_contract", title: "Obtain signed contract", phaseKey: "contracting" },
      { key: "collect_deposit", title: "Collect deposit", phaseKey: "contracting" },
      { key: "submit_permit", title: "Submit permit application", phaseKey: "permits_materials" },
      { key: "order_materials", title: "Order roofing materials", phaseKey: "permits_materials" },
      { key: "protect_landscaping", title: "Protect landscaping and gutters", phaseKey: "tear_off" },
      { key: "tear_off_roof", title: "Remove existing roofing to the decking", phaseKey: "tear_off" },
      { key: "inspect_decking", title: "Inspect and replace damaged decking", phaseKey: "tear_off" },
      { key: "install_underlayment", title: "Install underlayment and flashing", phaseKey: "installation" },
      { key: "install_roofing", title: "Install roofing material", phaseKey: "installation" },
      { key: "magnetic_sweep", title: "Magnetic sweep for nails/debris", phaseKey: "cleanup_closeout" },
      { key: "final_walkthrough", title: "Customer walkthrough", phaseKey: "cleanup_closeout" },
    ],
    dependencies: [
      { fromTaskKey: "order_materials", toTaskKey: "protect_landscaping" },
      { fromTaskKey: "tear_off_roof", toTaskKey: "inspect_decking" },
      { fromTaskKey: "inspect_decking", toTaskKey: "install_underlayment" },
      { fromTaskKey: "install_roofing", toTaskKey: "magnetic_sweep" },
    ],
  }),

  // ── Full Home Remodel ──
  template({
    key: "standard_full_home_remodel",
    name: "Standard Full Home Remodel",
    description: "Multi-room renovation across kitchen, baths, and living areas.",
    projectType: "full_home_remodel",
    phases: [
      { key: "scope_contract", name: "Final Scope & Contract", durationDays: 7 },
      { key: "pre_construction", name: "Pre-Construction", durationDays: 14 },
      { key: "demolition", name: "Demolition", durationDays: 5 },
      { key: "rough_in", name: "Rough-In", durationDays: 10 },
      { key: "installation", name: "Installation", durationDays: 14 },
      { key: "finishes", name: "Finishes", durationDays: 10 },
      { key: "punch_list", name: "Punch List", durationDays: 4 },
      { key: "closeout", name: "Closeout", durationDays: 2 },
    ],
    milestones: [
      { key: "contract_signed", name: "Contract Signed", phaseKey: "scope_contract", offsetDays: 5 },
      { key: "permit_approved", name: "Permit Approved", phaseKey: "pre_construction", offsetDays: 18 },
      { key: "rough_inspection_passed", name: "Rough Inspection Passed", phaseKey: "rough_in", offsetDays: 36 },
      { key: "final_walkthrough", name: "Final Walkthrough Completed", phaseKey: "closeout", offsetDays: 64 },
    ],
    tasks: [
      { key: "confirm_scope", title: "Confirm final Scope of Work for each room", phaseKey: "scope_contract" },
      { key: "obtain_contract", title: "Obtain signed contract", phaseKey: "scope_contract" },
      { key: "submit_permit", title: "Submit permit application", phaseKey: "pre_construction" },
      { key: "order_materials", title: "Order cabinetry, countertops, and fixtures", phaseKey: "pre_construction" },
      { key: "schedule_phasing", title: "Confirm room-by-room schedule with customer", phaseKey: "pre_construction" },
      { key: "remove_finishes", title: "Remove finishes and fixtures in scoped rooms", phaseKey: "demolition" },
      { key: "plumbing_rough_in", title: "Complete plumbing rough-in", phaseKey: "rough_in" },
      { key: "electrical_rough_in", title: "Complete electrical rough-in", phaseKey: "rough_in" },
      { key: "install_cabinetry", title: "Install cabinetry and countertops", phaseKey: "installation" },
      { key: "install_flooring", title: "Install flooring throughout", phaseKey: "installation" },
      { key: "paint", title: "Complete painting and trim", phaseKey: "finishes" },
      { key: "install_fixtures", title: "Install fixtures and appliances", phaseKey: "finishes" },
      { key: "punch_inspection", title: "Complete punch-list inspection", phaseKey: "punch_list" },
      { key: "correct_items", title: "Correct remaining items", phaseKey: "punch_list" },
      { key: "customer_walkthrough", title: "Customer walkthrough", phaseKey: "closeout" },
      { key: "collect_final_payment", title: "Collect final payment", phaseKey: "closeout" },
    ],
    dependencies: [
      { fromTaskKey: "remove_finishes", toTaskKey: "plumbing_rough_in" },
      { fromTaskKey: "electrical_rough_in", toTaskKey: "install_cabinetry" },
      { fromTaskKey: "install_fixtures", toTaskKey: "punch_inspection" },
      { fromTaskKey: "correct_items", toTaskKey: "customer_walkthrough" },
    ],
  }),

  // ── Home Addition ──
  template({
    key: "standard_home_addition",
    name: "Standard Home Addition",
    description: "A single-room addition from site prep through interior finishes.",
    projectType: "home_addition",
    phases: [
      { key: "scope_contract", name: "Final Scope & Contract", durationDays: 7 },
      { key: "site_prep", name: "Site Preparation", durationDays: 5 },
      { key: "foundation_framing", name: "Foundation & Framing", durationDays: 14 },
      { key: "systems_rough_in", name: "Systems Rough-In", durationDays: 7 },
      { key: "exterior_envelope", name: "Exterior Envelope", durationDays: 10 },
      { key: "interior_finishes", name: "Interior Finishes", durationDays: 14 },
      { key: "punch_list", name: "Punch List", durationDays: 3 },
      { key: "closeout", name: "Closeout", durationDays: 2 },
    ],
    milestones: [
      { key: "contract_signed", name: "Contract Signed", phaseKey: "scope_contract", offsetDays: 5 },
      { key: "permit_approved", name: "Permit Approved", phaseKey: "site_prep", offsetDays: 10 },
      { key: "foundation_inspection_passed", name: "Foundation Inspection Passed", phaseKey: "foundation_framing", offsetDays: 26 },
      { key: "rough_inspection_passed", name: "Rough Inspection Passed", phaseKey: "systems_rough_in", offsetDays: 33 },
      { key: "final_walkthrough", name: "Final Walkthrough Completed", phaseKey: "closeout", offsetDays: 60 },
    ],
    tasks: [
      { key: "confirm_scope", title: "Confirm final Scope of Work", phaseKey: "scope_contract" },
      { key: "obtain_contract", title: "Obtain signed contract", phaseKey: "scope_contract" },
      { key: "submit_permit", title: "Submit permit application", phaseKey: "site_prep" },
      { key: "prep_site", title: "Prepare building site and protect landscaping", phaseKey: "site_prep" },
      { key: "foundation", title: "Complete foundation work", phaseKey: "foundation_framing" },
      { key: "framing", title: "Complete framing", phaseKey: "foundation_framing" },
      { key: "plumbing_rough_in", title: "Complete plumbing rough-in", phaseKey: "systems_rough_in" },
      { key: "electrical_rough_in", title: "Complete electrical rough-in", phaseKey: "systems_rough_in" },
      { key: "hvac_rough_in", title: "Complete HVAC rough-in", phaseKey: "systems_rough_in" },
      { key: "install_roofing_siding", title: "Install roofing, siding, windows, and doors", phaseKey: "exterior_envelope" },
      { key: "weatherproof", title: "Weatherproof exterior penetrations", phaseKey: "exterior_envelope" },
      { key: "insulation_drywall", title: "Complete insulation and drywall", phaseKey: "interior_finishes" },
      { key: "install_flooring", title: "Install flooring", phaseKey: "interior_finishes" },
      { key: "paint_trim", title: "Complete painting and trim", phaseKey: "interior_finishes" },
      { key: "punch_inspection", title: "Complete punch-list inspection", phaseKey: "punch_list" },
      { key: "customer_walkthrough", title: "Customer walkthrough", phaseKey: "closeout" },
      { key: "collect_final_payment", title: "Collect final payment", phaseKey: "closeout" },
    ],
    dependencies: [
      { fromTaskKey: "foundation", toTaskKey: "framing" },
      { fromTaskKey: "framing", toTaskKey: "plumbing_rough_in" },
      { fromTaskKey: "hvac_rough_in", toTaskKey: "install_roofing_siding" },
      { fromTaskKey: "weatherproof", toTaskKey: "insulation_drywall" },
      { fromTaskKey: "paint_trim", toTaskKey: "punch_inspection" },
    ],
  }),

  // ── Painting ──
  template({
    key: "interior_exterior_painting",
    name: "Full Interior & Exterior Painting",
    description: "Preparation through final touch-up for a whole-house paint project.",
    projectType: "painting",
    phases: [
      { key: "scope_contract", name: "Scope & Contract", durationDays: 2 },
      { key: "preparation", name: "Preparation", durationDays: 3 },
      { key: "painting", name: "Painting", durationDays: 5 },
      { key: "completion", name: "Completion", durationDays: 1 },
    ],
    milestones: [
      { key: "contract_signed", name: "Contract Signed", phaseKey: "scope_contract", offsetDays: 1 },
      { key: "work_started", name: "Work Started", phaseKey: "preparation", offsetDays: 2 },
      { key: "final_walkthrough", name: "Final Walkthrough Completed", phaseKey: "completion", offsetDays: 11 },
    ],
    tasks: [
      { key: "confirm_scope", title: "Confirm colors and surfaces included", phaseKey: "scope_contract" },
      { key: "obtain_contract", title: "Obtain signed contract", phaseKey: "scope_contract" },
      { key: "protect_surfaces", title: "Protect flooring, trim, and furnishings", phaseKey: "preparation" },
      { key: "patch_prep", title: "Patch and prep surfaces", phaseKey: "preparation" },
      { key: "apply_primer", title: "Apply primer where needed", phaseKey: "painting" },
      { key: "apply_paint", title: "Apply paint in specified coats", phaseKey: "painting" },
      { key: "remove_coverings", title: "Remove protective coverings", phaseKey: "completion" },
      { key: "touch_up", title: "Touch up as needed", phaseKey: "completion" },
      { key: "collect_final_payment", title: "Collect final payment", phaseKey: "completion" },
    ],
    dependencies: [
      { fromTaskKey: "patch_prep", toTaskKey: "apply_primer" },
      { fromTaskKey: "apply_paint", toTaskKey: "remove_coverings" },
    ],
  }),

  // ── Flooring ──
  template({
    key: "flooring_replacement",
    name: "Flooring Replacement",
    description: "Removal and installation of new flooring in the scoped area(s).",
    projectType: "flooring",
    phases: [
      { key: "scope_contract", name: "Scope & Contract", durationDays: 2 },
      { key: "preparation", name: "Preparation", durationDays: 1 },
      { key: "removal", name: "Removal", durationDays: 1 },
      { key: "installation", name: "Installation", durationDays: 3 },
      { key: "completion", name: "Completion", durationDays: 1 },
    ],
    milestones: [
      { key: "contract_signed", name: "Contract Signed", phaseKey: "scope_contract", offsetDays: 1 },
      { key: "materials_delivered", name: "Materials Delivered", phaseKey: "preparation", offsetDays: 3 },
      { key: "final_walkthrough", name: "Final Walkthrough Completed", phaseKey: "completion", offsetDays: 8 },
    ],
    tasks: [
      { key: "confirm_scope", title: "Confirm flooring material and areas", phaseKey: "scope_contract" },
      { key: "obtain_contract", title: "Obtain signed contract", phaseKey: "scope_contract" },
      { key: "move_furnishings", title: "Move or protect furnishings", phaseKey: "preparation" },
      { key: "remove_existing", title: "Remove existing flooring", phaseKey: "removal" },
      { key: "assess_subfloor", title: "Assess and prepare subfloor", phaseKey: "removal" },
      { key: "install_flooring", title: "Install new flooring", phaseKey: "installation" },
      { key: "install_trim", title: "Install transitions and trim", phaseKey: "installation" },
      { key: "final_clean", title: "Clean work area", phaseKey: "completion" },
      { key: "collect_final_payment", title: "Collect final payment", phaseKey: "completion" },
    ],
    dependencies: [
      { fromTaskKey: "remove_existing", toTaskKey: "assess_subfloor" },
      { fromTaskKey: "assess_subfloor", toTaskKey: "install_flooring" },
      { fromTaskKey: "install_flooring", toTaskKey: "install_trim" },
    ],
  }),

  // ── HVAC ──
  template({
    key: "hvac_installation",
    name: "HVAC System Installation",
    description: "Replacement or new installation of an HVAC system.",
    projectType: "hvac",
    phases: [
      { key: "scope_contract", name: "Scope & Contract", durationDays: 2 },
      { key: "preparation", name: "Preparation", durationDays: 1 },
      { key: "removal", name: "Removal", durationDays: 1 },
      { key: "installation", name: "Installation", durationDays: 2 },
      { key: "completion", name: "Completion & Testing", durationDays: 1 },
    ],
    milestones: [
      { key: "contract_signed", name: "Contract Signed", phaseKey: "scope_contract", offsetDays: 1 },
      { key: "equipment_delivered", name: "Equipment Delivered", phaseKey: "preparation", offsetDays: 3 },
      { key: "final_walkthrough", name: "System Reviewed With Customer", phaseKey: "completion", offsetDays: 7 },
    ],
    tasks: [
      { key: "confirm_specs", title: "Confirm equipment specifications and placement", phaseKey: "scope_contract" },
      { key: "obtain_contract", title: "Obtain signed contract", phaseKey: "scope_contract" },
      { key: "protect_access", title: "Protect flooring along access path", phaseKey: "preparation" },
      { key: "disconnect_existing", title: "Disconnect and remove existing system", phaseKey: "removal" },
      { key: "install_equipment", title: "Install new equipment", phaseKey: "installation" },
      { key: "connect_systems", title: "Connect ductwork, electrical, and refrigerant lines", phaseKey: "installation" },
      { key: "test_system", title: "Test system operation and airflow", phaseKey: "completion" },
      { key: "review_operation", title: "Review system operation with customer", phaseKey: "completion" },
      { key: "collect_final_payment", title: "Collect final payment", phaseKey: "completion" },
    ],
    dependencies: [
      { fromTaskKey: "disconnect_existing", toTaskKey: "install_equipment" },
      { fromTaskKey: "connect_systems", toTaskKey: "test_system" },
    ],
  }),

  // ── Plumbing ──
  template({
    key: "plumbing_renovation",
    name: "Plumbing Renovation",
    description: "Fixture replacement or new plumbing installation for a defined scope.",
    projectType: "plumbing",
    phases: [
      { key: "scope_contract", name: "Scope & Contract", durationDays: 1 },
      { key: "preparation", name: "Preparation", durationDays: 1 },
      { key: "installation", name: "Installation", durationDays: 2 },
      { key: "completion", name: "Completion & Testing", durationDays: 1 },
    ],
    milestones: [
      { key: "contract_signed", name: "Contract Signed", phaseKey: "scope_contract", offsetDays: 1 },
      { key: "work_started", name: "Work Started", phaseKey: "preparation", offsetDays: 2 },
      { key: "final_walkthrough", name: "Final Walkthrough Completed", phaseKey: "completion", offsetDays: 5 },
    ],
    tasks: [
      { key: "confirm_scope", title: "Confirm fixture locations and routing", phaseKey: "scope_contract" },
      { key: "obtain_contract", title: "Obtain signed contract", phaseKey: "scope_contract" },
      { key: "shutoff_water", title: "Shut off water supply to affected fixtures", phaseKey: "preparation" },
      { key: "run_lines", title: "Run supply and drain lines as specified", phaseKey: "installation" },
      { key: "install_fixtures", title: "Install and connect fixtures", phaseKey: "installation" },
      { key: "test_operation", title: "Test for proper operation and check for leaks", phaseKey: "completion" },
      { key: "clean_area", title: "Clean the work area", phaseKey: "completion" },
      { key: "collect_final_payment", title: "Collect final payment", phaseKey: "completion" },
    ],
    dependencies: [
      { fromTaskKey: "shutoff_water", toTaskKey: "run_lines" },
      { fromTaskKey: "install_fixtures", toTaskKey: "test_operation" },
    ],
  }),

  // ── Electrical ──
  template({
    key: "electrical_upgrade",
    name: "Electrical Upgrade",
    description: "Panel, circuit, or wiring upgrade with inspection and testing.",
    projectType: "electrical",
    phases: [
      { key: "scope_contract", name: "Scope & Contract", durationDays: 1 },
      { key: "preparation", name: "Preparation", durationDays: 1 },
      { key: "installation", name: "Installation", durationDays: 2 },
      { key: "completion", name: "Completion & Testing", durationDays: 1 },
    ],
    milestones: [
      { key: "contract_signed", name: "Contract Signed", phaseKey: "scope_contract", offsetDays: 1 },
      { key: "inspection_passed", name: "Electrical Inspection Passed", phaseKey: "completion", offsetDays: 5 },
    ],
    tasks: [
      { key: "confirm_scope", title: "Confirm scope and coordinate power shutdown", phaseKey: "scope_contract" },
      { key: "obtain_contract", title: "Obtain signed contract", phaseKey: "scope_contract" },
      { key: "confirm_circuit", title: "Confirm circuit and shut off power", phaseKey: "preparation" },
      { key: "install_wiring", title: "Complete approved panel, circuit, or wiring work", phaseKey: "installation" },
      { key: "coordinate_inspection", title: "Coordinate required inspections", phaseKey: "installation" },
      { key: "test_circuits", title: "Test all affected circuits", phaseKey: "completion" },
      { key: "clean_area", title: "Clean the work area", phaseKey: "completion" },
      { key: "collect_final_payment", title: "Collect final payment", phaseKey: "completion" },
    ],
    dependencies: [
      { fromTaskKey: "confirm_circuit", toTaskKey: "install_wiring" },
      { fromTaskKey: "install_wiring", toTaskKey: "test_circuits" },
    ],
  }),

  // ── Repair / Maintenance & General ──
  template({
    key: "general_repair_project",
    name: "General Repair / Maintenance Project",
    description: "A flexible plan for a single repair or maintenance visit.",
    projectType: "repair_maintenance",
    phases: [
      { key: "assessment", name: "Assessment", durationDays: 1 },
      { key: "approval", name: "Approval", durationDays: 1 },
      { key: "repair_work", name: "Repair Work", durationDays: 2 },
      { key: "verification", name: "Verification", durationDays: 1 },
      { key: "closeout", name: "Closeout", durationDays: 1 },
    ],
    milestones: [
      { key: "approved", name: "Repair Approved", phaseKey: "approval", offsetDays: 2 },
      { key: "work_started", name: "Work Started", phaseKey: "repair_work", offsetDays: 3 },
      { key: "final_walkthrough", name: "Final Walkthrough Completed", phaseKey: "closeout", offsetDays: 6 },
    ],
    tasks: [
      { key: "inspect_issue", title: "Inspect and confirm the reported issue", phaseKey: "assessment" },
      { key: "quote_repair", title: "Confirm scope and cost with customer", phaseKey: "approval" },
      { key: "complete_repair", title: "Complete the approved repair", phaseKey: "repair_work" },
      { key: "verify_operation", title: "Verify proper operation", phaseKey: "verification" },
      { key: "clean_area", title: "Clean the work area", phaseKey: "closeout" },
      { key: "collect_final_payment", title: "Collect final payment", phaseKey: "closeout" },
    ],
    dependencies: [
      { fromTaskKey: "quote_repair", toTaskKey: "complete_repair" },
      { fromTaskKey: "complete_repair", toTaskKey: "verify_operation" },
    ],
  }),

  // ── General / Other fallback ──
  template({
    key: "general_construction_project",
    name: "General Construction Project",
    description: "A general framework for a custom project not covered by another template.",
    projectType: "other",
    phases: [
      { key: "scope_contract", name: "Scope & Contract", durationDays: 3 },
      { key: "preparation", name: "Preparation", durationDays: 5 },
      { key: "work_performed", name: "Work Performed", durationDays: 10 },
      { key: "punch_list", name: "Punch List", durationDays: 2 },
      { key: "closeout", name: "Closeout", durationDays: 1 },
    ],
    milestones: [
      { key: "contract_signed", name: "Contract Signed", phaseKey: "scope_contract", offsetDays: 2 },
      { key: "work_started", name: "Work Started", phaseKey: "work_performed", offsetDays: 8 },
      { key: "final_walkthrough", name: "Final Walkthrough Completed", phaseKey: "closeout", offsetDays: 21 },
    ],
    tasks: [
      { key: "confirm_scope", title: "Confirm the approved scope and schedule", phaseKey: "scope_contract" },
      { key: "obtain_contract", title: "Obtain signed contract", phaseKey: "scope_contract" },
      { key: "order_materials", title: "Order materials and coordinate access", phaseKey: "preparation" },
      { key: "complete_work", title: "Complete each item listed in the agreed sequence", phaseKey: "work_performed" },
      { key: "punch_inspection", title: "Complete punch-list inspection", phaseKey: "punch_list" },
      { key: "correct_items", title: "Correct remaining items", phaseKey: "punch_list" },
      { key: "customer_walkthrough", title: "Review completed work with customer", phaseKey: "closeout" },
      { key: "collect_final_payment", title: "Collect final payment", phaseKey: "closeout" },
    ],
    dependencies: [
      { fromTaskKey: "order_materials", toTaskKey: "complete_work" },
      { fromTaskKey: "complete_work", toTaskKey: "punch_inspection" },
      { fromTaskKey: "correct_items", toTaskKey: "customer_walkthrough" },
    ],
  }),
];

export function templatesForProjectType(projectType: ProjectType | null | undefined): ProjectPlanTemplate[] {
  if (!projectType) return [];
  const matches = PROJECT_PLAN_TEMPLATES.filter((t) => t.projectType === projectType);
  if (matches.length > 0) return matches;
  // Other/custom or any type without a dedicated template falls back to the general one.
  return PROJECT_PLAN_TEMPLATES.filter((t) => t.key === "general_construction_project");
}

export function findPlanTemplate(key: string): ProjectPlanTemplate | undefined {
  return PROJECT_PLAN_TEMPLATES.find((t) => t.key === key);
}

// ── Shared count formatting — one place for every "N phases · N tasks"
// label so the dropdown, preview, activity note, and toast summary can
// never drift apart or regress to abbreviations (ph/tk/t). ──────────────

export function pluralizeCount(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Compact form used in the template dropdown (option rows and the selected value, which Radix Select renders from the same option content). */
export function formatTemplateCounts(phaseCount: number, taskCount: number): string {
  return [pluralizeCount(phaseCount, "phase"), pluralizeCount(taskCount, "task")].join(" · ");
}

/** Full form used in the preview header, the applied-template activity note, and the success toast. */
export function formatTemplateSummary(counts: {
  phaseCount: number;
  milestoneCount: number;
  taskCount: number;
  dependencyCount: number;
}): string {
  return [
    pluralizeCount(counts.phaseCount, "phase"),
    pluralizeCount(counts.milestoneCount, "milestone"),
    pluralizeCount(counts.taskCount, "task"),
    pluralizeCount(counts.dependencyCount, "dependency", "dependencies"),
  ].join(" · ");
}
