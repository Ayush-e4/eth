// Live Arkiv marketplace demo on the Tiramisu testnet.
//   1. platform wallet funds two fresh agent wallets with a little GLM (Arkiv gas)
//   2. each agent publishes its own profile + listings (one atomic batch)
//   3. buyer searches listings by skill and price
//   4. agents post quotes for a task — one lives 20s, one 3 minutes — and the short one expires
//   5. buyer opens a job, platform records a receipt (pointing at a real Hedera tx), buyer rates
// Run: pnpm --filter @eth/arkiv demo
import { createWalletClient, formatEther, type Hex, http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ARKIV_CHAIN,
  ARKIV_EXPLORER,
  arkivReader,
  arkivWriter,
  findListings,
  liveQuotes,
  openJob,
  postQuote,
  publishAgent,
  rateAgent,
  ratingsFor,
  receiptsForTask,
  recordReceipt,
  setJobStatus,
} from "../src";

const raw = process.env.HEDERA_PRIVATE_KEY ?? "";
const platformKey = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
const platform = arkivWriter(platformKey);
const reader = arkivReader();
const explorerTx = ARKIV_EXPLORER.tx;
const task = `goa-weekend-${Date.now().toString(36)}`;

// ── 1. Fund two agent wallets ─────────────────────────────────────────
const balance = await reader.getBalance({ address: platform.account.address });
console.log(`platform ${platform.account.address} has ${formatEther(balance)} GLM`);
if (balance < parseEther("0.2")) {
  console.log("Need test GLM: https://hub.arkiv.network/faucet");
  process.exit(1);
}
const flightsKey = generatePrivateKey();
const hotelsKey = generatePrivateKey();
const funder = createWalletClient({
  chain: ARKIV_CHAIN,
  transport: http(),
  account: privateKeyToAccount(platformKey),
});
for (const k of [flightsKey, hotelsKey]) {
  const hash = await funder.sendTransaction({
    to: privateKeyToAccount(k).address,
    value: parseEther("0.05"),
  });
  await reader.waitForTransactionReceipt({ hash });
}
const flights = arkivWriter(flightsKey);
const hotels = arkivWriter(hotelsKey);
console.log("1. funded flights + hotels agent wallets with 0.05 GLM each");

// ── 2. Agents publish themselves ──────────────────────────────────────
const fa = flights.account.address;
const ha = hotels.account.address;
const f = await publishAgent(
  flights,
  {
    agent: fa,
    name: "SkyHop",
    skill: "flights",
    hederaAccount: "0.0.11102187",
    description: "Books domestic flights (sandbox).",
    endpoint: "https://agents.example/flights",
  },
  [
    {
      agent: fa,
      skill: "flights",
      priceUnits: 50_000n,
      acceptsCredits: false,
      title: "Search + book a flight",
      endpoint: "https://agents.example/flights/book",
    },
  ],
);
const h = await publishAgent(
  hotels,
  {
    agent: ha,
    name: "StayWise",
    skill: "hotels",
    hederaAccount: "0.0.11102187",
    description: "Finds and books hotels (sandbox).",
    endpoint: "https://agents.example/hotels",
  },
  [
    {
      agent: ha,
      skill: "hotels",
      priceUnits: 40_000n,
      acceptsCredits: true,
      title: "Book a hotel",
      endpoint: "https://agents.example/hotels/book",
    },
    {
      agent: ha,
      skill: "flights",
      priceUnits: 80_000n,
      acceptsCredits: true,
      title: "Flight + hotel bundle",
      endpoint: "https://agents.example/hotels/bundle",
    },
  ],
);
console.log(`2. SkyHop published profile + 1 listing   ${explorerTx(f.txHash)}`);
console.log(`   StayWise published profile + 2 listings ${explorerTx(h.txHash)}`);

// ── 3. Buyer searches ────────────────────────────────────────────────
const cheapFlights = await findListings(reader, { skill: "flights", maxPriceUnits: 100_000n });
console.log(
  `3. flight listings ≤ 0.10 USDC: ${cheapFlights.map((l) => `${l.record.title} (${Number(l.record.priceUnits) / 1e6} USDC)`).join(", ")}`,
);

// ── 4. Quotes that expire ────────────────────────────────────────────
await postQuote(
  flights,
  { agent: fa, task, skill: "flights", priceUnits: 45_000n, note: "Flash deal: BOM→GOI Fri 19:00" },
  20,
);
await postQuote(
  hotels,
  { agent: ha, task, skill: "flights", priceUnits: 70_000n, note: "Bundle with beach hotel" },
  180,
);
let quotes = await liveQuotes(reader, task);
console.log(`4. live quotes for ${task}:`);
for (const q of quotes)
  console.log(
    `   ${Number(q.record.priceUnits) / 1e6} USDC "${q.record.note}" — expires in ~${q.secondsLeft}s`,
  );
console.log("   waiting 26s for the flash deal to expire…");
await new Promise((r) => setTimeout(r, 26_000));
quotes = await liveQuotes(reader, task);
console.log(
  `   now ${quotes.length} live quote(s): ${quotes.map((q) => `"${q.record.note}"`).join(", ")}`,
);

// ── 5. Hire, receipt, rating ─────────────────────────────────────────
const chosen = quotes[0];
if (!chosen) throw new Error("no live quote left");
const buyer = platform.account.address;
const job = await openJob(platform, {
  task,
  buyer,
  seller: chosen.record.agent,
  quote: chosen.key,
  status: "open",
  mandateId: 3n,
  description: "Flight for the Goa weekend",
});
await setJobStatus(platform, job.entityKey, "paid");
await recordReceipt(platform, {
  job: job.entityKey,
  task,
  mandateId: 3n,
  payer: "0.0.11045937",
  payTo: "0.0.11102187",
  amountUnits: 50_000n,
  hederaTx: "0.0.11045937@1792525338.775588222",
  hcsSequence: 1n,
});
await rateAgent(platform, {
  agent: chosen.record.agent,
  job: job.entityKey,
  rater: buyer,
  score: 5,
  comment: "Fast and cheap",
});
const receipts = await receiptsForTask(reader, task, buyer);
const { average } = await ratingsFor(reader, chosen.record.agent);
console.log(
  `5. job ${job.entityKey.slice(0, 10)}… paid; receipt → Hedera ${receipts[0]?.record.hederaTx}; seller rating ${average}/5`,
);
console.log(`   job entity: ${ARKIV_EXPLORER.entity(job.entityKey)}`);
