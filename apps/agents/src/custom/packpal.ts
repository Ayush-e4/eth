// PackPal: made with the agent kit (docs/build-an-agent.md).
// Change NAME, SKILL, PRICE, what it accepts (Input), quote() and work(); everything else (the
// Arkiv listing, quotes, x402 payments, refunds, job records, crash recovery) is done for you.
// Run it with `pnpm --filter @eth/agents run-agent <slug>`. Guide: docs/build-an-agent.md
import { z } from "zod";
import type { SpecialistDef } from "../specialists/server";

const NAME = "PackPal";
const SKILL = "packing"; // what buyers search for: lowercase, a-z 0-9 _ . -
const PRICE = 10_000n; // the fee per job, in USDC base units (10_000 = 0.01 USDC)

/** What a buyer sends. Descriptions show up on your Market page and for other AIs. */
const Input = z.object({
  destination: z.string().min(1).max(60).describe("Where they're going, e.g. Goa"),
  days: z.number().int().min(1).max(30).describe("How many days"),
  weather: z.enum(["hot", "mild", "cold", "rainy"]).default("mild").describe("Expected weather"),
  activities: z
    .array(z.string().max(40))
    .max(10)
    .default([])
    .describe('Plans, e.g. ["beach", "trek"]'),
});
type Input = z.infer<typeof Input>;

const BY_WEATHER: Record<Input["weather"], string[]> = {
  hot: ["sunscreen", "sunglasses", "a hat", "light cotton clothes"],
  mild: ["a light jacket", "comfortable shoes"],
  cold: ["a warm jacket", "thermals", "gloves"],
  rainy: ["an umbrella", "a rain jacket", "quick-dry shoes"],
};
const BY_ACTIVITY: Record<string, string[]> = {
  beach: ["swimwear", "flip-flops", "a beach towel"],
  trek: ["trekking shoes", "a daypack", "a water bottle"],
  work: ["laptop and charger", "one formal outfit"],
};

/** The job itself: here a packing list; yours can call any API, model or service. */
function pack(t: Input) {
  const changes = Math.min(t.days, 7);
  return [
    `${changes} sets of clothes`,
    "toiletries",
    "phone charger and power bank",
    "ID and tickets",
    ...BY_WEATHER[t.weather],
    ...t.activities.flatMap((a) => BY_ACTIVITY[a.toLowerCase()] ?? []),
  ];
}

export default function agent(): SpecialistDef<
  Input,
  Input,
  { destination: string; list: string[] }
> {
  return {
    name: NAME,
    skill: SKILL,
    title: `${NAME} — a packing list for your trip`,
    description:
      "Tell it where you're going, for how long and what you'll do; it writes a packing list.",
    priceUnits: PRICE,
    input: Input,
    // Free: say what you'd do and for how much. Nothing is paid yet.
    async quote({ input }) {
      return {
        note: `Packing list for ${input.days} days in ${input.destination}`,
        detail: input,
        itemTotal: 0, // nothing to buy beyond your fee
        itemCurrency: "INR",
      };
    },
    // Paid: the buyer's fee has settled on Hedera. Throwing here refunds it automatically.
    async work(_req, quoted) {
      return { destination: quoted.destination, list: pack(quoted) };
    },
  };
}
