import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client";
import { users } from "../db/schema";
import { testDb } from "../test/db";
import { humanChecks } from "./checks";
import { type Poll, worldClient } from "./oidc";

const ISS = "https://auth.world.org";
const CFG = { issuer: ISS, clientId: "app_test", clientSecret: "worldidp_client_secret_x" };
const ORB = "https://world.org/oidc/acr/orb";
let key: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  key = pair.privateKey;
  const pub: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
  jwks = createLocalJWKSet({ keys: [pub] });
});

const now = () => Math.floor(Date.now() / 1000);
const token = (claims: Record<string, unknown> = {}, aud = CFG.clientId) =>
  new SignJWT({ auth_time: now(), acr: ORB, amr: ["pop", "iris"], ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISS)
    .setAudience(aud)
    .setSubject(String(claims.sub ?? "human-1"))
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);

const discovery = vi.fn(async () =>
  Response.json({
    device_authorization_endpoint: `${ISS}/api/v1/device_authorization`,
    token_endpoint: `${ISS}/api/v1/token`,
    jwks_uri: `${ISS}/.well-known/jwks.json`,
  }),
);
const client = () => worldClient(CFG, discovery as never, jwks);

describe("World ID ID-token checks", () => {
  it("accepts a fresh, Orb-level token for our app", async () => {
    expect(await client().verify(await token(), now() - 5)).toMatchObject({
      iss: ISS,
      sub: "human-1",
      acr: ORB,
    });
  });

  it.each([
    ["for another app", async () => token({}, "app_other"), /aud/],
    ["from before this attempt", async () => token({ auth_time: now() - 600 }), /isn't fresh/],
    ["with an unknown assurance", async () => token({ acr: "urn:weak" }), /isn't accepted/],
  ])("rejects a token %s", async (_, make, error) => {
    await expect(client().verify(await make(), now() - 5)).rejects.toThrow(error);
  });
});

let db: Db;
let userId: string;
const poll = vi.fn<(code: string) => Promise<Poll>>();
const verified = vi.fn();
const fakeWorld = () => ({
  ...client(),
  start: vi.fn(async () => ({
    deviceCode: "private-device-code",
    userCode: "ABCD-EFGH",
    verificationUri: "https://auth.world.org/device",
    verificationUriComplete: "https://auth.world.org/device?user_code=ABCD-EFGH",
    expiresIn: 600,
    interval: 5,
  })),
  poll,
});
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(async () => {
  vi.clearAllMocks();
  db = await testDb();
  const [u] = await db.insert(users).values({ isDemo: true }).returning();
  userId = u?.id ?? "";
});

describe("human checks for payment approvals", () => {
  const checks = () => humanChecks(db, fakeWorld(), verified, async () => {});

  it("waits for the person, validates, links their World ID and unlocks that one approval", async () => {
    poll
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "done", idToken: await token() });
    const h = checks();
    const c = await h.start(userId, "chat-1", "abc123");
    expect(c).toMatchObject({ status: "waiting", userCode: "ABCD-EFGH" });
    expect(JSON.stringify(c)).not.toContain("private-device-code"); // never leaves the server
    await settle();
    expect(h.get(c.id, userId)?.status).toBe("verified");
    expect(verified).toHaveBeenCalledWith("chat-1", "abc123");
    const [me] = await db.select().from(users);
    expect(me).toMatchObject({ worldIss: ISS, worldSub: "human-1" });
    expect(h.get(c.id, "someone-else")).toBeNull();
  });

  it.each([
    ["denied in the World ID app", { status: "denied", error: "access_denied" }, "denied"],
    ["left to expire", { status: "expired", error: "expired_token" }, "expired"],
    ["unavailable", { status: "failed", error: "HTTP 503" }, "failed"],
  ] as const)("unlocks nothing when %s", async (_, result, status) => {
    poll.mockResolvedValueOnce(result as Poll);
    const h = checks();
    const c = await h.start(userId, "chat-1", "abc123");
    await settle();
    expect(h.get(c.id, userId)?.status).toBe(status);
    expect(verified).not.toHaveBeenCalled();
  });

  it("refuses a different World ID than the one linked to the account", async () => {
    await db.update(users).set({ worldIss: ISS, worldSub: "human-1" });
    poll.mockResolvedValueOnce({ status: "done", idToken: await token({ sub: "human-2" }) });
    const h = checks();
    const c = await h.start(userId, "chat-1", "abc123");
    await settle();
    expect(h.get(c.id, userId)).toMatchObject({
      status: "mismatch",
      reason: "a different World ID",
    });
    expect(verified).not.toHaveBeenCalled();
  });

  it("won't link one World ID to two accounts", async () => {
    await db.insert(users).values({ isDemo: true, worldIss: ISS, worldSub: "human-1" });
    poll.mockResolvedValueOnce({ status: "done", idToken: await token() });
    const h = checks();
    const c = await h.start(userId, "chat-1", "abc123");
    await settle();
    expect(h.get(c.id, userId)?.reason).toBe("this World ID is linked to another account");
  });

  it("refuses a token that isn't fresh for this attempt", async () => {
    poll.mockResolvedValueOnce({
      status: "done",
      idToken: await token({ auth_time: now() - 3600 }),
    });
    const h = checks();
    const c = await h.start(userId, "chat-1", "abc123");
    await settle();
    expect(h.get(c.id, userId)?.status).toBe("failed");
    expect(verified).not.toHaveBeenCalled();
  });
});
