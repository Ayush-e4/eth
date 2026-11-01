import { addKeyCalls, removeKeyCalls } from "@eth/mandates";
import { and, asc, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Address } from "viem";
import { z } from "zod";
import type { DeviceLinks } from "../auth/device-links";
import { type AuthEnv, requireUser } from "../auth/routes";
import { endOtherSessions, SESSION_COOKIE } from "../auth/session";
import type { Db } from "../db/client";
import { passkeys } from "../db/schema";
import { type PasskeyWallets, passkeyKey, WalletOpError } from "../wallet/service";

const DEVICE_GAS = 800_000n; // like a cancel: one passkey check and one write
const Action = z.object({ action: z.enum(["add", "remove"]) });
const FaceIdBody = z.object({
  opId: z.uuid(),
  response: z.looseObject({ id: z.string().max(1024), response: z.looseObject({}) }),
});

/**
 * A person's devices: the passkeys on their account and which of them may approve the wallet's
 * moves. Adding one: a code for the new device (it makes its own passkey and is signed in),
 * then Face ID on a device the wallet trusts lets it pay too. Removing one (a lost phone): Face
 * ID shuts it out of the wallet, its passkey stops signing in, and other sessions end.
 */
export function deviceRoutes(db: Db, d: { wallets: PasskeyWallets | null; links: DeviceLinks }) {
  const app = new Hono<AuthEnv>();
  app.use("/account/devices", requireUser(db));
  app.use("/account/devices/*", requireUser(db));

  const keysOf = (userId: string) =>
    db.select().from(passkeys).where(eq(passkeys.userId, userId)).orderBy(asc(passkeys.createdAt));
  const forget = async (c: Context<AuthEnv>, id: string) => {
    const user = c.get("user");
    await db.delete(passkeys).where(and(eq(passkeys.id, id), eq(passkeys.userId, user.id)));
    await endOtherSessions(db, user.id, getCookie(c, SESSION_COOKIE));
  };

  app.get("/account/devices", async (c) => {
    const user = c.get("user");
    const wallet = await d.wallets?.get(user.id, false);
    return c.json({
      devices: (await keysOf(user.id)).map((k) => ({
        id: k.id,
        label: k.label,
        addedAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
        onWallet: k.onWallet,
      })),
      wallet: wallet && { status: wallet.status, multiDevice: wallet.version >= 2 },
    });
  });

  app.post("/account/devices/link", async (c) => {
    const user = c.get("user");
    if ((await keysOf(user.id)).length === 0)
      return c.json({ error: "only passkey accounts can add devices" }, 409);
    return c.json(d.links.make(user.id));
  });

  /** Face ID, step 1: the batch that lets a device pay from the wallet, or shuts it out. */
  app.post("/account/devices/:id/wallet/face-id", async (c) => {
    if (!d.wallets) return c.json({ error: "Face ID wallets are off on this server" }, 503);
    const body = Action.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "say add or remove" }, 400);
    const user = c.get("user");
    const keys = await keysOf(user.id);
    const key = keys.find((k) => k.id === c.req.param("id"));
    if (!key) return c.json({ error: "no such device" }, 404);
    const w = await d.wallets.get(user.id, false);
    if (!w || w.version < 2)
      return c.json(
        { error: "this account's wallet answers only to the device that made it" },
        409,
      );
    const add = body.data.action === "add";
    if (key.onWallet === add)
      return c.json({ error: add ? "it can already approve" : "it can't approve anyway" }, 409);
    if (!add && keys.filter((k) => k.onWallet).length < 2)
      return c.json({ error: "it's the only device that can approve; add another first" }, 409);
    const k = passkeyKey(key.publicKey);
    const wallet = w.address as Address;
    const calls = add ? addKeyCalls(wallet, k) : removeKeyCalls(wallet, k);
    try {
      return c.json(
        await d.wallets.prepare(user.id, calls, { kind: "device", passkeyId: key.id, add }),
      );
    } catch (err) {
      if (err instanceof WalletOpError) return c.json({ error: err.message }, 409);
      throw err;
    }
  });

  /** Step 2: a trusted device signed it; run it on Hedera, then note who may approve now. */
  app.post("/account/devices/:id/wallet", async (c) => {
    if (!d.wallets) return c.json({ error: "Face ID wallets are off on this server" }, 503);
    const body = FaceIdBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "send the Face ID approval" }, 400);
    const user = c.get("user");
    const meta = d.wallets.meta(user.id, body.data.opId);
    if (meta?.kind !== "device" || meta.passkeyId !== c.req.param("id"))
      return c.json({ error: "that approval is for something else" }, 409);
    try {
      const run = await d.wallets.run(
        user.id,
        body.data.opId,
        body.data.response as never,
        DEVICE_GAS,
      );
      if (!meta.add) await forget(c, meta.passkeyId);
      else
        await db
          .update(passkeys)
          .set({ onWallet: true })
          .where(and(eq(passkeys.id, meta.passkeyId), eq(passkeys.userId, user.id)));
      return c.json({ ok: true, hederaTx: run.hash });
    } catch (err) {
      if (err instanceof WalletOpError) return c.json({ error: err.message }, 422);
      throw err;
    }
  });

  /** A device the wallet doesn't trust (nothing on-chain to undo): just forget its passkey. */
  app.delete("/account/devices/:id", async (c) => {
    const keys = await keysOf(c.get("user").id);
    const key = keys.find((k) => k.id === c.req.param("id"));
    if (!key) return c.json({ error: "no such device" }, 404);
    if (key.onWallet) return c.json({ error: "shut it out of the wallet with Face ID" }, 409);
    if (keys.length < 2) return c.json({ error: "that's your only passkey" }, 409);
    await forget(c, key.id);
    return c.json({ ok: true });
  });

  return app;
}
