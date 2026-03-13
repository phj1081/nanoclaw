<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  Dual-agent AI assistant running Claude Code + Codex as parallel services over Discord.
</p>

<p align="center">
  Fork of <a href="https://github.com/qwibitai/nanoclaw">qwibitai/nanoclaw</a>
</p>

## Overview

This fork runs two independent NanoClaw instances as systemd services:

- **nanoclaw** (Claude Code) — powered by Claude Agent SDK, trigger `@claude`
- **nanoclaw-codex** (Codex) — powered by Codex app-server JSON-RPC, trigger `@codex`

Each service has its own store, data, and groups directories. Discord channels can be registered with either or both bots.

## Key Differences from Upstream

| Area | Upstream NanoClaw | This Fork |
|------|-------------------|-----------|
| Agent runtime | Container-isolated (Docker/Apple Container) | Direct host processes (no containers) |
| Agent backends | Claude Code only | Claude Code + OpenAI Codex |
| Codex integration | N/A | `codex app-server` (JSON-RPC, streaming, `turn/steer`) |
| Session management | Container-based | Per-group `CLAUDE_CONFIG_DIR` / `CODEX_HOME` |
| Token management | Manual | Auto-refresh with session sync |
| Channel | Multi-channel (WhatsApp, Telegram, etc.) | Discord-focused |
| Deployment | Single service | Dual systemd services |

## Architecture

```
Discord ──► SQLite ──► Polling Loop ──┬──► Claude Agent SDK (host process)
                                      └──► Codex App-Server (JSON-RPC stdio)
                                                ├── thread/start, thread/resume
                                                ├── turn/start (streaming)
                                                ├── turn/steer (mid-turn injection)
                                                └── Auto-approval (bypass sandbox)
```

### Directory Layout

```
nanoclaw/
├── src/                        # Core source
│   ├── index.ts                # Orchestrator: state, message loop, agent invocation
│   ├── container-runner.ts     # Spawns agent processes, manages env/sessions
│   ├── token-refresh.ts        # OAuth auto-refresh + session directory sync
│   ├── channels/discord.ts     # Discord channel implementation
│   ├── db.ts                   # SQLite operations
│   ├── ipc.ts                  # IPC watcher and task processing
│   ├── task-scheduler.ts       # Scheduled tasks (cron/interval/once)
│   └── config.ts               # Paths, intervals, trigger patterns
├── container/
│   ├── agent-runner/           # Claude Code runner (Agent SDK)
│   ├── codex-runner/           # Codex runner (app-server JSON-RPC)
│   └── skills/                 # Shared agent skills (browser, etc.)
├── store/                      # Claude Code service DB
├── store-codex/                # Codex service DB
├── data/sessions/              # Per-group Claude sessions (.claude/)
├── data-codex/sessions/        # Per-group Codex sessions (.codex/)
├── groups/                     # Per-group memory (Claude Code)
├── groups-codex/               # Per-group memory (Codex)
└── logs/                       # Service logs
```

### Codex App-Server Integration

The Codex runner (`container/codex-runner/`) communicates with `codex app-server` via JSON-RPC over stdio:

- **Session persistence**: Thread IDs stored in DB, sessions saved as JSONL on disk
- **Streaming**: `item/agentMessage/delta` notifications for real-time text
- **Mid-turn steering**: IPC messages injected via `turn/steer` during execution
- **Auto-approval**: `approvalPolicy: "never"` + `sandbox: "danger-full-access"`
- **Per-group config**: Model, effort, MCP servers configured per channel

### OAuth Token Auto-Refresh

`src/token-refresh.ts` handles Claude Code OAuth token lifecycle:

- Checks every 5 minutes, refreshes 30 minutes before expiry
- Tries `platform.claude.com` then falls back to `api.anthropic.com`
- Syncs refreshed credentials to all per-group session directories
- Solves the known headless environment token expiry issue

## Setup

### Prerequisites

- Linux (Ubuntu 22.04+) or macOS
- Node.js 20+
- [Claude Code CLI](https://claude.ai/download)
- [Codex CLI](https://github.com/openai/codex) (`npm install -g @openai/codex`)

### Environment Variables

```bash
# .env
DISCORD_BOT_TOKEN=           # Claude Code bot token
DISCORD_CODEX_BOT_TOKEN=     # Codex bot token (optional, for dual-bot)
ANTHROPIC_API_KEY=            # Or use OAuth (CLAUDE_CODE_OAUTH_TOKEN)
OPENAI_API_KEY=               # For Codex
CODEX_MODEL=                  # Default codex model
CODEX_EFFORT=                 # Default reasoning effort (low/medium/high)
```

### Service Management (Linux)

```bash
systemctl --user start nanoclaw           # Claude Code service
systemctl --user start nanoclaw-codex     # Codex service
systemctl --user restart nanoclaw nanoclaw-codex  # Restart both
journalctl --user -u nanoclaw -f          # Follow logs
```

### Service Management (macOS)

```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw-codex.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Channel Registration

Channels are registered in each service's SQLite database (`registered_groups` table). Each entry specifies:

- **jid**: Discord channel ID (`dc:<channel_id>`)
- **folder**: Group folder name (matches Discord channel name)
- **trigger_pattern**: Regex for bot activation (`@claude` or `@codex`)
- **agent_type**: `claude-code` or `codex`
- **work_dir**: Working directory for the agent
- **container_config**: JSON config (e.g., `{"codexEffort":"high"}`)

## Development

```bash
npm run build                              # Build main project
cd container/agent-runner && npm run build # Build Claude runner
cd container/codex-runner && npm run build # Build Codex runner
npm run dev                                # Dev mode with hot reload
```

## License

MIT — Fork of [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw)
