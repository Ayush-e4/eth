import type { Metadata } from "next";
import { Suspense } from "react";
import { ConsentView } from "@/components/connect/ConsentView";

export const metadata: Metadata = { title: "Connect an app · AgentNet" };

/** Where an app (e.g. Claude) sends you to give it a spending limit of its own. */
export default function AuthorizePage() {
  return (
    <Suspense fallback={<p className="p-10 text-center text-muted">Loading…</p>}>
      <ConsentView />
    </Suspense>
  );
}
