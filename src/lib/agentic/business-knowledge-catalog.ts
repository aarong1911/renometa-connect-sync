// src/lib/agentic/business-knowledge-catalog.ts
//
// Business Knowledge — the fixed catalog of "common contractor questions"
// the owner can configure with owner-friendly controls, shared by:
//   - the Settings UI (src/components/ai-center/business-knowledge-settings.tsx)
//   - the clarification card (knowledge-clarification-card.tsx)
//   - server code that validates a model-proposed category
//     (lib/ai/knowledge-clarification.ts) and builds canonical keys.
//
// Pure data + pure functions. No DOM, no Supabase, no Node-only imports —
// same constraint as everything else under src/lib/agentic/ (netlify
// functions import from here).
//
// TRUST: the catalog describes WHAT can be asked/answered. It contains no
// facts about any specific business. A fact only exists once an owner has
// written an entry (business_knowledge_entries) — never from this file.
//
// Options exist ONLY where a short multiple-choice answer is genuinely
// meaningful (permits, inspections, financing, ...). Free-form categories
// (service area, business hours, ...) deliberately have NO suggested
// options — inventing choices for them would put misleading "answers" in
// front of the owner.

export type KnowledgeOption = {
  id: string;
  /** Short label shown on the radio option. */
  label: string;
  /** The full customer-facing sentence stored as the answer / sent to the customer. */
  answer: string;
};

export type KnowledgeCategoryDefinition = {
  /** Canonical business_knowledge_entries.key. Stable — never rename. */
  key: string;
  label: string;
  /** Canonical question this entry answers (shown to the model + owner). */
  question: string;
  /** Short hint shown under a free-text answer box. */
  placeholder: string;
  /** Empty = free-text only. */
  options: KnowledgeOption[];
};

export const BUSINESS_KNOWLEDGE_CATALOG: readonly KnowledgeCategoryDefinition[] = [
  {
    key: "permit_handling",
    label: "Permit handling",
    question: "Do you handle permits?",
    placeholder: "e.g. We pull all permits required for your project.",
    options: [
      { id: "handle_all", label: "We handle permits and inspections", answer: "We handle permits and inspections." },
      { id: "assist", label: "We assist, homeowner files", answer: "We assist with permits, but the homeowner is responsible for filing them." },
      { id: "case_by_case", label: "Case-by-case", answer: "Permits are handled case-by-case depending on the project." },
      { id: "homeowner", label: "Homeowner is responsible", answer: "The homeowner is responsible for obtaining permits." },
    ],
  },
  {
    key: "inspection_handling",
    label: "Inspection handling",
    question: "Do you schedule and handle inspections?",
    placeholder: "e.g. We schedule and attend all required inspections.",
    options: [
      { id: "handle_all", label: "We schedule and handle inspections", answer: "We schedule and handle all required inspections." },
      { id: "assist", label: "We assist, homeowner schedules", answer: "We assist with inspections, but the homeowner is responsible for scheduling them." },
      { id: "case_by_case", label: "Case-by-case", answer: "Inspections are handled case-by-case depending on the project." },
      { id: "homeowner", label: "Homeowner is responsible", answer: "The homeowner is responsible for inspections." },
    ],
  },
  {
    key: "licensing",
    label: "Licensing & insurance",
    question: "Are you licensed and insured?",
    placeholder: "e.g. We are fully licensed and insured. License #…",
    options: [],
  },
  {
    key: "service_area",
    label: "Service area",
    question: "What areas do you serve?",
    placeholder: "Cities, counties, ZIP codes, or a short description of where you work.",
    options: [],
  },
  {
    key: "financing",
    label: "Financing",
    question: "Do you offer financing?",
    placeholder: "e.g. We offer financing through …",
    options: [
      { id: "offer", label: "We offer financing", answer: "We offer financing options for qualifying projects." },
      { id: "partner", label: "Through a lending partner", answer: "We work with a third-party lending partner for financing; we can share details during your consultation." },
      { id: "none", label: "We don't offer financing", answer: "We don't offer financing at this time." },
    ],
  },
  {
    key: "warranty",
    label: "Warranty",
    question: "Do you offer a warranty on your work?",
    placeholder: "e.g. 2-year workmanship warranty on all projects.",
    options: [
      { id: "workmanship", label: "We warranty our workmanship", answer: "We stand behind our work with a workmanship warranty." },
      { id: "manufacturer", label: "Manufacturer warranties only", answer: "Materials are covered by their manufacturer warranties." },
      { id: "none", label: "No warranty", answer: "We don't offer a separate warranty on our work." },
    ],
  },
  {
    key: "payment_methods",
    label: "Payment methods",
    question: "What payment methods do you accept?",
    placeholder: "e.g. Check, ACH, and major credit cards.",
    options: [],
  },
  {
    key: "deposits",
    label: "Deposits",
    question: "Do you require a deposit?",
    placeholder: "e.g. A 10% deposit is required to schedule work.",
    options: [],
  },
  {
    key: "project_minimums",
    label: "Project minimums",
    question: "Do you have a minimum project size?",
    placeholder: "e.g. We take projects starting at $5,000.",
    options: [],
  },
  {
    key: "estimate_policy",
    label: "Estimate / consultation policy",
    question: "Are estimates or consultations free?",
    placeholder: "e.g. In-home consultations and estimates are free.",
    options: [
      { id: "free", label: "Free estimates", answer: "Our estimates and consultations are free." },
      { id: "paid", label: "Paid consultation", answer: "We charge for consultations; the fee is credited toward your project if you move forward." },
      { id: "depends", label: "Depends on the project", answer: "Whether an estimate is free depends on the project." },
    ],
  },
  {
    key: "design_services",
    label: "Design services",
    question: "Do you offer design services?",
    placeholder: "e.g. Our in-house designer helps with layouts and selections.",
    options: [
      { id: "in_house", label: "In-house design", answer: "We offer in-house design services." },
      { id: "partner", label: "Through design partners", answer: "We work with design partners and can coordinate design services for your project." },
      { id: "none", label: "No design services", answer: "We don't offer design services; we build from your plans or your designer's." },
    ],
  },
  {
    key: "material_purchasing",
    label: "Material purchasing",
    question: "Who purchases the materials?",
    placeholder: "e.g. We purchase all materials unless you prefer to supply your own.",
    options: [
      { id: "we_purchase", label: "We purchase materials", answer: "We purchase and coordinate all materials for your project." },
      { id: "homeowner", label: "Homeowner purchases", answer: "The homeowner purchases materials, and we install them." },
      { id: "either", label: "Either option", answer: "Materials can be purchased by us or supplied by you — whichever you prefer." },
    ],
  },
  {
    key: "subcontractor_policy",
    label: "Subcontractor policy",
    question: "Do you use subcontractors?",
    placeholder: "e.g. We use our own crews for all trades except electrical.",
    options: [
      { id: "own_crews", label: "Our own crews only", answer: "All work is performed by our own crews." },
      { id: "vetted_subs", label: "Vetted subcontractors", answer: "We use trusted, vetted subcontractors for certain trades." },
    ],
  },
  {
    key: "cancellation_policy",
    label: "Cancellation / rescheduling policy",
    question: "What is your cancellation or rescheduling policy?",
    placeholder: "e.g. Please give 24 hours' notice to reschedule.",
    options: [],
  },
  {
    key: "typical_timelines",
    label: "Typical timelines",
    question: "How long do projects typically take?",
    placeholder: "e.g. Kitchen remodels typically take 6–10 weeks.",
    options: [],
  },
  {
    key: "business_hours",
    label: "Business hours",
    question: "What are your business hours?",
    placeholder: "e.g. Monday–Friday, 8am–5pm.",
    options: [],
  },
];

const CATALOG_BY_KEY = new Map(BUSINESS_KNOWLEDGE_CATALOG.map((c) => [c.key, c]));

export const BUSINESS_KNOWLEDGE_CATALOG_KEYS: readonly string[] = BUSINESS_KNOWLEDGE_CATALOG.map((c) => c.key);

export function getCatalogCategory(key: string): KnowledgeCategoryDefinition | undefined {
  return CATALOG_BY_KEY.get(key);
}

export function isCatalogKey(key: string): boolean {
  return CATALOG_BY_KEY.has(key);
}

/** Custom entries are keyed `custom_<slug>`; never collides with a catalog key. */
export const CUSTOM_KEY_PREFIX = "custom_";
export const CUSTOM_CATEGORY = "custom";
export const MAX_ANSWER_LENGTH = 1000;
export const MAX_QUESTION_LENGTH = 300;

const STOPWORDS = new Set(["a", "an", "the", "do", "does", "you", "your", "yours", "we", "i", "can", "could", "would", "will", "is", "are", "to", "of", "for", "and", "or", "my", "me", "it", "on", "in", "at", "with", "please", "also", "any", "have", "has", "get", "if"]);

/**
 * Deterministic canonical key for a custom (non-catalog) question. Same
 * question text (case/punctuation/stopword-insensitive) always yields the
 * same key, which is what makes "do not create a duplicate entry every time
 * the same clarification is answered" and pending-clarification coalescing
 * possible without any semantic matching.
 */
export function customKeyForQuestion(question: string): string {
  const tokens = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t));
  const slug = tokens.slice(0, 8).join("_").slice(0, 60) || "question";
  return `${CUSTOM_KEY_PREFIX}${slug}`;
}

/** Resolves a model-proposed category to a canonical key + stored category, or null if unusable. */
export function resolveKnowledgeTarget(
  category: string,
  question: string,
): { key: string; category: string } | null {
  if (isCatalogKey(category)) return { key: category, category };
  if (category === CUSTOM_CATEGORY) {
    const trimmed = question.trim();
    if (trimmed.length < 8) return null;
    return { key: customKeyForQuestion(trimmed), category: CUSTOM_CATEGORY };
  }
  return null;
}

/** Suggested options for a clarification — empty for custom/free-text categories. */
export function suggestedOptionsForKey(key: string): KnowledgeOption[] {
  return getCatalogCategory(key)?.options ?? [];
}
