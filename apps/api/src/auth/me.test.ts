import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { loadConfig } from "../config";
import { testDb } from "../test/db";

const ORIGIN = "http://localhost:3000";
let app: ReturnType<typeof createApp>;

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

type Me = { user: Record<string, unknown> };

beforeEach(async () => {
  app = createApp(await testDb(), loadConfig({ NODE_ENV: "test", APP_ORIGIN: ORIGIN }));
});

describe("PATCH /me", () => {
  it("starts with default spending settings and not onboarded", async () => {
    const me = (await (await req("GET", "/me", await signIn())).json()) as Me;
    expect(me.user).toMatchObject({
      defaultMode: "auto",
      defaultLimitUnits: "300000",
      onboarded: false,
    });
  });

  it("saves the profile and finishing setup", async () => {
    const cookie = await signIn();
    const res = await req("PATCH", "/me", cookie, {
      displayName: "Ayush",
      homeCity: "Mumbai",
      defaultMode: "ask",
      defaultLimitUnits: "500000",
      onboarded: true,
    });
    expect(((await res.json()) as Me).user).toMatchObject({
      displayName: "Ayush",
      homeCity: "Mumbai",
      defaultMode: "ask",
      defaultLimitUnits: "500000",
      onboarded: true,
    });
  });

  it("gives new chats the user's defaults", async () => {
    const cookie = await signIn();
    await req("PATCH", "/me", cookie, { defaultMode: "ask", defaultLimitUnits: "100000" });
    const chat = (await (await req("POST", "/chats", cookie)).json()) as Me & { chat: unknown };
    expect(chat.chat).toMatchObject({ mode: "ask", limitUnits: "100000" });
  });

  it("refuses bad values and unknown modes", async () => {
    const cookie = await signIn();
    expect((await req("PATCH", "/me", cookie, { defaultLimitUnits: "5000001" })).status).toBe(400);
    expect((await req("PATCH", "/me", cookie, { defaultMode: "yolo" })).status).toBe(400);
    expect((await req("PATCH", "/me", cookie, { displayName: "x".repeat(61) })).status).toBe(400);
    expect((await req("PATCH", "/me", cookie, { onboarded: false })).status).toBe(400);
  });

  it("needs a session", async () => {
    expect((await req("PATCH", "/me", "", { displayName: "x" })).status).toBe(401);
  });
});
