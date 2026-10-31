import { createHash, createHmac, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { type Hex, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Db } from "../db/client";
import { appConnections, oauthClients, oauthTokens } from "../db/schema";

const CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const b64url = (buf: Buffer) => buf.toString("base64url");

/** Apps may send people back only to https addresses, or to this computer while developing. */
export const okRedirect = (uri: string) => {
  try {
    const u = new URL(uri);
    return u.protocol === "https:" || ["localhost", "127.0.0.1"].includes(u.hostname);
  } catch {
    return false;
  }
};

export type Connection = typeof appConnections.$inferSelect;
export type Tokens = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
};

/**
 * OAuth 2.1 for apps that connect to AgentNet over MCP (Claude and others): they register
 * themselves, the user approves on our consent page (with Face ID, which also sets the app's
 * spending limit), and the app swaps the one-time code for tokens, proving with PKCE that it's
 * the app that asked. Web2 analogy: "Sign in with Google", except what's granted is a budget.
 */
export function oauthStore(db: Db, keySecret: Hex) {
  async function issue(connectionId: string, clientId: string): Promise<Tokens> {
    const access = secret();
    const refresh = secret();
    await db.insert(oauthTokens).values([
      {
        hash: sha256(access),
        kind: "access",
        connectionId,
        clientId,
        expiresAt: new Date(Date.now() + ACCESS_TTL_S * 1000),
      },
      {
        hash: sha256(refresh),
        kind: "refresh",
        connectionId,
        clientId,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    ]);
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
    };
  }

  /** Takes a live code or refresh token, once (the update both checks and uses it up). */
  async function take(token: string, kind: "code" | "refresh", clientId: string) {
    const [row] = await db
      .update(oauthTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(oauthTokens.hash, sha256(token)),
          eq(oauthTokens.kind, kind),
          eq(oauthTokens.clientId, clientId),
          isNull(oauthTokens.usedAt),
          gt(oauthTokens.expiresAt, new Date()),
        ),
      )
      .returning();
    return row ?? null;
  }

  return {
    /** The key that signs a connection's payments: derived from our secret, never stored. */
    agentKey(connectionId: string): Hex {
      const mac = createHmac("sha256", keySecret.slice(2))
        .update(`agentnet/connect/${connectionId}`)
        .digest();
      return keccak256(toHex(mac));
    },

    async register(name: string, redirectUris: string[]) {
      const id = `app_${secret().slice(0, 24)}`;
      await db.insert(oauthClients).values({ id, name, redirectUris });
      return { id, name, redirectUris };
    },

    async client(id: string) {
      return (await db.select().from(oauthClients).where(eq(oauthClients.id, id)))[0] ?? null;
    },

    /** A connection waiting for the user's Face ID; its key's address becomes the limit's agent. */
    async start(c: {
      userId: string;
      clientId: string;
      clientName: string;
      budgetUnits: bigint;
      perPaymentCapUnits: bigint;
      expiresAt: Date;
    }): Promise<Connection> {
      const id = crypto.randomUUID();
      const agentAddress = privateKeyToAccount(this.agentKey(id)).address;
      const [row] = await db
        .insert(appConnections)
        .values({ id, ...c, agentAddress })
        .returning();
      if (!row) throw new Error("could not start the connection");
      return row;
    },

    async activate(id: string, a: { mandateId: bigint; payer: string; chatId: string }) {
      await db
        .update(appConnections)
        .set({ ...a, status: "active" })
        .where(eq(appConnections.id, id));
    },

    async connection(id: string) {
      return (await db.select().from(appConnections).where(eq(appConnections.id, id)))[0] ?? null;
    },

    /** A one-time code for the app, bound to its redirect address and PKCE challenge. */
    async code(connectionId: string, clientId: string, redirectUri: string, challenge: string) {
      const code = secret();
      await db.insert(oauthTokens).values({
        hash: sha256(code),
        kind: "code",
        connectionId,
        clientId,
        codeChallenge: challenge,
        redirectUri,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      });
      return code;
    },

    /** Code → tokens, if it's this app's, for the same address, and the verifier matches. */
    async exchange(code: string, clientId: string, redirectUri: string, verifier: string) {
      const row = await take(code, "code", clientId);
      if (!row || row.redirectUri !== redirectUri) return null;
      if (b64url(createHash("sha256").update(verifier).digest()) !== row.codeChallenge) return null;
      return issue(row.connectionId, clientId);
    },

    async refresh(refreshToken: string, clientId: string) {
      const row = await take(refreshToken, "refresh", clientId);
      const c = row && (await this.connection(row.connectionId));
      return c?.status === "active" ? issue(c.id, clientId) : null;
    },

    /** The active connection behind an access token, or null. */
    async byAccessToken(token: string): Promise<Connection | null> {
      const [row] = await db
        .select({ c: appConnections })
        .from(oauthTokens)
        .innerJoin(appConnections, eq(appConnections.id, oauthTokens.connectionId))
        .where(
          and(
            eq(oauthTokens.hash, sha256(token)),
            eq(oauthTokens.kind, "access"),
            gt(oauthTokens.expiresAt, new Date()),
          ),
        );
      if (row?.c.status !== "active") return null;
      void db
        .update(appConnections)
        .set({ lastUsedAt: new Date() })
        .where(eq(appConnections.id, row.c.id))
        .catch(() => {});
      return row.c;
    },

    async forUser(userId: string) {
      return db.select().from(appConnections).where(eq(appConnections.userId, userId));
    },

    /** Disconnects: its tokens stop working at once (the limit is cancelled separately). */
    async revoke(userId: string, id: string) {
      const [row] = await db
        .update(appConnections)
        .set({ status: "revoked" })
        .where(and(eq(appConnections.id, id), eq(appConnections.userId, userId)))
        .returning();
      if (row) await db.delete(oauthTokens).where(eq(oauthTokens.connectionId, id));
      return !!row;
    },
  };
}

export type OAuthStore = ReturnType<typeof oauthStore>;
