import { createPublicKey, verify } from "node:crypto";
import type { Assertion, KeySig, WalletCall } from "@eth/mandates";
import { type Address, keccak256, toHex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { loadConfig } from "../config";
import type { Db } from "../db/client";
import { passkeys } from "../db/schema";
import type { HiringEnv } from "../hiring/env";
import { limitCard } from "../hiring/mandates";
import type { HiringService } from "../hiring/service";
import { testDb } from "../test/db";
import { env as baseEnv } from "../test/hiring";
import { softPasskey } from "../test/passkey";
import type { WalletChain } from "./chain";
import { passkeyKey, passkeyWallets } from "./service";

const ORIGIN = "http://localhost:3000";
const AIRNEST = "0x65F8E30A61635AFEB3F33B5221F05B8A6FCE3E13";
const logWrite = vi.fn(async () => 7);
const env = {
  ...baseEnv,
  mc: { ...baseEnv.mc, getMandate: async () => Promise.reject(new Error("offline")) },
  log: { topicId: "0.0.99", write: logWrite },
} as unknown as HiringEnv;

let db: Db;
let app: ReturnType<typeof createApp>;
let wallets: ReturnType<typeof passkeyWallets>;
let executed: { wallet: Address; calls: WalletCall[]; sig: Assertion | KeySig; gas?: bigint }[];
let gifts: bigint[];

const chain: WalletChain = {
  version: 2,
  addressOf: async (k) => `0x${k.qx.slice(2, 42)}` as Address,
  create: async (k) => `0x${k.qx.slice(2, 42)}` as Address,
  hederaIdOf: async () => "0.0.7777",
  gift: async (_to, units) => {
    gifts.push(units);
    return "0xgift";
  },
  balanceOf: async () => 500_000n,
  digest: async (wallet, calls, deadline) =>
    keccak256(toHex(JSON.stringify([wallet, calls, deadline], (_, v) => String(v)))),
  execute: async (wallet, calls, _deadline, sig, gas) => {
    executed.push({ wallet, calls, sig, gas });
    return { hash: "0xfeed", mandateId: calls.length === 2 ? 42n : undefined };
  },
};

function boot(giftsPerDay = 20) {
  wallets = passkeyWallets(db, chain, {
    rpID: "localhost",
    origin: ORIGIN,
    giftUnits: 500_000n,
    giftsPerDay,
  });
  app = createApp(db, loadConfig({ NODE_ENV: "test", APP_ORIGIN: ORIGIN }), {
    hiring: { env, service: { noteUserMessage: () => {} } as unknown as HiringService },
    wallets,
  });
}

const call = (method: string, path: string, cookie: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;

/** Signs up with a passkey and waits for the wallet the sign-up starts. */
async function signUp() {
  const key = softPasskey(ORIGIN);
  const opts = await json<{ challenge: string }>(
    call("POST", "/auth/passkey/register/options", ""),
  );
  const res = await call("POST", "/auth/passkey/register", "", {
    response: key.register(opts.challenge),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  const { user } = (await res.json()) as { user: { id: string } };
  await wallets.ensure(user.id);
  return { key, cookie, userId: user.id };
}

beforeEach(async () => {
  vi.clearAllMocks();
  executed = [];
  gifts = [];
  db = await testDb();
  boot();
});

describe("Face ID wallets", () => {
  it("sign-up makes the wallet and sends it free test USDC (within the daily cap)", async () => {
    boot(1);
    const a = await signUp();
    const me = await json<{ user: { wallet: { status: string; address: string } } }>(
      call("GET", "/me", a.cookie),
    );
    expect(me.user.wallet.status).toBe("ready");
    const w = await json<{ address: string; account: string; faceId: { giftUnits: string } }>(
      call("GET", "/wallet", a.cookie),
    );
    expect(w).toMatchObject({ address: me.user.wallet.address, account: "0.0.7777" });
    expect(w.faceId.giftUnits).toBe("500000");
    await signUp(); // the second one today goes over the cap: a wallet, no gift
    expect(gifts).toEqual([500_000n]);
  });

  it("Face ID sets a chat's limit from the user's own wallet, once", async () => {
    const { key, cookie, userId } = await signUp();
    const chatId = (await json<{ chat: { id: string } }>(call("POST", "/chats", cookie))).chat.id;
    const card = limitCard(env, 300_000n, [{ name: "AirNest", agent: AIRNEST }]);
    const prep = await json<{ opId: string; options: { challenge: string; rpId: string } }>(
      call("POST", `/chats/${chatId}/mandate/face-id`, cookie, { card }),
    );
    expect(prep.options.rpId).toBe("localhost");
    const response = key.signIn(prep.options.challenge);
    const res = await call("POST", `/chats/${chatId}/mandate`, cookie, {
      opId: prep.opId,
      response,
      card,
    });
    expect(res.status).toBe(201);
    const { mandate } = (await res.json()) as { mandate: Record<string, unknown> };
    expect(mandate).toMatchObject({ mandateId: "42", payer: "0.0.7777", demo: false });
    expect(logWrite).toHaveBeenCalledWith(expect.objectContaining({ via: "face-id" }));

    // What reached the chain is the device's own signature, in the contract's shape (v2: with
    // which passkey made it).
    const ks = executed[0]?.sig as KeySig;
    const sig = ks.sig;
    const [stored] = await db.select().from(passkeys);
    const k = passkeyKey(stored?.publicKey ?? "");
    expect({ qx: ks.qx, qy: ks.qy }).toEqual(k);
    const pub = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: Buffer.from(k.qx.slice(2), "hex").toString("base64url"),
        y: Buffer.from(k.qy.slice(2), "hex").toString("base64url"),
      },
      format: "jwk",
    });
    const msg = Buffer.concat([
      Buffer.from(sig.authenticatorData.slice(2), "hex"),
      Buffer.from(await crypto.subtle.digest("SHA-256", Buffer.from(sig.clientDataJSON))),
    ]);
    const rs = Buffer.from(sig.r.slice(2) + sig.s.slice(2), "hex");
    expect(verify("sha256", msg, { key: pub, dsaEncoding: "ieee-p1363" }, rs)).toBe(true);

    // The same approval can't run twice, and a card it wasn't for is refused.
    const again = await call("POST", `/chats/${chatId}/mandate`, cookie, {
      opId: prep.opId,
      response,
      card,
    });
    expect(again.status).toBe(409);
    expect(executed).toHaveLength(1);
    expect(executed[0]?.wallet).toBe((await wallets.get(userId, false))?.address);
  });

  it("refuses a signature over something else, and a card the op wasn't for", async () => {
    const { key, cookie } = await signUp();
    const chatId = (await json<{ chat: { id: string } }>(call("POST", "/chats", cookie))).chat.id;
    const card = limitCard(env, 300_000n, [{ name: "AirNest", agent: AIRNEST }]);
    const prep = await json<{ opId: string }>(
      call("POST", `/chats/${chatId}/mandate/face-id`, cookie, { card }),
    );
    const wrong = await call("POST", `/chats/${chatId}/mandate`, cookie, {
      opId: prep.opId,
      response: key.signIn("c29tZXRoaW5nLWVsc2U"),
      card,
    });
    expect(wrong.status).toBe(422);
    const prep2 = await json<{ opId: string; options: { challenge: string } }>(
      call("POST", `/chats/${chatId}/mandate/face-id`, cookie, { card }),
    );
    const edited = { ...card, payees: [{ name: "Evil", agent: AIRNEST.replace("65", "66") }] };
    const res = await call("POST", `/chats/${chatId}/mandate`, cookie, {
      opId: prep2.opId,
      response: key.signIn(prep2.options.challenge),
      card: edited,
    });
    expect(res.status).toBe(409);
    expect(executed).toHaveLength(0);
  });

  it("Face ID cancels a limit its wallet owns", async () => {
    const { key, cookie } = await signUp();
    const chatId = (await json<{ chat: { id: string } }>(call("POST", "/chats", cookie))).chat.id;
    const card = limitCard(env, 300_000n, [{ name: "AirNest", agent: AIRNEST }]);
    const prep = await json<{ opId: string; options: { challenge: string } }>(
      call("POST", `/chats/${chatId}/mandate/face-id`, cookie, { card }),
    );
    await call("POST", `/chats/${chatId}/mandate`, cookie, {
      opId: prep.opId,
      response: key.signIn(prep.options.challenge),
      card,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ balance: {} })),
    );
    const w = await json<{ limits: { id: string; via: string }[] }>(call("GET", "/wallet", cookie));
    const limit = w.limits[0];
    expect(limit?.via).toBe("face-id");
    const cancel = await json<{ opId: string; options: { challenge: string } }>(
      call("POST", `/wallet/limits/${limit?.id}/revoke/face-id`, cookie),
    );
    const res = await call("POST", `/wallet/limits/${limit?.id}/revoke`, cookie, {
      opId: cancel.opId,
      response: key.signIn(cancel.options.challenge),
    });
    expect(res.status).toBe(200);
    expect(executed[1]?.calls).toHaveLength(1);
    expect(executed[1]?.gas).toBe(800_000n);
    vi.unstubAllGlobals();
  });
});
