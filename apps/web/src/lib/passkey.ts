import {
  browserSupportsWebAuthn,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { api, type Me } from "./api";

/**
 * Passkeys: Face ID, a fingerprint, or a phone held up to a laptop. The device signs a one-time
 * challenge from our server; the private key never leaves it.
 */
export const passkeysSupported = () => typeof window !== "undefined" && browserSupportsWebAuthn();

const DEVICE_KEY = "agentnet.passkey";
/** Which of the account's passkeys this browser signed in with ("This device" in the list). */
export function thisDevice(): string | null {
  try {
    return localStorage.getItem(DEVICE_KEY);
  } catch {
    return null;
  }
}
const remember = <T extends { id: string }>(response: T) => {
  try {
    localStorage.setItem(DEVICE_KEY, response.id);
  } catch {}
  return response;
};

/** Makes a new passkey, which makes a new account, and signs in. */
export async function signUpWithPasskey(): Promise<Me> {
  const optionsJSON = await api<PublicKeyCredentialCreationOptionsJSON>(
    "/auth/passkey/register/options",
    { method: "POST", body: {} },
  );
  const response = remember(await startRegistration({ optionsJSON }));
  return (await api<{ user: Me }>("/auth/passkey/register", { method: "POST", body: { response } }))
    .user;
}

/** Signs in with a passkey this site made (the device asks which one). */
export async function signInWithPasskey(): Promise<Me> {
  const optionsJSON = await api<PublicKeyCredentialRequestOptionsJSON>(
    "/auth/passkey/login/options",
    { method: "POST", body: {} },
  );
  const response = remember(await startAuthentication({ optionsJSON }));
  return (await api<{ user: Me }>("/auth/passkey/login", { method: "POST", body: { response } }))
    .user;
}

/** Another device: whose account a code (from a signed-in device) is for, and what to sign. */
export const linkOptions = (code: string) =>
  api<{ name: string | null; options: PublicKeyCredentialCreationOptionsJSON }>(
    "/auth/passkey/link/options",
    { method: "POST", body: { code } },
  );

/** Makes this device's own passkey on that account, and signs in. */
export async function linkThisDevice(
  code: string,
  optionsJSON: PublicKeyCredentialCreationOptionsJSON,
): Promise<Me> {
  const response = remember(await startRegistration({ optionsJSON }));
  return (
    await api<{ user: Me }>("/auth/passkey/link", { method: "POST", body: { code, response } })
  ).user;
}

/**
 * A move from the user's own wallet, approved with Face ID: the server prepares the batch and
 * hands back what the device should sign; the device signs it; the server runs it on Hedera.
 */
export async function withFaceId<T>(
  prepare: string,
  prepareBody: unknown,
  submit: string,
  submitBody: Record<string, unknown> = {},
): Promise<T> {
  const { opId, options } = await api<{
    opId: string;
    options: PublicKeyCredentialRequestOptionsJSON;
  }>(prepare, { method: "POST", body: prepareBody });
  const response = await startAuthentication({ optionsJSON: options });
  return api<T>(submit, { method: "POST", body: { ...submitBody, opId, response } });
}

/** The browser's way of saying "the person closed the prompt" (or it timed out). */
export const cancelled = (err: unknown) =>
  err instanceof Error && (err.name === "NotAllowedError" || err.name === "AbortError");
