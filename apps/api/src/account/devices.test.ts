import { type KeySig, passkeyWalletV2Abi, type WalletCall } from "@eth/mandates";
import { eq } from "drizzle-orm";
import { type Address, encodeFunctionData, keccak256, toHex } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { deviceLabel } from "../auth/device-links";
import { loadConfig } from "../config";
import type { Db } from "../db/client";
import { passkeys, passkeyWallets as walletRows } from "../db/schema";
import { testDb } from "../test/db";
import { softPasskey } from "../test/passkey";
import type { WalletChain } from "../wallet/chain";
import { passkeyKey, passkeyWallets } from "../wallet/service";

const ORIGIN = "http://localhost:3000";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Safari/604.1";
let db: Db;
let app: ReturnType<typeof createApp>;
let wallets: ReturnType<typeof passkeyWallets>;
let executed: { wallet: Address; calls: WalletCall[]; sig: KeySig }[];

const chain: WalletChain = {
  version: 2,
  addressOf: async (k) => `0x${k.qx.slice(2, 42)}` as Address,
  create: async (k) => `0x${k.qx.slice(2, 42)}` as Address,
  hederaIdOf: async () => "0.0.7777",
  gift: async () => "0xgift",
  balanceOf: async () => 0n,
  digest: async (wallet, calls, deadline) =>
    keccak256(toHex(JSON.stringify([wallet, calls, deadline], (_, v) => String(v)))),
  execute: async (wallet, calls, _deadline, sig) => {
    executed.push({ wallet, calls, sig: sig as KeySig });
    return { hash: "0xfeed" };
  },
};

beforeEach(async () => {
  executed = [];
  db = await testDb();
  wallets = passkeyWallets(db, chain, {
    rpID: "localhost",
    origin: ORIGIN,
    giftUnits: 0n,
    giftsPerDay: 0,
  });
  app = createApp(db, loadConfig({ NODE_ENV: "test", APP_ORIGIN: ORIGIN }), { wallets });
});

const call = (method: string, path: string, cookie: string, body?: unknown, ua = "") =>
  app.request(path, {
    method,
    headers: { cookie, origin: ORIGIN, "content-type": "application/json", "user-agent": ua },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const cookieOf = (r: Response) => r.headers.get("set-cookie")?.split(";")[0] ?? "";
type Options = { challenge: string; allowCredentials?: { id: string }[] };

/** The first device: a new passkey account, and its wallet. */
async function signUp() {
  const key = softPasskey(ORIGIN);
  const opts = await json<Options>(call("POST", "/auth/passkey/register/options", ""));
  const res = await call("POST", "/auth/passkey/register", "", {
    response: key.register(opts.challenge),
  });
  const { user } = (await res.json()) as { user: { id: string } };
  await wallets.ensure(user.id);
  return { key, cookie: cookieOf(res), userId: user.id };
}

/** A second device joins with the code the first one shows. */
async function link(cookie: string) {
  const { code } = await json<{ code: string }>(call("POST", "/account/devices/link", cookie));
  const key = softPasskey(ORIGIN);
  const opts = await json<{ options: Options & { excludeCredentials: { id: string }[] } }>(
    call("POST", "/auth/passkey/link/options", "", { code }),
  );
  const res = await call(
    "POST",
    "/auth/passkey/link",
    "",
    { code, response: key.register(opts.options.challenge) },
    IPHONE,
  );
  return { key, code, res, opts: opts.options, cookie: cookieOf(res) };
}

/** Face ID for a device change, signed by `signer`. */
async function approve(
  cookie: string,
  id: string,
  action: string,
  signer: { signIn(c: string): unknown },
) {
  const prep = await json<{ opId: string; options: Options }>(
    call("POST", `/account/devices/${id}/wallet/face-id`, cookie, { action }),
  );
  return call("POST", `/account/devices/${id}/wallet`, cookie, {
    opId: prep.opId,
    response: signer.signIn(prep.options.challenge),
  });
}

describe("one account on several devices", () => {
  it("a signed-in device's code lets another make its own passkey on the account, once", async () => {
    const a = await signUp();
    const b = await link(a.cookie);
    expect(b.opts.excludeCredentials.map((k) => k.id)).toEqual([a.key.id]);
    expect(b.res.status).toBe(200);
    expect(((await b.res.json()) as { user: { id: string } }).user.id).toBe(a.userId);
    const again = await call("POST", "/auth/passkey/link/options", "", { code: b.code });
    expect(again.status).toBe(410);

    const list = await json<{
      devices: { id: string; label: string | null; onWallet: boolean }[];
      wallet: unknown;
    }>(call("GET", "/account/devices", b.cookie));
    expect(list.wallet).toEqual({ status: "ready", multiDevice: true });
    expect(list.devices).toEqual([
      expect.objectContaining({ id: a.key.id, onWallet: true }),
      expect.objectContaining({ id: b.key.id, onWallet: false, label: "iPhone · Safari" }),
    ]);
  });

  it("Face ID on a trusted device lets the new one pay; a lost one is shut out", async () => {
    const a = await signUp();
    const b = await link(a.cookie);
    const wallet = (await wallets.get(a.userId, false))?.address as Address;

    // The new device can't let itself in; the trusted one adds its passkey to the wallet.
    const [ka, kb] = [await keyOf(a.key.id), await keyOf(b.key.id)];
    expect((await approve(b.cookie, b.key.id, "add", b.key)).status).toBe(422);
    expect((await approve(b.cookie, b.key.id, "add", a.key)).status).toBe(200);
    expect(executed[0]?.calls[0]).toEqual({
      to: wallet,
      value: 0n,
      data: encodeFunctionData({
        abi: passkeyWalletV2Abi,
        functionName: "addKey",
        args: [kb.qx, kb.qy],
      }),
    });
    expect(executed[0]?.sig.qx).toBe(ka.qx);

    // Now either device approves a payment, and the chain is told which one did.
    const op = await wallets.prepare(a.userId, [], { kind: "revoke", limitId: "x" });
    expect(op.options.allowCredentials.map((k) => k.id).sort()).toEqual(
      [a.key.id, b.key.id].sort(),
    );
    await wallets.run(a.userId, op.opId, b.key.signIn(op.options.challenge) as never);
    expect(executed[1]?.sig.qx).toBe(kb.qx);

    // The phone is lost: the laptop shuts it out, which also signs it out.
    expect((await approve(a.cookie, b.key.id, "remove", a.key)).status).toBe(200);
    expect(await db.select().from(passkeys).where(eq(passkeys.id, b.key.id))).toEqual([]);
    expect((await call("GET", "/me", b.cookie)).status).toBe(401);
    expect((await call("GET", "/me", a.cookie)).status).toBe(200);
    const last = await call("POST", `/account/devices/${a.key.id}/wallet/face-id`, a.cookie, {
      action: "remove",
    });
    expect(last.status).toBe(409);
  });

  it("a device the wallet doesn't trust is simply forgotten; v1 wallets can't add devices to pay", async () => {
    const a = await signUp();
    const b = await link(a.cookie);
    expect((await call("DELETE", `/account/devices/${a.key.id}`, a.cookie)).status).toBe(409);
    expect((await call("DELETE", `/account/devices/${b.key.id}`, a.cookie)).status).toBe(200);

    const c = await link(a.cookie);
    await db.update(walletRows).set({ version: 1 });
    const res = await call("POST", `/account/devices/${c.key.id}/wallet/face-id`, a.cookie, {
      action: "add",
    });
    expect(res.status).toBe(409);
  });

  it("names devices from their browser", () => {
    expect(deviceLabel(IPHONE)).toBe("iPhone · Safari");
    expect(
      deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0 Safari/537.36"),
    ).toBe("Mac · Chrome");
    expect(deviceLabel("")).toBeNull();
  });
});

const keyOf = async (id: string) =>
  passkeyKey((await db.select().from(passkeys).where(eq(passkeys.id, id)))[0]?.publicKey ?? "");
