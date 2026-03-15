/**
 * NanoClaw Codex Runner (SDK mode)
 *
 * Uses @openai/codex-sdk which wraps `codex exec`. This ensures complete
 * task execution per turn — the agent finishes all work before responding,
 * unlike app-server mode which can end turns prematurely.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages as JSON files in $NANOCLAW_IPC_DIR/input/
 *          Sentinel: _close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 */

import { Codex, type Thread, type UserInput, type ThreadOptions } from '@openai/codex-sdk';
import fs from 'fs';
import path from 'path';

// ── Types ──────────────────────────────────────────────────────────

interface ContainerInput {
  prompt: string;
  sessionId?: string;   // threadId from previous session
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  agentType?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

// ── Constants ──────────────────────────────────────────────────────

const GROUP_DIR = process.env.NANOCLAW_GROUP_DIR || '/workspace/group';
const IPC_DIR = process.env.NANOCLAW_IPC_DIR || '/workspace/ipc';
const WORK_DIR = process.env.NANOCLAW_WORK_DIR || '';
const IPC_INPUT_DIR = path.join(IPC_DIR, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const MAX_TURNS = 100;

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

const EFFECTIVE_CWD = WORK_DIR || GROUP_DIR;
const CODEX_MODEL = process.env.CODEX_MODEL || '';
const CODEX_EFFORT = process.env.CODEX_EFFORT || '';

// ── Helpers ────────────────────────────────────────────────────────

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[codex-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

// ── Input Parsing ─────────────────────────────────────────────────

/**
 * Parse [Image: /path] patterns from text and build SDK input.
 */
function parseInput(text: string): string | UserInput[] {
  const imagePattern = /\[Image:\s*(\/[^\]]+)\]/g;
  const imagePaths: string[] = [];
  let match;
  while ((match = imagePattern.exec(text)) !== null) {
    imagePaths.push(match[1].trim());
  }

  if (imagePaths.length === 0) return text;

  const input: UserInput[] = [];
  const cleanText = text.replace(imagePattern, '').trim();
  if (cleanText) {
    input.push({ type: 'text', text: cleanText });
  }
  for (const imgPath of imagePaths) {
    if (fs.existsSync(imgPath)) {
      input.push({ type: 'local_image', path: imgPath });
      log(`Adding image input: ${imgPath}`);
    } else {
      log(`Image not found, skipping: ${imgPath}`);
    }
  }
  return input.length > 0 ? input : text;
}

// ── Turn Execution ────────────────────────────────────────────────

/**
 * Execute a single turn using the SDK. The SDK wraps `codex exec`,
 * ensuring the agent completes all work before returning.
 */
async function executeTurn(
  thread: Thread,
  input: string | UserInput[],
): Promise<{ result: string; error?: string }> {
  const ac = new AbortController();

  // Poll close sentinel + heartbeat during turn
  let turnSeconds = 0;
  const sentinel = setInterval(() => {
    if (shouldClose()) {
      log('Close sentinel detected during turn, aborting');
      ac.abort();
      return;
    }
    turnSeconds += 5;
    if (turnSeconds % 60 === 0) {
      log(`Turn in progress... (${Math.round(turnSeconds / 60)}min)`);
    }
  }, 5000);

  try {
    const turn = await thread.run(input, { signal: ac.signal });
    return { result: turn.finalResponse };
  } catch (err) {
    if (ac.signal.aborted) {
      return { result: '' };
    }
    return {
      result: '',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearInterval(sentinel);
  }
}

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    prompt += '\n' + pending.join('\n');
  }

  // Build thread options
  const threadOptions: ThreadOptions = {
    workingDirectory: EFFECTIVE_CWD,
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
    networkAccessEnabled: true,
    webSearchMode: 'live',
  };
  if (CODEX_MODEL) threadOptions.model = CODEX_MODEL;
  if (CODEX_EFFORT) {
    threadOptions.modelReasoningEffort = CODEX_EFFORT as ThreadOptions['modelReasoningEffort'];
  }

  // Create SDK instance (inherits env from parent — CODEX_HOME, OPENAI_API_KEY, etc.)
  const codex = new Codex();

  // Start or resume thread (resume may fail on first run, fallback to new thread)
  let thread: Thread;
  if (containerInput.sessionId) {
    thread = codex.resumeThread(containerInput.sessionId, threadOptions);
    log(`Thread resuming (session: ${containerInput.sessionId})`);
  } else {
    thread = codex.startThread(threadOptions);
    log('Thread started (new session)');
  }

  let turnCount = 0;

  try {
    // Main turn loop
    while (true) {
      turnCount++;
      if (turnCount > MAX_TURNS) {
        log(`Turn limit reached (${MAX_TURNS}), exiting`);
        writeOutput({
          status: 'success',
          result: '[세션 턴 제한 도달. 새 메시지로 다시 시작됩니다.]',
          newSessionId: thread.id || undefined,
        });
        break;
      }

      const input = parseInput(prompt);
      log(`Starting turn ${turnCount}/${MAX_TURNS}...`);

      let { result, error } = await executeTurn(thread, input);

      // Fallback: if resume failed on first turn, retry with a new thread
      if (error && turnCount === 1 && containerInput.sessionId) {
        log(`Resume may have failed, retrying with new thread: ${error}`);
        thread = codex.startThread(threadOptions);
        ({ result, error } = await executeTurn(thread, input));
      }

      // Check close sentinel
      if (shouldClose()) {
        if (result) {
          writeOutput({ status: 'success', result, newSessionId: thread.id || undefined });
        }
        log('Close sentinel detected, exiting');
        break;
      }

      if (error) {
        log(`Turn error: ${error}`);
        writeOutput({
          status: 'error',
          result: result || null,
          newSessionId: thread.id || undefined,
          error,
        });
      } else {
        writeOutput({
          status: 'success',
          result: result || null,
          newSessionId: thread.id || undefined,
        });
      }

      log('Turn done, waiting for next IPC message...');

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars)`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Runner error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage,
    });
  }
}

main();
