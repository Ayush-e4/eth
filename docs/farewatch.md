# FareWatch: a fare alert you hire from the chat

*"Watch Mumbai to Goa on 4 December and tell me if it drops below ₹3,000."* The concierge hires
FareWatch (skill `farewatch`, 0.02 USDC per watch) like any agent: a quote, the chat's limit, the
undo window, pay on delivery. Web2 analogy: a price alert on a travel site, run by an agent.

## What it does

- **Watches** one route and date (`origin`, `destination`, `date`, `adults`) for `hours` (default
  72), checking LiteAPI flights every `FAREWATCH_EVERY_MIN` minutes (default 15) and keeping every
  check (`apps/agents/src/specialists/farewatch.ts`, its watches in `.farewatch.local.json`).
- **Alerts** when the cheapest fare reaches the user's `targetInr`, or, without a target, when it's
  3% under the lowest seen so far. It never books: the buyer decides.
- Only the buyer on the watch's Arkiv job can read or stop it (requests signed, like bookings).

## In the chat

- A **live watch card**: the fare now, the lowest seen, where it started, the target, how many
  checks, alerts; **Check now** (once a minute) and **Stop watching**.
- The API follows every watch (`apps/api/src/hiring/watches.ts`, table `fare_watches`): each new
  alert is posted in the chat with **Book it** / **Keep watching**. A timer tick and a look from
  the card can't post the same alert twice.
- **Booking by itself** only when the user asked for it (`autoBook` and a target) in an "Auto"
  chat: it asks the flight agents for quotes and hires the cheapest fare at or under the target
  through the normal hire (limit, approvals, undo window, escrow). Never on a simulated drop.

## The Watchers page

`/watchers` (sidebar) lists every watch the user hired, from all their chats (`GET /watches`):
the ones still running first, then earlier ones, each with the same live card and a link to its
chat.

## Sandbox demos

Sandbox fares barely move, so `FAREWATCH_SIMULATE=1` (in both the market's and the API's env)
adds a **Simulate a 10% drop (sandbox)** button. A simulated check is labelled SIMULATED on the
card, in the alert message and in the watch itself, and is never booked on.

## Live (31 Oct 2026)

| Step | What happened |
|---|---|
| "Watch the fare Mumbai to Goa on 4 December, tell me if it drops below ₹3,000" | FareWatch found on the market (ERC-8004 #135), quoted: now ₹3,267 (IndiGo 6E5061) |
| Limit approved, hired | 0.02 USDC held → delivered → reviewed (log #133); the watch card appeared |
| Simulate a 10% drop | card and chat: "now ₹2,941, at or below your target of ₹3,000 … SIMULATED", with Book it |
| Book it | the concierge got live quotes (₹3,270 via AirNest) and, seeing the drop was simulated and the user already held that flight twice, asked before booking |
| Check now, Stop watching | back to the real ₹3,267; stopped |

FareWatch: Hedera account `0.0.11255607`, ERC-8004 #135, port 8416.
