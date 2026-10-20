// Live feasibility checks against the deployed HederaProbe contract on testnet:
//   (1) the contract recovers an EIP-712 signature made by our ECDSA key
//   (2) the contract moves USDC we approved via the HTS token's ERC-20 facade
// Run: pnpm --filter @eth/hedera probe-check <probeAddress> <recipientEvmAddress>
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig, Mirror, NETWORKS, unitsToUsdc } from "../src";

const [probe, recipient] = process.argv.slice(2) as [`0x${string}`, `0x${string}`];
if (!probe || !recipient) throw new Error("usage: probe-check <probeAddress> <recipientEvm>");

const config = loadConfig();
const net = NETWORKS[config.network];
const chain = defineChain({
  id: 296,
  name: "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: [net.jsonRpcUrl] } },
});
const key = (
  config.operatorKey.startsWith("0x") ? config.operatorKey : `0x${config.operatorKey}`
) as `0x${string}`;
const account = privateKeyToAccount(key);
const pub = createPublicClient({ chain, transport: http() });
const wallet = createWalletClient({ account, chain, transport: http() });

const probeAbi = parseAbi([
  "function recoverSigner((address payTo,uint256 amount,uint256 nonce,uint256 validBefore) a, bytes signature) view returns (address)",
  "function pull(address token, address from, address to, uint256 amount)",
]);
const erc20Abi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

// ── Check 1: EIP-712 signature verification ─────────────────────────────
const auth = { payTo: recipient, amount: 50_000n, nonce: 1n, validBefore: 9_999_999_999n };
const signature = await account.signTypedData({
  domain: { name: "eth-probe", version: "1", chainId: 296, verifyingContract: probe },
  types: {
    PaymentAuth: [
      { name: "payTo", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "validBefore", type: "uint256" },
    ],
  },
  primaryType: "PaymentAuth",
  message: auth,
});
const signer = await pub.readContract({
  address: probe,
  abi: probeAbi,
  functionName: "recoverSigner",
  args: [auth, signature],
});
const sigOk = signer.toLowerCase() === account.address.toLowerCase();
console.log(`(1) EIP-712 recover: ${sigOk ? "PASS" : "FAIL"} — contract says ${signer}`);

// ── Check 2: approve + transferFrom of HTS USDC via its ERC-20 facade ───
const tokenNum = Number(net.usdcTokenId.split(".")[2]);
const usdcEvm = `0x${tokenNum.toString(16).padStart(40, "0")}` as `0x${string}`;
const mirror = new Mirror(net.mirrorUrl);
const before = (await mirror.balances(recipient)).tokens[net.usdcTokenId] ?? 0n;

const approveTx = await wallet.writeContract({
  address: usdcEvm,
  abi: erc20Abi,
  functionName: "approve",
  args: [probe, 50_000n],
});
await pub.waitForTransactionReceipt({ hash: approveTx });
console.log(`    approved probe for 0.05 USDC  tx ${approveTx}`);

const pullTx = await wallet.writeContract({
  address: probe,
  abi: probeAbi,
  functionName: "pull",
  args: [usdcEvm, account.address, recipient, 50_000n],
  gas: 300_000n,
});
const pullReceipt = await pub.waitForTransactionReceipt({ hash: pullTx });
console.log(`    pull status: ${pullReceipt.status}  tx ${pullTx}`);

let after = before;
for (let i = 0; i < 10 && after === before; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  after = (await mirror.balances(recipient)).tokens[net.usdcTokenId] ?? 0n;
}
const moved = after - before;
console.log(
  `(2) approve + transferFrom: ${moved === 50_000n ? "PASS" : "FAIL"} — recipient +${unitsToUsdc(moved)} USDC`,
);
console.log(`    hashscan: ${net.hashscanUrl}/transaction/${pullTx}`);
