# NormJS

NormJS is a single-instance Discord bot for running Six Mans across multiple servers from one process.

Each guild is isolated from the others:
- its own PostgreSQL database URL
- its own queue, match, and leaderboard state
- its own tracked Discord messages
- its own OpenAI conversation state

The bot uses one shared Discord client and one shared outbound Discord work scheduler so queue updates, embed edits, and follow-up messages stay coordinated when multiple guilds are active at once. OpenAI features are slash-command-only through `/norm` and optional `/sora`.

## How Norm Works

Norm boots once and loads guild-specific configuration from `.guild-instance-config.json`.

Per-guild configuration is created inside Discord with `/setup set`, not by editing `.env`.

That means:
- `.env` stores bot-wide secrets and runtime flags
- `.guild-instance-config.json` stores per-guild configuration
- each guild record stores its own encrypted `databaseUrl`
- the `databaseUrl` is encrypted at rest with `CONFIG_ENCRYPTION_KEY`

If one guild has a bad database URL or an unreachable Docker-backed Postgres endpoint, that guild can fail to load without taking down the rest of the bot.

## Requirements

- Node.js 24.14.1 LTS recommended
- npm
- A Discord bot application and token
- An OpenAI API key for `/norm`
- One PostgreSQL database endpoint per guild

Docker is recommended for local hosting of those PostgreSQL databases, but the bot does not create or manage containers for you.

## Installation

1. Clone the repository.
2. Install dependencies:

```powershell
npm install
```

3. Generate the Prisma client:

```powershell
npm run generate
```

4. Create a `.env` file in the project root.

You can start from `.env.sample`.

## Bot-Wide Configuration

Only put bot-wide configuration in `.env`.

Example:

```env
token=YOUR_DISCORD_BOT_TOKEN
openai=YOUR_OPENAI_API_KEY
CONFIG_ENCRYPTION_KEY=replace-this-with-a-long-random-secret
NORM_HOME=
ENVIRONMENT=dev
conversation_token_limit=120000
ENABLE_SORA=false
SORA_MODEL=
```

What these do:
- `token`: Discord bot token
- `openai`: OpenAI API key
- `CONFIG_ENCRYPTION_KEY`: used to encrypt and decrypt stored per-guild database URLs
- `NORM_HOME`: optional runtime root override for `.env`, `.guild-instance-config.json`, and generated media
- `ENVIRONMENT`: optional runtime mode; `dev` enables dev-only behavior in a few helper paths
- `conversation_token_limit`: optional input-token threshold for rotating a guild's stored OpenAI conversation
- `ENABLE_SORA`: enables the `/sora` slash command
- `SORA_MODEL`: required only when `ENABLE_SORA=true`

Important:
- Do not rotate `CONFIG_ENCRYPTION_KEY` casually. If it changes, existing stored guild database URLs can no longer be decrypted.
- If `NORM_HOME` is unset, source-mode runs use the current working directory and the packaged executable uses the folder beside `Norm.exe`.
- Old `.env` values like `queue_channel_id`, `leaderboard_channel_id`, `guild_id`, `conversation_id`, and per-guild `DATABASE_URL` are legacy and are not the active per-guild setup path anymore.
- `DATABASE_URL` is only needed for one-off Prisma CLI commands like `npx prisma db push`; the bot runtime itself reads per-guild database URLs from `.guild-instance-config.json`.

## Database Setup

Norm expects each guild to point at its own PostgreSQL database URL. Those URLs can be separate Docker containers, separate databases on one server, or any other reachable Postgres endpoints.

Example Docker command for one guild database:

```powershell
docker run --name norm-guild-a-db `
  -e POSTGRES_USER=Norm `
  -e POSTGRES_PASSWORD=NormTheNiner `
  -e POSTGRES_DB=SixMansGuildA `
  -p 5432:5432 `
  -d postgres:latest
```

Example connection string for that database:

```text
postgresql://Norm:NormTheNiner@localhost:5432/SixMansGuildA
```

Before using that URL in `/setup set`, initialize the schema against that database.

PowerShell example:

```powershell
$env:DATABASE_URL="postgresql://Norm:NormTheNiner@localhost:5432/SixMansGuildA"
npx prisma db push
```

Bash example:

```bash
DATABASE_URL="postgresql://Norm:NormTheNiner@localhost:5432/SixMansGuildA" npx prisma db push
```

Repeat that for each guild database you plan to use.

When a guild database is loaded for the first time, Norm will automatically create a default active event if that database does not already have one. You do not need to seed the `Event` table manually just to get a fresh guild running.

## Starting the Bot

Start the bot with:

```powershell
npm start
```

The current start script runs `tsx watch src/index.ts`.

When the bot starts successfully, it registers slash commands globally and logs the path to the per-guild config store.

## Windows Portable EXE

Norm can also be packaged into a Windows portable executable using Node SEA.

Build it with:

```powershell
npm run package:windows
```

That creates a portable folder under `release/windows-portable` containing:
- `Norm.exe`
- `Norm.cmd`
- `.env.sample`
- `README.md`

Before the first launch, copy `.env.sample` to `.env` in that same folder and fill in your bot-wide values there.

Use `Norm.cmd` as the default double-click launcher. It starts `Norm.exe` from its own folder and keeps the console window open after the process exits so you can read startup or crash output.

Portable runtime behavior:
- `.env` is read from the executable folder by default
- `.guild-instance-config.json` is written beside the executable by default
- generated media is written under `data/generated-media` beside the executable by default
- set `NORM_HOME` if you want those runtime files somewhere else

Important packaging notes:
- build the EXE on Windows with the same Node version you want to ship
- the packaged path uses the official Node SEA workflow plus an `esbuild` bundle step
- GitHub Actions keeps normal lint/build/test checks on push and PR, while the Windows packaging artifact is intended for manual `workflow_dispatch` runs

## Guild Setup

After the bot is online in a guild, run `/setup set` in that server.

Current required setup fields:
- `queue_channel`
- `leaderboard_channel`
- `chat_channel`
- `database_url`

Optional setup fields:
- `api_status_channel`
- `conversation_id`

Example:

```text
/setup set
queue_channel: #six-mans-queue
leaderboard_channel: #leaderboard
chat_channel: #norm-chat
api_status_channel: #api-status
database_url: postgresql://Norm:NormTheNiner@localhost:5432/SixMansGuildA
conversation_id: conv_1234567890abcdef
```

Use `/setup show` to inspect the stored config for the current guild.

Use `/setup disable` to disable the guild runtime entry without deleting the stored file manually.

## Slash Commands

### Queue/Admin
- `/kick`
- `/clear`
- `/setup show`
- `/setup set`
- `/setup disable`

### OpenAI
- `/norm`
- `/sora` when `ENABLE_SORA=true`

OpenAI behavior:
- `/norm` uses a stored conversation per guild
- `/norm` supports optional image attachments
- `/norm` and `/sora` only work in the configured `chat_channel`
- `/sora` uses the OpenAI Videos API through the current SDK
- generated images and videos are written under `data/generated-media`

## Operational Notes

- Norm does not use `!norm` message triggers anymore. OpenAI interactions are slash-command-only.
- Per-guild configuration is saved in `.guild-instance-config.json`.
- The bot does not write guild setup back into `.env`.
- If a guild was configured before `chat_channel` was required, rerun `/setup set` to enable `/norm` and `/sora` for that server.
- Old generated source assets should not be committed; runtime media lives under `data/generated-media`.
- The bot uses stale-interaction protection so outdated queued button/select interactions are ignored when the authoritative queue or match state has already changed.

## Development Commands

Lint:

```powershell
npm run lint
```

Build:

```powershell
npm run build
```

Build Windows portable EXE:

```powershell
npm run package:windows
```

Generate Prisma client:

```powershell
npm run generate
```

## Tests

Unit tests:

```powershell
npm run test
```

Integration tests:

```powershell
npm run integration
```

Integration tests require a reachable PostgreSQL server.

GitHub Actions runs lint, build, unit tests, and integration tests on branch pushes and pull requests. The Windows portable package can be produced from the build workflow through manual dispatch.

## Troubleshooting

If a guild fails to initialize:
- verify the `database_url` provided in `/setup set`
- verify that the Postgres endpoint is reachable from the machine running Norm
- verify the schema has been pushed to that database
- verify the configured Discord channels still exist
- verify `CONFIG_ENCRYPTION_KEY` has not changed since the guild config was saved

If `/norm` or `/sora` refuse to run:
- make sure you are in the configured `chat_channel`
- rerun `/setup set` if this guild was configured before `chat_channel` was added

If Sora fails at startup:
- set `ENABLE_SORA=false`, or
- provide a valid `SORA_MODEL` and ensure your OpenAI project has access to the Videos API
