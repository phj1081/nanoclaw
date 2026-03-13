# NanoClaw

Dual-agent AI assistant (Claude Code + Codex) over Discord. Fork of [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw).

## Quick Context

Two systemd services (`nanoclaw`, `nanoclaw-codex`) share the same codebase but run with separate stores, data, and groups. Agents run as direct host processes (no containers). Claude Code uses the Agent SDK; Codex uses `codex app-server` via JSON-RPC. OAuth tokens auto-refresh and sync to per-group session dirs.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/container-runner.ts` | Spawns agent processes, manages env/sessions/MCP |
| `src/token-refresh.ts` | OAuth auto-refresh + session directory sync |
| `src/channels/discord.ts` | Discord channel (8s typing refresh) |
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
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run build                              # Build main project
cd container/agent-runner && npm run build # Build Claude runner
cd container/codex-runner && npm run build # Build Codex runner
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
