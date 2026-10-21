/** Shared plumbing for LiteAPI (Nuitee Connect). Sandbox keys only (they start with `sand_`). */

export const LITEAPI_URL = "https://api.liteapi.travel/v3.0";
export const LITEAPI_BOOK_URL = "https://book.liteapi.travel/v3.0";

export function assertSandboxKey(apiKey: string): void {
  if (!apiKey.startsWith("sand_")) {
    throw new Error("Refusing to use a LiteAPI key that is not a sandbox key");
  }
}

export async function litePost(
  fetchImpl: typeof fetch,
  apiKey: string,
  url: string,
  body: unknown,
): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const path = new URL(url).pathname;
    throw new Error(`LiteAPI ${path} → HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}
