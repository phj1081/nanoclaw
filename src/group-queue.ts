import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_AGENTS } from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

export interface GroupRunContext {
  runId: string;
  reason: 'messages' | 'drain';
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  closingStdin: boolean;
  isTaskProcess: boolean;
  runningTaskId: string | null;
  currentRunId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  processName: string | null;
  groupFolder: string | null;
  retryCount: number;
  startedAt: number | null;
}

export interface GroupStatus {
  jid: string;
  status: 'processing' | 'idle' | 'waiting' | 'inactive';
  elapsedMs: number | null;
  pendingMessages: boolean;
  pendingTasks: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn:
    | ((groupJid: string, context: GroupRunContext) => Promise<boolean>)
    | null = null;
  private shuttingDown = false;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        closingStdin: false,
        isTaskProcess: false,
        runningTaskId: null,
        currentRunId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        processName: null,
        groupFolder: null,
        retryCount: 0,
        startedAt: null,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(
    fn: (groupJid: string, context: GroupRunContext) => Promise<boolean>,
  ): void {
    this.processMessagesFn = fn;
  }

  private createRunId(): string {
    return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  enqueueMessageCheck(groupJid: string, groupFolder?: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Pre-set groupFolder so sendMessage can pipe IPC while agent process starts
    if (groupFolder && !state.groupFolder) {
      state.groupFolder = groupFolder;
    }

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ groupJid }, 'Agent active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_AGENTS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Prevent double-queuing: check both pending and currently-running task
    if (state.runningTaskId === taskId) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (state.idleWaiting) {
        this.closeStdin(groupJid);
      }
      logger.debug({ groupJid, taskId }, 'Agent active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_AGENTS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    processName: string,
    groupFolder?: string,
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.processName = processName;
    if (groupFolder) state.groupFolder = groupFolder;
    logger.info(
      {
        groupJid,
        runId: state.currentRunId,
        processName,
        groupFolder: state.groupFolder,
        isTaskProcess: state.isTaskProcess,
      },
      'Registered active process for group',
    );
  }

  /**
   * Mark the agent process as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle agent process immediately.
   */
  notifyIdle(groupJid: string, runId?: string): void {
    const state = this.getGroup(groupJid);
    state.idleWaiting = true;
    logger.info(
      {
        groupJid,
        runId: runId ?? state.currentRunId,
        pendingTasks: state.pendingTasks.length,
      },
      'Agent entered idle wait state',
    );
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupJid, {
        runId: runId ?? state.currentRunId ?? undefined,
        reason: 'pending-task-preemption',
      });
    }
  }

  /**
   * Send a follow-up message to the active agent process via IPC file.
   * Returns true if the message was written, false if no active agent process.
   */
  sendMessage(groupJid: string, text: string): boolean {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder || state.isTaskProcess) {
      logger.debug(
        {
          groupJid,
          runId: state.currentRunId,
          active: state.active,
          closingStdin: state.closingStdin,
          groupFolder: state.groupFolder,
          isTaskProcess: state.isTaskProcess,
        },
        'Cannot pipe follow-up message to active agent',
      );
      return false;
    }
    if (state.closingStdin) {
      logger.info(
        { groupJid, runId: state.currentRunId, groupFolder: state.groupFolder },
        'Skipping follow-up IPC because active agent is closing',
      );
      return false;
    }
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      logger.info(
        {
          groupJid,
          runId: state.currentRunId,
          groupFolder: state.groupFolder,
          textLength: text.length,
          filename,
        },
        'Queued follow-up message for active agent',
      );
      return true;
    } catch (err) {
      logger.warn(
        {
          groupJid,
          runId: state.currentRunId,
          groupFolder: state.groupFolder,
          err,
        },
        'Failed to queue follow-up message for active agent',
      );
      return false;
    }
  }

  /**
   * Signal the active agent process to wind down by writing a close sentinel.
   */
  closeStdin(
    groupJid: string,
    metadata?: { runId?: string; reason?: string },
  ): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) return;
    state.closingStdin = true;
    state.idleWaiting = false;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
      logger.info(
        {
          groupJid,
          runId: metadata?.runId ?? state.currentRunId,
          groupFolder: state.groupFolder,
          reason: metadata?.reason ?? 'unspecified',
        },
        'Signaled active agent to close stdin',
      );
    } catch (err) {
      logger.warn(
        {
          groupJid,
          runId: metadata?.runId ?? state.currentRunId,
          groupFolder: state.groupFolder,
          reason: metadata?.reason ?? 'unspecified',
          err,
        },
        'Failed to signal active agent to close stdin',
      );
    }
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    const runId = this.createRunId();
    state.active = true;
    state.idleWaiting = false;
    state.closingStdin = false;
    state.isTaskProcess = false;
    state.currentRunId = runId;
    state.pendingMessages = false;
    state.startedAt = Date.now();
    this.activeCount++;

    logger.info(
      { groupJid, runId, reason, activeCount: this.activeCount },
      'Starting group message run',
    );

    let outcome: 'success' | 'retry_scheduled' | 'error' = 'success';
    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid, {
          runId,
          reason,
        });
        if (success) {
          state.retryCount = 0;
        } else {
          outcome = 'retry_scheduled';
          this.scheduleRetry(groupJid, state, runId);
        }
      }
    } catch (err) {
      outcome = 'error';
      logger.error(
        { groupJid, runId, err },
        'Error processing messages for group',
      );
      this.scheduleRetry(groupJid, state, runId);
    } finally {
      const durationMs = state.startedAt ? Date.now() - state.startedAt : null;
      logger.info(
        {
          groupJid,
          runId,
          reason,
          outcome,
          durationMs,
          pendingMessages: state.pendingMessages,
          pendingTasks: state.pendingTasks.length,
        },
        'Finished group message run',
      );
      state.active = false;
      state.startedAt = null;
      state.idleWaiting = false;
      state.closingStdin = false;
      state.process = null;
      state.processName = null;
      state.groupFolder = null;
      state.currentRunId = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.closingStdin = false;
    state.isTaskProcess = true;
    state.runningTaskId = task.id;
    state.startedAt = Date.now();
    this.activeCount++;

    logger.debug(
      { groupJid, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskProcess = false;
      state.runningTaskId = null;
      state.startedAt = null;
      state.idleWaiting = false;
      state.closingStdin = false;
      state.process = null;
      state.processName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private scheduleRetry(
    groupJid: string,
    state: GroupState,
    runId?: string,
  ): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, runId, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, runId, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) =>
        logger.error(
          { groupJid, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForGroup(groupJid, 'drain').catch((err) =>
        logger.error(
          { groupJid, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
      return;
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_AGENTS
    ) {
      const nextJid = this.waitingGroups.shift()!;
      const state = this.getGroup(nextJid);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task).catch((err) =>
          logger.error(
            { groupJid: nextJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(nextJid, 'drain').catch((err) =>
          logger.error(
            { groupJid: nextJid, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      }
      // If neither pending, skip this group
    }
  }

  /**
   * Return current status of all known groups.
   * Only includes groups that have been seen (registered or had activity).
   */
  getStatuses(registeredJids?: string[]): GroupStatus[] {
    const jids = registeredJids ?? [...this.groups.keys()];
    const now = Date.now();
    return jids.map((jid) => {
      const state = this.groups.get(jid);
      if (!state) {
        return {
          jid,
          status: 'inactive' as const,
          elapsedMs: null,
          pendingMessages: false,
          pendingTasks: 0,
        };
      }
      let status: GroupStatus['status'];
      if (state.active && !state.idleWaiting) {
        status = 'processing';
      } else if (state.active && state.idleWaiting) {
        status = 'idle';
      } else if (
        state.pendingMessages ||
        state.pendingTasks.length > 0 ||
        this.waitingGroups.includes(jid)
      ) {
        status = 'waiting';
      } else {
        status = 'inactive';
      }
      return {
        jid,
        status,
        elapsedMs: state.startedAt ? now - state.startedAt : null,
        pendingMessages: state.pendingMessages,
        pendingTasks: state.pendingTasks.length,
      };
    });
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Count active agent processes but don't kill them — they'll finish on their own
    // via idle timeout or agent timeout.
    // This prevents reconnection restarts from killing working agents.
    const activeProcesses: string[] = [];
    for (const [, state] of this.groups) {
      if (state.process && !state.process.killed && state.processName) {
        activeProcesses.push(state.processName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedProcesses: activeProcesses },
      'GroupQueue shutting down (agent processes detached, not killed)',
    );
  }
}
