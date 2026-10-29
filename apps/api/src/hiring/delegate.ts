import { type ArkivReader, findAgents } from "@eth/arkiv";
import { hashPayees, mandateDomain, randomNonce, signSubMandateAuth } from "@eth/mandates";
import type { Delegation, Subcontract } from "@eth/shared";
import { type Address, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import type { Db } from "../db/client";
import type { MandateRow } from "../db/schema";
import type { HiringEnv } from "./env";
import { PER_PAYMENT_CAP } from "./mandates";
import { saveHire } from "./record";

/** The most a planner like TripMint may hand on to the agents it hires, per job. */
export const SUBCONTRACT_CAP = 200_000n; // 0.20 USDC

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * A planner's quote names the agents it will hire. Before the user is asked to allow them, each
 * must be a real agent on the market with that skill, and names come from their Arkiv profiles,
 * not from the planner's say-so. Returns null if the subcontract can't be trusted.
 */
export async function vetSubcontract(
  arkiv: ArkivReader,
  planner: string,
  sub: Subcontract,
): Promise<Subcontract | null> {
  if (BigInt(sub.budgetUnits) > SUBCONTRACT_CAP) return null;
  const profiles = await findAgents(arkiv);
  const payees = [];
  for (const p of sub.payees) {
    if (same(p.agent, planner)) return null; // it can't pay itself through the slice
    const profile = profiles.find(
      (a) => same(a.record.agent, p.agent) && a.record.skill === p.skill,
    );
    if (!profile) return null;
    payees.push({ ...p, name: profile.record.name });
  }
  return { ...sub, payees };
}

/**
 * Carves a sub-mandate out of the chat's mandate for a planner agent: exactly the budget it
 * quoted, only to the agents it named, never looser than the parent. The concierge (the parent
 * mandate's agent) signs it, as the contract requires; the demo wallet only pays the gas.
 */
export async function grantSubMandate(
  env: HiringEnv,
  parent: MandateRow,
  planner: Address,
  sub: Subcontract,
): Promise<Delegation & { budget: bigint; payees: Address[] }> {
  const onchain = await env.mc.getMandate(parent.mandateId);
  const budget = BigInt(sub.budgetUnits);
  const cap = [PER_PAYMENT_CAP, budget, onchain.perPaymentCap].reduce((a, b) => (b < a ? b : a));
  const hourFromNow = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const payees = sub.payees.map((p) => getAddress(p.agent)); // Arkiv may store any case
  const auth = {
    parentId: parent.mandateId,
    agent: getAddress(planner),
    budget,
    perPaymentCap: cap,
    expiresAt: onchain.expiresAt < hourFromNow ? onchain.expiresAt : hourFromNow,
    payeesHash: hashPayees(payees),
    nonce: randomNonce(),
    validBefore: BigInt(Math.floor(Date.now() / 1000) + 300),
  };
  const signature = await signSubMandateAuth(
    privateKeyToAccount(env.concierge.key),
    mandateDomain(env.mc.chain.id, env.registry),
    auth,
  );
  const { id } = await env.mc.createSubMandate(
    privateKeyToAccount(env.demo.key),
    auth,
    payees,
    signature,
  );
  return { mandateId: id.toString(), payer: parent.payer, budget, payees };
}

/** What a planner reports it hired. Third-party data: parsed strictly, kept short. */
const SubHiresSchema = z.object({
  hires: z
    .array(
      z.object({
        skill: z.string().max(64),
        agent: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        title: z.string().max(120),
        note: z.string().max(500).optional(),
        feeUnits: z.string().regex(/^\d{1,12}$/),
        hederaTx: z.string().max(80),
        jobKey: z.string().max(80),
        result: z.unknown(),
      }),
    )
    .max(5),
});

export type SubHire = z.infer<typeof SubHiresSchema>["hires"][number];

/** Saves the planner's own hires under the sub-mandate, so Tasks, Wallet and the limit count them. */
export async function recordSubHires(
  db: Db,
  env: HiringEnv,
  chatId: string,
  delegation: Delegation & { payees: Address[] },
  result: unknown,
) {
  const parsed = SubHiresSchema.safeParse(result);
  // Only agents the sub-mandate could pay; the chain refused anything else anyway.
  const list = parsed.success
    ? parsed.data.hires.filter((h) => delegation.payees.some((p) => same(p, h.agent)))
    : [];
  const out = [];
  for (const h of list) {
    const log = await saveHire(db, env, {
      chatId,
      mandateId: BigInt(delegation.mandateId),
      skill: h.skill,
      agent: h.agent,
      title: h.title,
      feeUnits: BigInt(h.feeUnits),
      hederaTx: h.hederaTx,
      jobKey: h.jobKey,
      result: h.result,
    });
    out.push({
      skill: h.skill,
      title: h.title,
      feeUnits: h.feeUnits,
      hederaTx: h.hederaTx,
      jobKey: h.jobKey,
      log,
    });
  }
  return out;
}
