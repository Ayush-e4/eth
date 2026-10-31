/** The Market as the API returns it (GET /market, GET /market/agents/:address). */
export interface MarketAgent {
  name: string;
  skill: string;
  title: string;
  description: string;
  priceUnits: string;
  agent: string;
  endpoint: string;
  identity?: { erc8004Id: string; paidJobs: number; averageScore: number | null };
  up: boolean | null;
  jobsHere: number;
  earnedHereUnits: string;
  lastJobAt: string | null;
}

export interface AgentDetail extends MarketAgent {
  hederaAccount: string | null;
  profileKey: string | null;
  listingKey: string | null;
  inputSchema: {
    properties?: Record<
      string,
      { type?: unknown; anyOf?: { type?: unknown }[]; description?: string; default?: unknown }
    >;
    required?: string[];
  } | null;
  delivered: number;
  refunded: number;
  deliveries: { key: string; task: string; status: "delivered" | "refunded"; refundTx?: string }[];
}

export const SKILL_TONE: Record<string, string> = {
  flights: "bg-[#EEEAF8] text-[#4E3D8F]",
  hotels: "bg-teal-soft text-teal",
  priceguard: "bg-saffron-soft text-saffron-ink",
  trips: "bg-[#E9F3E6] text-[#2F6A2A]",
};

export const initials = (name: string) =>
  name
    .split(/[\s·]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");

/** 1 base unit is the "no fee per job" placeholder (NO_JOB_FEE in @eth/arkiv), e.g. PriceGuard. */
export const feeText = (units: string) =>
  Number(units) > 1 ? `${(Number(units) / 1e6).toFixed(2)} USDC` : "no fee per job";

/** ERC-8004 scores are 0–100; shown as stars out of 5. */
export const stars = (score: number | null | undefined) =>
  score == null ? null : (score / 20).toFixed(1);
