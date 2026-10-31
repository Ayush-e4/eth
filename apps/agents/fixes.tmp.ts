import { fileURLToPath } from "node:url";
import { createAccount, createClient, loadConfig } from "@eth/hedera";
import { hederaTestnet } from "@eth/mandates";
import { deployRegistry } from "@eth/mandates/deploy";
import { createPublicClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const c = loadConfig();
const op = privateKeyToAccount(
  (c.operatorKey.startsWith("0x") ? c.operatorKey : `0x${c.operatorKey}`) as `0x${string}`,
);
const artifact = fileURLToPath(
  new URL("../../packages/contracts/out/MandateRegistry.sol/MandateRegistry.json", import.meta.url),
);
const d = await deployRegistry(op, artifact, "https://testnet.mirrornode.hedera.com");
const code = await createPublicClient({ chain: hederaTestnet, transport: http() }).getCode({
  address: d.address,
});
console.log(
  "spare registry:",
  d.address,
  d.contractId,
  "code bytes:",
  ((code?.length ?? 2) - 2) / 2,
);
const key = generatePrivateKey();
const made = await createAccount(createClient(c), {
  privateKey: key,
  initialHbar: 1,
  memo: "eth reset test",
});
console.log(
  "account from a given key:",
  made.accountId,
  made.evmAddress.toLowerCase() === privateKeyToAccount(key).address.toLowerCase()
    ? "same EVM address ✓"
    : "EVM address differs ✗",
);
