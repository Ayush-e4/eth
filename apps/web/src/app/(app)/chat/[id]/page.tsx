import { Suspense } from "react";
import { ChatThread } from "@/components/chat/ChatThread";

export default function ChatPage({ params }: PageProps<"/chat/[id]">) {
  return (
    <Suspense fallback={<p className="p-10 text-center text-muted">Opening chat…</p>}>
      <Thread params={params} />
    </Suspense>
  );
}

async function Thread({ params }: { params: PageProps<"/chat/[id]">["params"] }) {
  const { id } = await params;
  return <ChatThread chatId={id} />;
}
