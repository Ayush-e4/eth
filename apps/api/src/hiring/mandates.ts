import { mandateRegistryAbi } from "@eth/mandates";
import type { Card } from "@eth/shared";
import { and, desc, eq, sum } from "drizzle-orm";
import { type Address, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Db } from "../db/client";
import { type Chat, hires, type MandateRow, mandates, type User } from "../db/schema";
import { type HiringEnv, hederaAccountOf } from "./env";

export const PER_PAYMENT_CAP = 100_000n; // no single agent fee above 0.10 USDC
export const MANDATE_HOURS = 24;

type LimitCard = Extract<Card, { type: "limit" }>;
export type Payee = { name: string; agent: Address };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** What's left of the chat's limit: a new mandate only covers this, never the whole limit again. */
export async function chatRemaining(
  db: Db,
  chat: Pick<Chat, "id" | "limitUnits">,
): Promise<bigint> {
  const [row] = await db
    .select({ spent: sum(hires.feeUnits) })
    .from(hires)
    .where(eq(hires.chatId, chat.id));
  const left = chat.limitUnits - BigInt(row?.spent ?? 0);
  return left > 0n ? left : 0n;
}

/** What the user is asked to approve: what's left of the chat's limit, payable only to these agents. */
export function limitCard(
  env: HiringEnv,
  budget: bigint,
  payees: Payee[],
  now = Date.now(),
): LimitCard {
  return {
    type: "limit",
    budgetUnits: budget.toString(),
    perPaymentCapUnits: (budget < PER_PAYMENT_CAP ? budget : PER_PAYMENT_CAP).toString(),
    expiresAt: Math.floor(now / 1000) + MANDATE_HOURS * 3600,
    registry: env.registry,
    token: env.usdc,
    agent: env.concierge.evm,
    payees,
  };
}

/** The chat's live limit on the current registry (limits on an older one can't pay any more). */
export async function currentMandate(
  db: Db,
  env: Pick<HiringEnv, "registry">,
  chatId: string,
): Promise<MandateRow | null> {
  const [m] = await db
    .select()
    .from(mandates)
    .where(and(eq(mandates.chatId, chatId), eq(mandates.registry, env.registry.toLowerCase())))
    .orderBy(desc(mandates.createdAt))
    .limit(1);
  return m && m.expiresAt.getTime() > Date.now() ? m : null;
}

/** True if the chat's mandate can pay this agent (the chain checks again at payment time). */
export const covers = (m: MandateRow | null, agent: string) =>
  !!m && m.payees.some((p) => same(p, agent));

/** Demo users: the shared test wallet creates the mandate on Hedera for them. */
export async function createDemoMandate(db: Db, env: HiringEnv, chat: Chat, card: LimitCard) {
  const owner = privateKeyToAccount(env.demo.key);
  const budget = BigInt(card.budgetUnits);
  // The registry pulls fees through an allowance; keep it comfortably above any one budget.
  if ((await env.mc.allowance(env.usdc, owner.address)) < budget * 2n) {
    await env.mc.approve(owner, env.usdc, 20_000_000n);
  }
  const { id } = await env.mc.createMandate(owner, {
    agent: env.concierge.evm,
    token: env.usdc,
    budget,
    perPaymentCap: BigInt(card.perPaymentCapUnits),
    expiresAt: BigInt(card.expiresAt),
    payees: card.payees.map((p) => p.agent as Address),
  });
  return save(db, env, chat, card, {
    mandateId: id,
    owner: owner.address,
    payer: env.demo.account,
    budget,
    payees: card.payees.map((p) => p.agent),
    expiresAt: card.expiresAt,
    demo: true,
  });
}

export class MandateCheckError extends Error {}

/**
 * Wallet users create the mandate in MetaMask and send us its id. We trust nothing in the
 * request: the chain must say this user owns it, the concierge is its agent, it pays in USDC,
 * it's live, and it allows every agent the user was asked to approve.
 */
export async function adoptUserMandate(
  db: Db,
  env: HiringEnv,
  chat: Chat,
  user: User,
  id: bigint,
  card: LimitCard,
) {
  if (!user.address) throw new MandateCheckError("sign in with a wallet first");
  const m = await env.mc.getMandate(id).catch(() => null);
  if (!m || m.owner === "0x0000000000000000000000000000000000000000")
    throw new MandateCheckError("no such mandate");
  if (!same(m.owner, user.address)) throw new MandateCheckError("that mandate isn't yours");
  if (!same(m.agent, env.concierge.evm))
    throw new MandateCheckError("the concierge isn't its agent");
  if (!same(m.token, env.usdc)) throw new MandateCheckError("it doesn't pay in USDC");
  if (m.revoked || Number(m.expiresAt) * 1000 <= Date.now())
    throw new MandateCheckError("it's revoked or expired");
  for (const p of card.payees) {
    const ok = await env.mc.publicClient.readContract({
      address: env.registry,
      abi: mandateRegistryAbi,
      functionName: "isPayeeAllowed",
      args: [id, p.agent as Address],
    });
    if (!ok) throw new MandateCheckError(`it doesn't allow paying ${p.name}`);
  }
  const payer = await hederaAccountOf(env.mirrorUrl, getAddress(user.address) as Address);
  if (!payer)
    throw new MandateCheckError("your wallet has no Hedera account yet; get test HBAR first");
  return save(db, env, chat, card, {
    mandateId: id,
    owner: user.address,
    payer,
    budget: m.budget,
    payees: card.payees.map((p) => p.agent),
    expiresAt: Number(m.expiresAt),
    demo: false,
  });
}

/**
 * Passkey users: their own wallet created the mandate in a batch their Face ID signed, and we
 * submitted it (see wallet/service). The id comes from that transaction's MandateCreated event.
 */
export async function adoptPasskeyMandate(
  db: Db,
  env: HiringEnv,
  chat: Chat,
  card: LimitCard,
  m: { mandateId: bigint; wallet: string; payer: string },
) {
  return save(db, env, chat, card, {
    mandateId: m.mandateId,
    owner: m.wallet,
    payer: m.payer,
    budget: BigInt(card.budgetUnits),
    payees: card.payees.map((p) => p.agent),
    expiresAt: card.expiresAt,
    demo: false,
    via: "face-id",
  });
}

/** The batch a passkey wallet signs to set this limit card. */
export const limitCardParams = (card: LimitCard) => {
  const addr = (a: string) => getAddress(a.toLowerCase()); // any case in, checksummed out
  return {
    agent: addr(card.agent),
    token: addr(card.token),
    budget: BigInt(card.budgetUnits),
    perPaymentCap: BigInt(card.perPaymentCapUnits),
    expiresAt: BigInt(card.expiresAt),
    payees: card.payees.map((p) => addr(p.agent)),
  };
};

async function save(
  db: Db,
  env: HiringEnv,
  chat: Chat,
  card: LimitCard,
  m: {
    mandateId: bigint;
    owner: string;
    payer: string;
    budget: bigint;
    payees: string[];
    expiresAt: number;
    demo: boolean;
    via?: "face-id";
  },
): Promise<MandateRow> {
  const [row] = await db
    .insert(mandates)
    .values({
      chatId: chat.id,
      mandateId: m.mandateId,
      registry: env.registry.toLowerCase(),
      owner: m.owner,
      payer: m.payer,
      budgetUnits: m.budget,
      payees: m.payees,
      payeeNames: Object.fromEntries(card.payees.map((p) => [p.agent.toLowerCase(), p.name])),
      demo: m.demo,
      expiresAt: new Date(m.expiresAt * 1000),
    })
    .returning();
  if (!row) throw new Error("could not save the mandate");
  const logSeq =
    (await env.log?.write({
      kind: "agentnet.mandate.created",
      mandateId: m.mandateId.toString(),
      owner: m.owner,
      budget: m.budget.toString(),
      payees: m.payees,
      expiresAt: m.expiresAt,
      via: m.via ?? (m.demo ? "demo" : "wallet"),
    })) ?? null;
  if (logSeq === null) return row;
  await db.update(mandates).set({ logSeq }).where(eq(mandates.id, row.id));
  return { ...row, logSeq };
}
