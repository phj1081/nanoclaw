<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  Dual-agent AI assistant running Claude Code + Codex as parallel services over Discord.
</p>

<p align="center">
  Based on <a href="https://github.com/qwibitai/nanoclaw">qwibitai/nanoclaw</a>
</p>

## Overview

Two AI agents running as parallel systemd services, communicating over Discord:

- **Claude Code** — powered by Claude Agent SDK, trigger `@claude`
- **Codex** — powered by Codex app-server (JSON-RPC), trigger `@codex`

Each agent has its own store, data, and groups directories. Discord channels can be registered with either agent, or both (`both` agent type for shared channels).

### Key Features

- **Direct host processes** — no container overhead, agents run natively
- **Bidirectional image support** — receive images as multimodal input, send as Discord attachments
- **Skill sync** — single source of truth (`~/.claude/skills/`), auto-synced to all sessions
- **OAuth auto-refresh** — token lifecycle managed automatically for headless environments
- **Priority queue** — per-group serialization, global concurrency limit, idle preemption
- **Auto-continue** — Codex text-only turns automatically retried to enforce task execution

## Architecture

```
Discord ──► SQLite ──► GroupQueue ──┬──► Claude Agent SDK (host process)
                                    └──► Codex App-Server (JSON-RPC stdio)
                                              ├── thread/start, thread/resume
                                              ├── turn/start (streaming, multimodal)
                                              ├── turn/steer (mid-turn injection)
                                              ├── Auto-approval (bypass sandbox)
                                              └── Auto-continue (text-only turn retry)
```

### Directory Layout

```
nanoclaw/
├── src/
│   ├── index.ts                # Orchestrator: state, message loop, agent invocation
│   ├── agent-runner.ts         # Spawns agent processes, manages env/sessions/skills
│   ├── group-queue.ts          # Per-group concurrency, priority queue, idle preemption
│   ├── group-folder.ts         # Group directory resolution and management
│   ├── router.ts               # Outbound message formatting and routing
│   ├── sender-allowlist.ts     # Security: sender-based access control
│   ├── session-commands.ts     # Session commands (/compact)
│   ├── token-refresh.ts        # OAuth auto-refresh + session directory sync
│   ├── task-scheduler.ts       # Scheduled tasks (cron/interval/once)
│   ├── ipc.ts                  # IPC watcher and task processing
│   ├── db.ts                   # SQLite operations
│   ├── config.ts               # Paths, intervals, trigger patterns
│   └── channels/
│       ├── registry.ts         # Channel self-registration system
│       └── discord.ts          # Discord: mentions, images, typing, file attachments
├── container/
│   ├── agent-runner/           # Claude Code runner (Agent SDK, multimodal input)
│   ├── codex-runner/           # Codex runner (app-server JSON-RPC, auto-continue)
│   └── skills/                 # Shared agent skills (browser, etc.)
├── store/                      # Claude Code service DB
├── store-codex/                # Codex service DB
├── data/
│   ├── sessions/               # Per-group Claude sessions (.claude/)
│   └── attachments/            # Downloaded Discord image attachments
├── data-codex/sessions/        # Per-group Codex sessions (.codex/)
├── groups/                     # Per-group memory and workspace (Claude Code)
├── groups-codex/               # Per-group memory and workspace (Codex)
└── logs/                       # Service logs
```

### Codex App-Server Integration

The Codex runner (`container/codex-runner/`) communicates with `codex app-server` via JSON-RPC over stdio:

- **Session persistence**: Thread IDs stored in DB, sessions saved as JSONL on disk
- **Streaming**: `item/agentMessage/delta` notifications for real-time text
- **Mid-turn steering**: IPC messages injected via `turn/steer` during execution
- **Auto-approval**: `approvalPolicy: "never"` + `sandbox: "danger-full-access"`
- **Auto-continue**: Detects text-only turns (no tool execution) and automatically retries up to 5 times to nudge the agent into actually executing tasks
- **Multimodal input**: Image attachments converted to `localImage` input blocks in `turn/start`
- **Per-group config**: Model, effort, MCP servers configured per channel

### Image Handling

Bidirectional image support through Discord:

- **Receiving** (user → agent): Discord image attachments are downloaded to `data/attachments/`, then passed as base64 `ImageBlockParam` content blocks (Claude Code) or `localImage` input blocks (Codex)
- **Sending** (agent → user): Markdown image links `[name.png](/path)` in agent responses are automatically parsed and sent as Discord file attachments. Non-image file links are converted to readable filenames (`BuildPanel.tsx:320`)

### Skill Sync

Skills are managed from a single source of truth (`~/.claude/skills/` on the server) and automatically synced to all agent session directories at process start:

- Claude Code sessions: `~/.claude/skills/` + project `container/skills/`
- Codex sessions: Same sources, synced to per-group `.codex/` directories
- Skills auto-register as slash commands (`/name`) in Claude Code and `$name` in Codex

### OAuth Token Auto-Refresh

`src/token-refresh.ts` handles Claude Code OAuth token lifecycle:

- Checks every 5 minutes, refreshes 30 minutes before expiry
- Tries `platform.claude.com` then falls back to `api.anthropic.com`
- Syncs refreshed credentials to all per-group session directories
- Solves the known headless environment token expiry issue

### GroupQueue

`src/group-queue.ts` manages agent execution with:

- **Per-group serialization**: Only one agent process per group at a time
- **Global concurrency limit**: Configurable max concurrent agents across all groups
- **Task priority**: Scheduled tasks drain before message processing
- **Idle preemption**: Idle agents are terminated when higher-priority tasks arrive
- **Exponential backoff**: Retries with backoff on processing failure

## Setup

### Prerequisites

- Linux (Ubuntu 22.04+) or macOS
- Node.js 20+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- [Codex CLI](https://github.com/openai/codex) (`npm install -g @openai/codex`)
- Two Discord bot tokens (one per agent) — create at [Discord Developer Portal](https://discord.com/developers/applications)

### 1. Clone and Install

```bash
git clone https://github.com/phj1081/nanoclaw.git
cd nanoclaw
npm install
npm run build:runners   # installs + builds both agent-runner and codex-runner
npm run build           # builds main project
```

### 2. Authenticate CLIs

```bash
# Claude Code — opens browser for OAuth login
claude login

# Codex — set API key
export OPENAI_API_KEY=sk-...

# Groq — for fast voice transcription (free at console.groq.com)
export GROQ_API_KEY=gsk_...
```

### 3. Environment Variables

Create `.env` in the project root:

```bash
# .env — shared config (read by both services)
DISCORD_BOT_TOKEN=           # Claude Code Discord bot token
ASSISTANT_NAME=claude        # Bot trigger name (@claude)
ANTHROPIC_API_KEY=           # Or use OAuth (claude login)
OPENAI_API_KEY=              # For Codex
GROQ_API_KEY=                # For voice transcription (Groq Whisper, fast + free)
```

For dual-service setup, create `.env.codex` for Codex-specific overrides:

```bash
# .env.codex — Codex service secrets (loaded via systemd EnvironmentFile)
DISCORD_BOT_TOKEN=           # Codex Discord bot token (different from above)
```

> **Security**: Never put tokens in systemd service files or commit them to git. Use `.env` files with restricted permissions (`chmod 600`).

### 4. Systemd Services (Linux)

Create `~/.config/systemd/user/nanoclaw.service`:

```ini
[Unit]
Description=NanoClaw Claude Code
After=network.target

[Service]
Type=simple
ExecStart=/path/to/node /path/to/nanoclaw/dist/index.js
WorkingDirectory=/path/to/nanoclaw
Restart=always
RestartSec=5
Environment=HOME=/home/youruser
Environment=PATH=/path/to/node/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
```

Create `~/.config/systemd/user/nanoclaw-codex.service`:

```ini
[Unit]
Description=NanoClaw Codex
After=network.target

[Service]
EnvironmentFile=/path/to/nanoclaw/.env.codex
Type=simple
ExecStart=/path/to/node /path/to/nanoclaw/dist/index.js
WorkingDirectory=/path/to/nanoclaw
Restart=always
RestartSec=5
Environment=HOME=/home/youruser
Environment=PATH=/path/to/node/bin:/usr/local/bin:/usr/bin:/bin
Environment=ASSISTANT_NAME=codex
Environment=NANOCLAW_STORE_DIR=/path/to/nanoclaw/store-codex
Environment=NANOCLAW_DATA_DIR=/path/to/nanoclaw/data-codex
Environment=NANOCLAW_GROUPS_DIR=/path/to/nanoclaw/groups-codex

[Install]
WantedBy=default.target
```

Then enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable nanoclaw nanoclaw-codex
systemctl --user start nanoclaw nanoclaw-codex

# Logs
journalctl --user -u nanoclaw -f
journalctl --user -u nanoclaw-codex -f
```

### 5. Register Discord Channels

Channels are stored in each service's SQLite database (`registered_groups` table). Use the IPC auth endpoint or insert directly:

```bash
# Example: register a channel for Claude Code
sqlite3 store/nanoclaw.db "INSERT INTO registered_groups (jid, name, folder, agent_type, trigger_pattern) VALUES ('dc:CHANNEL_ID', 'my-channel', 'my-channel', 'claude-code', '@claude');"

# Example: register a channel for Codex
sqlite3 store-codex/nanoclaw.db "INSERT INTO registered_groups (jid, name, folder, agent_type, trigger_pattern) VALUES ('dc:CHANNEL_ID', 'my-channel', 'my-channel', 'codex', '@codex');"
```

Fields:

| Field | Description |
|-------|-------------|
| `jid` | `dc:<discord_channel_id>` |
| `name` | Display name |
| `folder` | Group folder name (workspace directory) |
| `agent_type` | `claude-code`, `codex`, or `both` |
| `trigger_pattern` | Regex for activation (e.g., `@claude`) |
| `work_dir` | Optional working directory override |
| `container_config` | Optional JSON (e.g., `{"codexEffort":"high"}`) |

### macOS (launchd)

```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw-codex.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Development

```bash
npm install                   # Install dependencies
npm run build                 # Build main project
npm run build:runners         # Install + build both runners
npm run dev                   # Dev mode with hot reload
npm test                      # Run tests
```

## License

MIT — Based on [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw)
