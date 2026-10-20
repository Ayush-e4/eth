// Live MandateRegistry walkthrough on Hedera testnet.
// Owner = the .env operator. Agents are fresh keys that only sign (they never pay gas).
// Run: pnpm --filter @eth/mandates demo [airlineEvmAddress]
import { loadConfig, Mirror, NETWORKS, unitsToUsdc } from "@eth/hedera";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  DEPLOYMENTS,
  hashPayees,
  hederaTestnet,
  MandateClient,
  type PaymentAuth,
  randomNonce,
  signPaymentAuth,
  signSubMandateAuth,
  tokenIdToEvmAddress,
} from "../src";

const config = loadConfig();
const net = NETWORKS[config.network];
const key = (
  config.operatorKey.startsWith("0x") ? config.operatorKey : `0x${config.operatorKey}`
) as Hex;
const owner = privateKeyToAccount(key);
const tripAgent = privateKeyToAccount(generatePrivateKey());
const flightsAgent = privateKeyToAccount(generatePrivateKey());
const airline = (process.argv[2] ?? "0xf690e2189f16441aff2510b2f7da456abd6e22d5") as Address;
const attacker = privateKeyToAccount(generatePrivateKey()).address;

const usdc = tokenIdToEvmAddress(net.usdcTokenId);
const mc = new MandateClient(DEPLOYMENTS.testnet.mandateRegistry, hederaTestnet);
const domain = mc.domain();
const tx = (hash: string) => `${net.hashscanUrl}/transaction/${hash}`;
const now = () => BigInt(Math.floor(Date.now() / 1000));
const usd = (units: bigint) => `${unitsToUsdc(units)} USDC`;

function auth(mandateId: bigint, payTo: Address, amount: bigint): PaymentAuth {
  return { mandateId, payTo, amount, nonce: randomNonce(), validBefore: now() + 300n };
}

async function expectRejected(label: string, a: PaymentAuth, sig: Hex, expected: string) {
  const got = await mc.checkPay(owner.address, a, sig);
  console.log(
    `  ${got === expected ? "✓" : "✗"} ${label}: rejected with ${got ?? "nothing (would succeed!)"}`,
  );
}

// 1. Owner approves the registry (funds stay in the owner's account).
console.log("1. Approve");
if ((await mc.allowance(usdc, owner.address)) < 2_000_000n) {
  const r = await mc.approve(owner, usdc, 2_000_000n);
  console.log(`  approved registry for 2 USDC  ${tx(r.transactionHash)}`);
} else console.log("  allowance already ≥ 2 USDC");

// 2. Root mandate: trip agent, budget 1 USDC, max 0.5 per payment, airline only, 1 hour.
console.log("2. Create mandate");
const { id: root, receipt: created } = await mc.createMandate(owner, {
  agent: tripAgent.address,
  token: usdc,
  budget: 1_000_000n,
  perPaymentCap: 500_000n,
  expiresAt: now() + 3600n,
  payees: [airline],
});
console.log(
  `  mandate #${root} for trip agent ${tripAgent.address}  ${tx(created.transactionHash)}`,
);

// 3. A valid payment.
console.log("3. Trip agent pays the airline 0.3 USDC");
const ok = auth(root, airline, 300_000n);
const okSig = await signPaymentAuth(tripAgent, domain, ok);
const paid = await mc.pay(owner, ok, okSig);
console.log(`  paid  ${tx(paid.transactionHash)}`);

// 4. Things the contract refuses — no prompt can talk its way past these.
console.log("4. Attacks and mistakes");
const big = auth(root, airline, 600_000n);
await expectRejected(
  "0.6 USDC (cap 0.5)",
  big,
  await signPaymentAuth(tripAgent, domain, big),
  "OverPaymentCap",
);
const steal = auth(root, attacker, 100_000n);
await expectRejected(
  "pay unknown address",
  steal,
  await signPaymentAuth(tripAgent, domain, steal),
  "PayeeNotAllowed",
);
const small = auth(root, airline, 100_000n);
const smallSig = await signPaymentAuth(tripAgent, domain, small);
await expectRejected(
  "signed 0.1, submitted 0.4",
  { ...small, amount: 400_000n },
  smallSig,
  "BadSignature",
);
await expectRejected("replay the paid authorisation", ok, okSig, "NonceUsed");
const forged = auth(root, airline, 100_000n);
await expectRejected(
  "signed by a stranger",
  forged,
  await signPaymentAuth(flightsAgent, domain, forged),
  "BadSignature",
);

// 5. Sub-mandate: trip agent hands 0.4 USDC of its budget to the flights agent.
console.log("5. Sub-mandate");
const payees = [airline] as const;
const subAuth = {
  parentId: root,
  agent: flightsAgent.address,
  budget: 400_000n,
  perPaymentCap: 400_000n,
  expiresAt: now() + 1800n,
  payeesHash: hashPayees(payees),
  nonce: randomNonce(),
  validBefore: now() + 300n,
};
const subSig = await signSubMandateAuth(tripAgent, domain, subAuth);
const { id: sub, receipt: subReceipt } = await mc.createSubMandate(owner, subAuth, payees, subSig);
console.log(
  `  mandate #${sub} for flights agent (0.4 USDC carved from #${root})  ${tx(subReceipt.transactionHash)}`,
);
const flight = auth(sub, airline, 200_000n);
const flightPaid = await mc.pay(owner, flight, await signPaymentAuth(flightsAgent, domain, flight));
console.log(`  flights agent paid the airline 0.2 USDC  ${tx(flightPaid.transactionHash)}`);

// 6. Kill switch: owner revokes the root; the sub-mandate stops too.
console.log("6. Revoke");
const revoked = await mc.revoke(owner, root);
console.log(`  owner revoked #${root}  ${tx(revoked.transactionHash)}`);
const after = auth(sub, airline, 100_000n);
await expectRejected(
  "flights agent pays after revoke",
  after,
  await signPaymentAuth(flightsAgent, domain, after),
  "MandateInactive",
);

// 7. Summary.
const r = await mc.getMandate(root);
const s = await mc.getMandate(sub);
console.log("7. Summary");
console.log(
  `  #${root}: budget ${usd(r.budget)}, spent ${usd(r.spent)}, delegated ${usd(r.delegated)}, active ${await mc.isActive(root)}`,
);
console.log(
  `  #${sub}: budget ${usd(s.budget)}, spent ${usd(s.spent)}, active ${await mc.isActive(sub)}`,
);
const airlineBal =
  (await new Mirror(net.mirrorUrl).balances(airline)).tokens[net.usdcTokenId] ?? 0n;
console.log(`  airline balance now ${usd(airlineBal)} (mirror node may lag a few seconds)`);
