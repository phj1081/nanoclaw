import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { USAGE_DASHBOARD_ENABLED } from './config.js';
import { readEnvFile } from './env.js';
import { GroupQueue, GroupStatus } from './group-queue.js';
import { logger } from './logger.js';
import { Channel, ChannelMeta, RegisteredGroup } from './types.js';

export interface DashboardOptions {
  assistantName: string;
  channels: Channel[];
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  registeredGroups: () => Record<string, RegisteredGroup>;
  statusChannelId: string;
  statusUpdateInterval: number;
  usageUpdateInterval: number;
}

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

const STATUS_ICONS: Record<string, string> = {
  processing: '🟡',
  idle: '🟢',
  waiting: '🔵',
  inactive: '⚪',
};

const CHANNEL_META_REFRESH_MS = 300000;

let statusMessageId: string | null = null;
let usageMessageId: string | null = null;
let usageUpdateInProgress = false;
let channelMetaCache = new Map<string, ChannelMeta>();
let channelMetaLastRefresh = 0;

function findDiscordChannel(channels: Channel[]): Channel | undefined {
  return channels.find((c) => c.name.startsWith('discord') && c.isConnected());
}

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

function formatResetKST(value: string | number): string {
  try {
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

async function refreshChannelMeta(opts: DashboardOptions): Promise<void> {
  const now = Date.now();
  if (now - channelMetaLastRefresh < CHANNEL_META_REFRESH_MS) return;

  const ch = opts.channels.find(
    (c) => c.name.startsWith('discord') && c.isConnected() && c.getChannelMeta,
  );
  if (!ch?.getChannelMeta) return;

  const jids = Object.keys(opts.registeredGroups()).filter((j) =>
    j.startsWith('dc:'),
  );
  try {
    channelMetaCache = await ch.getChannelMeta(jids);
    channelMetaLastRefresh = now;
  } catch (err) {
    logger.debug({ err }, 'Failed to refresh channel metadata');
  }
}

function getStatusLabel(status: GroupStatus): string {
  if (status.status === 'processing') {
    return `처리 중 (${formatElapsed(status.elapsedMs || 0)})`;
  }
  if (status.status === 'idle') return '대기 중';
  if (status.status === 'waiting') {
    return status.pendingTasks > 0
      ? `큐 대기 (태스크 ${status.pendingTasks}개)`
      : '큐 대기 (메시지)';
  }
  return '비활성';
}

function getSessionLabel(sessionId: string | undefined): string {
  if (!sessionId) return '세션 없음';
  const shortId = sessionId.length > 8 ? sessionId.slice(-8) : sessionId;
  return `세션 ${shortId}`;
}

/** @internal - exported for testing */
export function buildStatusContent(opts: DashboardOptions): string {
  const registeredGroups = opts.registeredGroups();
  const sessions = opts.getSessions();
  const jids = Object.keys(registeredGroups);
  const statuses = opts.queue.getStatuses(jids);

  const entries = statuses
    .map((status) => ({
      status,
      group: registeredGroups[status.jid],
      meta: channelMetaCache.get(status.jid),
    }))
    .filter((entry) => entry.group);

  const categoryMap = new Map<string, typeof entries>();
  for (const entry of entries) {
    const category = entry.meta?.category || '기타';
    if (!categoryMap.has(category)) categoryMap.set(category, []);
    categoryMap.get(category)!.push(entry);
  }

  const sortedCategories = [...categoryMap.entries()].sort((a, b) => {
    const posA = a[1][0]?.meta?.categoryPosition ?? 999;
    const posB = b[1][0]?.meta?.categoryPosition ?? 999;
    return posA - posB;
  });

  const sections: string[] = [];
  let totalActive = 0;
  let totalIdle = 0;
  let total = 0;

  for (const [categoryName, categoryEntries] of sortedCategories) {
    categoryEntries.sort(
      (a, b) => (a.meta?.position ?? 999) - (b.meta?.position ?? 999),
    );

    const lines = categoryEntries.map((entry) => {
      const icon = STATUS_ICONS[entry.status.status] || '⚪';
      const label = getStatusLabel(entry.status);
      const sessionLabel = getSessionLabel(sessions[entry.group.folder]);
      const name = entry.meta?.name ? `#${entry.meta.name}` : entry.group.name;
      return `  ${icon} **${name}** — ${label} · ${sessionLabel}`;
    });

    if (channelMetaCache.size > 0 && categoryName !== '기타') {
      sections.push(`📁 **${categoryName}**\n${lines.join('\n')}`);
    } else {
      sections.push(lines.join('\n'));
    }

    totalActive += categoryEntries.filter(
      (entry) => entry.status.status === 'processing',
    ).length;
    totalIdle += categoryEntries.filter(
      (entry) => entry.status.status === 'idle',
    ).length;
    total += categoryEntries.length;
  }

  const header = `**에이전트 상태** (${opts.assistantName}) — 활성 ${totalActive} | 대기 ${totalIdle} | 전체 ${total}`;
  return `${header}\n\n${sections.join('\n\n')}\n\n_${new Date().toLocaleTimeString('ko-KR')}_`;
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
  const npmGlobalBin = path.join(os.homedir(), '.npm-global', 'bin', 'codex');
  const codexBin = fs.existsSync(npmGlobalBin) ? npmGlobalBin : 'codex';

  return new Promise((resolve) => {
    let done = false;
    const finish = (value: CodexRateLimit[] | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (proc) {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
      }
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), 20000);

    let proc: ChildProcess | null = null;
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

    if (!proc.stdout || !proc.stdin) {
      finish(null);
      return;
    }

    const stdout = proc.stdout;
    const stdin = proc.stdin;

    proc.on('error', () => finish(null));
    proc.on('close', () => finish(null));

    let buf = '';
    stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1) {
            stdin.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'account/rateLimits/read',
                params: {},
              }) + '\n',
            );
          } else if (msg.id === 2 && msg.result) {
            const byId = msg.result.rateLimitsByLimitId;
            if (byId && typeof byId === 'object') {
              finish(Object.values(byId) as CodexRateLimit[]);
            } else {
              finish(null);
            }
          }
        } catch {
          /* non-JSON line */
        }
      }
    });

    stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'usage-monitor', version: '1.0' } },
      }) + '\n',
    );
  });
}

async function buildUsageContent(): Promise<string> {
  const lines: string[] = [];
  const [claudeUsage, codexUsage] = await Promise.all([
    fetchClaudeUsage(),
    fetchCodexUsage(),
  ]);

  const bar = (pct: number) => {
    const filled = Math.round(pct / 10);
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
  };

  lines.push('📊 *사용량*');

  type UsageRow = {
    name: string;
    h5pct: number;
    h5reset: string;
    d7pct: number;
    d7reset: string;
  };
  const rows: UsageRow[] = [];

  if (claudeUsage) {
    const h5 = claudeUsage.five_hour;
    const d7 = claudeUsage.seven_day;
    rows.push({
      name: 'Claude',
      h5pct: h5
        ? h5.utilization > 1
          ? Math.round(h5.utilization)
          : Math.round(h5.utilization * 100)
        : -1,
      h5reset: h5 ? formatResetKST(h5.resets_at) : '',
      d7pct: d7
        ? d7.utilization > 1
          ? Math.round(d7.utilization)
          : Math.round(d7.utilization * 100)
        : -1,
      d7reset: d7 ? formatResetKST(d7.resets_at) : '',
    });
  }

  if (codexUsage && Array.isArray(codexUsage)) {
    const relevant = codexUsage.filter(
      (limit) =>
        limit.primary.usedPercent > 0 || limit.secondary.usedPercent > 0,
    );
    const display = relevant.length > 0 ? relevant : codexUsage.slice(0, 1);
    for (const limit of display) {
      rows.push({
        name: 'Codex',
        h5pct: Math.round(limit.primary.usedPercent),
        h5reset: formatResetKST(limit.primary.resetsAt),
        d7pct: Math.round(limit.secondary.usedPercent),
        d7reset: formatResetKST(limit.secondary.resetsAt),
      });
    }
  }

  if (rows.length > 0) {
    lines.push('```');
    lines.push('        5-Hour             7-Day');
    for (const row of rows) {
      const h5 =
        row.h5pct >= 0
          ? `${bar(row.h5pct)} ${String(row.h5pct).padStart(3)}%`
          : '  —  ';
      const d7 =
        row.d7pct >= 0
          ? `${bar(row.d7pct)} ${String(row.d7pct).padStart(3)}%`
          : '  —  ';
      lines.push(`${row.name.padEnd(8)}${h5}   ${d7}`);
    }
    lines.push('```');
  } else {
    lines.push('_조회 불가_');
  }
  lines.push('');

  lines.push('🖥️ *서버*');

  const loadAvg = os.loadavg();
  const cpuCount = os.cpus().length;
  const cpuPct = Math.round((loadAvg[1] / cpuCount) * 100);

  const totalMem = os.totalmem();
  const usedMem = totalMem - os.freemem();
  const memPct = Math.round((usedMem / totalMem) * 100);
  const memUsedGB = (usedMem / 1073741824).toFixed(1);
  const memTotalGB = (totalMem / 1073741824).toFixed(1);

  let diskPct = 0;
  let diskUsedGB = '?';
  let diskTotalGB = '?';
  try {
    const df = execSync('df -B1 / | tail -1', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    const parts = df.split(/\s+/);
    const diskUsed = parseInt(parts[2], 10);
    const diskTotal = parseInt(parts[1], 10);
    diskPct = Math.round((diskUsed / diskTotal) * 100);
    diskUsedGB = (diskUsed / 1073741824).toFixed(0);
    diskTotalGB = (diskTotal / 1073741824).toFixed(0);
  } catch {
    /* ignore */
  }

  lines.push('```');
  lines.push(`${'CPU'.padEnd(8)}${bar(cpuPct)} ${String(cpuPct).padStart(3)}%`);
  lines.push(
    `${'Memory'.padEnd(8)}${bar(memPct)} ${String(memPct).padStart(3)}%  ${memUsedGB}/${memTotalGB}GB`,
  );
  lines.push(
    `${'Disk'.padEnd(8)}${bar(diskPct)} ${String(diskPct).padStart(3)}%  ${diskUsedGB}/${diskTotalGB}GB`,
  );
  lines.push(`${'Uptime'.padEnd(8)}${formatElapsed(os.uptime() * 1000)}`);
  lines.push('```');

  return (
    lines.join('\n') +
    `\n_${new Date().toLocaleTimeString('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
    })}_`
  );
}

export async function purgeDashboardChannel(
  opts: Pick<DashboardOptions, 'channels' | 'statusChannelId'>,
): Promise<void> {
  if (!opts.statusChannelId) return;

  const statusJid = `dc:${opts.statusChannelId}`;
  const ch = opts.channels.find(
    (channel) =>
      channel.name.startsWith('discord') &&
      channel.isConnected() &&
      channel.purgeChannel,
  );
  if (ch?.purgeChannel) {
    await ch.purgeChannel(statusJid);
  }
}

export async function startStatusDashboard(
  opts: DashboardOptions,
): Promise<void> {
  if (!opts.statusChannelId) return;

  const statusJid = `dc:${opts.statusChannelId}`;

  const updateStatus = async () => {
    const ch = findDiscordChannel(opts.channels);
    if (!ch) return;

    try {
      await refreshChannelMeta(opts);
      const content = buildStatusContent(opts);

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

  setInterval(updateStatus, opts.statusUpdateInterval);
  await updateStatus();
  logger.info({ channelId: opts.statusChannelId }, 'Status dashboard started');
}

export async function startUsageDashboard(
  opts: DashboardOptions,
): Promise<void> {
  if (!opts.statusChannelId) return;
  if (!USAGE_DASHBOARD_ENABLED) return;

  const statusJid = `dc:${opts.statusChannelId}`;

  const updateUsage = async () => {
    if (usageUpdateInProgress) return;
    usageUpdateInProgress = true;

    const ch = findDiscordChannel(opts.channels);
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

  setInterval(updateUsage, opts.usageUpdateInterval);
  await updateUsage();
  logger.info('Usage dashboard started');
}
