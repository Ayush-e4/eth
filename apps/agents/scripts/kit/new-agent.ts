// Make a new agent from the agent kit's example: its code and its own identity.
//   pnpm --filter @eth/agents new-agent <slug> "<Name>" <skill> <fee in USDC>
//   e.g. pnpm --filter @eth/agents new-agent packpal "PackPal" packing 0.01
// Then edit apps/agents/src/custom/<slug>.ts and run it: pnpm --filter @eth/agents run-agent <slug>
// On testnet our operator pays for the new account and a little Arkiv GLM; on mainnet you'd
// bring your own. Guide: docs/build-an-agent.md
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ARKIV_CHAIN, arkivReader } from "@eth/arkiv";
import { createAccount, createClient, loadConfig } from "@eth/hedera";
import { createWalletClient, type Hex, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadCustom, saveCustom, sourceOf } from "./custom-agents";

const [slug, name, skill, fee] = process.argv.slice(2);
if (
  !slug ||
  !/^[a-z][a-z0-9-]{1,30}$/.test(slug) ||
  !name ||
  !skill ||
  !/^[a-z0-9_.-]{1,64}$/.test(skill) ||
  !fee
) {
  console.error(
    'usage: new-agent <slug> "<Name>" <skill> <fee in USDC>   e.g. new-agent packpal "PackPal" packing 0.01',
  );
  process.exit(1);
}
const units = BigInt(Math.round(Number(fee) * 1e6));
if (units < 1000n) throw new Error("the fee must be at least 0.001 USDC");

// 1. The code: a copy of the example with your name, skill and fee.
const file = sourceOf(slug);
if (existsSync(file)) console.log(`${file} exists, kept as it is`);
else {
  const example = readFileSync(
    fileURLToPath(new URL("../../src/custom/example.ts", import.meta.url)),
    "utf8",
  );
  writeFileSync(
    file,
    example
      .replace(
        /^\/\/ An agent from the agent kit.*\n/m,
        `// ${name}: made with the agent kit (docs/build-an-agent.md).\n`,
      )
      .replace(/const NAME = ".*";/, `const NAME = ${JSON.stringify(name)};`)
      .replace(/const SKILL = ".*";/, `const SKILL = ${JSON.stringify(skill)};`)
      .replace(
        /const PRICE = .*n;/,
        `const PRICE = ${units.toLocaleString("en-US").replaceAll(",", "_")}n;`,
      ),
  );
  console.log(`code: ${file}`);
}

// 2. Its identity: a Hedera account to be paid into, with an ECDSA key that also signs its records.
const all = loadCustom();
if (all[slug]) console.log(`identity: ${all[slug].evm} (exists)`);
else {
  const config = loadConfig();
  const hedera = createClient(config);
  const made = await createAccount(hedera, { initialHbar: 2, memo: `eth agent: ${slug}` });
  hedera.close();
  const port = 8420 + Object.keys(all).length;
  all[slug] = {
    key: `0x${made.privateKey.replace(/^0x/, "")}` as Hex,
    evm: made.evmAddress as `0x${string}`,
    hederaAccount: made.accountId,
    port,
  };
  saveCustom(all);
  console.log(`identity: ${made.evmAddress}, paid to Hedera ${made.accountId}, port ${port}`);
  // 3. A little GLM so it can write its own records on Arkiv.
  const opKey = (
    config.operatorKey.startsWith("0x") ? config.operatorKey : `0x${config.operatorKey}`
  ) as Hex;
  const funder = createWalletClient({
    chain: ARKIV_CHAIN,
    transport: http(),
    account: privateKeyToAccount(opKey),
  });
  const hash = await funder.sendTransaction({
    to: made.evmAddress as `0x${string}`,
    value: parseEther("0.2"),
  });
  await arkivReader().waitForTransactionReceipt({ hash });
  console.log("funded 0.2 GLM on Arkiv for its records");
}
console.log(`\nnext: edit ${file}, then  pnpm --filter @eth/agents run-agent ${slug}`);
process.exit(0);
