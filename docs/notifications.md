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
