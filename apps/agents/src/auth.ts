import { type LocalAccount, sha256, toBytes, verifyMessage } from "viem";

/**
 * Signed agent requests — the web3 version of "log in". The caller signs what it is asking for
 * with its key; the receiver recovers who signed it. No accounts, no passwords, no sessions.
 * (Who may do what is decided separately, e.g. "is the signer the buyer of this booking's job?")
 */
export const AUTH = {
  address: "x-agent-address",
  time: "x-agent-time",
  signature: "x-agent-signature",
} as const;

const MAX_SKEW_MS = 5 * 60_000; // a signature is only good for a few minutes (limits replays)

function message(method: string, path: string, time: string, body: string): string {
  return `eth-agentnet request\n${method.toUpperCase()} ${path}\n${time}\n${sha256(toBytes(body))}`;
}

export async function signedHeaders(
  account: LocalAccount,
  method: string,
  path: string,
  body: string,
  now = Date.now(),
): Promise<Record<string, string>> {
  const time = String(now);
  return {
    [AUTH.address]: account.address,
    [AUTH.time]: time,
    [AUTH.signature]: await account.signMessage({ message: message(method, path, time, body) }),
  };
}

/** Returns the signer's address, or throws if the signature is missing, stale or wrong. */
export async function verifySigned(
  header: (name: string) => string | undefined,
  method: string,
  path: string,
  body: string,
  now = Date.now(),
): Promise<`0x${string}`> {
  const address = header(AUTH.address);
  const time = header(AUTH.time);
  const signature = header(AUTH.signature);
  if (!address || !time || !signature) throw new Error("unsigned request");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new Error("malformed signature headers");
  }
  if (Math.abs(now - Number(time)) > MAX_SKEW_MS) throw new Error("signature expired");
  const ok = await verifyMessage({
    address: address as `0x${string}`,
    message: message(method, path, time, body),
    signature: signature as `0x${string}`,
  });
  if (!ok) throw new Error("bad signature");
  return address as `0x${string}`;
}

/** A JSON statement signed by its author, checkable by anyone (permission slips, receipts). */
export interface Signed<T> {
  body: T;
  signer: `0x${string}`;
  signature: `0x${string}`;
}

/** Same bytes whatever the key order: sort object keys recursively. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const statement = (kind: string, body: unknown) => `eth-agentnet ${kind}\n${canonical(body)}`;

export async function signStatement<T>(
  account: LocalAccount,
  kind: string,
  body: T,
): Promise<Signed<T>> {
  return {
    body,
    signer: account.address,
    signature: await account.signMessage({ message: statement(kind, body) }),
  };
}

export function verifyStatement<T>(kind: string, s: Signed<T>): Promise<boolean> {
  return verifyMessage({
    address: s.signer,
    message: statement(kind, s.body),
    signature: s.signature,
  }).catch(() => false);
}

/** The traveller lets a watcher agent reprice one booking, within limits only they can change. */
export interface RepriceDelegation {
  bookingId: string;
  agent: `0x${string}`; // the agent holding the booking (StayWise)
  delegate: `0x${string}`; // the watcher (PriceGuard)
  minSavingInr: number;
  minSavingPercent: number;
  until: string; // YYYY-MM-DD, normally check-in
  issuedAt: number;
}
