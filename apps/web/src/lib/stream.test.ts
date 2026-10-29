import { describe, expect, it } from "vitest";
import { parseBlock, readEvents } from "./stream";

function bodyOf(chunks: string[]) {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

async function all(chunks: string[]) {
  const out = [];
  for await (const e of readEvents(bodyOf(chunks))) out.push(e);
  return out;
}

describe("readEvents", () => {
  it("yields events even when blocks are split across chunks", async () => {
    const events = await all([
      'event: text\ndata: {"type":"te',
      'xt","delta":"Hel"}\n\nevent: text\ndata: {"type":"text","delta":"lo"}\n',
      '\nevent: done\ndata: {"type":"done","messageId":"m1"}\n\n',
    ]);
    expect(events).toEqual([
      { type: "text", delta: "Hel" },
      { type: "text", delta: "lo" },
      { type: "done", messageId: "m1" },
    ]);
  });

  it("handles CRLF line endings and a last block without a trailing blank line", async () => {
    expect(
      await all([
        'data: {"type":"status","label":"Thinking"}\r\n\r\ndata: {"type":"done","messageId":"x"}',
      ]),
    ).toEqual([
      { type: "status", label: "Thinking" },
      { type: "done", messageId: "x" },
    ]);
  });
});

describe("parseBlock", () => {
  it("skips comments, junk and unknown event types", () => {
    expect(parseBlock(": keep-alive")).toBeNull();
    expect(parseBlock("data: not json")).toBeNull();
    expect(parseBlock('data: {"type":"launch-missiles"}')).toBeNull();
  });

  it("parses a card event", () => {
    const card = {
      type: "options",
      question: "Q?",
      options: [
        { label: "A", reply: "a" },
        { label: "B", reply: "b" },
      ],
    };
    expect(parseBlock(`data: ${JSON.stringify({ type: "card", card })}`)).toEqual({
      type: "card",
      card,
    });
  });
});
