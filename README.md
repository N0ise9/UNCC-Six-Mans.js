# NormJS

NormJS is a single-process Discord bot for organizing in-house Six Mans matches across multiple guilds at once.

Its primary job is to keep the whole in-house flow moving: players join a queue, Norm helps turn that queue into matches, match results are recorded, and each guild keeps an internal leaderboard with wins, losses, and MMR.

Each guild is isolated from the others:
- its own PostgreSQL database URL
- its own queue, match, leaderboard, and API status state
- its own tracked Discord messages
- its own OpenAI conversation state

The bot uses one shared Discord client and one shared outbound work scheduler so post-ack message edits, follow-up replies, and status updates stay coordinated across guilds.

## What Norm Is

Norm boots once and reads per-guild setup from `.guild-instance-config.json`.

Bot-wide configuration lives in `.env`. Per-guild configuration does not.

In practice, Norm is meant to run a private competitive ecosystem inside each server. Players queue for in-house matches, Norm manages the queue and match flow, and completed matches feed a persistent leaderboard. Wins and losses provide standing and match history, while MMR gives each guild a skill-based ranking signal for its own internal competition.

Guilds can also decide which match tiers Norm is allowed to create, from `1v1` through `12v12`. By default, Norm keeps the familiar `2v2` and `3v3` flow enabled. The highest enabled tier auto-pops when the queue fills, while lower enabled tiers only become available as unanimous exact-size votes. A passed `1v1` vote starts immediately with random blue/orange sides.

Important runtime behavior:
- slash commands are registered per guild on startup
- any old global application commands are pruned on startup
- newly joined guilds get the current command set automatically
- `/norm` and optional `/sora` are slash-command-only and only work when a `chat_channel` is configured
- one bad guild database URL should not block the rest of the process
- stale queued button/select interactions are ignored when the authoritative state has already changed
- queue timers refresh every minute so displayed wait times stay current

## Requirements / Install

- Node.js `24.14.1` LTS recommended
- npm
- a Discord bot application and token
- an OpenAI API key for `/norm`
- one reachable PostgreSQL database per guild

Docker is recommended for local Postgres hosting, but Norm does not create or manage containers for you.

Install and prepare the repo:

```powershell
npm install
npm run generate
```

Start the bot in source mode:

```powershell
npm start
```

The current `start` script runs `tsx watch src/index.ts`.

## Configuration

Only bot-wide values belong in `.env`.

Example:

```env
token=YOUR_DISCORD_BOT_TOKEN
openai=YOUR_OPENAI_API_KEY
CONFIG_ENCRYPTION_KEY=replace-this-with-a-long-random-secret
NORM_HOME=
ENVIRONMENT=dev
PRISMA_STUDIO_PASSWORD=replace-this-with-a-host-only-password
conversation_token_limit=120000
ENABLE_SORA=false
```

What these do:
- `token`: Discord bot token
- `openai`: OpenAI API key
- `CONFIG_ENCRYPTION_KEY`: encrypts and decrypts stored per-guild database URLs
- `NORM_HOME`: optional runtime-root override for `.env`, `.guild-instance-config.json`, generated media, and packaged extracted assets
- `ENVIRONMENT`: optional runtime mode; `dev` enables development-only behavior in a few helper paths
- `PRISMA_STUDIO_PASSWORD`: required by `/prisma` in addition to the `Bot Admin` role
- `conversation_token_limit`: optional per-guild OpenAI conversation rotation threshold
- `ENABLE_SORA`: host-level master switch for `/sora` registration; when enabled, Norm uses the fixed model `sora-2-2025-12-08`

Important notes:
- `.env` is bot-wide only
- `.guild-instance-config.json` stores guild config
- each stored guild `databaseUrl` is encrypted at rest with `CONFIG_ENCRYPTION_KEY`
- do not rotate `CONFIG_ENCRYPTION_KEY` casually or old stored guild DB URLs will stop decrypting
- legacy `.env` values like `queue_channel_id`, `leaderboard_channel_id`, `guild_id`, `conversation_id`, and per-guild `DATABASE_URL` are not part of the active runtime anymore
- `DATABASE_URL` is only for one-off Prisma CLI commands such as `npx prisma db push`

## Database Setup

Each guild needs its own PostgreSQL endpoint. That can be:
- one Docker container per guild
- separate databases on one server
- any other reachable Postgres layout

Example Docker command for one guild database:

```powershell
docker run --name norm-guild-a-db `
  -e POSTGRES_USER=Norm `
  -e POSTGRES_PASSWORD=NormTheNiner `
  -e POSTGRES_DB=SixMansGuildA `
  -p 5432:5432 `
  -d postgres:latest
```

Example connection string:

```text
postgresql://Norm:NormTheNiner@localhost:5432/SixMansGuildA
```

Before using that URL in `/setup set`, push the Prisma schema to that database:

```powershell
$env:DATABASE_URL="postgresql://Norm:NormTheNiner@localhost:5432/SixMansGuildA"
npx prisma db push
```

When a guild database is loaded for the first time, Norm auto-creates a default active event if none exists yet. You do not need to seed the `Event` table manually for a fresh guild.

## Guild Setup

After the bot is online in a guild, configure that server with `/setup set`.

Current `/setup set` shape:

```text
/setup set
queue_channel:<text channel>
leaderboard_channel:<text channel>
database_url:<postgres connection string>
[chat_channel:<text channel>]
[api_status_channel:<text channel>]
[conversation_id:<existing OpenAI conversation id>]
[enable_1v1:true|false] ... [enable_12v12:true|false]
[sora_enabled:true|false]
```

Required fields:
- `queue_channel`
- `leaderboard_channel`
- `database_url`

Optional fields:
- `chat_channel`
- `api_status_channel`
- `conversation_id`
- `enable_1v1` through `enable_12v12`
- `sora_enabled`

Match tier defaults and behavior:
- new and legacy guilds default to `2v2, 3v3`
- the highest enabled tier auto-pops with no size vote
- lower enabled tiers only appear as unanimous votes when the queue reaches that exact size
- `1v1` skips captains/random and starts immediately with random sides once both queued players vote for it

Example:

```text
/setup set
queue_channel: #six-mans-queue
leaderboard_channel: #leaderboard
chat_channel: #norm-chat
api_status_channel: #api-status
database_url: postgresql://Norm:NormTheNiner@localhost:5432/SixMansGuildA
conversation_id: conv_1234567890abcdef
enable_4v4: true
enable_5v5: true
sora_enabled: true
```

Other setup commands:
- `/setup show`
- `/setup disable`

`/setup show` displays the stored guild config with secrets masked.

## Commands

Queue/admin commands:
- `/setup show`
- `/setup set`
- `/setup disable`
- `/kick`
- `/clear`
- `/prisma password:<value>`

OpenAI commands:
- `/norm`
- `/sora` when `ENABLE_SORA=true`

Current command behavior:
- commands are registered per guild, not globally
- `/norm` uses a stored conversation per guild
- `/norm` supports optional image attachments
- `/norm` and `/sora` are optional features and only work when a `chat_channel` is configured
- `ENABLE_SORA=false` means `/sora` is not registered anywhere
- `ENABLE_SORA=true` means `/sora` is registered, but each guild must still enable it with `/setup set sora_enabled:true`
- Sora is disabled by default for each guild
- Sora always uses the fixed model `sora-2-2025-12-08`
- `/sora` writes generated media under `data/generated-media`
- `/prisma` is not `chat_channel`-gated

`/prisma` behavior:
- requires the `Bot Admin` role
- requires `PRISMA_STUDIO_PASSWORD` from the host `.env`
- launches Prisma Studio on the machine running Norm
- does not open anything on the Discord user's machine
- reuses one managed Studio process at a time
- applies a 60-second global cooldown after a successful launch
- locks globally for 15 minutes after 3 failed password attempts within 10 minutes
- uses Discord's normal TLS transport, but it is not end-to-end encrypted from the user directly to Norm because Discord processes slash command options

## Windows EXE / Packaging

Norm can be packaged into a Windows single-EXE distribution using Node SEA.

Build it with:

```powershell
npm run package:windows
```

That produces `release/windows-portable` with:
- `Norm.exe`
- `.env.sample`
- `README.md`

The packaged build does not require the source repo beside it.

Packaged runtime behavior:
- `Norm.exe` can be run directly on first launch
- if companion files are missing, it auto-creates `.env.sample`, `README.md`, and `.env`
- the generated `.env` is only a starter template; you still need to fill in real values before the bot can start successfully
- runtime files live beside the EXE by default unless `NORM_HOME` is set
- `.guild-instance-config.json` is written beside the EXE by default
- generated media is written under `data/generated-media`
- embedded Prisma Studio assets are extracted on demand under `.norm-internal/sea-assets/<version>/`

Use `Norm.exe` as the only supported launcher. The EXE uses the Norm icon and keeps its console window open on interactive Windows startup/runtime failures so you can read the error. If Explorer keeps showing an old Node.js icon after replacing an existing local package, refresh Explorer or rebuild into a fresh folder because Windows can cache EXE icons by path. If Norm is launched under Windows Terminal, the taskbar may show the Terminal icon because Terminal owns the visible console window.

Packaging notes:
- build the EXE on Windows with the same Node version you want to ship
- `npm run package:windows` is the supported packaging path
- GitHub Actions keeps normal lint/build/test checks on push and PR
- the Windows package artifact is produced from the build workflow through manual `workflow_dispatch`

## Tests / CI

Useful local commands:

```powershell
npm run lint
npm run build
npm run generate
npm run test
```

Integration tests use `TEST_DATABASE_URL`. The value can come from:
- a shell environment variable
- or a local `.env.test.local` file

Recommended local setup:

```powershell
Copy-Item .env.test.sample .env.test.local
```

Default sample file:

```env
TEST_DATABASE_URL=postgresql://Norm:NormTheNiner@localhost:5432/SixMansTesting
```

If your local test database uses a different name or host, change only `TEST_DATABASE_URL` in `.env.test.local`.

Push the Prisma schema to the integration database:

```powershell
npm run integration:db:push
```

Then run the integration suite:

```powershell
npm run integration
```

Current test contract:
- unit tests do not load the runtime `.env`
- unit tests are offline by default and must mock `fetch` explicitly
- integration tests use `TEST_DATABASE_URL` from the shell first, then `.env.test.local`
- integration tests reset the database they point at, so `TEST_DATABASE_URL` must be a dedicated test database and must not match any live guild/runtime database
- `npm run integration` and `npm run integration:db:push` fail fast if `TEST_DATABASE_URL` is missing or unsafe

GitHub Actions behavior:
- lint, build, unit tests, and integration tests run on branch pushes and pull requests
- GitHub integration tests use the workflow's own Postgres service container
- GitHub does not connect to your host machine Docker or Postgres setup
- the Windows portable package workflow is manual-only

## Troubleshooting

If a guild fails to initialize:
- verify the `database_url` from `/setup set`
- verify the Postgres endpoint is reachable from the machine running Norm
- verify the Prisma schema has been pushed to that database
- verify the configured Discord channels still exist
- verify `CONFIG_ENCRYPTION_KEY` has not changed since the guild config was saved

If `/norm` or `/sora` refuse to run:
- make sure the guild has a `chat_channel` configured if you want to use OpenAI features
- make sure you are running the command in the configured `chat_channel`
- rerun `/setup set` if the stored `chat_channel` is missing or points to the wrong channel
- if `/sora` says it is disabled for the server, rerun `/setup set sora_enabled:true`
- if `/sora` is missing entirely, make sure `ENABLE_SORA=true` on the host and restart the bot

If `/prisma` fails:
- make sure the guild has already been configured with `/setup set`
- make sure the user running `/prisma` has the `Bot Admin` role
- make sure `PRISMA_STUDIO_PASSWORD` is set in the host `.env`
- check the bot console for Prisma Studio startup errors

If the packaged EXE starts and exits immediately:
- open the generated `.env`
- fill in the required bot-wide values like `token`, `openai`, and `CONFIG_ENCRYPTION_KEY`
- run `Norm.exe` again

If Sora fails at startup:
- set `ENABLE_SORA=false`, or
- ensure your OpenAI project has access to the Videos API used by the fixed `sora-2-2025-12-08` model
