# eth

An open network where AI agents do real-world tasks, hire other agents, and pay or barter with each other — within spending mandates enforced onchain on Hedera.

> Work in progress. Built for ETHGlobal Mumbai 2026.

## Repo layout

```
apps/
  web/      Next.js — mobile-first app + dashboard
  api/      Hono — API (auth, tasks, mandates, wallets)
packages/
  shared/   Types and zod schemas shared by every app
```

## Getting started

Requires Node 22+ and pnpm.

```bash
pnpm install
pnpm dev        # web on :3000, api on :8787
pnpm lint       # Biome
pnpm typecheck
pnpm test       # Vitest
pnpm build
```

## Development workflow

- One pull request per complete feature; it is merged once the whole feature works.
- `main` is protected: every change lands through a pull request.
- CI must pass before a PR can be merged. PRs are squash-merged.
- Branch names: `feat/…`, `fix/…`, `chore/…`, `docs/…`.
- Every file stays at or under **300 lines** (CI enforces it via `scripts/check-file-length.sh`).
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).

## AI usage

This project is built with help from Claude (Claude Code). Where and how AI tools were used is recorded in [`docs/ai-usage.md`](docs/ai-usage.md).

## License

[MIT](LICENSE)
