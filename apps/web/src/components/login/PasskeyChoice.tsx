"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ApiError, type Me } from "@/lib/api";
import { cancelled, passkeysSupported, signInWithPasskey, signUpWithPasskey } from "@/lib/passkey";
import { PasskeyIcon } from "../icons";

const primary =
  "flex min-h-[52px] w-full flex-col items-center justify-center gap-0.5 rounded-xl bg-teal px-5 py-2 text-white hover:bg-teal-dark disabled:opacity-60";
const secondary =
  "flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-line-2 bg-white text-[15px] font-semibold disabled:opacity-60";

/** New here: make a passkey (that's the account). Been here: sign in with it. */
export function PasskeyChoice({ onDone }: { onDone: (me: Me) => void }) {
  const [supported, setSupported] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setSupported(passkeysSupported()), []);

  const run = async (fn: () => Promise<Me>) => {
    setBusy(true);
    setError(null);
    try {
      onDone(await fn());
    } catch (err) {
      setError(
        cancelled(err)
          ? "The passkey prompt was closed. Try again when you're ready."
          : err instanceof ApiError
            ? `Sign-in failed: ${err.message}`
            : "This device couldn't use a passkey. Try your phone, or MetaMask below.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (!supported)
    return (
      <p className="rounded-xl bg-side px-4 py-3 text-sm text-ink-3">
        This browser can't use passkeys. Open AgentNet in Safari, Chrome or Edge, or use MetaMask
        below.
      </p>
    );
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        className={primary}
        disabled={busy}
        onClick={() => run(signUpWithPasskey)}
      >
        <span className="flex items-center gap-2 text-[15px] font-semibold">
          <PasskeyIcon size={20} /> Create an account with a passkey
        </span>
        <span className="text-xs text-[#D7E8EA]">
          Face ID, fingerprint or your phone. Free test money to try with.
        </span>
      </button>
      <button
        type="button"
        className={secondary}
        disabled={busy}
        onClick={() => run(signInWithPasskey)}
      >
        I have a passkey: sign in
      </button>
      <Link href="/link" className="self-center text-sm font-medium text-teal">
        Signed in on another device? Use your account here
      </Link>
      {error && (
        <p role="alert" className="rounded-xl bg-bad-soft px-4 py-3 text-sm text-bad">
          {error}
        </p>
      )}
    </div>
  );
}
