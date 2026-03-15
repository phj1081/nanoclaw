# NanoClaw

Dual-agent AI assistant (Claude Code + Codex) over Discord. Based on [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw).

## Quick Context

Two systemd services (`nanoclaw`, `nanoclaw-codex`) share the same codebase but run with separate stores, data, and groups (will be unified — DB supports shared access via WAL mode + service partitioning). Agents run as direct host processes (no containers). Claude Code uses the Agent SDK; Codex uses the Codex SDK (`codex exec`). Auth via `CLAUDE_CODE_OAUTH_TOKEN` in `.env` (1-year token from `claude setup-token`).

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/agent-runner.ts` | Spawns agent processes, manages env/sessions/skills |
| `src/channels/discord.ts` | Discord channel (8s typing refresh, Groq/OpenAI Whisper transcription) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `runners/agent-runner/` | Claude Code runner (Agent SDK) |
| `runners/codex-runner/` | Codex runner (SDK, `codex exec` wrapper) |
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

- `nanoclaw.service` — Claude Code bot (`@claude`), `SERVICE_ID=claude`, `SERVICE_AGENT_TYPE=claude-code`
- `nanoclaw-codex.service` — Codex bot (`@codex`), `SERVICE_ID=codex`, `SERVICE_AGENT_TYPE=codex`
- Both share the same codebase (`dist/index.js`), differentiated by env vars
- Unified dirs (`store/`, `groups/`, `data/` shared by both services):
  - `router_state`: keys prefixed with `{SERVICE_ID}:` (e.g., `claude:last_timestamp`)
  - `sessions`: composite PK `(group_folder, agent_type)`
  - `registered_groups`: filtered by `agent_type` on load
  - SQLite WAL mode + `busy_timeout=5000` for concurrent access

## Debugging Paths (Server: clone-ej@100.64.185.108)

Unified DB + directories (both services share `store/`, `groups/`, `data/`):

| 항목 | 경로 |
|------|------|
| **DB** | `store/messages.db` (공유, WAL 모드) |
| 서비스 로그 (Claude) | `journalctl --user -u nanoclaw -f` 또는 `logs/nanoclaw.log` |
| 서비스 로그 (Codex) | `journalctl --user -u nanoclaw-codex -f` 또는 `logs/nanoclaw-codex.log` |
| 그룹별 로그 | `groups/{name}/logs/` (공유 채널은 양쪽 봇 로그가 같은 폴더) |
| Claude 세션 | `data/sessions/{name}/.claude/` |
| Codex 세션 | `data/sessions/{name}/.codex/` |
| Claude 글로벌 설정 | `groups/global/CLAUDE.md` |
| Codex 글로벌 설정 | `~/.codex/AGENTS.md` |

## Codex SDK

Codex runner uses `@openai/codex-sdk` (wraps `codex exec`):
- `codex.startThread()` / `codex.resumeThread()` for session persistence
- `thread.run(input)` for single-shot turn execution (completes all work before returning)
- `approvalPolicy: "never"` + `sandboxMode: "danger-full-access"` for bypass
- Per-group: model (`CODEX_MODEL`), effort (`CODEX_EFFORT`), MCP servers via `config.toml`
- `CODEX_HOME` set to per-group session dir, reads `AGENTS.md` from there + CWD

## Voice Transcription

Audio attachments in Discord are transcribed via Groq Whisper (primary) or OpenAI Whisper (fallback):
- `GROQ_API_KEY` — Groq `whisper-large-v3-turbo`, ~200x real-time, free tier (console.groq.com)
- `OPENAI_API_KEY` — OpenAI `whisper-1`, fallback if Groq key not set
- Shared file cache (`cache/transcriptions/`) deduplicates across both services
- `.pending` file coordination prevents duplicate API calls
