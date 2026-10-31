# Sign-in, roles and the ops page

How people sign in to the API (`apps/api`), what each kind of account can do, and the admins'
ops page. The rest of the API is in [api.md](api.md).

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

## Sign-in with a passkey

Web2 analogy: "Sign in with Apple", without an Apple account. A passkey is a key pair made by the
person's device (Face ID, a fingerprint, or a phone held up to a laptop). The private key never
leaves the device; we store only the public key (`passkeys` table) and check a signature on a
one-time challenge at each sign-in.

1. `POST /auth/passkey/register/options` gives the browser what it needs to make a passkey for
   this site, including a one-time challenge (5 minutes, stored in `auth_nonces`).
2. `POST /auth/passkey/register {response}` checks the device's answer (right site, right
   challenge, used up once), creates the account and signs in.
3. `POST /auth/passkey/login/options` then `POST /auth/passkey/login {response}` sign back in
   with any passkey this site made; the device asks which one.

A passkey only works on the site that made it (`APP_ORIGIN`'s hostname), so a look-alike site
can't use it. We ask for P-256 keys only, the kind phones and laptops use, so the same passkey
can later control an on-chain wallet. New passkey accounts get their own Face ID wallet (below) and keep their chats across visits; making one needs `DEMO_MODE=on`, signing back in
doesn't. `GET /me` says `passkey: true` for them.

### Their own wallet (Face ID approves limits)

Each passkey account also gets its own wallet on Hedera: a `PasskeyWallet` contract whose only
key is that passkey (see [mandates.md](mandates.md#passkey-wallets-face-id-controls-the-wallet)).
Sign-up makes it in the background (`passkey_wallets` table, status creating → ready) and the demo
wallet sends it `WALLET_GIFT_UNITS` of test USDC (0.50 by default, at most
`WALLET_GIFTS_PER_DAY` new wallets a day). We send its transactions and pay the gas; we can't
change them.

A wallet move is two calls, the same way for a limit and for a cancel:

1. `POST /chats/:id/mandate/face-id {card}` (or `POST /wallet/limits/:id/revoke/face-id`): the
   server builds the batch (approve USDC + create the limit, or revoke it), reads its digest from
   the wallet, and returns `{opId, options}`: WebAuthn request options whose challenge is that
   digest, for this user's passkey only, user verification required.
2. The browser asks the device (Face ID), then `POST /chats/:id/mandate {opId, response, card}`
   (or `POST /wallet/limits/:id/revoke {opId, response}`). The server checks it's the same op,
   passkey, origin and challenge, and submits the batch; the contract checks the signature.

An op is good for 5 minutes and runs once. `GET /me` carries `wallet: {address, status}`;
`GET /wallet` shows the wallet as the account (`faceId: {status, giftUnits}`) and each limit's
`via` (`face-id`, `wallet` or `demo`). The concierge pays agents from these limits exactly as from
MetaMask ones: the registry pulls fees from the wallet, and refunds go back to it.

`POST /auth/demo` ("Just looking? Try it without an account") creates a throwaway demo user with
no wallet and no passkey: it's gone once the cookie is. Turn it off with `DEMO_MODE=off`.

## Roles

| Role | Who | How it's decided |
|---|---|---|
| user | everyone signed in | default |
| admin | wallets in `ADMIN_WALLETS`, account ids in `ADMIN_USERS` | server settings, so nobody can make themselves admin |
| builder | people who own an agent | added when agents are stored in the database |

## Ops page (admins)

`/ops` in the web app, `GET /ops` in the API: is the money there (demo wallet USDC and HBAR, the
concierge's HBAR for pay-on-delivery releases, today's demo fees and Face ID gifts), is anyone
using it (accounts by kind, new accounts, messages and hires in the last 24 hours, the latest 20
hires), and every listed agent with whether it's up and what it did here.

`POST /ops/agents/:address/hide {reason}` takes an agent off AgentNet at once: the Market page,
the concierge's search and its quotes leave it out (`hidden_agents` table; quotes say "not
offered on AgentNet"). Its Arkiv listing is its own and stays. `POST /ops/agents/:address/unhide`
puts it back.

Admins come from server settings only: `ADMIN_WALLETS` (MetaMask addresses) and `ADMIN_USERS`
(account ids, for passkey accounts). A signed-in non-admin gets 403 with their account id, which
the page shows so it can be added. Top-ups are by hand (the faucets have captchas); the page links
them.
