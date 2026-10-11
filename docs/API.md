# Optional HTTP API

HTTP is off unless `HTTP_ENABLED=true`. The default host is `127.0.0.1` and
port is 8000. Set a random `API_SECRET_KEY` of at least 32 characters before
enabling it. For Docker, bind HTTP to `0.0.0.0` inside the container and publish
the port to loopback on the host, as shown in compose.yaml. Use an authenticated
backend and HTTPS reverse proxy for remote access.

Authenticate with `Authorization: Bearer <key>` or `X-API-Key: <key>`.
This key grants administration of the bot's joined servers, including settings
and birthday data. It must never be embedded in a public website or sent to a
member's browser. There is no member OAuth or permissive CORS behavior.

Responses use `{ "success": true, "data": ... }` or
`{ "success": false, "error": ... }`, except successful DELETE returns 204.
Requests have a 64 KB body limit and a per-IP limit of 120 requests per minute.
Bodies must be JSON objects with `Content-Type: application/json`.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/healthz` | Unauthenticated ready check; 503 if not ready |
| GET | `/discord/v1/status` | Bot name, version, ready status |
| GET | `/discord/v1/ping` | Connectivity check |
| GET | `/discord/v1/plugins` | Registered plugin descriptions |
| GET | `/discord/v1/bots/:bot/guilds` | Current joined servers |
| GET | `/discord/v1/bots/:bot/guilds/:guild` | One joined server |
| GET | `/discord/v1/bots/:bot/guilds/:guild/plugins` | Stored settings |
| GET/PATCH | `/discord/v1/bots/:bot/guilds/:guild/plugins/:plugin` | Read or update one feature |
| GET | `/discord/v1/bots/:bot/guilds/:guild/leaderboard` | Paginated server ranking |
| GET | `/discord/v1/bots/:bot/guilds/:guild/birthdays` | Paginated birthdays |
| GET | `/discord/v1/bots/:bot/guilds/:guild/birthdays/today` | Birthdays in the configured time zone |
| GET/PUT/DELETE | `/discord/v1/bots/:bot/guilds/:guild/birthdays/:user` | Individual birthday |
| GET | `/discord/v1/leaderboards/global` | Lifetime XP by member across this bot's servers |
| GET | `/discord/v1/leaderboards/total-xp` | Aggregate lifetime XP for this bot |

`:bot` must match `DISCORD_CLIENT_ID`; unknown or unjoined guilds return 404.
Use `?page=1&limit=25` on paginated routes (limit 1–100, page 1–10000).
PATCH merges nested objects and replaces arrays. For example:

```json
{ "enabled": true, "config": { "xp_gain": { "min": 15, "max": 25 } } }
```

Birthday PUT accepts `{ "day": 10, "month": 10 }` and optional `year`.
The key holder is responsible for obtaining a member's consent before setting
their birthday through the administrative API. Members can remove their record
inside Discord. Provider webhook routes return 501 until their providers are
actually implemented.
