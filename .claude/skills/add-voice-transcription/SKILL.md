---
name: add-voice-transcription
description: Add voice message transcription to NanoClaw using Groq Whisper (fast, free) with OpenAI fallback. Works on Discord and WhatsApp.
---

# Add Voice Transcription

This skill adds automatic voice message transcription to NanoClaw. When a voice note arrives, it is downloaded, transcribed, and delivered to the agent as `[Voice message transcription]: <text>`.

**Provider priority:** Groq Whisper (fast, free) > OpenAI Whisper (fallback).

## Phase 1: Pre-flight

### Discord

Voice transcription is built into `src/channels/discord.ts`. No code changes needed — just configure API keys (Phase 3).

### WhatsApp

Check if `src/transcription.ts` exists. If it does, skip to Phase 3 (Configure). The code changes are already in place.

If not, merge the skill branch:

```bash
git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git 2>/dev/null
git fetch whatsapp skill/voice-transcription
git merge whatsapp/skill/voice-transcription
npm install --legacy-peer-deps
npm run build
```

## Phase 2: Configure

### Get API key

**Groq (recommended — fast + free):**

> 1. Go to https://console.groq.com
> 2. Sign up (no credit card needed)
> 3. Create an API key (starts with `gsk_`)
>
> Free tier: 2,000 requests/day, 8 hours of audio/day. Uses `whisper-large-v3-turbo` at ~200x real-time speed.

**OpenAI (fallback):**

> 1. Go to https://platform.openai.com/api-keys
> 2. Create a key (starts with `sk-`)
>
> Cost: ~$0.006 per minute of audio. Requires funded account.

### Add to environment

Add to `.env`:

```bash
GROQ_API_KEY=gsk_...          # Primary (fast, free)
OPENAI_API_KEY=sk-...          # Fallback (optional if Groq is set)
```

### Build and restart

```bash
npm run build
systemctl --user restart nanoclaw nanoclaw-codex  # Linux
# macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 3: Verify

Send a voice note in any registered chat. The agent should receive it as `[Voice message transcription]: <text>`.

### Check logs

```bash
tail -f logs/nanoclaw.log | grep -iE "transcri|audio"
```

Look for:
- `Audio transcribed + cached` with `provider: "groq"` and `elapsed` — success
- `Transcription cache hit` — second service read from cache (no duplicate API call)
- `no transcription API key` — neither `GROQ_API_KEY` nor `OPENAI_API_KEY` set
- `groq Whisper 4xx` — check key validity

## Troubleshooting

**No transcription:** Check `GROQ_API_KEY` (or `OPENAI_API_KEY`) is set in `.env`. Restart service after changes.

**Slow transcription:** Verify `provider: "groq"` in logs. If it shows `openai`, the Groq key may be missing or invalid.

**Agent doesn't respond to voice notes:** Verify the chat is registered and the agent is running. Voice transcription only runs for registered groups.
