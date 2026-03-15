import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  ASSISTANT_NAME,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  SERVICE_AGENT_TYPE,
  STATUS_CHANNEL_ID,
  STATUS_UPDATE_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
  USAGE_UPDATE_INTERVAL,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  AgentOutput,
  runAgentProcess,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './agent-runner.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getLastHumanMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { readEnvFile } from './env.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, ChannelMeta, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups(SERVICE_AGENT_TYPE);
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./agent-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // --- Session command interception (before trigger check) ---
  const cmdResult = await handleSessionCommand({
    missedMessages,
    isMainGroup,
    groupName: group.name,
    triggerPattern: TRIGGER_PATTERN,
    timezone: TIMEZONE,
    deps: {
      sendMessage: (text) => channel.sendMessage(chatJid, text),
      setTyping: (typing) =>
        channel.setTyping?.(chatJid, typing) ?? Promise.resolve(),
      runAgent: (prompt, onOutput) =>
        runAgent(group, prompt, chatJid, onOutput),
      closeStdin: () => queue.closeStdin(chatJid),
      advanceCursor: (ts) => {
        lastAgentTimestamp[chatJid] = ts;
        saveState();
      },
      formatMessages,
      canSenderInteract: (msg) => {
        const hasTrigger = TRIGGER_PATTERN.test(msg.content.trim());
        const reqTrigger = !isMainGroup && group.requiresTrigger !== false;
        return (
          isMainGroup ||
          !reqTrigger ||
          (hasTrigger &&
            (msg.is_from_me ||
              isTriggerAllowed(chatJid, msg.sender, loadSenderAllowlist())))
        );
      },
    },
  });
  if (cmdResult.handled) return cmdResult.success;
  // --- End session command interception ---

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) {
      return true;
    }
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing agent stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  let hadError = false;
  let outputSentToUser = false;

  await channel.setTyping?.(chatJid, true);

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
    }

    // Always clear typing and reset idle timer on any output (including null results)
    await channel.setTyping?.(chatJid, false);
    resetIdleTimer();

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);

  if (output === 'error') {
    hadError = true;
  }

  if (idleTimer) clearTimeout(idleTimer);

  if (hadError) {
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: AgentOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for agent to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: AgentOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runAgentProcess(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, processName) =>
        queue.registerProcess(chatJid, proc, processName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Agent process error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

// ── Status & Usage Dashboards ───────────────────────────────────

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}m${rem.toString().padStart(2, '0')}s`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h < 24) return `${h}h${m.toString().padStart(2, '0')}m`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return `${d}d${remH}h`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)}GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(0)}MB`;
  return `${(bytes / 1024).toFixed(0)}KB`;
}

function usageEmoji(pct: number): string {
  if (pct >= 80) return '🔴';
  if (pct >= 50) return '🟡';
  return '🟢';
}

function formatResetKST(value: string | number): string {
  try {
    // Handle unix timestamp (seconds) or ISO string
    const date =
      typeof value === 'number' ? new Date(value * 1000) : new Date(value);
    return date.toLocaleString('ko-KR', {
      timeZone: 'Asia/Seoul',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(value);
  }
}

const STATUS_ICONS: Record<string, string> = {
  processing: '🟡',
  idle: '🟢',
  waiting: '🔵',
  inactive: '⚪',
};

let statusMessageId: string | null = null;
let usageMessageId: string | null = null;

// Cache for Discord channel metadata (name, position, category)
let channelMetaCache = new Map<string, ChannelMeta>();
let channelMetaLastRefresh = 0;
const CHANNEL_META_REFRESH_MS = 300000; // 5 minutes

async function refreshChannelMeta(): Promise<void> {
  const now = Date.now();
  if (now - channelMetaLastRefresh < CHANNEL_META_REFRESH_MS) return;

  const ch = channels.find(
    (c) => c.name.startsWith('discord') && c.isConnected() && c.getChannelMeta,
  );
  if (!ch?.getChannelMeta) return;

  const jids = Object.keys(registeredGroups).filter((j) => j.startsWith('dc:'));
  try {
    channelMetaCache = await ch.getChannelMeta(jids);
    channelMetaLastRefresh = now;
  } catch (err) {
    logger.debug({ err }, 'Failed to refresh channel metadata');
  }
}

function getStatusLabel(s: import('./group-queue.js').GroupStatus): string {
  if (s.status === 'processing')
    return `처리 중 (${formatElapsed(s.elapsedMs || 0)})`;
  if (s.status === 'idle') return '대기 중';
  if (s.status === 'waiting')
    return s.pendingTasks > 0
      ? `큐 대기 (태스크 ${s.pendingTasks}개)`
      : '큐 대기 (메시지)';
  return '비활성';
}

function buildStatusContent(): string {
  const jids = Object.keys(registeredGroups);
  const statuses = queue.getStatuses(jids);

  const entries = statuses
    .map((s) => ({
      status: s,
      group: registeredGroups[s.jid],
      meta: channelMetaCache.get(s.jid),
    }))
    .filter((e) => e.group);

  // Group by category
  const categoryMap = new Map<string, typeof entries>();
  for (const entry of entries) {
    const cat = entry.meta?.category || '기타';
    if (!categoryMap.has(cat)) categoryMap.set(cat, []);
    categoryMap.get(cat)!.push(entry);
  }

  // Sort categories by position
  const sortedCategories = [...categoryMap.entries()].sort((a, b) => {
    const posA = a[1][0]?.meta?.categoryPosition ?? 999;
    const posB = b[1][0]?.meta?.categoryPosition ?? 999;
    return posA - posB;
  });

  const sections: string[] = [];
  let totalActive = 0;
  let totalIdle = 0;
  let total = 0;

  for (const [catName, catEntries] of sortedCategories) {
    catEntries.sort(
      (a, b) => (a.meta?.position ?? 999) - (b.meta?.position ?? 999),
    );

    const lines = catEntries.map((e) => {
      const icon = STATUS_ICONS[e.status.status] || '⚪';
      const label = getStatusLabel(e.status);
      // Prefer actual Discord channel name over DB-stored name
      const name = e.meta?.name ? `#${e.meta.name}` : e.group.name;
      return `  ${icon} **${name}** — ${label}`;
    });

    if (channelMetaCache.size > 0 && catName !== '기타') {
      sections.push(`📁 **${catName}**\n${lines.join('\n')}`);
    } else {
      sections.push(lines.join('\n'));
    }

    totalActive += catEntries.filter(
      (e) => e.status.status === 'processing',
    ).length;
    totalIdle += catEntries.filter((e) => e.status.status === 'idle').length;
    total += catEntries.length;
  }

  const header = `**에이전트 상태** (${ASSISTANT_NAME}) — 활성 ${totalActive} | 대기 ${totalIdle} | 전체 ${total}`;
  return `${header}\n\n${sections.join('\n\n')}\n\n_${new Date().toLocaleTimeString('ko-KR')}_`;
}

// ── API Usage Fetchers ──────────────────────────────────────────

interface ClaudeUsageData {
  five_hour?: { utilization: number; resets_at: string };
  seven_day?: { utilization: number; resets_at: string };
}

interface CodexRateLimit {
  limitId?: string;
  limitName: string | null;
  primary: { usedPercent: number; resetsAt: string | number };
  secondary: { usedPercent: number; resetsAt: string | number };
}

async function fetchClaudeUsage(): Promise<ClaudeUsageData | null> {
  try {
    const envToken = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN']);
    let token =
      process.env.CLAUDE_CODE_OAUTH_TOKEN ||
      envToken.CLAUDE_CODE_OAUTH_TOKEN ||
      '';
    if (!token) {
      const configDir =
        process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
      const credsPath = path.join(configDir, '.credentials.json');
      if (!fs.existsSync(credsPath)) return null;
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
      token = creds?.claudeAiOauth?.accessToken || '';
    }
    if (!token) return null;

    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as ClaudeUsageData;
  } catch {
    return null;
  }
}

async function fetchCodexUsage(): Promise<CodexRateLimit[] | null> {
  // Find codex binary
  const npmGlobalBin = path.join(os.homedir(), '.npm-global', 'bin', 'codex');
  const codexBin = fs.existsSync(npmGlobalBin) ? npmGlobalBin : 'codex';

  return new Promise((resolve) => {
    let done = false;
    const finish = (val: CodexRateLimit[] | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      resolve(val);
    };

    const timer = setTimeout(() => finish(null), 20000);

    let proc: ChildProcess;
    try {
      proc = spawn(codexBin, ['app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...(process.env as Record<string, string>),
          PATH: [
            path.dirname(process.execPath),
            path.join(os.homedir(), '.npm-global', 'bin'),
            process.env.PATH || '',
          ].join(':'),
        },
      });
    } catch {
      resolve(null);
      return;
    }

    proc.on('error', () => finish(null));
    proc.on('close', () => finish(null));

    let buf = '';
    proc.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1) {
            // Initialize done, query rate limits
            proc.stdin!.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'account/rateLimits/read',
                params: {},
              }) + '\n',
            );
          } else if (msg.id === 2 && msg.result) {
            // Extract rate limits from rateLimitsByLimitId object
            const byId = msg.result.rateLimitsByLimitId;
            if (byId && typeof byId === 'object') {
              finish(Object.values(byId) as CodexRateLimit[]);
            } else {
              finish(null);
            }
          }
        } catch {
          /* non-JSON line, skip */
        }
      }
    });

    // Send initialize
    proc.stdin!.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'usage-monitor', version: '1.0' } },
      }) + '\n',
    );
  });
}

// ── Usage Dashboard Builder ─────────────────────────────────────

async function buildUsageContent(): Promise<string> {
  const lines: string[] = [];

  // Fetch API usage in parallel
  const [claudeUsage, codexUsage] = await Promise.all([
    fetchClaudeUsage(),
    fetchCodexUsage(),
  ]);

  // Claude Code usage
  if (claudeUsage) {
    lines.push('☁️ *Claude Code*');
    if (claudeUsage.five_hour) {
      // utilization may be fraction (0-1) or percentage (0-100)
      const raw = claudeUsage.five_hour.utilization;
      const pct = raw > 1 ? Math.round(raw) : Math.round(raw * 100);
      lines.push(
        `• 5시간: ${usageEmoji(pct)} ${pct}% (리셋: ${formatResetKST(claudeUsage.five_hour.resets_at)})`,
      );
    }
    if (claudeUsage.seven_day) {
      const raw = claudeUsage.seven_day.utilization;
      const pct = raw > 1 ? Math.round(raw) : Math.round(raw * 100);
      lines.push(
        `• 7일: ${usageEmoji(pct)} ${pct}% (리셋: ${formatResetKST(claudeUsage.seven_day.resets_at)})`,
      );
    }
    lines.push('');
  }

  // Codex usage
  if (codexUsage && Array.isArray(codexUsage)) {
    lines.push('🤖 *Codex CLI*');
    for (const limit of codexUsage) {
      const p = Math.round(limit.primary.usedPercent);
      const s = Math.round(limit.secondary.usedPercent);
      const name = limit.limitName || limit.limitId || 'Codex';
      lines.push(
        `• ${name} 5시간: ${usageEmoji(p)} ${p}% (리셋: ${formatResetKST(limit.primary.resetsAt)})`,
      );
      lines.push(
        `• ${name} 7일: ${usageEmoji(s)} ${s}% (리셋: ${formatResetKST(limit.secondary.resetsAt)})`,
      );
    }
    lines.push('');
  }

  if (!claudeUsage && !codexUsage) {
    lines.push('_API 사용량 조회 불가_');
    lines.push('');
  }

  // System resources
  lines.push('🖥️ *서버*');

  const loadAvg = os.loadavg();
  const cpuCount = os.cpus().length;
  const cpuPct1 = Math.round((loadAvg[0] / cpuCount) * 100);
  const cpuPct5 = Math.round((loadAvg[1] / cpuCount) * 100);
  const cpuPct15 = Math.round((loadAvg[2] / cpuCount) * 100);
  lines.push(
    `• CPU: ${usageEmoji(cpuPct1)} ${cpuPct1}% (1m) | ${cpuPct5}% (5m) | ${cpuPct15}% (15m)`,
  );

  const totalMem = os.totalmem();
  const usedMem = totalMem - os.freemem();
  const memPct = Math.round((usedMem / totalMem) * 100);
  lines.push(
    `• 메모리: ${usageEmoji(memPct)} ${memPct}% (${(usedMem / 1073741824).toFixed(1)}GB / ${(totalMem / 1073741824).toFixed(1)}GB)`,
  );

  let diskLine = '• 디스크: 확인 불가';
  try {
    const df = execSync('df -B1 / | tail -1', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    const parts = df.split(/\s+/);
    const diskUsed = parseInt(parts[2], 10);
    const diskTotal = parseInt(parts[1], 10);
    const diskPct = Math.round((diskUsed / diskTotal) * 100);
    diskLine = `• 디스크: ${usageEmoji(diskPct)} ${diskPct}% (${(diskUsed / 1073741824).toFixed(1)}GB / ${(diskTotal / 1073741824).toFixed(1)}GB)`;
  } catch {
    /* ignore */
  }
  lines.push(diskLine);

  lines.push(`• 업타임: ${formatElapsed(os.uptime() * 1000)}`);

  return (
    lines.join('\n') +
    `\n\n_${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}_`
  );
}

// ── Dashboard Lifecycle ─────────────────────────────────────────

async function startStatusDashboard(): Promise<void> {
  if (!STATUS_CHANNEL_ID) return;

  const statusJid = `dc:${STATUS_CHANNEL_ID}`;

  const findDiscordChannel = () =>
    channels.find((c) => c.name.startsWith('discord') && c.isConnected());

  const updateStatus = async () => {
    const ch = findDiscordChannel();
    if (!ch) return;

    try {
      await refreshChannelMeta();
      const content = buildStatusContent();

      if (statusMessageId && ch.editMessage) {
        await ch.editMessage(statusJid, statusMessageId, content);
      } else if (ch.sendAndTrack) {
        const id = await ch.sendAndTrack(statusJid, content);
        if (id) statusMessageId = id;
      }
    } catch (err) {
      logger.debug({ err }, 'Status dashboard update failed');
      statusMessageId = null;
    }
  };

  setInterval(updateStatus, STATUS_UPDATE_INTERVAL);
  await updateStatus();
  logger.info({ channelId: STATUS_CHANNEL_ID }, 'Status dashboard started');
}

let usageUpdateInProgress = false;

async function startUsageDashboard(): Promise<void> {
  if (!STATUS_CHANNEL_ID) return;
  // Only one service should show usage (set USAGE_DASHBOARD=true on that service)
  if (process.env.USAGE_DASHBOARD !== 'true') return;

  const statusJid = `dc:${STATUS_CHANNEL_ID}`;

  const findDiscordChannel = () =>
    channels.find((c) => c.name.startsWith('discord') && c.isConnected());

  const updateUsage = async () => {
    if (usageUpdateInProgress) return;
    usageUpdateInProgress = true;

    const ch = findDiscordChannel();
    if (!ch) {
      usageUpdateInProgress = false;
      return;
    }

    try {
      const content = await buildUsageContent();

      if (usageMessageId && ch.editMessage) {
        await ch.editMessage(statusJid, usageMessageId, content);
      } else if (ch.sendAndTrack) {
        const id = await ch.sendAndTrack(statusJid, content);
        if (id) usageMessageId = id;
      }
    } catch (err) {
      logger.debug({ err }, 'Usage dashboard update failed');
      usageMessageId = null;
    } finally {
      usageUpdateInProgress = false;
    }
  };

  setInterval(updateUsage, USAGE_UPDATE_INTERVAL);
  await updateUsage();
  logger.info('Usage dashboard started');
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;

          // --- Bot-collaboration timeout ---
          // If all new messages are from bots, only process if a human
          // sent a message within the last 12 hours.
          const BOT_COLLAB_TIMEOUT_MS = 12 * 60 * 60 * 1000;
          const allFromBots = groupMessages.every(
            (m) => m.is_from_me || !!m.is_bot_message,
          );
          if (allFromBots) {
            const lastHuman = getLastHumanMessageTimestamp(chatJid);
            if (
              !lastHuman ||
              Date.now() - new Date(lastHuman).getTime() > BOT_COLLAB_TIMEOUT_MS
            ) {
              logger.info(
                { chatJid, lastHuman },
                'Bot-collaboration timeout: no human message within 12h, skipping',
              );
              continue;
            }
          }
          // --- End bot-collaboration timeout ---

          // --- Session command interception (message loop) ---
          // Scan ALL messages in the batch for a session command.
          const loopCmdMsg = groupMessages.find(
            (m) => extractSessionCommand(m.content, TRIGGER_PATTERN) !== null,
          );

          if (loopCmdMsg) {
            // Only close active agent if the sender is authorized — otherwise an
            // untrusted user could kill in-flight work by sending /compact (DoS).
            // closeStdin no-ops internally when no agent is active.
            if (
              isSessionCommandAllowed(
                isMainGroup,
                loopCmdMsg.is_from_me === true,
              )
            ) {
              queue.closeStdin(chatJid);
            }
            // Enqueue so processGroupMessages handles auth + cursor advancement.
            // Don't pipe via IPC — slash commands need a fresh agent with
            // string prompt (not MessageStream) for SDK recognition.
            queue.enqueueMessageCheck(chatJid);
            continue;
          }
          // --- End session command interception ---

          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active agent',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the agent processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active agent — enqueue for a new one
            queue.enqueueMessageCheck(chatJid, group.folder);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid, group.folder);
    }
  }
}

async function main(): Promise<void> {
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, processName, groupFolder) =>
      queue.registerProcess(groupJid, proc, processName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  // Purge old messages in status channel before creating fresh dashboards
  if (STATUS_CHANNEL_ID) {
    const statusJid = `dc:${STATUS_CHANNEL_ID}`;
    const ch = channels.find(
      (c) => c.name.startsWith('discord') && c.isConnected() && c.purgeChannel,
    );
    if (ch?.purgeChannel) {
      await ch.purgeChannel(statusJid);
    }
  }
  await startStatusDashboard();
  await startUsageDashboard();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
