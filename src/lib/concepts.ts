import { clauseById, type Clause } from "./knowledge";

// The material concepts a customer must actually understand before a Health Protection
// recommendation is suitable. Each one is anchored to clauses that exist in KNOWLEDGE — the
// ledger cites those pages, so an unanchored concept would produce an unciteable claim.
//
// `misconceptions` is authored content. The system detects *known* wrong framings, not arbitrary
// ones: every entry below is a framing the corpus directly contradicts, so a match is a real
// catch rather than a guess about what is in the customer's head.

export type Concept = {
  id: string;
  label: string;
  productArea: string;
  clauseIds: string[]; // anchors into KNOWLEDGE — the citation source
  terms: string[]; // surface forms that mean the customer is talking about this
  canonical: string; // the correct plain-language statement (the scoring target)
  misconceptions: string[]; // known wrong framings (the detection targets)
  qualifiers: string[]; // words carrying the limit; dropping one is a divergence
  teachBack: string; // the question that elicits demonstration rather than assent
  material: boolean; // if true, never raising it is itself a finding on the record
};

export const CONCEPTS: Concept[] = [
  {
    id: "deductible-definition",
    label: "Deductible",
    productArea: "Health Protection",
    clauseIds: ["deductible-definition", "out-of-pocket"],
    terms: [
      "deductible",
      "deductable",
      "excess",
      "pay first",
      "before the insurance",
      "before they pay",
      "upfront",
      "up front",
      "own pocket",
    ],
    canonical:
      "The deductible is the amount you pay yourself first, each policy year, before MediShield Life or PRUShield pays anything at all. It is paid once per policy year, not once per claim.",
    misconceptions: [
      "The insurer pays the first part of the bill and I only pay whatever is left over after that.",
      "The deductible is charged again on every separate claim I make during the year.",
      "The deductible is the monthly premium I pay to keep the plan running.",
      "The deductible is only payable if I stay overnight in hospital.",
    ],
    qualifiers: ["before", "first", "once", "policy year", "yourself"],
    teachBack:
      "Just so I know I explained it well — if your bill came to S$8,000 at a panel hospital, what would you expect to pay first, and who pays the rest?",
    material: true,
  },
  {
    id: "deductible-amounts",
    label: "Deductible amount",
    productArea: "Health Protection",
    clauseIds: ["deductible-amounts", "deductible-definition"],
    terms: [
      "how much is the deductible",
      "3,500",
      "3500",
      "2,500",
      "2500",
      "1,500",
      "1500",
      "ward",
      "class a",
      "a ward",
      "b1",
      "b2",
      "c ward",
      "day surgery",
    ],
    canonical:
      "How much the deductible is depends on the ward or setting you are treated in: S$1,500 in a C ward, S$2,000 in B2, S$2,500 in B1, and S$3,500 in an A ward or a private hospital.",
    misconceptions: [
      "The deductible is the same amount no matter which hospital or ward class I choose.",
      "The deductible is S$3,500 for everybody on every plan.",
      "Choosing a private hospital gives me a lower deductible.",
      "The deductible amount stays the same for life once the policy starts.",
    ],
    qualifiers: ["depends", "ward", "policy year", "setting"],
    teachBack:
      "If we compared a B1 ward with a private hospital, what would you expect the deductible to be in each case?",
    material: true,
  },
  {
    id: "co-insurance",
    label: "Co-insurance",
    productArea: "Health Protection",
    clauseIds: ["co-insurance", "pruextra-coinsurance-coverage"],
    terms: [
      "co-insurance",
      "coinsurance",
      "co insurance",
      "co-pay",
      "copay",
      "co payment",
      "10%",
      "10 percent",
      "ten percent",
      "share of the bill",
      "percentage of the bill",
    ],
    canonical:
      "Co-insurance is the 10% share of the claimable amount you co-pay after the deductible has been paid. With PRUExtra, half of that 10% is covered, so you pay the remaining half.",
    misconceptions: [
      "Co-insurance is just another name for the deductible.",
      "Once I have paid the deductible the insurer covers everything else in full.",
      "Co-insurance is ten percent of my premium rather than of the bill.",
      "PRUExtra removes the co-insurance completely so I pay none of it.",
    ],
    qualifiers: ["after", "10%", "claimable", "half", "50%"],
    teachBack:
      "Once the deductible is paid on a S$20,000 bill, roughly what share of the rest would still be yours?",
    material: true,
  },
  {
    id: "panel-providers",
    label: "Panel vs non-panel",
    productArea: "Health Protection",
    clauseIds: ["panel-providers", "pruextra-deductible-coverage"],
    terms: [
      "panel",
      "non-panel",
      "non panel",
      "off panel",
      "ppc",
      "prupanel",
      "extended panel",
      "any hospital",
      "any doctor",
      "any specialist",
      "own doctor",
      "own specialist",
      "own surgeon",
      "which hospital",
      "choose my doctor",
    ],
    canonical:
      "Panel and Extended Panel providers are what unlock the extra cover: 95% of the deductible above S$3,500, half the co-insurance, and the S$6,000 stop-loss cap. At a non-panel provider the deductible is not covered and stop-loss does not apply.",
    misconceptions: [
      "Any hospital or specialist is fine, the coverage works out the same wherever I go.",
      "Panel providers only mean shorter waiting times and nicer service.",
      "Going outside the panel costs me a little more but nothing significant.",
      "The stop-loss cap still limits what I pay even at a non-panel hospital.",
    ],
    qualifiers: ["panel", "extended panel", "only", "not covered", "does not apply"],
    teachBack:
      "If you chose a specialist who is not on the panel, what do you think would change about what you end up paying?",
    material: true,
  },
  {
    id: "stop-loss",
    label: "Stop-loss",
    productArea: "Health Protection",
    clauseIds: ["stop-loss", "panel-providers"],
    terms: [
      "stop-loss",
      "stop loss",
      "cap",
      "capped",
      "ceiling",
      "6,000",
      "6000",
      "most i would pay",
      "maximum i pay",
      "worst case",
    ],
    canonical:
      "Stop-loss caps your out-of-pocket co-insurance and co-payment at S$6,000 in a policy year, but only with a panel or Extended Panel provider or in an emergency. It does not include the deductible.",
    misconceptions: [
      "Stop-loss means I will never pay more than S$6,000 in total, deductible included.",
      "The S$6,000 cap applies wherever I choose to be treated.",
      "Stop-loss is a lifetime cap rather than a yearly one.",
    ],
    qualifiers: ["up to", "policy year", "panel", "co-insurance", "not the deductible"],
    teachBack:
      "In a really bad year, what is the most you think you would be out of pocket — and does that number include the deductible?",
    material: true,
  },
  {
    id: "pro-ration",
    label: "Pro-ration",
    productArea: "Health Protection",
    clauseIds: ["pro-ration", "plan-tiers"],
    terms: [
      "pro-ration",
      "proration",
      "pro rated",
      "prorated",
      "pro-rate",
      "upgrade",
      "higher ward",
      "better ward",
      "private hospital",
      "scaled down",
      "65%",
      "80%",
    ],
    canonical:
      "If you are treated in a ward or hospital above what your plan entitles you to, the claimable amount is scaled down first. On PRUShield Plus a private hospital claim is pro-rated to 65%; on Standard a private hospital is 50% and an A ward 80%.",
    misconceptions: [
      "I can be treated anywhere I like and still claim the full amount of the bill.",
      "Pro-ration is just a small administrative fee taken off the claim.",
      "Upgrading my ward on the day only costs me the difference in the ward rate.",
    ],
    qualifiers: ["higher than", "entitlement", "65%", "50%", "80%", "pro-rated"],
    teachBack:
      "If you were on Plus and went to a private hospital, how much of that bill would you expect to be claimable?",
    material: true,
  },
  {
    id: "medisave-premiums",
    label: "MediSave and premiums",
    productArea: "Health Protection",
    clauseIds: ["medisave-premiums"],
    terms: [
      "medisave",
      "cpf",
      "cash",
      "premium",
      "premiums",
      "afford",
      "cost per year",
      "yearly cost",
      "withdrawal limit",
      "pay for it",
    ],
    canonical:
      "PRUShield premiums can be paid from MediSave up to the Additional Withdrawal Limits, and only if the policy owner is a Singaporean or PR. PRUExtra premiums cannot be paid from MediSave — those come out of cash. Premiums are not guaranteed and are based on age next birthday.",
    misconceptions: [
      "MediSave covers the whole premium so this costs me nothing in cash.",
      "PRUExtra premiums can be paid out of MediSave as well.",
      "The premium is locked in and will not change as I get older.",
    ],
    qualifiers: ["up to", "withdrawal limits", "cannot", "not guaranteed"],
    teachBack:
      "Of the two premiums — the PRUShield one and the PRUExtra one — which would come out of MediSave and which out of cash?",
    material: true,
  },
  {
    id: "limits-of-cover",
    label: "Limits of cover",
    productArea: "Health Protection",
    clauseIds: ["limits-of-cover"],
    terms: [
      "limit",
      "limits",
      "how much does it cover",
      "maximum cover",
      "2 million",
      "2,000,000",
      "1 million",
      "1,000,000",
      "lifetime",
      "refresh benefit",
      "run out",
    ],
    canonical:
      "The Policy Year Limit is S$2,000,000 on Premier — but S$1,200,000 if the claims were not at panel providers — S$1,000,000 on Plus and S$200,000 on Standard. The Lifetime Limit is unlimited, and Premier and Plus refresh the yearly limit once if it is reached.",
    misconceptions: [
      "There is no limit at all on what the plan will pay out.",
      "The yearly limit is the same whether or not I use panel providers.",
      "Once I hit the yearly limit I am not covered again at all.",
    ],
    qualifiers: ["policy year", "panel", "once", "lifetime"],
    teachBack:
      "What do you understand the yearly ceiling to be on your plan — and does using a non-panel hospital change it?",
    material: false,
  },
];

// Concepts scoped to the session's product area. Other areas have no authored concepts yet, so
// they get an empty ledger rather than Health Protection concepts that could never be raised.
export function conceptsForArea(area: string): Concept[] {
  return CONCEPTS.filter((c) => c.productArea === area);
}

// The advisory areas the comprehension engine can actually track — i.e. the ones with authored
// concepts. The session picker offers only these: an area with clauses but no concepts would give
// the rep a live session where no readiness, no alert and an empty Understanding Record ever appear,
// with nothing on screen to say why. Today that is Health Protection alone; add concepts for another
// area and it shows up here automatically.
export function conceptAreas(): string[] {
  return [...new Set(CONCEPTS.map((c) => c.productArea))];
}

export function conceptById(id: string): Concept | undefined {
  return CONCEPTS.find((c) => c.id === id);
}

// The clauses backing a concept, skipping ids that no longer resolve.
export function clausesFor(concept: Concept): Clause[] {
  return concept.clauseIds.map(clauseById).filter((c): c is Clause => c !== undefined);
}

// Brochure page citations for the Understanding Record, deduplicated in clause order.
export function citationsFor(concept: Concept): string[] {
  return [...new Set(clausesFor(concept).map((c) => c.source))];
}

// Fail loudly at import rather than shipping a concept that can never cite a page.
const orphans = CONCEPTS.flatMap((c) =>
  c.clauseIds.filter((id) => !clauseById(id)).map((id) => `${c.id} -> ${id}`),
);
if (orphans.length) {
  throw new Error(`[concepts] clause ids missing from KNOWLEDGE: ${orphans.join(", ")}`);
}
