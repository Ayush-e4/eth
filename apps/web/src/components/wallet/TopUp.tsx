"use client";

import { useState } from "react";

/**
 * Free test money, fetched by the person themselves: Circle's faucet sends test USDC on Hedera
 * testnet to any address (with a captcha, so we can't do it for them). Their Face ID wallet can
 * receive it like any account, as can anything sent from their own testnet wallet.
 */
export function TopUp({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(address).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <section
      aria-label="Get more test USDC"
      className="flex flex-col gap-3 rounded-2xl border border-line p-4 text-sm"
    >
      <span className="font-semibold">Get more test USDC, free</span>
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-ink-3">
        <li>
          Copy your wallet's address:{" "}
          <span className="mt-1 flex flex-wrap items-center gap-2">
            <code className="rounded-lg bg-side px-2 py-1 font-mono text-xs break-all">
              {address}
            </code>
            <button
              type="button"
              onClick={copy}
              className="h-8 rounded-lg border border-line-2 bg-white px-3 text-xs font-semibold"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </span>
        </li>
        <li>
          Open{" "}
          <a
            className="font-medium text-teal underline"
            href="https://faucet.circle.com/"
            target="_blank"
            rel="noreferrer"
          >
            Circle's faucet
          </a>
          , pick <strong>Hedera testnet</strong>, paste the address and ask for USDC. It shows up
          here in a minute.
        </li>
      </ol>
      <span className="text-xs text-muted">
        Already have test USDC on Hedera testnet? Send it to the same address from your own wallet.
      </span>
    </section>
  );
}
