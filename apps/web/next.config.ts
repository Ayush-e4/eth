import type { NextConfig } from "next";

// The browser only ever talks to this app: /api/* is forwarded to the Hono API, so the session
// cookie and Sign-In with Ethereum stay on one origin (no CORS, SameSite works as intended).
const API_URL = process.env.API_URL ?? "http://localhost:8787";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@eth/shared", "@eth/mandates"],
  cacheComponents: true,
  // Forwarded /api and /mcp requests may run long (an agent being hired and doing its job); the
  // default 30 s cut-off made a connected app see an error and hire again.
  experimental: { proxyTimeout: 300_000 },
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API_URL}/:path*` },
      // Connected apps (MCP + OAuth) look these up at the site's root.
      { source: "/mcp", destination: `${API_URL}/mcp` },
      {
        source: "/.well-known/oauth-authorization-server/:path*",
        destination: `${API_URL}/oauth/metadata`,
      },
      {
        source: "/.well-known/oauth-protected-resource/:path*",
        destination: `${API_URL}/oauth/resource`,
      },
    ];
  },
};

export default nextConfig;
