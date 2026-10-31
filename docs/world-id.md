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

## Integration debrief (for World)

- **Time to first success:** _to fill in after the first live run._
- **Friction:** _to fill in._
- **Missing capability or documentation:** the device flow can't show *what* is being approved
  (`binding_message` isn't supported), so the World ID app shows only our app's name and a code.
  We record the action ourselves, as the docs advise. A signed "approve this payment of 0.03 USDC
  to AirNest" would let the human see and sign the actual action.
- **The one improvement with the greatest impact:** _to fill in._
