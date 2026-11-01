// End to end on Hedera testnet, with a software passkey standing in for Face ID: make a wallet,
// give it test USDC, set a spending limit signed by the passkey, pay an agent from it, cancel it.
// Run: pnpm --filter @eth/mandates passkey-wallet-demo
import { loadConfig, NETWORKS } from "@eth/hedera";
import { createWalletClient, type Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  DEPLOYMENTS,
  erc20Abi,
  hederaTestnet,
  limitCalls,
  MandateClient,
  PasskeyWalletClient,
  randomNonce,
  revokeCalls,
  signPaymentAuth,
  tokenIdToEvmAddress,
  type WalletCall,
} from "../src";
import { softwarePasskey } from "./software-passkey";

const config = loadConfig();
const net = NETWORKS[config.network];
const key = (
  config.operatorKey.startsWith("0x") ? config.operatorKey : `0x${config.operatorKey}`
) as Hex;
const operator = privateKeyToAccount(key); // relayer, funder, and the stand-in agent
const usdc = tokenIdToEvmAddress(net.usdcTokenId);
const registry = DEPLOYMENTS.testnet.mandateRegistry;
const wallets = new PasskeyWalletClient(DEPLOYMENTS.testnet.passkeyWalletFactory);
const mc = new MandateClient(registry, hederaTestnet);
const tx = (h: string) => `${net.hashscanUrl}/transaction/${h}`;

// The "phone": a P-256 key, as a passkey is.
const k = softwarePasskey();
async function run(wallet: Hex, calls: WalletCall[]) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const d = await wallets.digest(wallet, calls, deadline);
  return wallets.execute(operator, wallet, calls, deadline, k.faceId(d));
}

console.log("1. make the wallet");
const wallet = await wallets.create(operator, k, usdc);
console.log(`   ${wallet}  ${net.hashscanUrl}/contract/${wallet}`);

console.log("2. give it 0.10 test USDC");
const fund = await createWalletClient({
  account: operator,
  chain: hederaTestnet,
  transport: http(),
}).writeContract({
  address: usdc,
  abi: erc20Abi,
  functionName: "transfer",
  args: [wallet, 100_000n],
});
await mc.publicClient.waitForTransactionReceipt({ hash: fund });
console.log(`   ${tx(fund)}`);

console.log("3. Face ID sets a 0.05 USDC limit (we only relay it)");
const limit = await run(
  wallet,
  limitCalls(registry, {
    agent: operator.address,
    token: usdc,
    budget: 50_000n,
    perPaymentCap: 50_000n,
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
    payees: [operator.address],
  }),
);
const id = limit.mandateId ?? 0n;
const m = await mc.getMandate(id);
console.log(`   mandate #${id}, owner ${m.owner}  ${tx(limit.hash)}`);
if (m.owner.toLowerCase() !== wallet.toLowerCase()) throw new Error("owner isn't the wallet");

console.log("4. the agent is paid 0.01 USDC out of the wallet");
const auth = {
  mandateId: id,
  payTo: operator.address,
  amount: 10_000n,
  nonce: randomNonce(),
  validBefore: BigInt(Math.floor(Date.now() / 1000) + 600),
};
const paid = await mc.pay(operator, auth, await signPaymentAuth(operator, mc.domain(), auth));
const left = await mc.publicClient.readContract({
  address: usdc,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [wallet],
});
console.log(`   wallet now holds ${Number(left) / 1e6} USDC  ${tx(paid.transactionHash)}`);

console.log("5. Face ID cancels the limit");
const revoked = await run(wallet, revokeCalls(registry, id));
console.log(`   revoked: ${(await mc.getMandate(id)).revoked}  ${tx(revoked.hash)}`);
