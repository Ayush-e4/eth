"use client";

import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { cancelled, linkOptions, linkThisDevice, passkeysSupported } from "@/lib/passkey";
import { PasskeyIcon } from "../icons";

const primary =
  "flex h-[52px] w-full items-center justify-center gap-2 rounded-xl bg-teal px-5 text-[15px] font-semibold text-white hover:bg-teal-dark disabled:opacity-60";

const sentence = (m: string) => m.charAt(0).toUpperCase() + m.slice(1);

type Found = { code: string; name: string | null; options: PublicKeyCredentialCreationOptionsJSON };

/**
 * The new device's side of "use this account on another device": the code (typed, or from the
 * QR's /link#CODE) says which account; this device makes its own passkey for it and signs in.
 */
export function LinkDevice() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);

  const look = async (c: string) => {
    setBusy(true);
    setError(null);
    try {
      setFound({ code: c, ...(await linkOptions(c)) });
    } catch (err) {
      setError(
        err instanceof ApiError ? sentence(err.message) : "Couldn't reach AgentNet. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  // A scanned QR brings the code in the address's #fragment, which never reaches a server log.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on arrival
  useEffect(() => {
    setSupported(passkeysSupported());
    const c = decodeURIComponent(window.location.hash.slice(1));
    if (c) {
      setCode(c);
      void look(c);
    }
  }, []);

  const add = async () => {
    if (!found) return;
    setBusy(true);
    setError(null);
    try {
      await linkThisDevice(found.code, found.options);
      router.replace("/wallet?device=added#devices");
    } catch (err) {
      setError(
        cancelled(err)
          ? "The passkey prompt was closed, or this device already has a passkey for this account (then just sign in with it)."
          : err instanceof ApiError
            ? sentence(err.message)
            : "This device couldn't make a passkey. Try another browser.",
      );
      if (err instanceof ApiError && err.status === 410) setFound(null);
    } finally {
      setBusy(false);
    }
  };

  if (!supported)
    return (
      <p className="text-sm text-ink-3">This browser can't use passkeys. Try Safari or Chrome.</p>
    );
  return (
    <div className="flex w-full max-w-[440px] flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-[26px] font-bold tracking-tight">Use your account on this device</h1>
        <p className="text-[15px] leading-relaxed text-ink-3">
          {found
            ? `This device will get its own passkey for ${found.name ? `${found.name}'s` : "your"} account, and you'll be signed in.`
            : "On a device where you're signed in, open Wallet → Your devices → Add another device. Scan its QR code, or type the code here."}
        </p>
      </div>
      {found ? (
        <button type="button" className={primary} onClick={add} disabled={busy}>
          <PasskeyIcon size={20} /> Make a passkey on this device
        </button>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void look(code.trim());
          }}
        >
          <label htmlFor="code" className="text-sm font-semibold">
            Code from your other device
          </label>
          <input
            id="code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABCD-EFGH"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            className="h-12 rounded-xl border border-line-2 bg-white px-4 font-mono text-lg tracking-widest"
          />
          <button type="submit" className={primary} disabled={busy || code.trim().length < 8}>
            Continue
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="rounded-xl bg-bad-soft px-4 py-3 text-sm text-bad">
          {error}
        </p>
      )}
      <Link href="/login" className="self-center text-sm font-medium text-teal">
        Back to sign-in
      </Link>
    </div>
  );
}
