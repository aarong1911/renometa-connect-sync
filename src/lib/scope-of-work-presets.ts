// src/lib/scope-of-work-presets.ts
//
// Phase 10.4 continuation — built-in, read-only Scope of Work starter
// content, filtered by Work Type (reuses the WorkType union from
// estimate-status.ts — no duplicate union). Plain in-repo constants, same
// pattern as proposal-presets.ts: every organization sees the same
// presets, none can mutate them; "editing" one means copying its text into
// an org-owned estimate_proposal_templates row (category = 'scope_of_work'),
// which is a completely independent copy from that point on.
//
// General, editable starter language only — no code-compliance claims, no
// permit-inclusion claims, no warranties, no prices.

import type { WorkType } from "@/lib/estimate-status";

export type ScopeOfWorkPreset = {
  id: string;
  workType: WorkType;
  name: string;
  description: string;
  content: string;
};

function section(title: string, bullets: string[]): string {
  return `${title}\n${bullets.map((b) => `- ${b}`).join("\n")}`;
}
function build(sections: string[]): string {
  return sections.join("\n\n");
}

const PREP = (note: string) => section("1. Project Preparation", [
  "Protect adjacent floors, walls, and occupied areas.",
  "Establish a designated work and material-staging area.",
  note,
]);
const COMPLETION = section("Cleanup and Completion", [
  "Remove construction debris and dispose of it according to the approved project plan.",
  "Perform final job-site cleanup.",
  "Complete a customer walkthrough and document any remaining punch-list items.",
]);

let seq = 0;
function preset(workType: WorkType, name: string, description: string, sections: string[]): ScopeOfWorkPreset {
  seq += 1;
  return { id: `sow-${workType}-${seq}`, workType, name, description, content: build(sections) };
}

export const SCOPE_OF_WORK_PRESETS: ScopeOfWorkPreset[] = [
  // ── Kitchen Remodel ──
  preset("kitchen_remodel", "Basic Kitchen Refresh", "Cosmetic updates without layout changes.", [
    PREP("Coordinate access and working hours with the customer."),
    section("2. Surface Preparation", ["Remove cabinet doors, hardware, and listed fixtures for refinishing or replacement.", "Patch and prep walls as needed."]),
    section("3. Finishes", ["Install new cabinet doors, hardware, or listed countertop/backsplash updates.", "Complete listed painting and caulking."]),
    COMPLETION,
  ]),
  preset("kitchen_remodel", "Standard Kitchen Remodel", "Cabinet, countertop, and finish replacement.", [
    PREP("Coordinate access and working hours with the customer."),
    section("2. Demolition", ["Remove existing cabinets, countertops, backsplash, sink, and listed fixtures.", "Dispose of demolition debris according to the approved project plan.", "Preserve items specifically identified for reuse."]),
    section("3. Cabinet Installation", ["Install the approved cabinet layout.", "Level and secure cabinets to existing framing.", "Install fillers, panels, trim, and included hardware."]),
    section("4. Countertops", ["Coordinate field measurements after cabinet installation.", "Install the selected countertop material and listed edge profile.", "Complete sink and faucet cutouts where included."]),
    section("5. Electrical and Plumbing", ["Complete only the electrical and plumbing work specifically listed in this proposal.", "Reconnect approved fixtures and appliances.", "Additional work discovered after demolition requires customer approval."]),
    section("6. Finishes", ["Patch affected walls and ceilings.", "Install the approved backsplash where included.", "Complete listed painting, caulking, and finish work."]),
    section("7. Completion", ["Remove construction debris.", "Perform final job-site cleanup.", "Complete a customer walkthrough and document remaining punch-list items."]),
  ]),
  preset("kitchen_remodel", "Full Kitchen Renovation", "Layout changes, structural, and full finish-out.", [
    PREP("Coordinate access, working hours, and temporary kitchen arrangements with the customer."),
    section("2. Demolition", ["Remove existing cabinets, countertops, flooring, and listed fixtures down to the framing where the layout is changing.", "Cap or relocate utilities as required by the approved layout."]),
    section("3. Framing and Rough-In", ["Complete framing changes shown in the approved layout.", "Complete rough electrical and plumbing for new fixture locations."]),
    section("4. Cabinet and Countertop Installation", ["Install the approved cabinet layout, including any island or peninsula.", "Install the selected countertop material and edge profile."]),
    section("5. Flooring and Finishes", ["Install the selected flooring material.", "Install backsplash, lighting, and listed finish fixtures.", "Complete drywall, painting, and trim work."]),
    section("6. Electrical and Plumbing Finish", ["Set and connect approved fixtures and appliances.", "Complete final electrical trim and testing."]),
    COMPLETION,
  ]),

  // ── Bathroom Remodel ──
  preset("bathroom_remodel", "Bathroom Refresh", "Cosmetic updates without layout changes.", [
    PREP("Coordinate access and working hours with the customer."),
    section("2. Preparation", ["Remove listed fixtures, hardware, and surfaces scheduled for replacement.", "Protect the tub/shower and flooring not being replaced."]),
    section("3. Finishes", ["Install new vanity, fixtures, or hardware as listed.", "Complete listed painting, caulking, and grout work."]),
    COMPLETION,
  ]),
  preset("bathroom_remodel", "Standard Bathroom Remodel", "Vanity, tile, and fixture replacement.", [
    PREP("Coordinate access and working hours with the customer."),
    section("2. Demolition", ["Remove existing vanity, toilet, tub/shower surround, flooring, and listed fixtures.", "Dispose of demolition debris according to the approved project plan."]),
    section("3. Rough-In", ["Complete plumbing and electrical work specifically listed in this proposal for new fixture locations.", "Address subfloor or wall substrate issues discovered during demolition, with customer approval for anything beyond normal preparation."]),
    section("4. Tile and Surfaces", ["Install the selected floor and/or shower/tub surround tile.", "Waterproof wet areas per the installed materials' requirements."]),
    section("5. Fixtures", ["Install the selected vanity, toilet, faucet, and listed fixtures.", "Connect and test all plumbing fixtures."]),
    section("6. Finishes", ["Complete painting, caulking, and trim work.", "Install lighting and accessories as listed."]),
    COMPLETION,
  ]),
  preset("bathroom_remodel", "Full Bathroom Renovation", "Layout changes and full finish-out.", [
    PREP("Coordinate access, working hours, and temporary facility arrangements with the customer."),
    section("2. Demolition", ["Remove all existing fixtures, surfaces, and flooring down to the framing where the layout is changing."]),
    section("3. Framing, Plumbing, and Electrical Rough-In", ["Complete framing changes shown in the approved layout.", "Relocate or add plumbing and electrical rough-in for new fixture locations."]),
    section("4. Waterproofing and Tile", ["Waterproof all wet areas per the installed materials' requirements.", "Install the selected floor and shower/tub tile."]),
    section("5. Fixtures and Finishes", ["Install the selected vanity, toilet, tub/shower, and fixtures.", "Complete lighting, ventilation, painting, and trim work."]),
    COMPLETION,
  ]),

  // ── Full Home Remodel ──
  preset("full_home_remodel", "Cosmetic Full Home Refresh", "Paint, flooring, and fixture updates throughout.", [
    PREP("Coordinate a room-by-room schedule and access with the customer."),
    section("2. Preparation", ["Protect furnishings and surfaces not included in this scope.", "Remove listed fixtures and hardware scheduled for replacement."]),
    section("3. Finishes", ["Complete listed painting, flooring, and fixture updates throughout the home.", "Reinstall or replace hardware and trim as listed."]),
    COMPLETION,
  ]),
  preset("full_home_remodel", "Standard Full Home Remodel", "Multi-room renovation across kitchen, baths, and living areas.", [
    PREP("Coordinate a phased schedule and access with the customer."),
    section("2. Demolition", ["Remove finishes, fixtures, and surfaces in the rooms included in this scope.", "Dispose of demolition debris according to the approved project plan."]),
    section("3. Rough-In", ["Complete electrical and plumbing work specifically listed in this proposal for each affected room."]),
    section("4. Installation", ["Install cabinetry, countertops, flooring, and fixtures per the approved selections for each room."]),
    section("5. Finishes", ["Complete drywall, painting, trim, and finish work throughout the affected areas."]),
    COMPLETION,
  ]),
  preset("full_home_remodel", "Comprehensive Full Home Renovation", "Structural, systems, and full finish-out throughout.", [
    PREP("Coordinate a phased schedule, access, and any temporary living arrangements with the customer."),
    section("2. Demolition and Structural Work", ["Remove finishes and, where shown in the approved plan, structural elements.", "Complete framing changes shown in the approved layout."]),
    section("3. Systems", ["Complete electrical, plumbing, and HVAC work specifically listed in this proposal.", "Coordinate required inspections for systems work as applicable."]),
    section("4. Installation and Finishes", ["Install cabinetry, countertops, flooring, fixtures, and trim per the approved selections.", "Complete drywall, painting, and finish work throughout."]),
    COMPLETION,
  ]),

  // ── Home Addition ──
  preset("home_addition", "Room Addition", "A single-room addition to the existing structure.", [
    section("1. Site Preparation", ["Prepare the building site and protect adjacent landscaping and structures.", "Coordinate access and working hours with the customer."]),
    section("2. Foundation and Framing", ["Complete the foundation work shown in the approved plan.", "Frame the addition per the approved plan."]),
    section("3. Systems Rough-In", ["Complete electrical, plumbing, and HVAC rough-in specifically listed in this proposal.", "Coordinate required inspections as applicable."]),
    section("4. Exterior Envelope", ["Install roofing, siding, windows, and doors matching or complementing the existing structure as specified.", "Weatherproof all exterior penetrations and transitions."]),
    section("5. Interior Finishes", ["Complete insulation, drywall, flooring, painting, and trim per the approved selections."]),
    COMPLETION,
  ]),
  preset("home_addition", "Primary Suite Addition", "A bedroom and bathroom addition.", [
    section("1. Site Preparation", ["Prepare the building site and protect adjacent landscaping and structures.", "Coordinate access and working hours with the customer."]),
    section("2. Foundation and Framing", ["Complete the foundation and framing shown in the approved plan, including the bathroom layout."]),
    section("3. Systems Rough-In", ["Complete electrical, plumbing, and HVAC rough-in for the bedroom and bathroom.", "Coordinate required inspections as applicable."]),
    section("4. Exterior Envelope", ["Install roofing, siding, windows, and doors matching or complementing the existing structure.", "Weatherproof all exterior penetrations and transitions."]),
    section("5. Interior Finishes", ["Waterproof and tile the bathroom per the installed materials' requirements.", "Complete insulation, drywall, flooring, fixtures, painting, and trim per the approved selections."]),
    COMPLETION,
  ]),
  preset("home_addition", "General Home Addition", "A flexible-use addition per the approved plan.", [
    section("1. Site Preparation", ["Prepare the building site and protect adjacent landscaping and structures."]),
    section("2. Foundation and Framing", ["Complete the foundation and framing shown in the approved plan."]),
    section("3. Systems Rough-In", ["Complete electrical, plumbing, and HVAC rough-in specifically listed in this proposal."]),
    section("4. Exterior Envelope and Finishes", ["Install roofing, siding, windows, and doors as specified.", "Complete insulation, drywall, flooring, painting, and trim per the approved selections."]),
    COMPLETION,
  ]),

  // ── Roofing ──
  preset("roofing", "Roof Repair", "Targeted repair of a specific roof area or issue.", [
    section("1. Assessment and Preparation", ["Inspect the affected area and confirm the repair scope with the customer.", "Protect landscaping and adjacent surfaces below the work area."]),
    section("2. Repair", ["Remove and replace damaged roofing materials in the affected area.", "Repair or replace damaged flashing, underlayment, or decking as needed."]),
    section("3. Completion", ["Verify the repaired area for proper sealing and water-tightness.", "Remove debris and clean the work area, including a magnetic sweep for nails/debris."]),
  ]),
  preset("roofing", "Partial Roof Replacement", "Replacement of one or more roof sections.", [
    section("1. Preparation", ["Protect landscaping, gutters, and adjacent surfaces below the work area.", "Coordinate material delivery and staging with the customer."]),
    section("2. Tear-Off", ["Remove existing roofing material down to the decking in the specified section(s).", "Inspect decking and replace damaged sections as needed and approved."]),
    section("3. Installation", ["Install underlayment, flashing, and the selected roofing material per manufacturer specifications.", "Install listed ventilation components."]),
    section("4. Completion", ["Clean the work area, including a magnetic sweep for nails/debris.", "Remove and dispose of roofing debris according to the approved project plan."]),
  ]),
  preset("roofing", "Full Roof Replacement", "Complete tear-off and replacement of the entire roof system.", [
    section("1. Preparation", ["Protect landscaping, gutters, and adjacent surfaces around the entire structure.", "Coordinate material delivery, staging, and dumpster placement with the customer."]),
    section("2. Tear-Off", ["Remove all existing roofing material down to the decking.", "Inspect decking and replace damaged sections as needed and approved."]),
    section("3. Installation", ["Install underlayment, flashing, ventilation, and the selected roofing material per manufacturer specifications across the entire roof."]),
    section("4. Completion", ["Clean the work area, including a magnetic sweep for nails/debris around the full perimeter.", "Remove and dispose of roofing debris according to the approved project plan."]),
  ]),

  // ── Flooring ──
  preset("flooring", "Flooring Removal and Replacement", "Removal of existing flooring and installation of new material in a defined area.", [
    section("1. Preparation", ["Move or protect furnishings in the work area as coordinated with the customer.", "Protect adjacent areas not included in this scope."]),
    section("2. Removal", ["Remove existing flooring and dispose of it according to the approved project plan.", "Assess the subfloor and address issues discovered, with customer approval for anything beyond normal preparation."]),
    section("3. Installation", ["Prepare the subfloor per the selected material's requirements.", "Install the selected flooring material and listed transitions/trim."]),
    COMPLETION,
  ]),
  preset("flooring", "New Flooring Installation", "Installation of new flooring in a room without existing floor removal.", [
    section("1. Preparation", ["Move or protect furnishings in the work area as coordinated with the customer."]),
    section("2. Subfloor Preparation", ["Inspect and prepare the existing subfloor per the selected material's requirements."]),
    section("3. Installation", ["Install the selected flooring material and listed transitions/trim."]),
    COMPLETION,
  ]),
  preset("flooring", "Whole-Home Flooring Project", "Flooring replacement across multiple rooms.", [
    section("1. Preparation", ["Coordinate a room-by-room schedule and furniture arrangements with the customer."]),
    section("2. Removal", ["Remove existing flooring in each listed area and dispose of it according to the approved project plan.", "Assess subfloors and address issues discovered, with customer approval for anything beyond normal preparation."]),
    section("3. Installation", ["Prepare each subfloor per the selected material's requirements.", "Install the selected flooring material and transitions throughout the listed areas."]),
    COMPLETION,
  ]),

  // ── Interior Painting ──
  preset("interior_painting", "Single-Room Interior Painting", "Painting of one interior room.", [
    section("1. Preparation", ["Move or cover furnishings and protect flooring and trim in the room.", "Patch minor nail holes and surface imperfections."]),
    section("2. Painting", ["Apply primer where needed.", "Apply the selected paint in the specified number of coats to walls, ceiling, and/or trim as listed."]),
    section("3. Completion", ["Remove protective coverings and clean the work area.", "Touch up as needed."]),
  ]),
  preset("interior_painting", "Multi-Room Interior Painting", "Painting of several interior rooms.", [
    section("1. Preparation", ["Move or cover furnishings and protect flooring and trim in each listed room.", "Patch minor nail holes and surface imperfections."]),
    section("2. Painting", ["Apply primer where needed.", "Apply the selected paint in the specified number of coats across all listed rooms."]),
    section("3. Completion", ["Remove protective coverings and clean each work area.", "Touch up as needed."]),
  ]),
  preset("interior_painting", "Full Interior Repaint", "Painting throughout the interior of the home.", [
    section("1. Preparation", ["Coordinate a room-by-room schedule with the customer.", "Move or cover furnishings and protect flooring and trim throughout.", "Patch minor nail holes and surface imperfections."]),
    section("2. Painting", ["Apply primer where needed.", "Apply the selected paint in the specified number of coats to walls, ceilings, and/or trim throughout the home."]),
    section("3. Completion", ["Remove protective coverings and clean all work areas.", "Touch up as needed."]),
  ]),

  // ── Exterior Painting ──
  preset("exterior_painting", "Exterior Touch-Up", "Spot painting of specific exterior areas.", [
    section("1. Preparation", ["Protect landscaping and adjacent surfaces near the work areas."]),
    section("2. Painting", ["Scrape and spot-prep the listed areas.", "Apply primer and the selected paint to the listed areas."]),
    section("3. Completion", ["Remove protective coverings and clean the work areas."]),
  ]),
  preset("exterior_painting", "Standard Exterior Painting", "Painting of primary exterior surfaces.", [
    section("1. Preparation", ["Protect landscaping, walkways, and adjacent surfaces.", "Pressure wash and scrape/sand surfaces as needed.", "Caulk gaps and repair minor surface imperfections."]),
    section("2. Painting", ["Apply primer to bare or repaired areas.", "Apply the selected paint in the specified number of coats to the listed surfaces."]),
    section("3. Completion", ["Remove protective coverings and clean the work areas.", "Touch up as needed."]),
  ]),
  preset("exterior_painting", "Full Exterior Repaint", "Painting of the entire exterior, including trim and listed components.", [
    section("1. Preparation", ["Protect landscaping, walkways, and adjacent surfaces around the entire structure.", "Pressure wash and scrape/sand all surfaces as needed.", "Caulk gaps and repair minor surface imperfections."]),
    section("2. Painting", ["Apply primer to all bare or repaired areas.", "Apply the selected paint in the specified number of coats to siding, trim, and listed components."]),
    section("3. Completion", ["Remove protective coverings and clean all work areas.", "Touch up as needed."]),
  ]),

  // ── HVAC Installation ──
  preset("hvac_installation", "HVAC System Replacement", "Replacement of an existing HVAC system with a new unit.", [
    section("1. Preparation", ["Protect flooring and surfaces along the access path.", "Confirm equipment specifications and placement with the customer."]),
    section("2. Removal", ["Disconnect and remove the existing system components being replaced.", "Dispose of removed equipment according to the approved project plan."]),
    section("3. Installation", ["Install the new equipment and connect to existing ductwork, electrical, and refrigerant lines as applicable.", "Test system operation and verify proper airflow."]),
    section("4. Completion", ["Clean the work area.", "Review system operation with the customer."]),
  ]),
  preset("hvac_installation", "New HVAC Installation", "Installation of HVAC where no system currently exists.", [
    section("1. Preparation", ["Confirm equipment specifications, placement, and routing with the customer."]),
    section("2. Installation", ["Install equipment, ductwork, electrical, and refrigerant lines as specified.", "Test system operation and verify proper airflow."]),
    section("3. Completion", ["Clean the work area.", "Review system operation with the customer."]),
  ]),
  preset("hvac_installation", "Multi-Zone HVAC Installation", "Installation of a multi-zone HVAC system.", [
    section("1. Preparation", ["Confirm zone layout, equipment specifications, and routing with the customer."]),
    section("2. Installation", ["Install equipment, zone controls, ductwork or line sets, electrical, and refrigerant lines as specified.", "Test each zone for proper operation and airflow."]),
    section("3. Completion", ["Clean all work areas.", "Review system and zone-control operation with the customer."]),
  ]),

  // ── HVAC Repair ──
  preset("hvac_repair", "HVAC Diagnostic and Repair", "Diagnosis and repair of a reported HVAC issue.", [
    section("1. Diagnostic", ["Inspect and test the system to identify the cause of the reported issue.", "Review findings and recommended repair with the customer."]),
    section("2. Repair", ["Complete the approved repair.", "Test system operation following the repair."]),
  ]),
  preset("hvac_repair", "Component Replacement", "Replacement of a specific failed HVAC component.", [
    section("1. Diagnostic", ["Confirm the failed component and replacement part with the customer."]),
    section("2. Replacement", ["Remove the failed component and install the replacement.", "Test system operation following the replacement."]),
  ]),
  preset("hvac_repair", "Major HVAC Repair", "Repair involving multiple components or significant labor.", [
    section("1. Diagnostic", ["Inspect and test the system to identify all issues contributing to the reported problem.", "Review findings and the recommended repair plan with the customer."]),
    section("2. Repair", ["Complete the approved repairs, including any listed component replacements.", "Test system operation and verify proper performance following the repairs."]),
  ]),

  // ── Plumbing ──
  preset("plumbing", "Plumbing Repair", "Repair of a reported plumbing issue.", [
    section("1. Diagnostic", ["Inspect and test to identify the cause of the reported issue.", "Review findings and the recommended repair with the customer."]),
    section("2. Repair", ["Complete the approved repair.", "Test for proper operation and check for leaks."]),
  ]),
  preset("plumbing", "Fixture Replacement", "Removal and replacement of listed plumbing fixtures.", [
    section("1. Preparation", ["Shut off water supply to the affected fixture(s)."]),
    section("2. Replacement", ["Remove the existing fixture(s) and install the selected replacement(s).", "Test for proper operation and check for leaks."]),
    section("3. Completion", ["Clean the work area."]),
  ]),
  preset("plumbing", "Plumbing Installation", "New plumbing installation for a listed fixture or line.", [
    section("1. Preparation", ["Confirm fixture locations and routing with the customer."]),
    section("2. Installation", ["Run supply and drain lines as specified.", "Install and connect the specified fixture(s).", "Test for proper operation and check for leaks."]),
    section("3. Completion", ["Clean the work area."]),
  ]),

  // ── Electrical ──
  preset("electrical", "Electrical Repair", "Repair of a reported electrical issue.", [
    section("1. Diagnostic", ["Inspect and test to identify the cause of the reported issue.", "Review findings and the recommended repair with the customer."]),
    section("2. Repair", ["Complete the approved repair.", "Test for proper operation."]),
  ]),
  preset("electrical", "Fixture and Device Installation", "Installation or replacement of listed fixtures, outlets, or switches.", [
    section("1. Preparation", ["Confirm circuit and shut off power to the affected area."]),
    section("2. Installation", ["Install or replace the listed fixtures, outlets, or switches.", "Test for proper operation."]),
    section("3. Completion", ["Clean the work area."]),
  ]),
  preset("electrical", "Electrical Upgrade", "Panel, circuit, or wiring upgrade.", [
    section("1. Preparation", ["Confirm scope and coordinate any required power shutdown with the customer."]),
    section("2. Installation", ["Complete the approved panel, circuit, or wiring work.", "Coordinate required inspections as applicable."]),
    section("3. Completion", ["Test all affected circuits for proper operation.", "Clean the work area."]),
  ]),

  // ── Landscaping ──
  preset("landscaping", "Landscape Cleanup", "General cleanup and maintenance of existing landscaping.", [
    section("1. Assessment", ["Walk the property with the customer to confirm the areas and items included."]),
    section("2. Cleanup", ["Remove debris, dead plant material, and listed overgrowth.", "Complete listed trimming, edging, and bed cleanup."]),
    section("3. Completion", ["Haul away green waste and debris according to the approved project plan."]),
  ]),
  preset("landscaping", "Landscape Installation", "Installation of new plantings, beds, or hardscape elements.", [
    section("1. Preparation", ["Confirm the approved plan and plant/material selections with the customer.", "Prepare beds and installation areas."]),
    section("2. Installation", ["Install the selected plants, materials, or hardscape elements per the approved plan.", "Install listed irrigation adjustments where included."]),
    section("3. Completion", ["Clean the work area and haul away debris."]),
  ]),
  preset("landscaping", "Full Outdoor Transformation", "Comprehensive landscaping across the property.", [
    section("1. Preparation", ["Confirm the approved plan and coordinate a phased schedule with the customer."]),
    section("2. Site Work", ["Complete grading, bed preparation, and hardscape base work shown in the approved plan."]),
    section("3. Installation", ["Install hardscape elements, plantings, and listed irrigation per the approved plan."]),
    section("4. Completion", ["Clean the work area and haul away debris.", "Walk the property with the customer to review completed work."]),
  ]),

  // ── Commercial Renovation ──
  preset("commercial_renovation", "Commercial Interior Refresh", "Cosmetic updates to a commercial interior space.", [
    section("1. Preparation", ["Coordinate access and working hours around business operations with the customer.", "Protect fixtures, equipment, and areas not included in this scope."]),
    section("2. Finishes", ["Complete listed painting, flooring, or fixture updates.", "Patch and prepare surfaces as needed."]),
    COMPLETION,
  ]),
  preset("commercial_renovation", "Tenant Improvement", "Buildout of a commercial space per an approved plan.", [
    section("1. Preparation", ["Coordinate access, working hours, and any required permits/inspections with the customer.", "Confirm the approved buildout plan."]),
    section("2. Framing and Systems", ["Complete framing, electrical, plumbing, and HVAC work specifically listed in this proposal.", "Coordinate required inspections as applicable."]),
    section("3. Finishes", ["Install flooring, ceiling, lighting, and fixtures per the approved plan.", "Complete painting and trim work."]),
    COMPLETION,
  ]),
  preset("commercial_renovation", "Full Commercial Renovation", "Comprehensive renovation of a commercial space.", [
    section("1. Preparation", ["Coordinate a phased schedule, access, and any required permits/inspections with the customer."]),
    section("2. Demolition and Structural Work", ["Remove finishes and, where shown in the approved plan, structural elements."]),
    section("3. Systems", ["Complete electrical, plumbing, and HVAC work specifically listed in this proposal.", "Coordinate required inspections as applicable."]),
    section("4. Finishes", ["Install flooring, ceiling, lighting, fixtures, and finish work per the approved plan."]),
    COMPLETION,
  ]),

  // ── New Construction ──
  preset("new_construction", "Preliminary Construction Scope", "Site work and foundation stage.", [
    section("1. Site Preparation", ["Prepare the building site, including clearing and grading shown in the approved plan.", "Coordinate utility locates and temporary services."]),
    section("2. Foundation", ["Complete the foundation work shown in the approved plan.", "Coordinate required inspections as applicable."]),
  ]),
  preset("new_construction", "Standard New Construction Scope", "Full construction through move-in-ready finish.", [
    section("1. Site and Foundation", ["Prepare the site and complete the foundation shown in the approved plan."]),
    section("2. Framing", ["Complete framing per the approved plans and specifications."]),
    section("3. Systems Rough-In", ["Complete electrical, plumbing, and HVAC rough-in.", "Coordinate required inspections as applicable."]),
    section("4. Exterior Envelope", ["Install roofing, siding, windows, and doors per the approved plans."]),
    section("5. Interior Finishes", ["Complete insulation, drywall, flooring, cabinetry, fixtures, painting, and trim per the approved selections."]),
    COMPLETION,
  ]),
  preset("new_construction", "Comprehensive New Build Scope", "Full-service new construction including site development.", [
    section("1. Site Development", ["Complete site clearing, grading, and utility work shown in the approved plan."]),
    section("2. Foundation and Framing", ["Complete the foundation and framing per the approved plans and specifications."]),
    section("3. Systems", ["Complete electrical, plumbing, and HVAC installation.", "Coordinate required inspections as applicable."]),
    section("4. Exterior Envelope", ["Install roofing, siding, windows, and doors per the approved plans."]),
    section("5. Interior Finishes", ["Complete insulation, drywall, flooring, cabinetry, fixtures, painting, and trim per the approved selections."]),
    COMPLETION,
  ]),

  // ── Repair / Maintenance ──
  preset("repair_maintenance", "General Repair", "A single reported repair item.", [
    section("1. Diagnostic", ["Inspect the reported issue and confirm the repair scope with the customer."]),
    section("2. Repair", ["Complete the approved repair.", "Verify proper operation following the repair."]),
  ]),
  preset("repair_maintenance", "Preventive Maintenance", "Routine maintenance and inspection items.", [
    section("1. Inspection", ["Inspect the listed systems or components."]),
    section("2. Maintenance", ["Complete the listed maintenance tasks.", "Note and report any items needing further attention."]),
  ]),
  preset("repair_maintenance", "Multi-Item Repair Visit", "Several repair items addressed in one visit.", [
    section("1. Diagnostic", ["Inspect each reported item and confirm the scope with the customer."]),
    section("2. Repairs", ["Complete each approved repair item.", "Verify proper operation of each repaired item."]),
    section("3. Completion", ["Clean work areas.", "Review completed items and any remaining recommendations with the customer."]),
  ]),

  // ── Inspection ──
  preset("inspection", "General Property Inspection", "A broad visual inspection of the property.", [
    section("1. Inspection", ["Visually inspect the listed systems and areas of the property.", "Document observed conditions."]),
    section("2. Reporting", ["Provide a written summary of findings to the customer."]),
  ]),
  preset("inspection", "Trade-Specific Inspection", "A focused inspection of a specific system or trade.", [
    section("1. Inspection", ["Inspect and test the specified system or component.", "Document observed conditions."]),
    section("2. Reporting", ["Provide a written summary of findings and recommendations to the customer."]),
  ]),
  preset("inspection", "Pre-Construction Inspection", "Inspection prior to starting a construction project.", [
    section("1. Inspection", ["Inspect the existing conditions relevant to the planned project.", "Document conditions that may affect project scope or pricing."]),
    section("2. Reporting", ["Provide a written summary of findings to the customer prior to finalizing the project scope."]),
  ]),

  // ── Consultation ──
  preset("consultation", "Project Consultation", "A general consultation to discuss a potential project.", [
    section("1. Discussion", ["Meet with the customer to discuss project goals, timeline, and general budget expectations."]),
    section("2. Follow-Up", ["Provide a written summary of the discussion and recommended next steps."]),
  ]),
  preset("consultation", "Design and Planning Consultation", "A consultation focused on design direction and planning.", [
    section("1. Discussion", ["Meet with the customer to review design goals, material preferences, and layout considerations."]),
    section("2. Follow-Up", ["Provide a written summary and recommended next steps, which may include design deliverables listed separately."]),
  ]),
  preset("consultation", "Site Evaluation and Recommendations", "An on-site evaluation with follow-up recommendations.", [
    section("1. Site Visit", ["Walk the site with the customer and document relevant conditions."]),
    section("2. Recommendations", ["Provide a written summary of observations and recommended next steps."]),
  ]),

  // ── Other ──
  preset("other", "General Custom Work", "A flexible starting point for work not covered by another category.", [
    section("1. Preparation", ["Coordinate access and working hours with the customer.", "Protect adjacent areas not included in this scope."]),
    section("2. Work Performed", ["Complete the work specifically listed in this proposal."]),
    COMPLETION,
  ]),
  preset("other", "Custom Project Scope", "A general framework for a custom project.", [
    section("1. Preparation", ["Confirm the approved scope and schedule with the customer."]),
    section("2. Work Performed", ["Complete each item listed in this proposal in the agreed sequence."]),
    section("3. Completion", ["Clean the work area.", "Review completed work with the customer."]),
  ]),
  preset("other", "Detailed Custom Services", "A framework for multi-part custom service work.", [
    section("1. Preparation", ["Confirm the approved scope, sequence, and schedule with the customer."]),
    section("2. Services Performed", ["Complete each listed service item.", "Note any conditions discovered that may affect scope, with customer approval required for additional work."]),
    section("3. Completion", ["Clean all work areas.", "Review completed work and any recommendations with the customer."]),
  ]),
];

export function scopePresetsForWorkType(workType: WorkType): ScopeOfWorkPreset[] {
  return SCOPE_OF_WORK_PRESETS.filter((p) => p.workType === workType);
}

export function findScopePreset(id: string): ScopeOfWorkPreset | undefined {
  return SCOPE_OF_WORK_PRESETS.find((p) => p.id === id);
}
