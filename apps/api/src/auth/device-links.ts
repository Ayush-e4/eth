import { randomInt } from "node:crypto";

const TTL_MS = 10 * 60 * 1000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I to misread

/**
 * Codes for "use this account on another device". A signed-in device shows one (and a QR of
 * /link#CODE); the new device sends it back while it makes its own passkey, and is signed in to
 * the same account. Each works once, for 10 minutes, one at a time per account. Kept in memory,
 * so a restart simply expires them.
 */
export function deviceLinks() {
  const codes = new Map<string, { userId: string; expires: number }>();
  const norm = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const peek = (code: string) => {
    const l = codes.get(norm(code));
    return l && l.expires > Date.now() ? l.userId : null;
  };
  return {
    make(userId: string) {
      for (const [c, l] of codes)
        if (l.userId === userId || l.expires < Date.now()) codes.delete(c);
      const raw = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
      const expires = Date.now() + TTL_MS;
      codes.set(raw, { userId, expires });
      return {
        code: `${raw.slice(0, 4)}-${raw.slice(4)}`,
        expiresAt: new Date(expires).toISOString(),
      };
    },
    /** Whose account a code is for, without using it up. */
    peek,
    /** Uses the code up and says whose account it was for (null: unknown, used or expired). */
    take(code: string) {
      const userId = peek(code);
      codes.delete(norm(code));
      return userId;
    },
  };
}

export type DeviceLinks = ReturnType<typeof deviceLinks>;

/** "iPhone · Safari" from a User-Agent, to tell a person's devices apart in their list. */
export function deviceLabel(ua = ""): string | null {
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh|Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : null;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\/|FxiOS/.test(ua)
      ? "Firefox"
      : /Chrome\/|CriOS/.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : null;
  return [os, browser].filter(Boolean).join(" · ") || null;
}
