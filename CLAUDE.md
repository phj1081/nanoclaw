# NanoClaw

Dual-agent AI assistant (Claude Code + Codex) over Discord. Based on [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw).

## Quick Context

Two systemd services (`nanoclaw`, `nanoclaw-codex`) share the same codebase but run with separate stores, data, and groups. Agents run as direct host processes (no containers). Claude Code uses the Agent SDK; Codex uses `codex app-server` via JSON-RPC. OAuth tokens auto-refresh and sync to per-group session dirs.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/agent-runner.ts` | Spawns agent processes, manages env/sessions/skills |
| `src/token-refresh.ts` | OAuth auto-refresh + session directory sync |
| `src/channels/discord.ts` | Discord channel (8s typing refresh, Groq/OpenAI Whisper transcription) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `container/agent-runner/` | Claude Code runner (Agent SDK) |
| `container/codex-runner/` | Codex runner (app-server JSON-RPC, streaming, turn/steer) |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Agent issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run build                              # Build main project
npm run build:runners                      # Install + build both runners
npm run dev                                # Dev mode with hot reload
```

Service management (Linux):
```bash
systemctl --user restart nanoclaw nanoclaw-codex  # Restart both
systemctl --user status nanoclaw                  # Check status
journalctl --user -u nanoclaw -f                  # Follow logs
```

Deploy to server: `scp dist/*.js clone-ej@100.64.185.108:~/nanoclaw/dist/`

## Dual-Service Architecture

- `nanoclaw.service` — Claude Code bot (`@claude`), uses `store/`, `data/`, `groups/`
- `nanoclaw-codex.service` — Codex bot (`@codex`), uses `store-codex/`, `data-codex/`, `groups-codex/`
- Both share the same codebase (`dist/index.js`), differentiated by env vars (`NANOCLAW_STORE_DIR`, etc.)
- Channel registration is per-service DB (`registered_groups` table)

## Codex App-Server

Codex runner uses `codex app-server` JSON-RPC (not `codex exec`):
- `thread/start` / `thread/resume` for session persistence (threadId-based)
- `turn/start` for streaming responses (`item/agentMessage/delta`)
- `turn/steer` for mid-execution message injection (IPC polling during turn)
- `approvalPolicy: "never"` + `sandbox: "danger-full-access"` for bypass
- Per-group: model (`CODEX_MODEL`), effort (`CODEX_EFFORT`), MCP servers via `config.toml`

## Voice Transcription

Audio attachments in Discord are transcribed via Groq Whisper (primary) or OpenAI Whisper (fallback):
- `GROQ_API_KEY` — Groq `whisper-large-v3-turbo`, ~200x real-time, free tier (console.groq.com)
- `OPENAI_API_KEY` — OpenAI `whisper-1`, fallback if Groq key not set
- Shared file cache (`cache/transcriptions/`) deduplicates across both services
- `.pending` file coordination prevents duplicate API calls
