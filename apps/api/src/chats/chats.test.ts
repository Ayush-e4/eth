import { type ConciergeEvent, ConciergeEventSchema } from "@eth/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { Concierge, ConciergeInput } from "../concierge/concierge";
import { loadConfig } from "../config";
import { testDb } from "../test/db";

const ORIGIN = "http://localhost:3000";
let app: ReturnType<typeof createApp>;
let calls: ConciergeInput[];

/** Streams "Hello " + "there", shows one options card, like the real concierge would. */
const fake: Concierge = async (input) => {
  calls.push(input);
  input.emit({ type: "status", label: "Thinking" });
  input.emit({ type: "text", delta: "Hello " });
  const card = {
    type: "options" as const,
    question: "Which weekend?",
    options: [
      { label: "This one", reply: "This weekend" },
      { label: "Next one", reply: "Next weekend" },
    ],
  };
  input.emit({ type: "card", card });
  input.emit({ type: "text", delta: "there" });
  return { text: "Hello there", cards: [card] };
};

async function boot(concierge: Concierge | null = fake) {
  calls = [];
  app = createApp(await testDb(), loadConfig({ NODE_ENV: "test", APP_ORIGIN: ORIGIN }), {
    concierge,
  });
}

const req = (method: string, path: string, cookie: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function signIn() {
  const res = await app.request("/auth/demo", { method: "POST", headers: { origin: ORIGIN } });
  return res.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function newChat(cookie: string) {
  return ((await (await req("POST", "/chats", cookie)).json()) as { chat: { id: string } }).chat.id;
}

/** Parses an SSE body into the events the app would receive. */
async function events(res: Response): Promise<ConciergeEvent[]> {
  return (await res.text())
    .split("\n\n")
    .map((block) => block.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => !!l)
    .map((l) => ConciergeEventSchema.parse(JSON.parse(l.slice(6))));
}

beforeEach(() => boot());

describe("chats", () => {
  it("needs a session", async () => {
    expect((await app.request("/chats")).status).toBe(401);
  });

  it("creates, lists, renames and deletes a chat", async () => {
    const me = await signIn();
    const id = await newChat(me);
    const patched = await req("PATCH", `/chats/${id}`, me, {
      title: "Goa",
      mode: "ask",
      limitUnits: "500000",
    });
    expect(await patched.json()).toMatchObject({
      chat: { title: "Goa", mode: "ask", limitUnits: "500000" },
    });
    const list = (await (await req("GET", "/chats", me)).json()) as { chats: { id: string }[] };
    expect(list.chats.map((c) => c.id)).toEqual([id]);
    expect((await req("DELETE", `/chats/${id}`, me)).status).toBe(200);
    expect((await req("GET", `/chats/${id}`, me)).status).toBe(404);
  });

  it("refuses a chat limit above 5 USDC", async () => {
    const me = await signIn();
    const id = await newChat(me);
    expect((await req("PATCH", `/chats/${id}`, me, { limitUnits: "5000001" })).status).toBe(400);
  });

  it("never shows one user's chat to another", async () => {
    const alice = await signIn();
    const bob = await signIn();
    const id = await newChat(alice);
    expect((await req("GET", `/chats/${id}`, bob)).status).toBe(404);
    expect((await req("POST", `/chats/${id}/messages`, bob, { text: "hi" })).status).toBe(404);
    expect((await req("DELETE", `/chats/${id}`, bob)).status).toBe(404);
    expect((await req("GET", "/chats/not-a-uuid", alice)).status).toBe(404);
  });
});

describe("sending a message", () => {
  it("streams the reply as events and saves both turns", async () => {
    const me = await signIn();
    const id = await newChat(me);
    const res = await req("POST", `/chats/${id}/messages`, me, { text: "Plan a Goa weekend" });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const got = await events(res);
    expect(got.map((e) => e.type)).toEqual(["status", "text", "card", "text", "done"]);

    const body = (await (await req("GET", `/chats/${id}`, me)).json()) as {
      chat: { title: string };
      messages: { role: string; text: string; cards: unknown[] }[];
    };
    expect(body.chat.title).toBe("Plan a Goa weekend"); // first message names the chat
    expect(body.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "Plan a Goa weekend"],
      ["assistant", "Hello there"],
    ]);
    expect(body.messages[1]?.cards).toHaveLength(1);
  });

  it("gives the concierge the earlier turns and the chat's spending settings", async () => {
    const me = await signIn();
    const id = await newChat(me);
    await events(await req("POST", `/chats/${id}/messages`, me, { text: "first" }));
    await events(await req("POST", `/chats/${id}/messages`, me, { text: "second" }));
    expect(calls[1]?.history).toEqual([
      { role: "user", text: "first" },
      // cards the user saw are summarised so the concierge remembers them
      { role: "assistant", text: "Hello there\n[asked: Which weekend? — This one / Next one]" },
    ]);
    expect(calls[1]?.chat).toMatchObject({ mode: "auto", limitUnits: 300_000n });
  });

  it("sends an error event and saves no reply when the concierge fails", async () => {
    await boot(async () => {
      throw new Error("upstream down");
    });
    const me = await signIn();
    const id = await newChat(me);
    const got = await events(await req("POST", `/chats/${id}/messages`, me, { text: "hi" }));
    expect(got).toEqual([{ type: "error", message: "The concierge couldn't answer. Try again." }]);
    const body = (await (await req("GET", `/chats/${id}`, me)).json()) as { messages: unknown[] };
    expect(body.messages).toHaveLength(1);
  });

  it("refuses empty or oversized messages, and says when the concierge is off", async () => {
    const me = await signIn();
    const id = await newChat(me);
    expect((await req("POST", `/chats/${id}/messages`, me, { text: "  " })).status).toBe(400);
    expect(
      (await req("POST", `/chats/${id}/messages`, me, { text: "x".repeat(4001) })).status,
    ).toBe(400);
    await boot(null);
    const me2 = await signIn();
    const id2 = await newChat(me2);
    expect((await req("POST", `/chats/${id2}/messages`, me2, { text: "hi" })).status).toBe(503);
  });
});
