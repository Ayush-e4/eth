import { ChatModeSchema } from "@eth/shared";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { Config } from "../config";
import type { Db } from "../db/client";
import { passkeys, type User, users } from "../db/schema";
import { limitUnitsSchema } from "../limits";
import type { PasskeyWallets } from "../wallet/service";
import type { SignInLinks } from "./links";
import { passkeyAuth } from "./passkey";
import { rolesFor } from "./roles";
import { createSession, endSession, SESSION_COOKIE, SESSION_TTL_MS, userForToken } from "./session";
import { demoUser, issueNonce, SignInError, signIn } from "./siwe";

export type AuthEnv = { Variables: { user: User } };

const ProfilePatch = z.object({
  displayName: z.string().trim().min(1).max(60).nullable().optional(),
  homeCity: z.string().trim().min(1).max(60).nullable().optional(),
  defaultMode: ChatModeSchema.optional(),
  defaultLimitUnits: limitUnitsSchema.optional(),
  onboarded: z.literal(true).optional(), // finishing setup; there's no way to un-finish it
});

const VerifyBody = z.object({
  message: z.string().min(1).max(4000),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

// The browser's passkey response; the passkey library checks every field of it.
const PasskeyBody = z.object({
  response: z.looseObject({ id: z.string().min(1).max(1024), type: z.literal("public-key") }),
});
const PasskeyName = z.object({ name: z.string().max(60).optional() });

/** The user as the app sees it: no internal ids beyond its own, roles computed here. */
export function publicUser(user: User, config: Config) {
  return {
    id: user.id,
    address: user.address,
    displayName: user.displayName,
    homeCity: user.homeCity,
    isDemo: user.isDemo,
    defaultMode: user.defaultMode,
    defaultLimitUnits: user.defaultLimitUnits.toString(),
    onboarded: user.onboardedAt !== null,
    roles: rolesFor(user, config.admins, config.adminUsers),
  };
}

/** Rejects requests without a valid session; otherwise puts the user on the context. */
export function requireUser(db: Db) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const user = await userForToken(db, getCookie(c, SESSION_COOKIE));
    if (!user) return c.json({ error: "sign in first" }, 401);
    c.set("user", user);
    await next();
  });
}

export function authRoutes(
  db: Db,
  config: Config,
  wallets: PasskeyWallets | null = null,
  links: SignInLinks | null = null,
) {
  const app = new Hono<AuthEnv>();

  const signInAs = async (c: Context, userId: string) => {
    const token = await createSession(db, userId);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: config.production,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
    });
  };
  const startSession = async (c: Context, user: User) => {
    await signInAs(c, user.id);
    return c.json({ user: publicUser(user, config) });
  };

  /** A one-time link the bot sent to the person's own Telegram: sign in, go where it points. */
  app.get("/auth/link", async (c) => {
    const l = links?.take(c.req.query("t") ?? "");
    if (!l) return c.redirect("/login?expired=1");
    await signInAs(c, l.userId);
    return c.redirect(l.path.startsWith("/") ? l.path : "/chat");
  });

  app.get("/auth/nonce", async (c) => c.json({ nonce: await issueNonce(db) }));

  app.post("/auth/verify", async (c) => {
    const body = VerifyBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "send message and signature" }, 400);
    try {
      const user = await signIn(db, {
        message: body.data.message,
        signature: body.data.signature as `0x${string}`,
        domain: config.siweDomain,
        uri: config.appOrigin,
      });
      return startSession(c, user);
    } catch (e) {
      if (e instanceof SignInError) return c.json({ error: e.message }, 401);
      throw e;
    }
  });

  app.post("/auth/demo", async (c) => {
    if (!config.demoMode) return c.json({ error: "demo mode is off" }, 403);
    return startSession(c, await demoUser(db));
  });

  // Passkeys. A new one makes an account that pays from the demo wallet, so it needs demo mode.
  const passkey = passkeyAuth(db, {
    rpID: new URL(config.appOrigin).hostname,
    origin: config.appOrigin,
  });
  const passkeyIn = async (c: Context, go: (response: never) => Promise<User>) => {
    const body = PasskeyBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "send the passkey response" }, 400);
    try {
      return await startSession(c, await go(body.data.response as never));
    } catch (e) {
      if (e instanceof SignInError) return c.json({ error: e.message }, 401);
      throw e;
    }
  };

  app.post("/auth/passkey/register/options", async (c) => {
    if (!config.demoMode) return c.json({ error: "new accounts need demo mode" }, 403);
    const body = PasskeyName.safeParse(await c.req.json().catch(() => ({})));
    return c.json(await passkey.registrationOptions(body.data?.name));
  });
  app.post("/auth/passkey/register", (c) =>
    config.demoMode
      ? passkeyIn(c, async (r) => {
          const user = await passkey.register(r);
          void wallets?.ensure(user.id); // their own Face ID wallet, made in the background
          return user;
        })
      : c.json({ error: "new accounts need demo mode" }, 403),
  );
  app.post("/auth/passkey/login/options", async (c) =>
    c.json(await passkey.authenticationOptions()),
  );
  app.post("/auth/passkey/login", (c) => passkeyIn(c, (r) => passkey.authenticate(r)));

  app.post("/auth/logout", async (c) => {
    await endSession(db, getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // The signed-in user, plus their passkey wallet (made, or retried, here if it's missing).
  const meJson = async (user: User) => {
    const keys = await db
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(eq(passkeys.userId, user.id))
      .limit(1);
    const wallet = keys.length > 0 ? ((await wallets?.get(user.id, false)) ?? null) : null;
    if (keys.length > 0 && wallets && (!wallet || wallet.status === "failed"))
      void wallets.ensure(user.id);
    return {
      user: {
        ...publicUser(user, config),
        passkey: keys.length > 0,
        wallet: wallet && { address: wallet.address, status: wallet.status },
      },
    };
  };

  app.get("/me", requireUser(db), async (c) => c.json(await meJson(c.get("user"))));

  app.patch("/me", requireUser(db), async (c) => {
    const body = ProfilePatch.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid profile", issues: body.error.issues }, 400);
    const { onboarded, ...fields } = body.data;
    const [user] = await db
      .update(users)
      .set({ ...fields, ...(onboarded ? { onboardedAt: new Date() } : {}) })
      .where(eq(users.id, c.get("user").id))
      .returning();
    return c.json(await meJson(user ?? c.get("user")));
  });

  return app;
}
