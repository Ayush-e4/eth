import { Hono } from "hono";
import type { MarketCatalog } from "./catalog";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Public: the open market of agents, and one agent in full. No sign-in needed. */
export function marketRoutes(catalog: MarketCatalog | null) {
  const app = new Hono();
  app.get("/market", async (c) =>
    catalog ? c.json(await catalog.list()) : c.json({ error: "the market is off" }, 503),
  );
  app.get("/market/agents/:address", async (c) => {
    const address = c.req.param("address");
    if (!catalog) return c.json({ error: "the market is off" }, 503);
    if (!ADDRESS.test(address)) return c.json({ error: "not an agent address" }, 400);
    const agent = await catalog.agent(address);
    return agent ? c.json({ agent }) : c.json({ error: "no such agent on the market" }, 404);
  });
  return app;
}
