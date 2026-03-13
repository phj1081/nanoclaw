/**
 * NanoClaw Codex Runner (app-server mode)
 *
 * Spawns a single `codex app-server` process and communicates via JSON-RPC
 * over stdio. Supports streaming responses, session persistence (threadId),
 * and mid-turn message injection via turn/steer.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages as JSON files in $NANOCLAW_IPC_DIR/input/
 *          Sentinel: _close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 */

import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

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

interface JsonRpcRequest {
  method: string;
  id?: number;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  id?: number;
  method?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  params?: Record<string, unknown>;
}

// ── Constants ──────────────────────────────────────────────────────

const GROUP_DIR = process.env.NANOCLAW_GROUP_DIR || '/workspace/group';
const IPC_DIR = process.env.NANOCLAW_IPC_DIR || '/workspace/ipc';
const WORK_DIR = process.env.NANOCLAW_WORK_DIR || '';
const IPC_INPUT_DIR = path.join(IPC_DIR, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const MAX_TURNS = 100;
const MAX_AUTO_CONTINUES = 5;
const AUTO_CONTINUE_PROMPT = 'Continue. Execute the task — don\'t just describe what you\'ll do.';

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

// ── App-Server Client ──────────────────────────────────────────────

class CodexAppServer {
  private proc: ChildProcess;
  private rl: readline.Interface;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: JsonRpcResponse) => void;
    reject: (err: Error) => void;
  }>();
  private notificationHandler: ((msg: JsonRpcResponse) => void) | null = null;
  private serverRequestHandler: ((msg: JsonRpcResponse) => void) | null = null;

  constructor() {
    this.proc = spawn('codex', ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: EFFECTIVE_CWD,
      env: { ...process.env },
    });

    this.rl = readline.createInterface({ input: this.proc.stdout! });

    this.rl.on('line', (line: string) => {
      if (!line.trim()) return;
      try {
        const msg: JsonRpcResponse = JSON.parse(line);
        this.handleMessage(msg);
      } catch {
        // Non-JSON output, ignore
      }
    });

    this.proc.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().trim().split('\n')) {
        if (line) log(line);
      }
    });

    this.proc.on('error', (err: Error) => {
      log(`App-server spawn error: ${err.message}`);
      // Reject all pending requests
      for (const [, { reject }] of this.pending) {
        reject(err);
      }
      this.pending.clear();
    });

    this.proc.on('close', (code: number | null) => {
      log(`App-server exited with code ${code}`);
      const err = new Error(`App-server exited with code ${code}`);
      for (const [, { reject }] of this.pending) {
        reject(err);
      }
      this.pending.clear();
    });
  }

  private handleMessage(msg: JsonRpcResponse): void {
    // Response to a request we made
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const handler = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      handler.resolve(msg);
      return;
    }

    // Server-initiated request (has id + method) — needs a response
    if (msg.id !== undefined && msg.method) {
      this.serverRequestHandler?.(msg);
      return;
    }

    // Notification (has method, no id)
    if (msg.method) {
      this.notificationHandler?.(msg);
    }
  }

  setNotificationHandler(handler: ((msg: JsonRpcResponse) => void) | null): void {
    this.notificationHandler = handler;
  }

  setServerRequestHandler(handler: ((msg: JsonRpcResponse) => void) | null): void {
    this.serverRequestHandler = handler;
  }

  send(msg: JsonRpcRequest): void {
    this.proc.stdin!.write(JSON.stringify(msg) + '\n');
  }

  async request(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (resp) => {
          clearTimeout(timer);
          resolve(resp);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.send({ method, id, params });
    });
  }

  respond(id: number, result: Record<string, unknown>): void {
    this.proc.stdin!.write(JSON.stringify({ id, result }) + '\n');
  }

  async initialize(): Promise<void> {
    const resp = await this.request('initialize', {
      clientInfo: { name: 'nanoclaw', title: 'NanoClaw Codex', version: '1.0' },
      capabilities: { experimentalApi: false },
    }, 15_000);

    if (resp.error) {
      throw new Error(`Initialize failed: ${resp.error.message}`);
    }

    // Send initialized notification
    this.send({ method: 'initialized' });
    log('App-server initialized');
  }

  async startThread(): Promise<string> {
    const params: Record<string, unknown> = {
      cwd: EFFECTIVE_CWD,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    };
    if (CODEX_MODEL) params.model = CODEX_MODEL;

    const resp = await this.request('thread/start', params, 30_000);
    if (resp.error) {
      throw new Error(`thread/start failed: ${resp.error.message}`);
    }

    const thread = resp.result?.thread as Record<string, unknown> | undefined;
    const threadId = thread?.id as string;
    log(`Thread started: ${threadId}`);
    return threadId;
  }

  async resumeThread(threadId: string): Promise<string> {
    const params: Record<string, unknown> = {
      threadId,
      cwd: EFFECTIVE_CWD,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      persistExtendedHistory: false,
    };
    if (CODEX_MODEL) params.model = CODEX_MODEL;

    const resp = await this.request('thread/resume', params, 30_000);
    if (resp.error) {
      // If resume fails (e.g., thread not found), start a new one
      log(`thread/resume failed: ${resp.error.message}, starting new thread`);
      return this.startThread();
    }

    const thread = resp.result?.thread as Record<string, unknown> | undefined;
    const actualId = (thread?.id as string) || threadId;
    log(`Thread resumed: ${actualId}`);
    return actualId;
  }

  async startTurn(threadId: string, text: string): Promise<string> {
    // Parse [Image: /absolute/path] patterns and convert to multimodal input
    const imagePattern = /\[Image:\s*(\/[^\]]+)\]/g;
    const input: Array<Record<string, unknown>> = [];
    const imagePaths: string[] = [];
    let match;
    while ((match = imagePattern.exec(text)) !== null) {
      imagePaths.push(match[1].trim());
    }
    // Add text (with image tags stripped) as first input block
    const cleanText = text.replace(imagePattern, '').trim();
    if (cleanText) {
      input.push({ type: 'text', text: cleanText, text_elements: [] });
    }
    // Add image input blocks
    for (const imgPath of imagePaths) {
      if (fs.existsSync(imgPath)) {
        input.push({ type: 'localImage', path: imgPath });
        log(`Adding image input: ${imgPath}`);
      } else {
        log(`Image not found, skipping: ${imgPath}`);
      }
    }
    if (input.length === 0) {
      input.push({ type: 'text', text, text_elements: [] });
    }

    const params: Record<string, unknown> = {
      threadId,
      input,
    };
    if (CODEX_EFFORT) params.effort = CODEX_EFFORT;

    const resp = await this.request('turn/start', params, 30_000);
    if (resp.error) {
      throw new Error(`turn/start failed: ${resp.error.message}`);
    }

    const turn = resp.result?.turn as Record<string, unknown> | undefined;
    const turnId = turn?.id as string;
    log(`Turn started: ${turnId}`);
    return turnId;
  }

  async steerTurn(threadId: string, turnId: string, text: string): Promise<void> {
    const resp = await this.request('turn/steer', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      expectedTurnId: turnId,
    }, 10_000);

    if (resp.error) {
      log(`turn/steer failed: ${resp.error.message}`);
    }
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    try {
      await this.request('turn/interrupt', { threadId, turnId }, 10_000);
    } catch (err) {
      log(`turn/interrupt failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  kill(): void {
    try {
      this.proc.kill('SIGTERM');
      setTimeout(() => {
        if (!this.proc.killed) this.proc.kill('SIGKILL');
      }, 5000);
    } catch { /* ignore */ }
  }

  get alive(): boolean {
    return !this.proc.killed && this.proc.exitCode === null;
  }
}

// ── Turn Execution ─────────────────────────────────────────────────

/**
 * Execute a turn and collect the agent's text response.
 * While the turn is running, polls IPC for new messages and injects
 * them via turn/steer (mid-execution message injection).
 * Returns when turn/completed notification is received.
 */
async function executeTurn(
  server: CodexAppServer,
  threadId: string,
  prompt: string,
): Promise<{ result: string; error?: string; turnId: string; hadToolExecution: boolean }> {
  return new Promise((resolve) => {
    let agentText = '';
    let turnId = '';
    let resolved = false;
    let hadToolExecution = false;
    let ipcPollTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      server.setNotificationHandler(null);
      server.setServerRequestHandler(null);
      if (ipcPollTimer) {
        clearTimeout(ipcPollTimer);
        ipcPollTimer = null;
      }
    };

    // Timeout safety (5 minutes per turn)
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        log('Turn execution timed out (5min)');
        resolve({
          result: agentText || '',
          error: 'Turn timed out after 5 minutes',
          turnId,
          hadToolExecution,
        });
      }
    }, 5 * 60 * 1000);

    // IPC polling during turn — steer messages into the running turn
    const pollIpcDuringTurn = () => {
      if (resolved) return;

      // Check close sentinel
      if (shouldClose()) {
        log('Close sentinel during turn, interrupting');
        if (turnId) {
          server.interruptTurn(threadId, turnId).catch(() => {});
        }
        return;
      }

      // Check for new messages to steer
      const messages = drainIpcInput();
      if (messages.length > 0 && turnId) {
        const text = messages.join('\n');
        log(`Steering message into turn (${text.length} chars)`);
        server.steerTurn(threadId, turnId, text).catch((err) => {
          log(`Steer failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }

      ipcPollTimer = setTimeout(pollIpcDuringTurn, IPC_POLL_MS);
    };

    // Handle notifications (streaming events)
    server.setNotificationHandler((msg) => {
      if (resolved) return;

      switch (msg.method) {
        case 'item/agentMessage/delta': {
          const delta = (msg.params as Record<string, unknown>)?.delta as string;
          if (delta) agentText += delta;
          break;
        }

        case 'item/completed': {
          const item = (msg.params as Record<string, unknown>)?.item as Record<string, unknown>;
          if (item?.type === 'agentMessage') {
            // Use authoritative text from completed item
            const text = item.text as string;
            if (text) agentText = text;
          }
          break;
        }

        case 'turn/completed': {
          const turn = (msg.params as Record<string, unknown>)?.turn as Record<string, unknown>;
          const status = turn?.status as string;
          const error = turn?.error as Record<string, unknown> | null;

          clearTimeout(timer);
          resolved = true;
          cleanup();

          if (status === 'failed') {
            const errMsg = (error?.message as string) || 'Turn failed';
            resolve({ result: agentText || '', error: errMsg, turnId, hadToolExecution });
          } else {
            resolve({ result: agentText, turnId, hadToolExecution });
          }
          break;
        }

        case 'turn/started': {
          const turn = (msg.params as Record<string, unknown>)?.turn as Record<string, unknown>;
          if (turn?.id) turnId = turn.id as string;
          break;
        }
      }
    });

    // Handle server requests (approval auto-accept)
    server.setServerRequestHandler((msg) => {
      if (msg.id === undefined) return;

      if (msg.method === 'item/commandExecution/requestApproval' ||
          msg.method === 'item/fileChange/requestApproval' ||
          msg.method === 'item/permissions/requestApproval') {
        hadToolExecution = true;
        server.respond(msg.id, { decision: 'accept' });
        return;
      }

      // Unknown server request — accept generically
      server.respond(msg.id, {});
    });

    // Start IPC polling for mid-turn message injection
    ipcPollTimer = setTimeout(pollIpcDuringTurn, IPC_POLL_MS);

    // Start the turn
    server.startTurn(threadId, prompt)
      .then((id) => { turnId = id; })
      .catch((err) => {
        if (!resolved) {
          clearTimeout(timer);
          resolved = true;
          cleanup();
          resolve({
            result: '',
            error: `Failed to start turn: ${err.message}`,
            turnId: '',
            hadToolExecution: false,
          });
        }
      });
  });
}

// ── Main ───────────────────────────────────────────────────────────

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

  // Spawn app-server
  const server = new CodexAppServer();

  try {
    await server.initialize();

    // Start or resume thread
    const threadId = containerInput.sessionId
      ? await server.resumeThread(containerInput.sessionId)
      : await server.startThread();

    let turnCount = 0;
    let autoContinueCount = 0;

    // Main turn loop
    while (true) {
      turnCount++;
      if (turnCount > MAX_TURNS) {
        log(`Turn limit reached (${MAX_TURNS}), exiting`);
        writeOutput({
          status: 'success',
          result: '[세션 턴 제한 도달. 새 메시지로 다시 시작됩니다.]',
          newSessionId: threadId,
        });
        break;
      }

      log(`Starting turn ${turnCount}/${MAX_TURNS} (auto-continue: ${autoContinueCount}/${MAX_AUTO_CONTINUES})...`);

      const { result, error, hadToolExecution } = await executeTurn(server, threadId, prompt);

      // Check close sentinel
      if (shouldClose()) {
        // Flush any pending output before exiting
        if (result) {
          writeOutput({ status: 'success', result, newSessionId: threadId });
        }
        log('Close sentinel detected, exiting');
        break;
      }

      // Auto-continue: if the turn produced only text (no tool execution),
      // nudge Codex to actually execute instead of just describing plans.
      // This mimics `codex exec --full-auto` behavior.
      if (!error && !hadToolExecution && result && autoContinueCount < MAX_AUTO_CONTINUES) {
        autoContinueCount++;
        log(`Turn had no tool execution, auto-continuing (${autoContinueCount}/${MAX_AUTO_CONTINUES})`);
        // Still emit the intermediate text so user sees progress
        writeOutput({ status: 'success', result, newSessionId: threadId });
        prompt = AUTO_CONTINUE_PROMPT;
        continue;
      }

      // Reset auto-continue counter when tools were actually executed
      if (hadToolExecution) {
        autoContinueCount = 0;
      }

      if (error) {
        log(`Turn error: ${error}`);
        writeOutput({
          status: 'error',
          result: result || null,
          newSessionId: threadId,
          error,
        });
      } else {
        writeOutput({
          status: 'success',
          result: result || null,
          newSessionId: threadId,
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
      autoContinueCount = 0; // Reset on new user message
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Runner error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage,
    });
  } finally {
    server.kill();
  }
}

main();
