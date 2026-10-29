import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { Config } from "../config";
import type { Db } from "../db/client";
import type { User } from "../db/schema";
import { rolesFor } from "./roles";
import { createSession, endSession, SESSION_COOKIE, SESSION_TTL_MS, userForToken } from "./session";
import { demoUser, issueNonce, SignInError, signIn } from "./siwe";

export type AuthEnv = { Variables: { user: User } };

const VerifyBody = z.object({
  message: z.string().min(1).max(4000),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

/** The user as the app sees it: no internal ids beyond its own, roles computed here. */
export function publicUser(user: User, config: Config) {
  return {
    id: user.id,
    address: user.address,
    displayName: user.displayName,
    homeCity: user.homeCity,
    isDemo: user.isDemo,
    roles: rolesFor(user, config.admins),
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

export function authRoutes(db: Db, config: Config) {
  const app = new Hono<AuthEnv>();

  const startSession = async (c: Context, user: User) => {
    const token = await createSession(db, user.id);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: config.production,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
    });
    return c.json({ user: publicUser(user, config) });
  };

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

  app.post("/auth/logout", async (c) => {
    await endSession(db, getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/me", requireUser(db), (c) => c.json({ user: publicUser(c.get("user"), config) }));

  return app;
}
