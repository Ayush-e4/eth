# World ID on payment approvals

In an "Ask first" chat, every agent payment waits for the user's approval. With World ID turned
on, **approving needs a fresh World ID check**: proof that a real, unique person, the one linked to
this account, is present right now. A tapped button alone isn't enough.

Web2 analogy: a bank asking for your fingerprint before a transfer. Your session isn't the same as
you being there.

Built on **World ID Agent Pass** (`auth.world.org`), OpenID Connect, device flow.

## The flow

```
concierge ──hire_agent──▶ hiring service: "ask" chat → approval card (code abc123, human: true)
user taps "Approve with World ID"
web ──POST /chats/:id/approvals/abc123/human-check──▶ API ──device_authorization──▶ World ID
API ◀── user_code, link (the device_code stays on our server) ──
user opens the link → approves in the World ID app
API polls the token endpoint ──▶ ID token (signed JWT)
API checks it:
  - signature (World's keys), issuer, audience = our app, expiry
  - auth_time is after this check started (fresh for THIS approval, not an old session)
  - acr is Orb or Selfie Check level
  - (iss, sub) is the World ID linked to this account (the first check links it; one account each)
→ approval abc123 marked human-verified (valid 5 minutes)
web sees "verified" → sends "Approve abc123" → concierge hires → the payment runs once
```

**Nothing is paid** when the person declines in World ID, lets it expire, cancels, uses a
different World ID than the one linked, or reuses an old session. The same goes for a token that
fails any check above, or World ID being unavailable. The card says so ("…Nothing was paid") and
offers to try again.

The verdict is reached only on our server. The browser shows the status and can't mark an
approval as verified. Typing "Approve abc123" without a passed check does nothing.

## Code

| File | What it does |
|---|---|
| `apps/api/src/world/oidc.ts` | Discovery, device start and poll (`client_secret_basic`), ID-token checks with `jose` |
| `apps/api/src/world/checks.ts` | One check per approval: poll loop (interval, `slow_down`, expiry), account linking, verdict |
| `apps/api/src/world/routes.ts` | `POST /chats/:id/approvals/:code/human-check`, `GET /human-checks/:id` (owner only) |
| `apps/api/src/hiring/service.ts` | `requireHuman`: an approval counts only within 5 minutes of a passed check |
| `apps/web/src/components/chat/HumanApproval.tsx` | Approve with World ID → code + link → waiting → verified or "nothing was paid" |
| `apps/api/src/world/world.test.ts` | Locally signed tokens: good, wrong app, stale, weak assurance, denied, expired, 503, wrong World ID, one World ID on two accounts |

## Set it up

1. Register an app at https://auth.world.org/portal (Google sign-in). Client authentication:
   `client_secret_basic`. The device flow still needs one registered HTTPS callback; it isn't used.
2. Put the client ID and secret in `.env` as `WORLD_ID_CLIENT_ID` / `WORLD_ID_CLIENT_SECRET`
   (`WORLD_ID_ISSUER` defaults to `https://auth.world.org`). Restart the API.
3. Leave them empty and approvals work as before, without a human check.

## Status (31 Oct 2026)

| Path | Live? |
|---|---|
| Start a check: our app registered, World shows "AgentNet" and the same code as our card | ✅ production and sandbox |
| **Denied**: "Deny connection" on World's page → card says "You declined in World ID. Nothing was paid.", no hire recorded | ✅ live |
| Approved → validated → paid | ⏳ blocked on access to a test World ID (below); the server checks are covered by tests with locally signed tokens |

We run against the **sandbox** issuer (`WORLD_ID_ISSUER=https://sandbox.auth.world.org`). Its
banner says "Uses fake identities", but completing a proof there still needs World's sandbox app.

## Integration debrief (for World)

- **Time to first success:** about an hour from reading the docs to a live check started from our
  app, showing our name and code on World's page, with the denied path working end to end. The
  approved path is still blocked (see friction).
- **Friction:**
  1. The portal accepts only work Google accounts ("Personal Gmail accounts are not supported").
     We used a university account.
  2. The production World ID app asks a new user to verify at an Orb before it can approve
     anything, so a hackathon team can't complete a production proof.
  3. The sandbox needs World's sandbox app. The TestFlight link on the prize page
     (`testflight.apple.com/join/Tub7zuyD`) says "not found", and the prize page says proofs are
     mocked and the sandbox app isn't needed, without saying what replaces it.
  4. The web World ID Simulator can't answer Agent Pass requests: its Content Security Policy only
     allows `bridge.worldcoin.org` / `staging-bridge.worldcoin.org`, so fetching the request from
     `sandbox.auth.world.org/bridge/v1` is blocked ("Failed to fetch bridge request data").
- **Missing capability or documentation:**
  - How to complete a mocked proof in the sandbox without the TestFlight app.
  - The device flow can't show *what* is being approved (`binding_message` isn't supported), so
    the World ID app shows only our app's name and a code. We record the action ourselves, as the
    docs advise. A signed "approve this payment of 0.03 USDC to AirNest" would let the human see
    and sign the actual action.
- **The one improvement with the greatest impact:** let the web Simulator (or a "mock approve"
  button on the sandbox approval page) complete Agent Pass sandbox requests. Then anyone can
  test the full flow in minutes, with no phone, no Orb and no TestFlight.
