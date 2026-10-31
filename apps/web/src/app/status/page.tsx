import type { Metadata } from "next";
import { StatusView } from "@/components/status/StatusView";

export const metadata: Metadata = { title: "Status · AgentNet" };

/** Public: is AgentNet up right now? No sign-in needed. */
export default function StatusPage() {
  return <StatusView />;
}
