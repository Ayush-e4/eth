import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** IPv4/IPv6 ranges that aren't the public internet: loopback, private, link-local, etc. */
function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, incl. cloud metadata services
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return privateAddress(v6.slice(7)); // IPv4 mapped
  return (
    v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("ff")
  );
}

/**
 * The checker fetches a URL a user typed, from our server. In production that must never reach
 * our own network or a cloud metadata service (SSRF), so the host has to resolve only to public
 * addresses. In development, agents run on localhost, so local addresses are allowed.
 */
export async function safeAgentUrl(
  raw: string,
  production: boolean,
  resolve: (host: string) => Promise<string[]> = async (h) =>
    (await lookup(h, { all: true })).map((x) => x.address),
): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "not a URL" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    return { ok: false, reason: "only http(s) addresses" };
  if (u.username || u.password) return { ok: false, reason: "no credentials in the address" };
  if (production) {
    if (u.protocol !== "https:") return { ok: false, reason: "agents must use https" };
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const ips = isIP(host) ? [host] : await resolve(host).catch(() => []);
    if (!ips.length) return { ok: false, reason: `${host} doesn't resolve` };
    if (ips.some(privateAddress))
      return { ok: false, reason: "that address isn't on the public internet" };
  }
  u.hash = "";
  return { ok: true, url: u.toString() };
}
