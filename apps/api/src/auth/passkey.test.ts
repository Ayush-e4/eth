import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { loadConfig } from "../config";
import type { Db } from "../db/client";
import { testDb } from "../test/db";
import { softPasskey } from "../test/passkey";

const ORIGIN = "http://localhost:3000";
let app: ReturnType<typeof createApp>;
let db: Db;

async function boot(env: Record<string, string> = {}, keep = false) {
  if (!keep) db = await testDb();
  app = createApp(db, loadConfig({ NODE_ENV: "test", APP_ORIGIN: ORIGIN, ...env }));
}

const post = (path: string, body?: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const challenge = async (path: string) =>
  ((await (await post(path, {})).json()) as { challenge: string }).challenge;
const cookieOf = (res: Response) => res.headers.get("set-cookie")?.split(";")[0] ?? "";
type Me = { user: { id: string; isDemo: boolean } };

async function signUp(key = softPasskey(ORIGIN)) {
  const res = await post("/auth/passkey/register", {
    response: key.register(await challenge("/auth/passkey/register/options")),
  });
  return { res, key, body: (await res.clone().json()) as Me };
}

beforeEach(() => boot());

describe("passkeys", () => {
  it("sign up makes an account that pays from the demo wallet, and signs you in", async () => {
    const opts = (await (await post("/auth/passkey/register/options", {})).json()) as {
      rp: { id: string };
      pubKeyCredParams: { alg: number }[];
    };
    expect(opts.rp.id).toBe("localhost");
    expect(opts.pubKeyCredParams).toEqual([{ alg: -7, type: "public-key" }]); // P-256 only
    const { res, body } = await signUp();
    expect(res.status).toBe(200);
    expect(body.user.isDemo).toBe(true);
    const me = await app.request("/me", { headers: { cookie: cookieOf(res) } });
    expect(((await me.json()) as Me).user.id).toBe(body.user.id);
  });

  it("signs back in to the same account, on a later visit", async () => {
    const { key, body } = await signUp();
    const res = await post("/auth/passkey/login", {
      response: key.signIn(await challenge("/auth/passkey/login/options")),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Me).user.id).toBe(body.user.id);
  });

  it("each passkey is its own account", async () => {
    const a = await signUp();
    const b = await signUp();
    expect(a.body.user.id).not.toBe(b.body.user.id);
  });

  it("refuses a replayed challenge, an unknown passkey and the wrong site", async () => {
    const { key } = await signUp();
    const c = await challenge("/auth/passkey/login/options");
    expect((await post("/auth/passkey/login", { response: key.signIn(c) })).status).toBe(200);
    expect((await post("/auth/passkey/login", { response: key.signIn(c) })).status).toBe(401);

    const stranger = softPasskey(ORIGIN);
    const s = await challenge("/auth/passkey/login/options");
    const unknown = await post("/auth/passkey/login", { response: stranger.signIn(s) });
    expect(unknown.status).toBe(401);

    const phish = softPasskey("http://agentnet.evil.example");
    const p = await challenge("/auth/passkey/register/options");
    expect((await post("/auth/passkey/register", { response: phish.register(p) })).status).toBe(
      401,
    );
    expect((await post("/auth/passkey/login", { response: { id: "x" } })).status).toBe(400);
  });

  it("new passkey accounts need demo mode; existing ones still sign in", async () => {
    const { key } = await signUp();
    await boot({ DEMO_MODE: "off" }, true);
    expect((await post("/auth/passkey/register/options", {})).status).toBe(403);
    const res = await post("/auth/passkey/login", {
      response: key.signIn(await challenge("/auth/passkey/login/options")),
    });
    expect(res.status).toBe(200);
  });
});
