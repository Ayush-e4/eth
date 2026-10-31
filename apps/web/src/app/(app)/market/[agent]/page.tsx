import { Suspense } from "react";
import { AgentView } from "@/components/market/AgentView";

export default function AgentPage({ params }: PageProps<"/market/[agent]">) {
  return (
    <Suspense fallback={<p className="p-10 text-center text-muted">Opening agent…</p>}>
      <Agent params={params} />
    </Suspense>
  );
}

async function Agent({ params }: { params: PageProps<"/market/[agent]">["params"] }) {
  const { agent } = await params;
  return <AgentView address={agent} />;
}
