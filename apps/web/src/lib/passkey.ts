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

/** Makes a new passkey, which makes a new account, and signs in. */
export async function signUpWithPasskey(): Promise<Me> {
  const optionsJSON = await api<PublicKeyCredentialCreationOptionsJSON>(
    "/auth/passkey/register/options",
    { method: "POST", body: {} },
  );
  const response = await startRegistration({ optionsJSON });
  return (await api<{ user: Me }>("/auth/passkey/register", { method: "POST", body: { response } }))
    .user;
}

/** Signs in with a passkey this site made (the device asks which one). */
export async function signInWithPasskey(): Promise<Me> {
  const optionsJSON = await api<PublicKeyCredentialRequestOptionsJSON>(
    "/auth/passkey/login/options",
    { method: "POST", body: {} },
  );
  const response = await startAuthentication({ optionsJSON });
  return (await api<{ user: Me }>("/auth/passkey/login", { method: "POST", body: { response } }))
    .user;
}

/** The browser's way of saying "the person closed the prompt" (or it timed out). */
export const cancelled = (err: unknown) =>
  err instanceof Error && (err.name === "NotAllowedError" || err.name === "AbortError");
