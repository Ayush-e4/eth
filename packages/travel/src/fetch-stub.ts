/** Test helper: a fetch that records requests and answers canned JSON per URL fragment. */
export function stubFetch(routes: Record<string, unknown>) {
  const calls: { url: string; body: unknown; headers: Headers }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      body: JSON.parse(String(init?.body ?? "null")),
      headers: new Headers(init?.headers),
    });
    const hit = Object.entries(routes).find(([frag]) => url.includes(frag));
    return hit ? Response.json(hit[1]) : new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
