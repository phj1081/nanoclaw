/**
 * OAuth Token Auto-Refresh for Claude Code
 *
 * Periodically checks ~/.claude/.credentials.json and refreshes
 * the access token before it expires. This solves the known issue
 * where Claude Code CLI fails to auto-refresh in headless environments.
 *
 * Endpoint and client_id extracted from Claude Code CLI binary.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const FALLBACK_TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const DEFAULT_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
];

// Check every 5 minutes, refresh if within 30 minutes of expiry
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const REFRESH_BEFORE_EXPIRY_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

interface CredentialsFile {
  claudeAiOauth: OAuthCredentials;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

function getCredentialsPath(): string {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

function readCredentials(): CredentialsFile | null {
  const credsPath = getCredentialsPath();
  try {
    if (!fs.existsSync(credsPath)) return null;
    return JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
  } catch (err) {
    logger.warn({ err }, 'Failed to read Claude credentials');
    return null;
  }
}

function writeCredentials(creds: CredentialsFile): void {
  const credsPath = getCredentialsPath();
  const tempPath = `${credsPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, credsPath);
}

async function refreshToken(
  refreshTokenStr: string,
  scopes: string[],
): Promise<TokenResponse> {
  const body = JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: refreshTokenStr,
    client_id: CLIENT_ID,
    scope: (scopes.length > 0 ? scopes : DEFAULT_SCOPES).join(' '),
  });

  const headers = { 'Content-Type': 'application/json' };

  // Try primary endpoint first, then fallback
  for (const url of [TOKEN_URL, FALLBACK_TOKEN_URL]) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (res.status === 200) {
        return (await res.json()) as TokenResponse;
      }

      const errText = await res.text().catch(() => '');
      logger.warn(
        { url, status: res.status, body: errText.slice(0, 200) },
        'Token refresh failed at endpoint',
      );
    } catch (err) {
      logger.warn(
        { url, err: err instanceof Error ? err.message : String(err) },
        'Token refresh request error',
      );
    }
  }

  throw new Error('Token refresh failed on all endpoints');
}

async function checkAndRefresh(): Promise<void> {
  const creds = readCredentials();
  if (!creds?.claudeAiOauth) return;

  const { expiresAt, refreshToken: rt } = creds.claudeAiOauth;
  if (!rt) {
    logger.debug('No refresh token in credentials, skipping');
    return;
  }

  const now = Date.now();
  const remaining = expiresAt - now;

  if (remaining > REFRESH_BEFORE_EXPIRY_MS) {
    logger.debug(
      { remainingMin: Math.round(remaining / 60000) },
      'Token still valid, no refresh needed',
    );
    return;
  }

  const isExpired = remaining <= 0;
  logger.info(
    { remainingMin: Math.round(remaining / 60000), isExpired },
    'Refreshing Claude OAuth token',
  );

  try {
    const response = await refreshToken(
      rt,
      creds.claudeAiOauth.scopes || DEFAULT_SCOPES,
    );

    creds.claudeAiOauth.accessToken = response.access_token;
    creds.claudeAiOauth.refreshToken = response.refresh_token || rt;
    creds.claudeAiOauth.expiresAt = now + response.expires_in * 1000;

    if (response.scope) {
      creds.claudeAiOauth.scopes = response.scope.split(' ');
    }

    writeCredentials(creds);

    const newExpiryMin = Math.round(response.expires_in / 60);
    logger.info(
      { expiresInMin: newExpiryMin },
      'Claude OAuth token refreshed successfully',
    );
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to refresh Claude OAuth token — manual re-login may be required',
    );
  }
}

let refreshInterval: ReturnType<typeof setInterval> | null = null;

export function startTokenRefreshLoop(): void {
  // Only run if credentials file exists (skip for API key-only setups)
  const creds = readCredentials();
  if (!creds?.claudeAiOauth) {
    logger.info('No OAuth credentials found, token refresh disabled');
    return;
  }

  logger.info(
    { checkIntervalMin: CHECK_INTERVAL_MS / 60000 },
    'Token auto-refresh started',
  );

  // Check immediately on startup
  checkAndRefresh().catch((err) =>
    logger.error({ err }, 'Initial token refresh check failed'),
  );

  refreshInterval = setInterval(() => {
    checkAndRefresh().catch((err) =>
      logger.error({ err }, 'Token refresh check failed'),
    );
  }, CHECK_INTERVAL_MS);
}

export function stopTokenRefreshLoop(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}
