import { randomBytes } from "node:crypto";

const TTL_MS = 15 * 60 * 1000;

/**
 * One-time sign-in links, for buttons the bot sends to a person's own linked Telegram chat:
 * tapping one opens the app signed in as them, at the page that needs them (often Telegram's
 * own browser, which has no AgentNet session). Each works once, for 15 minutes; kept in
 * memory, so a restart simply expires them.
 */
export function signInLinks() {
  const links = new Map<string, { userId: string; path: string; expires: number }>();
  return {
    make(userId: string, path: string) {
      const token = randomBytes(24).toString("base64url");
      links.set(token, { userId, path, expires: Date.now() + TTL_MS });
      return token;
    },
    take(token: string) {
      const l = links.get(token);
      links.delete(token);
      return l && l.expires > Date.now() ? l : null;
    },
  };
}

export type SignInLinks = ReturnType<typeof signInLinks>;
