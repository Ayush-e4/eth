// Pay on delivery, live on Hedera testnet, against the registry in .env (MANDATE_REGISTRY_*).
// Owner = the .env operator; the agent is a fresh key that only signs; the payee is a fresh
// Hedera account (it marks delivery and refunds with its own key).
// Run: pnpm --filter @eth/mandates escrow-demo
import { createAccount, createClient, loadConfig, NETWORKS, unitsToUsdc } from "@eth/hedera";
import { createWalletClient, decodeEventLog, type Hex, http, keccak256, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  DEPLOYMENTS,
  type EscrowAuth,
  EscrowClient,
  erc20Abi,
  hederaTestnet,
  MandateClient,
  mandateRegistryAbi,
  randomNonce,
  signEscrowAuth,
  tokenIdToEvmAddress,
} from "../src";

const config = loadConfig();
const net = NETWORKS[config.network];
const key = (
  config.operatorKey.startsWith("0x") ? config.operatorKey : `0x${config.operatorKey}`
) as Hex;
const owner = privateKeyToAccount(key);
const agent = privateKeyToAccount(generatePrivateKey());
const registry = DEPLOYMENTS.testnet.mandateRegistry;
const usdc = tokenIdToEvmAddress(net.usdcTokenId);
const mc = new MandateClient(registry, hederaTestnet);
const escrow = new EscrowClient(registry);
const tx = (hash: string) => `${net.hashscanUrl}/transaction/${hash}`;
const now = () => BigInt(Math.floor(Date.now() / 1000));
const balance = (who: `0x${string}`) =>
  mc.publicClient.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [who],
  });
const show = async (label: string, id: Hex) => {
  const e = await escrow.get(id);
  console.log(
    `   ${label}: escrow is ${e.state}; registry holds ${unitsToUsdc(await balance(registry))} USDC`,
  );
};

console.log(`registry ${registry} (${DEPLOYMENTS.testnet.mandateRegistryId})`);
const payeeKey = generatePrivateKey();
const made = await createAccount(createClient(config), {
  privateKey: payeeKey,
  initialHbar: 3,
  memo: "escrow demo payee",
});
const payee = privateKeyToAccount(payeeKey);
console.log(`0. payee ${made.accountId} (${payee.address})`);

if ((await mc.allowance(usdc, owner.address)) < 100_000n) await mc.approve(owner, usdc, 1_000_000n);
const { id: mandateId } = await mc.createMandate(owner, {
  agent: agent.address,
  token: usdc,
  budget: 100_000n,
  perPaymentCap: 50_000n,
  expiresAt: now() + 3600n,
  payees: [payee.address],
});
console.log(`1. limit #${mandateId}: up to 0.10 USDC, only to the payee`);

const wallet = createWalletClient({ account: owner, chain: hederaTestnet, transport: http() });
async function hold(amount: bigint) {
  const a: EscrowAuth = {
    mandateId,
    payTo: payee.address,
    amount,
    nonce: randomNonce(),
    validBefore: now() + 300n,
    deliverBy: now() + 3600n,
    reviewSeconds: 120,
  };
  const sig = await signEscrowAuth(agent, mc.domain(), a);
  const hash = await wallet.writeContract({
    address: registry,
    abi: mandateRegistryAbi,
    functionName: "payIntoEscrow",
    args: [a, sig],
  });
  const r = await mc.publicClient.waitForTransactionReceipt({ hash });
  const ev = r.logs
    .map((l) => {
      try {
        return decodeEventLog({ abi: mandateRegistryAbi, data: l.data, topics: l.topics });
      } catch {
        return null;
      }
    })
    .find((x) => x?.eventName === "Escrowed");
  if (!ev) throw new Error(`no Escrowed event in ${hash}`);
  return { id: (ev.args as { id: Hex }).id, hash };
}

const before = await balance(payee.address);
const job = await hold(20_000n);
console.log(`2. paid 0.02 USDC into escrow  ${tx(job.hash)}`);
await show("   ", job.id);
const delivered = await escrow.markDelivered(payee, job.id, keccak256(toHex("the packing list")));
console.log(`3. payee marked it delivered  ${tx(delivered.transactionHash)}`);
const released = await escrow.release(owner, job.id);
console.log(`4. buyer released it  ${tx(released.transactionHash)}`);
await show("   ", job.id);
console.log(`   payee got ${unitsToUsdc((await balance(payee.address)) - before)} USDC`);

const failed = await hold(10_000n);
console.log(`5. paid 0.01 USDC into escrow for a job that fails  ${tx(failed.hash)}`);
const refunded = await escrow.refund(payee, failed.id);
console.log(`6. payee couldn't deliver and refunded  ${tx(refunded.transactionHash)}`);
await show("   ", failed.id);
console.log(
  `   limit left: ${unitsToUsdc(await mc.remaining(mandateId))} of 0.10 USDC (the refund came back to it)`,
);
process.exit(0);
