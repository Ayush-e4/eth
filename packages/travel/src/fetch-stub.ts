/** Test helper: a fetch that records requests and answers canned JSON per URL fragment
 * (`{ __status, body }` to answer with another status). */
export function stubFetch(routes: Record<string, unknown>) {
  const calls: { url: string; method: string; body: unknown; headers: Headers }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: new Headers(init?.headers),
    });
    const hit = Object.entries(routes).find(([frag]) => url.includes(frag));
    if (!hit) return new Response("not found", { status: 404 });
    const v = hit[1] as { __status?: number; body?: unknown };
    return v && typeof v === "object" && "__status" in v
      ? Response.json(v.body, { status: v.__status })
      : Response.json(hit[1]);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
