# Alerts outside the app (ntfy, Telegram)

When something happens while you're away, the chat gets a message, and you get a nudge with a
link back to it:

- an agent finished a job from earlier (pending hires),
- a fee is waiting for your review before it's paid out (pay on delivery),
- FareWatch found a drop, or the fare reached your target,
- PriceGuard rebooked your hotel and sent its invoice.

Each person links their own channels on **Watchers → Get alerts on your phone**, so a demo
account gets its own alerts (every demo login is its own account; only the test wallet is
shared). It's part of the app, not a paid agent: paying an agent per message would cost more in
network fees than the message is worth, and add minutes to every alert.

| Channel | Setup | How it's linked |
|---|---|---|
| **ntfy** | none (`NTFY_URL`, default `https://ntfy.sh`) | "Get my private topic": a long random topic name. Subscribe in the free ntfy app or a browser tab. Whoever knows the name can read it, so it's never shown to anyone else; self-host ntfy for private servers |
| **Telegram** | `TELEGRAM_BOT_TOKEN` from @BotFather | "Connect Telegram" opens the bot with a one-time code; tapping Start links that chat. `/stop` unlinks |

The bot reads its own messages (long polling), so it works on a laptop with no public address.
Sending is best effort: the chat message is the record.

Code: `apps/api/src/notify/` (`notifier.ts` channels and sending, `telegram.ts` the bot,
`post.ts` post-and-nudge, `routes.ts` `/notifications`), table `notify_channels`.

## Set up the Telegram bot (once)

1. In Telegram, message **@BotFather**, send `/newbot`, pick a name and a username.
2. Put the token in `.env` as `TELEGRAM_BOT_TOKEN=…` (never in chat or git), restart the API.
3. Watchers → Connect Telegram → Start.

## Chatting on Telegram

Once linked, the bot is also the concierge: anything you write that isn't a command goes to
your own AgentNet chat called "Telegram" (made on first use), so the conversation is in the app
too, with the same limits and agents (`apps/api/src/notify/telegram-chat.ts`, the shared turn in
`chats/turn.ts`).

- Quotes and choices come back as buttons; tapping one sends its reply, as in the app.
- "Ask first" approvals get Approve / Decline buttons (or a link when World ID must check it's you).
- A spending limit needs Face ID, which only a browser can do: the reply has an **Approve with
  Face ID** button that opens the chat in the app. Once approved, payments under it happen
  right from Telegram.
- Hires reply with a receipt and the HashScan link; later news (a delivery, a fare drop) arrives
  as an alert, as before.
- One message at a time per person, with "typing…" while the concierge works. Demo accounts
  keep their daily message allowance here too.
