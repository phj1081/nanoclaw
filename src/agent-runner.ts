/**
 * Agent Process Runner for NanoClaw
 * Spawns agent execution as direct host processes and handles IPC
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  AGENT_MAX_OUTPUT_SIZE,
  AGENT_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { readEnvFile } from './env.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface AgentInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  agentType?: 'claude-code' | 'codex';
}

export interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

/**
 * Prepare the group's environment: directories, sessions, env vars.
 * Returns the environment variables and paths for the runner process.
 */
function prepareGroupEnvironment(
  group: RegisteredGroup,
  isMain: boolean,
): { env: Record<string, string>; groupDir: string; runnerDir: string } {
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Per-group Claude sessions directory
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  // Sync credentials from user's home ~/.claude/ so per-group sessions stay fresh
  const homeClaudeDir = path.join(os.homedir(), '.claude');
  const credsSrc = path.join(homeClaudeDir, '.credentials.json');
  if (fs.existsSync(credsSrc)) {
    fs.copyFileSync(credsSrc, path.join(groupSessionsDir, '.credentials.json'));
  }

  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills and commands into each group's .claude/ session dir
  // Sources: 1) user's global ~/.claude/  2) project workDir/.claude/  3) container/skills/
  const workDirClaude = group.workDir
    ? path.join(group.workDir, '.claude')
    : null;
  const syncDirs = [
    {
      dst: path.join(groupSessionsDir, 'skills'),
      sources: [
        path.join(os.homedir(), '.claude', 'skills'),
        ...(workDirClaude ? [path.join(workDirClaude, 'skills')] : []),
        path.join(projectRoot, 'container', 'skills'),
      ],
    },
    {
      dst: path.join(groupSessionsDir, 'commands'),
      sources: [
        path.join(os.homedir(), '.claude', 'commands'),
        ...(workDirClaude ? [path.join(workDirClaude, 'commands')] : []),
      ],
    },
  ];
  for (const { dst, sources } of syncDirs) {
    for (const src of sources) {
      if (!fs.existsSync(src)) continue;
      for (const entry of fs.readdirSync(src)) {
        const srcPath = path.join(src, entry);
        const dstPath = path.join(dst, entry);
        if (fs.statSync(srcPath).isDirectory()) {
          fs.cpSync(srcPath, dstPath, { recursive: true });
        } else {
          fs.mkdirSync(dst, { recursive: true });
          fs.copyFileSync(srcPath, dstPath);
        }
      }
    }
  }

  // Per-group IPC namespace
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });

  // Global memory directory (for non-main groups)
  const globalDir = path.join(GROUPS_DIR, 'global');

  // Additional mount directories (validated)
  const extraDirs: string[] = [];
  if (group.agentConfig?.additionalMounts) {
    for (const mount of group.agentConfig.additionalMounts) {
      if (fs.existsSync(mount.hostPath)) {
        extraDirs.push(mount.hostPath);
      }
    }
  }

  // Determine runner directory
  const agentType = group.agentType || 'claude-code';
  const runnerDirName = agentType === 'codex' ? 'codex-runner' : 'agent-runner';
  const runnerDir = path.join(projectRoot, 'container', runnerDirName);

  // Build environment variables for the runner process
  const envVars = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_MODEL',
    'CLAUDE_THINKING',
    'CLAUDE_THINKING_BUDGET',
    'CLAUDE_EFFORT',
    'OPENAI_API_KEY',
    'CODEX_OPENAI_API_KEY',
    'CODEX_MODEL',
    'CODEX_EFFORT',
  ]);

  // Build a clean env without Claude Code nesting detection variables
  const cleanEnv = { ...(process.env as Record<string, string>) };
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

  // Ensure node and npm-global binaries (codex, etc.) are findable
  const nodeBin = path.dirname(process.execPath);
  const npmGlobalBin = path.join(os.homedir(), '.npm-global', 'bin');
  const currentPath = cleanEnv.PATH || '/usr/local/bin:/usr/bin:/bin';
  const extraPaths = [nodeBin, npmGlobalBin].filter(
    (p) => !currentPath.includes(p) && fs.existsSync(p),
  );
  const enrichedPath =
    extraPaths.length > 0
      ? `${extraPaths.join(':')}:${currentPath}`
      : currentPath;

  const env: Record<string, string> = {
    ...cleanEnv,
    PATH: enrichedPath,
    TZ: TIMEZONE,
    HOME: os.homedir(),
    // Path configuration for the runner
    NANOCLAW_GROUP_DIR: groupDir,
    NANOCLAW_IPC_DIR: groupIpcDir,
    NANOCLAW_GLOBAL_DIR: globalDir,
    NANOCLAW_EXTRA_DIR: extraDirs.length > 0 ? extraDirs[0] : '',
    // Working directory override (agent uses this as cwd instead of group dir)
    ...(group.workDir ? { NANOCLAW_WORK_DIR: group.workDir } : {}),
    // MCP server context
    NANOCLAW_CHAT_JID: group.folder,
    NANOCLAW_GROUP_FOLDER: group.folder,
    NANOCLAW_IS_MAIN: isMain ? '1' : '0',
    // Claude sessions directory — set CLAUDE_CONFIG_DIR so SDK uses per-group sessions
    CLAUDE_CONFIG_DIR: groupSessionsDir,
  };

  // Pass credentials directly (no proxy needed on host)
  if (agentType === 'codex') {
    const openaiKey =
      envVars.CODEX_OPENAI_API_KEY ||
      process.env.CODEX_OPENAI_API_KEY ||
      envVars.OPENAI_API_KEY ||
      process.env.OPENAI_API_KEY;
    if (openaiKey) env.OPENAI_API_KEY = openaiKey;

    // Codex model/effort configuration (per-group overrides global)
    const codexModel =
      group.agentConfig?.codexModel ||
      envVars.CODEX_MODEL ||
      process.env.CODEX_MODEL;
    if (codexModel) env.CODEX_MODEL = codexModel;
    const codexEffort =
      group.agentConfig?.codexEffort ||
      envVars.CODEX_EFFORT ||
      process.env.CODEX_EFFORT;
    if (codexEffort) env.CODEX_EFFORT = codexEffort;

    // Codex session directory
    const hostCodexDir = path.join(os.homedir(), '.codex');
    const sessionCodexDir = path.join(
      DATA_DIR,
      'sessions',
      group.folder,
      '.codex',
    );
    fs.mkdirSync(sessionCodexDir, { recursive: true });
    const authSrc = path.join(hostCodexDir, 'auth.json');
    const authDst = path.join(sessionCodexDir, 'auth.json');
    if (fs.existsSync(authSrc)) fs.copyFileSync(authSrc, authDst);
    for (const file of ['config.toml', 'config.json', 'instructions.md']) {
      const src = path.join(hostCodexDir, file);
      const dst = path.join(sessionCodexDir, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
      }
    }
    // Sync skills into Codex session dir (same sources as Claude Code)
    const codexSkillsDst = path.join(sessionCodexDir, 'skills');
    const codexSkillSources = [
      path.join(hostCodexDir, 'skills'),
      path.join(projectRoot, 'container', 'skills'),
    ];
    for (const src of codexSkillSources) {
      if (!fs.existsSync(src)) continue;
      for (const entry of fs.readdirSync(src)) {
        const srcPath = path.join(src, entry);
        const dstPath = path.join(codexSkillsDst, entry);
        if (fs.statSync(srcPath).isDirectory()) {
          fs.cpSync(srcPath, dstPath, { recursive: true });
        } else {
          fs.mkdirSync(codexSkillsDst, { recursive: true });
          fs.copyFileSync(srcPath, dstPath);
        }
      }
    }

    // Inject nanoclaw MCP server into Codex config.toml
    const mcpServerPath = path.join(
      projectRoot,
      'container',
      'agent-runner',
      'dist',
      'ipc-mcp-stdio.js',
    );
    const configTomlPath = path.join(sessionCodexDir, 'config.toml');
    if (fs.existsSync(mcpServerPath)) {
      let toml = fs.existsSync(configTomlPath)
        ? fs.readFileSync(configTomlPath, 'utf-8')
        : '';
      // Remove existing nanoclaw MCP section if present (to refresh env vars)
      toml = toml.replace(/\n?\[mcp_servers\.nanoclaw\][\s\S]*?(?=\n\[|$)/, '');
      const mcpSection = `
[mcp_servers.nanoclaw]
command = "node"
args = [${JSON.stringify(mcpServerPath)}]

[mcp_servers.nanoclaw.env]
NANOCLAW_IPC_DIR = ${JSON.stringify(env.NANOCLAW_IPC_DIR)}
NANOCLAW_CHAT_JID = ${JSON.stringify(group.folder)}
NANOCLAW_GROUP_FOLDER = ${JSON.stringify(group.folder)}
NANOCLAW_IS_MAIN = ${JSON.stringify(isMain ? '1' : '0')}
`;
      toml = toml.trimEnd() + '\n' + mcpSection;
      fs.writeFileSync(configTomlPath, toml);
    }

    // Sanitize secrets: prevent API keys from leaking to codex subprocesses
    delete env.ANTHROPIC_API_KEY;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;

    env.CODEX_HOME = sessionCodexDir;
  } else {
    // Claude Code — pass real credentials directly
    if (envVars.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY) {
      env.ANTHROPIC_API_KEY =
        envVars.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';
    }
    if (
      envVars.CLAUDE_CODE_OAUTH_TOKEN ||
      process.env.CLAUDE_CODE_OAUTH_TOKEN
    ) {
      env.CLAUDE_CODE_OAUTH_TOKEN =
        envVars.CLAUDE_CODE_OAUTH_TOKEN ||
        process.env.CLAUDE_CODE_OAUTH_TOKEN ||
        '';
    }
    // Model/thinking config (per-group overrides global)
    for (const key of [
      'CLAUDE_MODEL',
      'CLAUDE_THINKING',
      'CLAUDE_THINKING_BUDGET',
      'CLAUDE_EFFORT',
    ]) {
      const val = envVars[key as keyof typeof envVars] || process.env[key];
      if (val) env[key] = val;
    }
    if (group.agentConfig?.claudeModel) {
      env.CLAUDE_MODEL = group.agentConfig.claudeModel;
    }
    if (group.agentConfig?.claudeEffort) {
      env.CLAUDE_EFFORT = group.agentConfig.claudeEffort;
    }
  }

  return { env, groupDir, runnerDir };
}

export async function runAgentProcess(
  group: RegisteredGroup,
  input: AgentInput,
  onProcess: (proc: ChildProcess, processName: string) => void,
  onOutput?: (output: AgentOutput) => Promise<void>,
): Promise<AgentOutput> {
  const startTime = Date.now();
  const { env, groupDir, runnerDir } = prepareGroupEnvironment(
    group,
    input.isMain,
  );

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processName = `nanoclaw-${safeName}-${Date.now()}`;

  // Check if runner is built
  const distEntry = path.join(runnerDir, 'dist', 'index.js');
  if (!fs.existsSync(distEntry)) {
    logger.error(
      { runnerDir },
      'Runner not built. Run: cd container/agent-runner && npm install && npm run build',
    );
    return {
      status: 'error',
      result: null,
      error: `Runner not built at ${distEntry}. Run npm run build:runners first.`,
    };
  }

  logger.info(
    {
      group: group.name,
      processName,
      agentType: group.agentType || 'claude-code',
      isMain: input.isMain,
    },
    'Spawning agent process',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const proc = spawn('node', [distEntry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: runnerDir,
      env,
    });

    onProcess(proc, processName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = AGENT_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Agent stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: AgentOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            resetTimeout();
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ agent: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = AGENT_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.agentConfig?.timeout || AGENT_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, processName },
        'Agent timeout, sending SIGTERM',
      );
      proc.kill('SIGTERM');
      // Force kill after 15s if still alive
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 15000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    proc.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        fs.writeFileSync(
          path.join(logsDir, `agent-${ts}.log`),
          [
            `=== Agent Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Process: ${processName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, processName, duration, code },
            'Agent timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }

        resolve({
          status: 'error',
          result: null,
          error: `Agent timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `agent-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Agent Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `AgentType: ${group.agentType || 'claude-code'}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        ``,
      ];

      const isError = code !== 0;
      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Stderr ===`,
          stderr,
          ``,
          `=== Stdout ===`,
          stdout,
        );
      } else {
        logLines.push(
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));

      if (code !== 0) {
        logger.error(
          { group: group.name, code, duration, logFile },
          'Agent exited with error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Agent exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Agent completed (streaming mode)',
          );
          resolve({ status: 'success', result: null, newSessionId });
        });
        return;
      }

      // Legacy mode: parse output from stdout
      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);
        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }
        const output: AgentOutput = JSON.parse(jsonLine);
        logger.info(
          { group: group.name, duration, status: output.status },
          'Agent completed',
        );
        resolve(output);
      } catch (err) {
        logger.error(
          { group: group.name, error: err },
          'Failed to parse agent output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse agent output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, processName, error: err },
        'Agent spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Agent spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);
  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });
  const visibleGroups = isMain ? groups : [];
  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      { groups: visibleGroups, lastSync: new Date().toISOString() },
      null,
      2,
    ),
  );
}
