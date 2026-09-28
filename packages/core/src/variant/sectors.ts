/**
 * Sector frameworks: which KPIs matter, how the sector is valued, what usually moves the stocks
 * and how they typically react. Used to build analyst prompts and to select metrics to compare.
 */

export type SectorKey = "banks" | "software" | "semiconductors" | "biotech" | "consumer" | "industrials" | "energy" | "generic";

export interface SectorFramework {
  key: SectorKey;
  label: string;
  kpis: string[];
  valuationMethods: string[];
  commonCatalysts: string[];
  riskFactors: string[];
  typicalReactions: string[];
  /** Metrics from the internal forecast / consensus that matter most for a variant view, in priority order. */
  priorityMetrics: ("eps" | "revenue" | "marginPct" | "growthPct")[];
}

export const SECTOR_FRAMEWORKS: Record<SectorKey, SectorFramework> = {
  banks: {
    key: "banks",
    label: "Banks and financials",
    kpis: ["net interest margin", "net interest income", "loan growth", "deposit costs and betas", "credit costs / provisions", "CET1 ratio", "efficiency ratio", "ROTCE", "fee income mix"],
    valuationMethods: ["price to tangible book vs ROTCE", "P/E on normalised credit costs", "dividend and buyback yield"],
    commonCatalysts: ["rate path changes", "quarterly credit trends", "stress test results and capital return", "regulatory capital rule changes", "deposit flows"],
    riskFactors: ["credit cycle turn", "deposit flight", "rate sensitivity mismatch", "regulatory capital surprises", "commercial real estate exposure"],
    typicalReactions: ["NIM guidance moves the stock more than the EPS beat", "credit provisions surprises dominate late in the cycle", "capital return announcements re-rate slowly"],
    priorityMetrics: ["eps", "revenue", "marginPct", "growthPct"],
  },
  software: {
    key: "software",
    label: "Software and SaaS",
    kpis: ["ARR / RPO growth", "net revenue retention", "billings", "gross margin", "operating margin and rule of 40", "free cash flow margin", "customer count and seat expansion", "sales efficiency"],
    valuationMethods: ["EV / sales adjusted for growth", "EV / FCF", "rule-of-40 vs multiple regression", "reverse DCF on FCF margin path"],
    commonCatalysts: ["quarterly results and next-year guide", "large customer wins/losses", "pricing changes and product cycles", "AI product monetisation data points", "consumption trends"],
    riskFactors: ["deceleration in a high multiple", "seat compression", "competitive pricing", "SBC dilution", "long-duration valuation sensitivity to rates"],
    typicalReactions: ["a beat with a decelerating guide sells off", "multiple compression dominates estimate changes when growth slows", "reaction to billings/RPO exceeds reaction to revenue"],
    priorityMetrics: ["revenue", "growthPct", "marginPct", "eps"],
  },
  semiconductors: {
    key: "semiconductors",
    label: "Semiconductors",
    kpis: ["revenue by end market", "gross margin and utilisation", "inventory days (own and channel)", "book to bill / backlog", "capex and wafer starts", "pricing and mix", "design wins"],
    valuationMethods: ["P/E on mid-cycle earnings", "EV / sales through the cycle", "price to book for foundries/memory"],
    commonCatalysts: ["monthly industry data (SIA, TSMC sales)", "hyperscaler capex updates", "inventory correction end", "product ramps", "export control changes"],
    riskFactors: ["inventory cycle", "customer concentration", "geopolitics and export controls", "capex overbuild", "pricing collapse in commodity segments"],
    typicalReactions: ["stocks bottom while estimates are still falling", "cycle turns are traded months ahead of the data", "guidance beats matter more than the reported quarter"],
    priorityMetrics: ["revenue", "marginPct", "eps", "growthPct"],
  },
  biotech: {
    key: "biotech",
    label: "Biotech and pharma",
    kpis: ["trial readouts and endpoints", "regulatory timelines (PDUFA)", "cash runway", "launch trajectory and scripts", "pricing and reimbursement", "patent expiry schedule", "pipeline breadth"],
    valuationMethods: ["risk-adjusted NPV per asset", "EV / peak sales", "P/E for profitable pharma", "cash-adjusted enterprise value"],
    commonCatalysts: ["clinical data readouts", "FDA decisions", "M&A and licensing", "competitor data", "pricing policy"],
    riskFactors: ["binary trial outcomes", "dilution", "regulatory setbacks", "safety signals", "competition from later entrants"],
    typicalReactions: ["binary outcomes move 30-80%", "positive data priced ahead of the event leads to sell-the-news", "runway concerns cap rallies"],
    priorityMetrics: ["revenue", "growthPct", "eps", "marginPct"],
  },
  consumer: {
    key: "consumer",
    label: "Consumer",
    kpis: ["same-store / comparable sales", "traffic vs ticket", "gross margin and promotions", "inventory turns", "unit growth", "brand and pricing power", "channel mix (DTC/online)"],
    valuationMethods: ["P/E vs growth", "EV / EBITDA", "FCF yield", "EV / sales for growth concepts"],
    commonCatalysts: ["quarterly comps", "holiday season data", "pricing actions", "new store or product cycles", "consumer credit and employment data"],
    riskFactors: ["consumer demand slowdown", "input cost inflation", "promotional intensity", "channel shift", "fashion/brand risk"],
    typicalReactions: ["comps vs whisper decide the day", "margin commentary drives the guide reaction", "macro consumer data moves the whole group"],
    priorityMetrics: ["revenue", "marginPct", "eps", "growthPct"],
  },
  industrials: {
    key: "industrials",
    label: "Industrials",
    kpis: ["orders and backlog", "book to bill", "organic growth", "incremental margins", "pricing vs cost", "free cash conversion", "capacity utilisation"],
    valuationMethods: ["EV / EBITDA", "P/E on mid-cycle", "FCF yield", "sum-of-the-parts for conglomerates"],
    commonCatalysts: ["PMI and industrial production data", "order trends", "pricing announcements", "portfolio actions", "infrastructure and defence budgets"],
    riskFactors: ["cycle downturn", "input costs and tariffs", "project execution", "customer capex cuts", "labour"],
    typicalReactions: ["orders matter more than revenue", "incremental margin commentary drives multiples", "group trades with PMI surprises"],
    priorityMetrics: ["revenue", "marginPct", "eps", "growthPct"],
  },
  energy: {
    key: "energy",
    label: "Energy",
    kpis: ["production volumes", "realised prices vs benchmark", "cash cost per barrel / unit", "capex and free cash breakeven", "reserve replacement", "shareholder return framework", "refining margins / cracks"],
    valuationMethods: ["EV / EBITDA at strip", "FCF yield at strip", "NAV", "EV / reserves"],
    commonCatalysts: ["OPEC+ decisions", "inventory data", "quarterly production and capex guidance", "M&A", "policy and permitting"],
    riskFactors: ["commodity price", "political and regulatory", "capital discipline lapses", "cost inflation", "decarbonisation demand risk"],
    typicalReactions: ["commodity moves dominate company-specific news", "capex increases are punished", "buyback frameworks rerate slowly"],
    priorityMetrics: ["eps", "revenue", "marginPct", "growthPct"],
  },
  generic: {
    key: "generic",
    label: "Generic framework",
    kpis: ["revenue growth", "gross and operating margin", "free cash flow", "return on invested capital", "leverage", "guidance vs consensus"],
    valuationMethods: ["P/E vs growth and history", "EV / EBITDA", "FCF yield", "reverse DCF"],
    commonCatalysts: ["earnings and guidance", "investor days", "product or contract news", "M&A", "sector data"],
    riskFactors: ["estimate cuts", "multiple compression", "balance sheet", "competition", "regulation"],
    typicalReactions: ["guidance changes dominate the reaction", "crowded names react asymmetrically to bad news"],
    priorityMetrics: ["eps", "revenue", "growthPct", "marginPct"],
  },
};

const MATCHERS: [RegExp, SectorKey][] = [
  [/bank|financial|insur|lender|credit|asset manag|broker/i, "banks"],
  [/semi|chip|foundry|memory|gpu/i, "semiconductors"],
  [/software|saas|cloud|internet|information technology|it services|tech/i, "software"],
  [/bio|pharma|health|medical|life science|therapeut/i, "biotech"],
  [/consumer|retail|restaurant|apparel|leisure|staples|discretionary|auto/i, "consumer"],
  [/industrial|machinery|aerospace|defen[cs]e|transport|construction|capital goods/i, "industrials"],
  [/energy|oil|gas|petrol|refin|utilit|power/i, "energy"],
];

export function sectorKeyFor(sector: string | null | undefined, industry?: string | null): SectorKey {
  const hay = `${sector ?? ""} ${industry ?? ""}`.trim();
  if (hay.length === 0) return "generic";
  for (const [re, key] of MATCHERS) if (re.test(hay)) return key;
  return "generic";
}

export function frameworkFor(sector: string | null | undefined, industry?: string | null): SectorFramework {
  return SECTOR_FRAMEWORKS[sectorKeyFor(sector, industry)];
}

/** Plain-text rendering for prompts. */
export function describeFramework(f: SectorFramework): string {
  return [
    `Sector framework: ${f.label}`,
    `Key KPIs: ${f.kpis.join("; ")}`,
    `Valuation methods: ${f.valuationMethods.join("; ")}`,
    `Common catalysts: ${f.commonCatalysts.join("; ")}`,
    `Risk factors: ${f.riskFactors.join("; ")}`,
    `Typical reactions: ${f.typicalReactions.join("; ")}`,
  ].join("\n");
}
