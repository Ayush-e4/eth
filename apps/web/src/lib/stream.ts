import { type ConciergeEvent, ConciergeEventSchema } from "@eth/shared";

/**
 * Reads a Server-Sent Events body chunk by chunk and yields each concierge event as soon as
 * its block is complete. Blocks are separated by a blank line; only `data:` lines matter here.
 * Anything that doesn't parse as a known event is skipped rather than breaking the chat.
 */
export async function* readEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ConciergeEvent> {
  const reader = body
    .pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>)
    .getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (value) buffer += value.replace(/\r\n/g, "\n");
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const event = parseBlock(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      if (event) yield event;
      end = buffer.indexOf("\n\n");
    }
    if (done) {
      const last = parseBlock(buffer);
      if (last) yield last;
      return;
    }
  }
}

export function parseBlock(block: string): ConciergeEvent | null {
  const data = block
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trimStart())
    .join("\n");
  if (!data) return null;
  try {
    const parsed = ConciergeEventSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Sends a chat message and streams the reply's events. */
export async function* sendMessage(chatId: string, text: string, signal?: AbortSignal) {
  const res = await fetch(`/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    credentials: "same-origin",
    signal,
  });
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    yield {
      type: "error",
      message: err.error ?? `couldn't send (${res.status})`,
    } as ConciergeEvent;
    return;
  }
  yield* readEvents(res.body);
}
