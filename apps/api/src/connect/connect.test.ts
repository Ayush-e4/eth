import { createHash } from "node:crypto";
import type { WalletCall } from "@eth/mandates";
import { type Address, keccak256, toHex } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { Market } from "../concierge/market";
import { loadConfig } from "../config";
import type { Db } from "../db/client";
import type { HiringEnv } from "../hiring/env";
import type { HiringService } from "../hiring/service";
import { testDb } from "../test/db";
import { env as baseEnv } from "../test/hiring";
import { softPasskey } from "../test/passkey";
import type { WalletChain } from "../wallet/chain";
import { passkeyWallets } from "../wallet/service";
import { oauthStore } from "./oauth";

const ORIGIN = "http://localhost:3000";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const env = {
  ...baseEnv,
  mc: { ...baseEnv.mc, remaining: async () => 300_000n },
} as unknown as HiringEnv;
const market: Market = { agents: async () => [] };
let executed: WalletCall[][];
const chain: WalletChain = {
  addressOf: async (k) => `0x${k.qx.slice(2, 42)}` as Address,
  create: async (k) => `0x${k.qx.slice(2, 42)}` as Address,
  hederaIdOf: async () => "0.0.7777",
  gift: async () => "0x01",
  balanceOf: async () => 200_000n,
  digest: async (w, calls, dl) =>
    keccak256(toHex(JSON.stringify([w, calls, dl], (_, v) => String(v)))),
  execute: async (_w, calls) => {
    executed.push(calls);
    return { hash: "0xfeed", mandateId: 77n };
  },
};

let db: Db;
let app: ReturnType<typeof createApp>;
let wallets: ReturnType<typeof passkeyWallets>;

const req = (
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {},
) =>
  app.request(path, {
    method,
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...opts.headers,
    },
    body:
      opts.body === undefined
        ? undefined
        : typeof opts.body === "string"
          ? opts.body
          : JSON.stringify(opts.body),
  });
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const pkce = () => {
  const verifier = "v".repeat(43) + Math.random().toString(36).slice(2);
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function signUp() {
  const key = softPasskey(ORIGIN);
  const opts = await json<{ challenge: string }>(
    req("POST", "/auth/passkey/register/options", { body: {} }),
  );
  const res = await req("POST", "/auth/passkey/register", {
    body: { response: key.register(opts.challenge) },
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  const { user } = (await res.json()) as { user: { id: string } };
  await wallets.ensure(user.id);
  return { key, cookie };
}

/** Claude's side: register, send the user to consent (they approve with Face ID), get tokens. */
async function connect() {
  const { key, cookie } = await signUp();
  const client = await json<{ client_id: string }>(
    req("POST", "/oauth/register", { body: { client_name: "Claude", redirect_uris: [CALLBACK] } }),
  );
  const { verifier, challenge } = pkce();
  const prep = await json<{ opId: string; options: { challenge: string } }>(
    req("POST", "/oauth/authorize", {
      cookie,
      body: {
        client_id: client.client_id,
        redirect_uri: CALLBACK,
        state: "s1",
        code_challenge: challenge,
        code_challenge_method: "S256",
        budgetUnits: "300000",
      },
    }),
  );
  const { redirect } = await json<{ redirect: string }>(
    req("POST", "/oauth/authorize/approve", {
      cookie,
      body: { opId: prep.opId, response: key.signIn(prep.options.challenge) },
    }),
  );
  const url = new URL(redirect);
  const form = (p: Record<string, string>) =>
    req("POST", "/oauth/token", {
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://claude.ai" },
      body: new URLSearchParams(p).toString(),
    });
  const grant = {
    grant_type: "authorization_code",
    code: url.searchParams.get("code") ?? "",
    client_id: client.client_id,
    redirect_uri: CALLBACK,
  };
  return { url, form, grant, verifier, client, cookie };
}

const mcp = (token: string | null, body: unknown) =>
  req("POST", "/mcp", {
    headers: {
      accept: "application/json, text/event-stream",
      origin: "https://claude.ai",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body,
  });

beforeEach(async () => {
  executed = [];
  db = await testDb();
  wallets = passkeyWallets(db, chain, {
    rpID: "localhost",
    origin: ORIGIN,
    giftUnits: 0n,
    giftsPerDay: 0,
  });
  app = createApp(db, loadConfig({ NODE_ENV: "test", APP_ORIGIN: ORIGIN }), {
    hiring: { env, service: { noteUserMessage: () => {} } as unknown as HiringService },
    wallets,
    connect: { oauth: oauthStore(db, `0x${"33".repeat(32)}`), market, post: null },
  });
});

describe("connected apps (MCP over OAuth)", () => {
  it("publishes where to sign in, and refuses /mcp without a token", async () => {
    const meta = await json<Record<string, string>>(req("GET", "/oauth/metadata"));
    expect(meta).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/connect/authorize`,
    });
    const res = await mcp(null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("oauth-protected-resource");
    const bad = await req("POST", "/oauth/register", {
      body: { redirect_uris: ["http://evil.example/cb"] },
    });
    expect(bad.status).toBe(400);
  });

  it("Face ID gives the app its own limit, and the app's tokens open the tools", async () => {
    const { url, form, grant, verifier } = await connect();
    expect(url.origin + url.pathname).toBe(CALLBACK);
    expect(url.searchParams.get("state")).toBe("s1");
    expect(executed[0]).toHaveLength(2); // approve + create the limit, from the user's wallet

    const tokens = await json<{ access_token: string; refresh_token: string }>(
      form({ ...grant, code_verifier: verifier }),
    );
    expect(tokens.access_token).toBeTruthy();
    expect((await form({ ...grant, code_verifier: verifier })).status).toBe(400); // used up

    const init = await mcp(tokens.access_token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    });
    expect(init.status).toBe(200);
    const list = await json<{ result: { tools: { name: string }[] } }>(
      mcp(tokens.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list" }),
    );
    expect(list.result.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["find_agents", "get_quotes", "hire", "budget"]),
    );
    const budget = await json<{ result: { content: { text: string }[] } }>(
      mcp(tokens.access_token, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "budget", arguments: {} },
      }),
    );
    expect(budget.result.content[0]?.text).toContain("0.30 USDC");

    const fresh = await json<{ access_token: string }>(
      form({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: grant.client_id,
      }),
    );
    expect(fresh.access_token).toBeTruthy();
  });

  it("a code with the wrong PKCE verifier is refused and burned", async () => {
    const { form, grant, verifier } = await connect();
    expect((await form({ ...grant, code_verifier: "wrong".repeat(10) })).status).toBe(400);
    expect((await form({ ...grant, code_verifier: verifier })).status).toBe(400);
  });

  it("shows the connection, and disconnecting stops the app at once", async () => {
    const { form, grant, verifier, cookie } = await connect();
    const tokens = await json<{ access_token: string }>(
      form({ ...grant, code_verifier: verifier }),
    );
    const { connections } = await json<{
      connections: { id: string; app: string; chatId: string }[];
    }>(req("GET", "/connections", { cookie }));
    expect(connections).toEqual([expect.objectContaining({ app: "Claude" })]);
    expect(connections[0]?.chatId).toBeTruthy();
    await req("DELETE", `/connections/${connections[0]?.id}`, { cookie });
    expect(
      (await mcp(tokens.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status,
    ).toBe(401);
  });
});
