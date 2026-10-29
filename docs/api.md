# API server

`apps/api` is a Hono server backed by Postgres. It is what the web app talks to.

## Run it locally

```bash
pnpm db:up                          # Postgres 17 in Docker on 127.0.0.1:54329
pnpm --filter @eth/api dev          # http://localhost:8787, applies migrations on start
pnpm db:down                        # stop the database (data stays in the Docker volume)
```

Port 54329 is deliberate, so the container never clashes with a Postgres you already run on 5432.
Tests don't need Docker: they run against PGlite, an in-memory Postgres, with the same migrations.

Change the schema in `src/db/schema.ts`, then `pnpm --filter @eth/api db:generate` writes the
SQL migration to `apps/api/drizzle/`. Commit it with the schema change.

## Sign-in (Sign-In with Ethereum)

Web2 analogy: a password login where the "password" is a signature only your wallet can make.

1. `GET /auth/nonce` gives a one-time code, valid 10 minutes.
2. The browser builds a sign-in message with that code (domain, `APP_ORIGIN`, chain 296 =
   Hedera testnet) and MetaMask signs it. Signing is free and sends no transaction.
3. `POST /auth/verify {message, signature}` checks the message is for this site and network,
   that the signature matches the account, and uses the code up in the same database statement
   so it can't be replayed. It then sets an httpOnly `eth_session` cookie (7 days).
4. `GET /me` returns the signed-in user and their roles. `POST /auth/logout` ends the session.

Only a SHA-256 hash of the session token is stored, so a database leak doesn't hand out logins.
Writes from any origin other than `APP_ORIGIN` are refused, and cookies are `SameSite=Lax`.

`POST /auth/demo` ("Try the demo") creates a fresh demo user with no wallet. Turn it off with
`DEMO_MODE=off`.

## Roles

| Role | Who | How it's decided |
|---|---|---|
| user | everyone signed in | default |
| admin | wallets in `ADMIN_WALLETS` | server setting, so nobody can make themselves admin |
| builder | people who own an agent | added when agents are stored in the database |
