import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { type Config, HEDERA_TESTNET_CHAIN_ID, loadConfig } from "../config";
import { testDb } from "../test/db";

const ORIGIN = "http://localhost:3000";
const alice = privateKeyToAccount(generatePrivateKey());
const mallory = privateKeyToAccount(generatePrivateKey());

type App = ReturnType<typeof createApp>;
let app: App;
let config: Config;

async function boot(env: Record<string, string> = {}) {
  config = loadConfig({ NODE_ENV: "test", APP_ORIGIN: ORIGIN, ...env });
  app = createApp(await testDb(), config);
}

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function nonce() {
  return ((await (await app.request("/auth/nonce")).json()) as { nonce: string }).nonce;
}

function message(n: string, over: Partial<Parameters<typeof createSiweMessage>[0]> = {}) {
  return createSiweMessage({
    address: alice.address,
    chainId: HEDERA_TESTNET_CHAIN_ID,
    domain: "localhost:3000",
    nonce: n,
    uri: ORIGIN,
    version: "1",
    statement: "Sign in to AgentNet. This will not send a transaction or cost any fees.",
    ...over,
  });
}

async function signInAs(signer = alice, msg?: string) {
  const m = msg ?? message(await nonce());
  return post("/auth/verify", { message: m, signature: await signer.signMessage({ message: m }) });
}

const cookieOf = (res: Response) => res.headers.get("set-cookie")?.split(";")[0] ?? "";
const me = (cookie: string) => app.request("/me", { headers: { cookie } });

beforeEach(() => boot());

describe("Sign-In with Ethereum", () => {
  it("signs in with a valid signature and sets an httpOnly session cookie", async () => {
    const res = await signInAs();
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/eth_session=.+HttpOnly/i);
    const body = (await (await me(cookieOf(res))).json()) as { user: { address: string } };
    expect(body.user.address).toBe(alice.address);
  });

  it("returns the same user on a second sign-in", async () => {
    const a = (await (await signInAs()).json()) as { user: { id: string } };
    const b = (await (await signInAs()).json()) as { user: { id: string } };
    expect(b.user.id).toBe(a.user.id);
  });

  it("refuses a reused sign-in code", async () => {
    const m = message(await nonce());
    expect((await signInAs(alice, m)).status).toBe(200);
    const again = await signInAs(alice, m);
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: "sign-in code already used or expired" });
  });

  it("refuses a code the server never issued", async () => {
    expect((await signInAs(alice, message("madeUpNonce123"))).status).toBe(401);
  });

  it("refuses a signature from a different account", async () => {
    const m = message(await nonce());
    const res = await post("/auth/verify", {
      message: m,
      signature: await mallory.signMessage({ message: m }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signature does not match the account" });
  });

  it("refuses a message for another site or another network", async () => {
    const otherSite = message(await nonce(), { domain: "evil.example" });
    expect((await signInAs(alice, otherSite)).status).toBe(401);
    const mainnet = message(await nonce(), { chainId: 1 });
    expect(await (await signInAs(alice, mainnet)).json()).toEqual({ error: "wrong network" });
  });

  it("refuses an expired message", async () => {
    const m = message(await nonce(), { expirationTime: new Date(Date.now() - 1000) });
    expect((await signInAs(alice, m)).status).toBe(401);
  });

  it("refuses sign-in posted from another site", async () => {
    const m = message(await nonce());
    const sig = await alice.signMessage({ message: m });
    const res = await post(
      "/auth/verify",
      { message: m, signature: sig },
      { origin: "https://evil.example" },
    );
    expect(res.status).toBe(403);
  });
});

describe("sessions and roles", () => {
  it("needs a session for /me", async () => {
    expect((await app.request("/me")).status).toBe(401);
    expect((await me("eth_session=not-a-real-token")).status).toBe(401);
  });

  it("logs out by deleting the session", async () => {
    const cookie = cookieOf(await signInAs());
    expect((await post("/auth/logout", undefined, { cookie })).status).toBe(200);
    expect((await me(cookie)).status).toBe(401);
  });

  it("gives the admin role only to allowlisted wallets", async () => {
    await boot({ ADMIN_WALLETS: alice.address.toLowerCase() });
    const admin = (await (await signInAs()).json()) as { user: { roles: string[] } };
    expect(admin.user.roles).toEqual(["user", "admin"]);
    const other = (await (
      await signInAs(mallory, message(await nonce(), { address: mallory.address }))
    ).json()) as {
      user: { roles: string[] };
    };
    expect(other.user.roles).toEqual(["user"]);
  });

  it("rejects a bad admin allowlist at startup", () => {
    expect(() => loadConfig({ ADMIN_WALLETS: "not-an-address" })).toThrow(/invalid address/);
  });
});

describe("demo mode", () => {
  it("creates a separate demo user each time", async () => {
    const a = (await (await post("/auth/demo")).json()) as {
      user: { id: string; isDemo: boolean };
    };
    const b = (await (await post("/auth/demo")).json()) as { user: { id: string } };
    expect(a.user.isDemo).toBe(true);
    expect(a.user.id).not.toBe(b.user.id);
  });

  it("can be switched off", async () => {
    await boot({ DEMO_MODE: "off" });
    expect((await post("/auth/demo")).status).toBe(403);
  });
});
