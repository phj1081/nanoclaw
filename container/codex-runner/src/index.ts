/**
 * NanoClaw Codex Runner
 * Runs inside a container, receives config via stdin, executes Codex CLI, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 */

import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
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

// Paths configurable via env vars (defaults to container paths for backwards compat)
const GROUP_DIR = process.env.NANOCLAW_GROUP_DIR || '/workspace/group';
const IPC_DIR = process.env.NANOCLAW_IPC_DIR || '/workspace/ipc';
// Optional: override cwd (agent works in this directory instead of GROUP_DIR)
const WORK_DIR = process.env.NANOCLAW_WORK_DIR || '';
const IPC_INPUT_DIR = path.join(IPC_DIR, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const MAX_TURNS = 100;

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

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

/**
 * Run a Codex CLI exec command and return the result.
 * If resume=true, resumes the most recent session instead of starting fresh.
 */
async function runCodexExec(prompt: string, resume: boolean): Promise<{ result: string; error?: string }> {
  return new Promise((resolve) => {
    const args: string[] = [];
    const effectiveCwd = WORK_DIR || GROUP_DIR;
    const codexModel = process.env.CODEX_MODEL || '';
    const codexEffort = process.env.CODEX_EFFORT || '';

    if (resume) {
      args.push(
        'exec', 'resume', '--last',
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
        prompt,
      );
    } else {
      args.push(
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '-C', effectiveCwd,
        '--skip-git-repo-check',
        '--color', 'never',
      );
      if (codexModel) args.push('-m', codexModel);
      if (codexEffort) args.push('-c', `model_reasoning_effort=${codexEffort}`);
      args.push(prompt);
    }

    log(`Running: codex ${args.slice(0, 6).join(' ')}... (resume=${resume})`);

    const codex: ChildProcess = spawn('codex', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: effectiveCwd,
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    codex.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    codex.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      // Log stderr lines for debugging
      for (const line of chunk.trim().split('\n')) {
        if (line) log(line);
      }
    });

    codex.on('close', (code: number | null) => {
      log(`Codex exited with code ${code}`);

      if (code !== 0) {
        resolve({
          result: stdout.trim() || '',
          error: `Codex exited with code ${code}: ${stderr.slice(-500)}`,
        });
        return;
      }

      // Extract the meaningful output
      const result = stdout.trim();
      resolve({ result });
    });

    codex.on('error', (err: Error) => {
      resolve({
        result: '',
        error: `Failed to spawn codex: ${err.message}`,
      });
    });

    // Close stdin immediately since we pass prompt as argument
    codex.stdin?.end();
  });
}

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
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  // Clean up stale _close sentinel
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

  // Query loop: run codex exec → wait for IPC message → repeat
  // First exec is a fresh session; subsequent execs resume the last session.
  let isFirstExec = true;
  let turnCount = 0;

  try {
    while (true) {
      turnCount++;
      if (turnCount > MAX_TURNS) {
        log(`Turn limit reached (${MAX_TURNS}), exiting`);
        writeOutput({ status: 'success', result: '[세션 턴 제한 도달. 새 메시지로 다시 시작됩니다.]' });
        break;
      }
      log(`Starting codex exec (first=${isFirstExec}, turn=${turnCount}/${MAX_TURNS})...`);

      const { result, error } = await runCodexExec(prompt, !isFirstExec);
      isFirstExec = false;

      if (error) {
        log(`Codex error: ${error}`);
        writeOutput({
          status: 'error',
          result: result || null,
          error,
        });
      } else {
        writeOutput({
          status: 'success',
          result: result || null,
        });
      }

      // Check if close was requested
      if (shouldClose()) {
        log('Close sentinel detected, exiting');
        break;
      }

      log('Codex exec done, waiting for next IPC message...');

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new codex exec`);
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
    process.exit(1);
  }
}

main();
