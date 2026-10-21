/** Shared plumbing for LiteAPI (Nuitee Connect). Sandbox keys only (they start with `sand_`). */

export const LITEAPI_URL = "https://api.liteapi.travel/v3.0";
export const LITEAPI_BOOK_URL = "https://book.liteapi.travel/v3.0";

export function assertSandboxKey(apiKey: string): void {
  if (!apiKey.startsWith("sand_")) {
    throw new Error("Refusing to use a LiteAPI key that is not a sandbox key");
  }
}

export function litePost(
  fetchImpl: typeof fetch,
  apiKey: string,
  url: string,
  body: unknown,
): Promise<unknown> {
  return liteSend(fetchImpl, apiKey, "POST", url, body);
}

/** POST/PUT a JSON body; returns parsed JSON (and the HTTP status, since 202 can mean "queued"). */
export async function liteSend(
  fetchImpl: typeof fetch,
  apiKey: string,
  method: "POST" | "PUT",
  url: string,
  body?: unknown,
  onStatus?: (status: number) => void,
): Promise<unknown> {
  const res = await fetchImpl(url, {
    method,
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const path = new URL(url).pathname;
    throw new Error(`LiteAPI ${path} → HTTP ${res.status}: ${await res.text()}`);
  }
  onStatus?.(res.status);
  return res.json();
}

export async function liteGet(
  fetchImpl: typeof fetch,
  apiKey: string,
  url: string,
  params: Record<string, string | number>,
): Promise<unknown> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const res = await fetchImpl(u.toString(), { headers: { "X-API-Key": apiKey } });
  if (!res.ok) throw new Error(`LiteAPI ${u.pathname} → HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}
