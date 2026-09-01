import { readCredential, writeCredential, type Credential } from './accounts.ts';

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

const MARGIN_MS = 60_000;
const LOCK_STALE_MS = 30_000;

export function needsRefresh(credential: Credential, now = Date.now()): boolean {
  return credential.expiresAt - now <= MARGIN_MS;
}

export function refreshTokenUsable(credential: Credential, now = Date.now()): boolean {
  return credential.refreshTokenExpiresAt === null || credential.refreshTokenExpiresAt > now;
}

async function lockName(dir: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(dir));
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12);
}

async function acquire(path: string): Promise<boolean> {
  try {
    const file = await Deno.open(path, { createNew: true, write: true });
    file.close();
    return true;
  } catch {
    try {
      const info = await Deno.stat(path);
      const age = Date.now() - (info.mtime?.getTime() ?? 0);
      if (age < LOCK_STALE_MS) return false;
      await Deno.remove(path);
    } catch {
      return false;
    }
    return acquire(path);
  }
}

async function release(path: string): Promise<void> {
  await Deno.remove(path).catch(() => {});
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

export type RefreshOutcome =
  | { kind: 'refreshed'; credential: Credential }
  | { kind: 'already-fresh'; credential: Credential }
  | { kind: 'busy' }
  | { kind: 'failed'; detail: string };

export async function refreshCredential(dir: string, lockDir: string): Promise<RefreshOutcome> {
  const lock = `${lockDir}/refresh-${await lockName(dir)}.lock`;
  if (!(await acquire(lock))) return { kind: 'busy' };
  try {
    const current = await readCredential(dir);
    if (!current) return { kind: 'failed', detail: 'no credential in the store' };
    if (!needsRefresh(current)) return { kind: 'already-fresh', credential: current };
    if (!refreshTokenUsable(current)) return { kind: 'failed', detail: 'refresh token has expired' };

    let response: Response;
    try {
      response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: current.refreshToken,
          client_id: CLIENT_ID,
        }),
      });
    } catch (err) {
      return { kind: 'failed', detail: err instanceof Error ? err.message : String(err) };
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return { kind: 'failed', detail: detail.slice(0, 200) || `http ${response.status}` };
    }

    const body = (await response.json()) as TokenResponse;
    if (!body.access_token || !body.refresh_token || typeof body.expires_in !== 'number') {
      return { kind: 'failed', detail: 'token response was missing half the pair' };
    }

    const rotated: Credential = {
      ...current,
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + body.expires_in * 1000,
    };
    await writeCredential(dir, rotated);
    return { kind: 'refreshed', credential: rotated };
  } finally {
    await release(lock);
  }
}
