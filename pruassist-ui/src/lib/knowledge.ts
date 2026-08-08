// PRUShield / PRUExtra Health Protection knowledge base.
//
// Clauses below are sourced from Prudential's public "PRUShield" Product Brochure
// (information correct as at 1 April 2026). Page numbers ("p.N") refer to that
// brochure PDF. The text is quoted/closely grounded in the brochure so the AI can
// cite an exact source; figures should still be re-verified against the latest
// brochure and the policy documents before any real advisory use — the brochure
// itself states it "is for reference only and is not a contract of insurance."
//
// Scope: Health Protection only (PRUShield base plan + PRUExtra supplementary plan).
// To add other lines (Life, Critical Illness) later, append clauses in the same shape.

export type Clause = { id: string; source: string; text: string };

export const KNOWLEDGE: Clause[] = [
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
    source: "PRUShield Product Brochure (Apr 2026) · p.2, p.12",
    text: "The deductible is the amount you need to pay before any MediShield Life and PRUShield benefits are paid out. It is paid once per policy year. It increases by 50% depending on ward class when the Life Assured is above age 85.",
  },
  {
    id: "deductible-amounts",
    source: "PRUShield Product Brochure (Apr 2026) · p.17",
    text: "For PRUShield Premier/Plus, the per-policy-year deductible by setting is: Restructured Hospital C Ward S$1,500; B2/B2+ Ward S$2,000; B1 Ward S$2,500; A Ward S$3,500; Private Hospital S$3,500; Day Surgery (Subsidised) S$1,500; Day Surgery (Non-Subsidised) S$2,000. PRUShield Standard has its own deductible schedule that also varies with age (see p.24).",
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
];
