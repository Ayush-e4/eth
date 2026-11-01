// One account, two devices, on Hedera testnet: a v2 wallet made by the phone's passkey lets the
// laptop's in, the laptop sets a spending limit, then the phone shuts the laptop out again.
// Software passkeys stand in for Face ID. Run: pnpm --filter @eth/mandates multi-device-demo
import { loadConfig, NETWORKS } from "@eth/hedera";
import { createWalletClient, type Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  addKeyCalls,
  DEPLOYMENTS,
  erc20Abi,
  hederaTestnet,
  limitCalls,
  MandateClient,
  PasskeyWalletClient,
  removeKeyCalls,
  revokeCalls,
  tokenIdToEvmAddress,
  type WalletCall,
} from "../src";
import { softwarePasskey } from "./software-passkey";

const config = loadConfig();
const net = NETWORKS[config.network];
const key = (
  config.operatorKey.startsWith("0x") ? config.operatorKey : `0x${config.operatorKey}`
) as Hex;
const operator = privateKeyToAccount(key); // relayer and funder
const usdc = tokenIdToEvmAddress(net.usdcTokenId);
const registry = DEPLOYMENTS.testnet.mandateRegistry;
const wallets = new PasskeyWalletClient(DEPLOYMENTS.testnet.passkeyWalletFactoryV2);
const mc = new MandateClient(registry, hederaTestnet);
const tx = (h: string) => `${net.hashscanUrl}/transaction/${h}`;

const phone = softwarePasskey();
const laptop = softwarePasskey();
type Device = ReturnType<typeof softwarePasskey>;

async function run(device: Device, wallet: Hex, calls: WalletCall[]) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const d = await wallets.digest(wallet, calls, deadline);
  const sig = { qx: device.qx, qy: device.qy, sig: device.faceId(d) };
  return wallets.execute(operator, wallet, calls, deadline, sig);
}
async function refused(device: Device, wallet: Hex, calls: WalletCall[]) {
  try {
    await run(device, wallet, calls);
  } catch (e) {
    return (e as Error).message.match(/NotAKey|LastKey|BadSignature/)?.[0] ?? "refused";
  }
  throw new Error("it should have been refused");
}
const limit = () =>
  limitCalls(registry, {
    agent: operator.address,
    token: usdc,
    budget: 20_000n,
    perPaymentCap: 20_000n,
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
    payees: [],
  });

console.log("1. the phone's passkey makes the wallet; it gets 0.05 test USDC");
const wallet = await wallets.create(operator, phone, usdc);
const fund = await createWalletClient({
  account: operator,
  chain: hederaTestnet,
  transport: http(),
}).writeContract({
  address: usdc,
  abi: erc20Abi,
  functionName: "transfer",
  args: [wallet, 50_000n],
});
await mc.publicClient.waitForTransactionReceipt({ hash: fund });
console.log(`   ${wallet}  ${net.hashscanUrl}/contract/${wallet}`);

console.log("2. the laptop tries to set a limit on its own");
console.log(`   refused: ${await refused(laptop, wallet, limit())}`);

console.log("3. Face ID on the phone lets the laptop in");
const added = await run(phone, wallet, addKeyCalls(wallet, laptop));
console.log(`   laptop is a key: ${await wallets.hasKey(wallet, laptop)}  ${tx(added.hash)}`);

console.log("4. the laptop sets a 0.02 USDC limit");
const set = await run(laptop, wallet, limit());
const id = set.mandateId ?? 0n;
console.log(`   mandate #${id}, owner ${(await mc.getMandate(id)).owner}  ${tx(set.hash)}`);

console.log("5. the laptop is lost: the phone shuts it out");
const removed = await run(phone, wallet, removeKeyCalls(wallet, laptop));
console.log(`   laptop is a key: ${await wallets.hasKey(wallet, laptop)}  ${tx(removed.hash)}`);
console.log(
  `   the laptop cancelling the limit: ${await refused(laptop, wallet, revokeCalls(registry, id))}`,
);

console.log("6. the phone cancels the limit");
const revoked = await run(phone, wallet, revokeCalls(registry, id));
console.log(`   revoked: ${(await mc.getMandate(id)).revoked}  ${tx(revoked.hash)}`);
