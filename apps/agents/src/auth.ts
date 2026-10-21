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
