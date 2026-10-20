import { health } from "@eth/shared";
import { Hono } from "hono";

export const app = new Hono();

app.get("/health", (c) => c.json(health("api")));
