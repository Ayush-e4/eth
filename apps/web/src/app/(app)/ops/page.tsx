import type { Metadata } from "next";
import { OpsView } from "@/components/ops/OpsView";

export const metadata: Metadata = { title: "Ops · AgentNet" };

/** Admins only (the API checks): money, usage, agents, and the switch to hide one. */
export default function OpsPage() {
  return <OpsView />;
}
