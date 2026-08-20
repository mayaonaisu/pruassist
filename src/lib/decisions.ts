import { conceptById } from "./concepts";
import { clauseById } from "./knowledge";
import { termRegex } from "./agent/utterance";

// The comparisons a representative actually works through with a customer, and the concepts that
// decide them.
//
// The split between `prerequisites` and `differentiators` is the whole mechanism. A prerequisite is
// something without which the comparison is meaningless — you cannot weigh two deductibles against
// each other without knowing what a deductible is. A differentiator is something that changes which
// option is right. Only differentiators gate a recommendation, because those are where the money
// actually differs.

export type Option = {
  id: string;
  label: string;
  clauseIds: string[]; // anchors into KNOWLEDGE — the citation source
  gist: string; // one plain line the rep could say out loud
};

export type Decision = {
  id: string;
  productArea: string;
  question: string;
  options: Option[];
  prerequisites: string[];
  differentiators: string[];
  terms: string[]; // surface forms that mean the customer is asking to compare
};

export const DECISIONS: Decision[] = [
  {
    id: "which-tier",
    productArea: "Health Protection",
    question: "Which PRUShield tier?",
    options: [
      {
        id: "premier",
        label: "PRUShield Premier",
        clauseIds: ["plan-tiers", "limits-of-cover"],
        gist: "Private and restructured hospitals, with a S$2,000,000 yearly limit.",
      },
      {
        id: "plus",
        label: "PRUShield Plus",
        clauseIds: ["plan-tiers", "limits-of-cover", "pro-ration"],
        gist: "Restructured hospitals up to Class A, S$1,000,000 a year, and private stays pro-rated to 65%.",
      },
      {
        id: "standard",
        label: "PRUShield Standard",
        clauseIds: ["plan-tiers", "limits-of-cover", "pro-ration"],
        gist: "Restructured hospitals up to Class B1, S$200,000 a year, and private stays pro-rated to 50%.",
      },
    ],
    prerequisites: ["deductible-definition"],
    differentiators: ["pro-ration", "deductible-amounts", "limits-of-cover"],
    terms: [
      "premier",
      "plus",
      "standard",
      "which plan",
      "which tier",
      "which one",
      "difference between",
      "compare",
      "versus",
      "vs",
      "better",
    ],
  },
  {
    id: "add-pruextra",
    productArea: "Health Protection",
    question: "Add PRUExtra?",
    options: [
      {
        id: "with-rider",
        label: "With PRUExtra",
        clauseIds: [
          "what-is-pruextra",
          "pruextra-deductible-coverage",
          "pruextra-coinsurance-coverage",
          "stop-loss",
        ],
        gist: "95% of the deductible above S$3,500 at panel providers, half the co-insurance, and out-of-pocket capped at S$6,000.",
      },
      {
        id: "without-rider",
        label: "Without PRUExtra",
        clauseIds: ["out-of-pocket", "co-insurance", "deductible-definition"],
        gist: "You pay the deductible in full and the whole 10% co-insurance, with no stop-loss cap.",
      },
    ],
    prerequisites: ["deductible-definition", "co-insurance"],
    // MediSave is not padding: PRUExtra premiums cannot be paid from it, so the rider has a real
    // cash-flow consequence the customer has to understand before choosing.
    differentiators: ["panel-providers", "stop-loss", "medisave-premiums"],
    terms: [
      "pruextra",
      "rider",
      "add-on",
      "add on",
      "supplementary",
      "worth it",
      "upgrade",
      "top up",
      "extra cover",
    ],
  },
];

export function decisionsForArea(area: string): Decision[] {
  return DECISIONS.filter((d) => d.productArea === area);
}

export function decisionById(id: string): Decision | undefined {
  return DECISIONS.find((d) => d.id === id);
}

/** Whether an utterance is asking to compare, rather than to have something explained. */
export function looksComparative(text: string, decision: Decision): boolean {
  return decision.terms.some((t) => termRegex(t).test(text));
}

// Fail loudly at import rather than shipping a decision that cannot cite a page or name a concept.
const broken = DECISIONS.flatMap((d) => [
  ...d.options.flatMap((o) => o.clauseIds.filter((id) => !clauseById(id)).map((id) => `${d.id}/${o.id} -> ${id}`)),
  ...[...d.prerequisites, ...d.differentiators].filter((id) => !conceptById(id)).map((id) => `${d.id} -> ${id}`),
]);
if (broken.length) {
  throw new Error(`[decisions] ids missing from KNOWLEDGE or CONCEPTS: ${broken.join(", ")}`);
}
