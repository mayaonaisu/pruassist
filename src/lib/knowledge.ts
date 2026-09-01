// PRUShield / PRUExtra clauses from the public brochure (Apr 2026). Re-verify figures before real advisory use.
// Adding a new product document? See docs/kb-authoring.md for the extraction-to-clause workflow.
import { WEB_KNOWLEDGE, WEB_DOCUMENT_AREA } from "./web-knowledge";

export type Clause = { id: string; source: string; text: string };

// Documents the AI can cite, derived from the clauses so the UI can't advertise a missing source.
export function knowledgeDocuments(): string[] {
  return [...new Set(KNOWLEDGE.map((c) => c.source.split(" · ")[0]))];
}

// Advisory areas the rep can pick, derived from the documents actually indexed.
const DOCUMENT_AREA: Record<string, string> = {
  "PRUShield Product Brochure (Apr 2026)": "Health Protection",
  "PRUActive Protect Brochure": "Critical Illness",
  "PRUPersonal Accident Brochure": "Personal Accident",
  "PRUActive Term Brochure": "Term Life",
  "PRUActive Retirement II Brochure": "Retirement",
  // Web documents ingested from prudential.com.sg (scripts/ingest-web.mts).
  ...WEB_DOCUMENT_AREA,
};

export function productAreas(): string[] {
  return [...new Set(knowledgeDocuments().map((d) => DOCUMENT_AREA[d]).filter(Boolean))];
}

// The advisory area a clause belongs to, so retrieval can be scoped to the session's product.
export function areaOfClause(clause: Clause): string | undefined {
  return DOCUMENT_AREA[clause.source.split(" · ")[0]];
}

// Clause lookup by id — the concept ledger anchors to ids, so it must resolve them cheaply.
// Built on first call: KNOWLEDGE is declared below and would be in the temporal dead zone here.
let byId: Map<string, Clause> | null = null;

export function clauseById(id: string): Clause | undefined {
  if (!byId) byId = new Map(KNOWLEDGE.map((c) => [c.id, c]));
  return byId.get(id);
}

// One row per document with the clause count and page span the retriever can cite.
export type DocumentIndex = { doc: string; clauses: number; pages: string };

export function knowledgeIndex(): DocumentIndex[] {
  return knowledgeDocuments().map((doc) => {
    const clauses = KNOWLEDGE.filter((c) => c.source.startsWith(doc));
    const pages = clauses.flatMap((c) => [...c.source.matchAll(/p\.(\d+)/g)].map((m) => Number(m[1])));
    return {
      doc,
      clauses: clauses.length,
      pages: pages.length ? `pp. ${Math.min(...pages)}–${Math.max(...pages)}` : "—",
    };
  });
}

const BROCHURE_KNOWLEDGE: Clause[] = [
  {
    id: "what-is-prushield",
    source: "PRUShield Product Brochure (Apr 2026) · p.3",
    text: "PRUShield is a MediSave-approved Integrated Shield Plan (IP) that complements your MediShield Life coverage. It comes in three tiers — PRUShield Standard, PRUShield Plus and PRUShield Premier — each offering different coverage levels, and can be combined with PRUExtra supplementary plans for additional protection and lower out-of-pocket costs.",
  },
  {
    id: "plan-tiers",
    source: "PRUShield Product Brochure (Apr 2026) · p.3, p.10",
    text: "PRUShield Standard covers medical and surgical expenses at restructured hospitals up to Class B1 wards. PRUShield Plus covers restructured hospitals up to Class A wards. PRUShield Premier covers both private and restructured hospitals. Where you can receive treatment depends on the tier you choose.",
  },
  {
    id: "deductible-definition",
    source: "PRUShield Product Brochure (Apr 2026) · p.2, p.12, p.17",
    text: "The deductible is the amount you need to pay before any MediShield Life and PRUShield benefits are paid out. It is paid once per policy year. It increases by 50% depending on ward class when the Life Assured is above age 85 (p.17).",
  },
  {
    id: "deductible-amounts",
    source: "PRUShield Product Brochure (Apr 2026) · p.17",
    text: "For PRUShield Premier/Plus, the per-policy-year deductible by setting is: Restructured Hospital C Ward S$1,500; B2/B2+ Ward S$2,000; B1 Ward S$2,500; A Ward S$3,500; Private Hospital S$3,500; Day Surgery (Subsidised) S$1,500; Day Surgery (Non-Subsidised) S$2,000; Short Stay Ward (Subsidised) S$1,500; Short Stay Ward (Non-Subsidised) S$2,000. PRUShield Standard has its own deductible schedule that also varies with age (see p.24).",
  },
  {
    id: "co-insurance",
    source: "PRUShield Product Brochure (Apr 2026) · p.2, p.12, p.17",
    text: "Co-insurance is a percentage of the claimable amount that a policyowner needs to co-pay after paying the deductible. Under PRUShield the co-insurance is 10%.",
  },
  {
    id: "out-of-pocket",
    source: "PRUShield Product Brochure (Apr 2026) · p.2, p.5",
    text: "On a covered hospital bill, the amounts payable by you are the deductible and the co-insurance; MediShield Life and PRUShield pay the rest. Adding a PRUExtra supplementary plan reduces both of these out-of-pocket portions.",
  },
  {
    id: "what-is-pruextra",
    source: "PRUShield Product Brochure (Apr 2026) · p.2, p.6",
    text: "PRUExtra is a supplementary plan (a rider / add-on) that complements your main PRUShield plan, with coverage of up to 50% of PRUShield's co-insurance, a stop-loss feature, and extended coverage for cancer treatment. It reduces your out-of-pocket expenses, especially when you use panel providers or PRUPanel Connect specialists.",
  },
  {
    id: "pruextra-plans",
    source: "PRUShield Product Brochure (Apr 2026) · p.6, p.10",
    text: "PRUShield Premier pairs with PRUExtra Premier Care (most comprehensive) or PRUExtra Preferred Care (value for money). PRUShield Plus pairs with PRUExtra Plus Care (budget-friendly). The right combination depends on where the customer wants to be treated and which providers they prefer.",
  },
  {
    id: "pruextra-deductible-coverage",
    source: "PRUShield Product Brochure (Apr 2026) · p.6, p.12",
    text: "For claims under panel providers and Extended Panel, PRUExtra covers 95% of the deductible amount above S$3,500 per policy year. Deductible of S$3,500 and below is not covered, and the deductible for claims not under panel providers is not covered.",
  },
  {
    id: "pruextra-coinsurance-coverage",
    source: "PRUShield Product Brochure (Apr 2026) · p.12, p.18",
    text: "PRUExtra covers 50% of PRUShield's co-insurance (which is 10%); you pay the remaining 50%. For PRUExtra Preferred Care, this co-insurance coverage does not apply at non-panel providers.",
  },
  {
    id: "stop-loss",
    source: "PRUShield Product Brochure (Apr 2026) · p.7, p.12",
    text: "The stop-loss benefit caps your out-of-pocket expenses at up to S$6,000 per policy year. Stop-loss refers to the total out-of-pocket expenses under the co-insurance and co-payment features, and will not exceed S$6,000 per policy year if your hospital confinement is with a panel provider, an Extended Panel (EP) specialist, or in an emergency. Stop-loss applies only to co-insurance and does not include the deductible.",
  },
  {
    id: "panel-providers",
    source: "PRUShield Product Brochure (Apr 2026) · p.7, p.8",
    text: "Providers are grouped as Panel, Extended Panel (EP), Non-Panel and No Access. Only participating PRUPanel Connect (PPC) providers let you enjoy exclusive services and no Claims-Based Premium Pricing impact. Using panel providers is what unlocks the 95%-of-deductible-above-S$3,500 coverage, the 50% co-insurance coverage and the S$6,000 stop-loss; at non-panel providers the deductible is not covered and stop-loss does not apply.",
  },
  {
    id: "pre-authorisation",
    source: "PRUShield Product Brochure (Apr 2026) · p.4, p.8",
    text: "Pre-Authorisation lets you gain early approval on upcoming treatments or surgeries that align with your policy benefits. An Extended Panel (EP) specialist must obtain Pre-Authorisation approval and adhere to the pre-authorised amount; failure to adhere to the pre-authorised amount results in a Non-Panel claim.",
  },
  {
    id: "pro-ration",
    source: "PRUShield Product Brochure (Apr 2026) · p.11, p.17, p.24",
    text: "A pro-ration factor reduces the claimable amount if you receive treatment in a hospital or ward class higher than your plan's entitlement (for example, a private hospital). For PRUShield Plus, private hospital and private day surgery claims are pro-rated to 65%. For PRUShield Standard, private hospital treatment is pro-rated to 50% and restructured Hospital A ward to 80%. Staying within your plan's entitled setting avoids pro-ration.",
  },
  {
    id: "pre-post-hospitalisation",
    source: "PRUShield Product Brochure (Apr 2026) · p.4, p.14",
    text: "PRUShield covers pre-hospitalisation consultations and diagnostic/laboratory services incurred within 180 days before confinement or day surgery, and post-hospitalisation follow-up treatments and diagnostic/laboratory services incurred within 365 days after confinement or day surgery.",
  },
  {
    id: "cancer-and-outpatient",
    source: "PRUShield Product Brochure (Apr 2026) · p.4, p.15",
    text: "Beyond inpatient stays, PRUShield provides comprehensive outpatient cancer treatment coverage of up to 20x MediShield Life limits for one primary cancer (combined with PRUExtra), and covers outpatient treatments such as radiotherapy, chemotherapy and immunotherapy, and kidney dialysis, subject to the plan's limits.",
  },
  {
    id: "limits-of-cover",
    source: "PRUShield Product Brochure (Apr 2026) · p.4, p.17, p.24",
    text: "Policy Year Limit — PRUShield Premier: S$2,000,000 (S$1,200,000 if claims are not incurred at panel providers); PRUShield Plus: S$1,000,000; PRUShield Standard: S$200,000. The Lifetime Limit is Unlimited. Premier and Plus include a Refresh Benefit that resets the Policy Year Limit once in the same policy year if the limit is reached.",
  },
  {
    id: "eligibility-renewal",
    source: "PRUShield Product Brochure (Apr 2026) · p.17, p.25",
    text: "For PRUShield Premier/Plus the Maximum Entry Age is 75 and the Maximum Renewal Age is Lifetime. PRUShield is a yearly renewable plan and Prudential guarantees lifetime coverage for PRUShield and PRUExtra. Eligibility covers Singapore Citizens, Singapore PRs and eligible Foreigners.",
  },
  {
    id: "medisave-premiums",
    source: "PRUShield Product Brochure (Apr 2026) · p.4, p.25",
    text: "PRUShield premiums may be paid with MediSave up to the Additional Withdrawal Limits, and the MediSave option applies only to policy owners who are Singaporeans or PRs. PRUExtra premiums cannot be paid by MediSave. Premiums are not guaranteed and are based on age next birthday.",
  },
  {
    id: "important-notes",
    source: "PRUShield Product Brochure (Apr 2026) · p.25",
    text: "The brochure is for reference only and is not a contract of insurance — refer to the exact terms, conditions and exclusions in the policy documents. Customers are recommended to read the product summary and seek advice from a qualified Prudential Financial Representative before purchasing. A policy can be cancelled in writing within the 21-day free look period for a refund of premiums paid, less medical fees and expenses incurred.",
  },
  {
    id: "protect-what-it-covers",
    source: "PRUActive Protect Brochure · p.2",
    text: "PRUActive Protect provides coverage against 37 critical illnesses, including major cancer, heart attack of specified severity, stroke with permanent neurological deficit, coronary artery bypass surgery, end stage kidney failure, end stage liver failure, and Alzheimer's Disease / severe dementia. It is designed to cushion the financial impact of a critical illness, including loss of income, even if the illness happens more than once.",
  },
  {
    id: "protect-term-and-age",
    source: "PRUActive Protect Brochure · p.3",
    text: "PRUActive Protect covers critical illness up to age 100, with a customisable policy term from 10 up to 99 years. Supplementary benefits can be added at any time during the policy term, but the maximum age to add on riders is 65.",
  },
  {
    id: "protect-crisis-care",
    source: "PRUActive Protect Brochure · p.3",
    text: "The Crisis Care Accelerator Benefit pays out when the insured undergoes surgery on a vital organ (heart, lung, brain, kidney or liver) as a result of illness or accident AND is admitted to an Intensive Care Unit for 3 consecutive days or more. Surgery due to organ donation is excluded. It is paid once only, at 50% of the benefit, subject to a cap of S$100,000 per life assured.",
  },
  {
    id: "protect-riders",
    source: "PRUActive Protect Brochure · p.3",
    text: "Optional supplementary benefits on PRUActive Protect: Protect Plus covers relapses or recurrences of any critical illness condition up to 500% of the selected coverage; Early Protect covers pre-critical stage critical illnesses and claims up to 100% of the coverage amount; Early Protect Plus gives repeated coverage against recurring or relapsed pre-critical stage critical illnesses up to 500% of the selected coverage. Life Protect Plus (additional death benefit), Severe Infections Protect and a Monthly Benefit paying out for 1 to 3 years are also available.",
  },
  {
    id: "protect-family-benefits",
    source: "PRUActive Protect Brochure · p.3",
    text: "Child Cover Benefit gives complimentary coverage for children against critical illnesses and juvenile conditions; when both parents each purchase a PRUActive Protect policy, all their unnamed children are entitled to it. Spouse Waiver Benefit provides a one-year premium waiver.",
  },
  {
    id: "protect-important-notes",
    source: "PRUActive Protect Brochure · p.5",
    text: "PRUActive Protect has no savings or investment feature, so there is no cash value if the policy ends or is terminated prematurely, and premiums are not guaranteed and may be adjusted based on future claims experience. Certain conditions, such as pre-existing conditions, are stated as exclusions in the contract and no benefits are payable for them. A waiting period and a survival period apply before critical illness benefits are payable — refer to the policy contract for details.",
  },
  {
    id: "term-what-it-is",
    source: "PRUActive Term Brochure · p.2",
    text: "PRUActive Term is a term life plan covering the life assured up to age 100, with a minimum sum assured of S$100,000 and the freedom to stop the policy at any time. Its basic death benefit sum assured can be increased annually, along with the premium, without the need to undergo a medical examination — so coverage keeps pace with growing commitments.",
  },
  {
    id: "term-premium-flexibility",
    source: "PRUActive Term Brochure · p.2",
    text: "PRUActive Term lets the customer choose their own premium payment term, anywhere from 5 to 82 years, so premiums can be paid over a shorter period rather than for the whole policy term.",
  },
  {
    id: "accident-what-it-covers",
    source: "PRUPersonal Accident Brochure · p.2",
    text: "PRUPersonal Accident gives 24-hour worldwide coverage and is designed to complement existing hospitalisation or medical insurance. It covers accidents, food poisoning, infectious diseases, and animal and insect bites. It pays 3 times the payout for public transport accidents, and 2 times for private transport and pedestrian accidents, building fires, and accidents during school-time. Injuries sustained during National Service, reservist duty and adventurous activities such as scuba diving are covered, treatment bills including Traditional Chinese Medicine are reimbursed, and coverage increases by up to 25% over the first five years if no claims are made.",
  },
  {
    id: "accident-plans",
    source: "PRUPersonal Accident Brochure · p.3",
    text: "PRUPersonal Accident comes in 6 plans (A to F). The Accidental Death and Dismemberment Benefit sum assured runs from S$100,000 on Plan A to S$1,000,000 on Plan F, with the double benefit at twice and the triple benefit at three times those amounts. Medical Reimbursement per accident or infectious disease ranges from up to S$2,000 on Plan A to up to S$6,000 on Plan F, and the Traditional Chinese Medicine benefit per accident from up to S$500 to up to S$1,500. It is also available as a supplementary benefit, Accident Assist, which can be added to selected main plans.",
  },
  {
    id: "retirement-what-it-is",
    source: "PRUActive Retirement II Brochure · p.2",
    text: "PRUActive Retirement II is a customisable retirement plan built to weather market volatility and provide a steady cumulative retirement income. Once payout begins the customer receives a guaranteed monthly income plus a non-guaranteed portion that can potentially increase year-on-year, so the monthly income never decreases.",
  },
  {
    id: "retirement-flexibility",
    source: "PRUActive Retirement II Brochure · p.2",
    text: "With PRUActive Retirement II the customer decides when payouts start and end — as early as age 50, received for up to 30 years — and can adjust the payout period as needs change. The premium term is flexible: a lump sum in the first year, or spread over a longer period.",
  },
];

// The hand-authored brochure clauses plus whatever has been ingested from the website — tagged and
// cited to the page URL. Retrieval and grounding treat both alike; only the brochure anchors concepts.
export const KNOWLEDGE: Clause[] = [...BROCHURE_KNOWLEDGE, ...WEB_KNOWLEDGE];
