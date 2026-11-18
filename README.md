# Rolimon's Presence Tracker

Watches the live Rolimon's trade ad feed, filters for players whose **RAP** or **Value** falls into one of your brackets, confirms they are actually **in a Roblox game** right now, then posts an embed with their stats, profile, and a server-join link into the matching channel.

In each post:

- **Header** — avatar + username (author), game name as the title, both linking out
- **RAP / Value / Bracket** as three inline fields
- **Top limiteds** — the player's most valuable limiteds, each linked to its Rolimon's item page, with the total number they own in the field title
- **Buttons** — Profile, Rolimon's, Join server

## How it works

1. `GET https://api.rolimons.com/tradeads/v1/getrecentads` — every trade ad made in the last 3 minutes (ad id, timestamp, user id, username).
2. `POST https://presence.roblox.com/v1/presence/users` — batched presence check. Only `presenceType 2` (in a game) with a visible server survives.
3. `GET https://api.rolimons.com/players/v1/playerassets/{id}` — the player's inventory, priced with `items/v3/itemdetails` to compute total RAP and total Value.
4. Presence is re-checked right before posting, so nobody who already left their game gets posted.
5. Embed goes to the bracket channel, then that player is locked out of that channel for the cooldown window.

## Brackets

| Bracket   | Channel            |
| --------- | ------------------ |
| 100k–200k | `1572383197931638844` |
| 300k–400k | `1572383259109625976` |
| 500k–600k | `1572383272682651788` |
| 1M–2M     | `1572383285341065236` |
| 5M–10M    | `1572383299836580070` |

Channels and ranges live in `src/config.js`.

## Setup

```bash
cd rolimons-tracker
npm install
copy .env.example .env
```

Then fill in `.env`:

- `DISCORD_TOKEN` — from https://discord.com/developers/applications → your app → Bot → Reset Token.
- `GUILD_ID` — right-click your server → Copy Server ID. Commands register instantly instead of waiting for global propagation.

Invite the bot with `Send Messages` + `Embed Links`:

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_APP_ID&permissions=19456&scope=bot%20applications.commands
```

No privileged intents are required — the bot only reads guilds and uses slash commands.

## Run

```bash
npm start        # live
npm run dry      # prints matches to the console, no Discord connection
```

## Commands

- `/check player:<username or id>` — drops a full embed for one player without posting to a bracket.
- `/stats` — cached players, posted count, current settings.

## Settings

| Variable                  | Default | Notes |
| ------------------------- | ------- | ----- |
| `POLL_INTERVAL_SECONDS`   | 120     | Ads are returned for the past 3 min, so anything ≤ 180 is fine |
| `ROLIMONS_MIN_INTERVAL_MS`| 1300    | Rolimon's throttles above ~45 req/min and honours `Retry-After` |
| `VALUE_CACHE_MINUTES`     | 60      | Player RAP/Value is re-computed after this |
| `POST_COOLDOWN_MINUTES`   | 360     | Same player can't be reposted in the same bracket for 6h |
| `BUCKET_METRIC`           | both    | `both` = RAP **or** Value in range, or pin it to `rap` / `value` |
| `MAX_POSTS_PER_CYCLE`     | 10      | Keeps a first scan from dumping 50 embeds at once |
| `TOP_ITEMS`               | 5       | How many limiteds to list per post (max 10) |

## Notes

- Accounts that hide their join details (`presenceType 2` with a null `placeId`) are skipped — there is no server to link.
- Terminated and privacy-enabled accounts are skipped automatically.
- State (value cache + post cooldowns) is kept in `data/state.json`; delete it to reset.
- Rolimon's asks bots to use the API rather than scrape the site, which is what this does.
