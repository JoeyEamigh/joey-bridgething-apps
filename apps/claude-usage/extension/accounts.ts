const DEFAULT_SERVICE = 'Claude Code-credentials';

export interface Credential {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshTokenExpiresAt: number | null;
  scopes: string[];
  subscriptionType: string | null;
  rateLimitTier: string | null;
}

export interface Label {
  email: string;
  orgName: string | null;
  subscriptionType: string | null;
  tier: string | null;
}

export interface Account {
  dir: string;
  name: string;
  isDefault: boolean;
}

interface CredentialFile {
  claudeAiOauth?: Partial<Credential>;
}

export function home(): string {
  const dir = Deno.env.get('HOME') ?? Deno.env.get('USERPROFILE');
  if (!dir) throw new Error('no HOME in the environment');
  return dir.replace(/[/\\]+$/, '');
}

export function defaultConfigDir(): string {
  return `${home()}/.claude`;
}

async function shortHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 8);
}

export async function keychainService(dir: string): Promise<string> {
  const path = dir.replace(/\/+$/, '');
  return path === defaultConfigDir() ? DEFAULT_SERVICE : `${DEFAULT_SERVICE}-${await shortHash(path)}`;
}

async function capture(bin: string, args: string[]): Promise<string | null> {
  try {
    const out = await new Deno.Command(bin, { args, stdout: 'piped', stderr: 'null' }).output();
    return out.success ? new TextDecoder().decode(out.stdout).trim() : null;
  } catch {
    return null;
  }
}

function parseCredential(raw: string): Credential | null {
  let parsed: CredentialFile;
  try {
    parsed = JSON.parse(raw) as CredentialFile;
  } catch {
    return null;
  }
  const oauth = parsed.claudeAiOauth;
  if (!oauth?.accessToken || !oauth.refreshToken || typeof oauth.expiresAt !== 'number') return null;
  return {
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
    refreshTokenExpiresAt: oauth.refreshTokenExpiresAt ?? null,
    scopes: oauth.scopes ?? [],
    subscriptionType: oauth.subscriptionType ?? null,
    rateLimitTier: oauth.rateLimitTier ?? null,
  };
}

export async function readCredential(dir: string): Promise<Credential | null> {
  if (Deno.build.os === 'darwin') {
    const raw = await capture('security', ['find-generic-password', '-s', await keychainService(dir), '-w']);
    return raw ? parseCredential(raw) : null;
  }
  try {
    return parseCredential(await Deno.readTextFile(`${dir}/.credentials.json`));
  } catch {
    return null;
  }
}

export async function writeCredential(dir: string, credential: Credential): Promise<void> {
  const payload = JSON.stringify({ claudeAiOauth: credential });
  if (Deno.build.os === 'darwin') {
    const service = await keychainService(dir);
    const result = await new Deno.Command('security', {
      args: ['add-generic-password', '-U', '-s', service, '-a', service, '-w', payload],
      stdout: 'null',
      stderr: 'piped',
    }).output();
    if (!result.success) throw new Error(new TextDecoder().decode(result.stderr).trim() || 'keychain write failed');
    return;
  }
  const target = `${dir}/.credentials.json`;
  const scratch = `${target}.${crypto.randomUUID()}`;
  await Deno.writeTextFile(scratch, payload, { mode: 0o600 });
  await Deno.rename(scratch, target);
}

function isConfigDir(path: string): boolean {
  for (const marker of ['.claude.json', 'projects']) {
    try {
      Deno.statSync(`${path}/${marker}`);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

export function displayName(dir: string): string {
  const base = dir.slice(dir.lastIndexOf('/') + 1);
  return base === '.claude' ? 'default' : base.replace(/^\.claude-?/, '') || base;
}

export function discover(): Account[] {
  const root = home();
  const fallback = defaultConfigDir();
  const found: Account[] = [];
  try {
    for (const entry of Deno.readDirSync(root)) {
      if (!entry.name.startsWith('.claude')) continue;
      const path = `${root}/${entry.name}`;
      if (!entry.isDirectory && !entry.isSymlink) continue;
      if (!isConfigDir(path)) continue;
      found.push({ dir: path, name: displayName(path), isDefault: path === fallback });
    }
  } catch {
    if (isConfigDir(fallback)) found.push({ dir: fallback, name: 'default', isDefault: true });
  }
  found.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.dir.localeCompare(b.dir));
  return found;
}

interface StoredAccount {
  emailAddress?: string;
  organizationName?: string;
  organizationType?: string;
  organizationRateLimitTier?: string;
  displayName?: string;
}

function configFilePaths(dir: string): string[] {
  return dir === defaultConfigDir() ? [`${home()}/.claude.json`, `${dir}/.claude.json`] : [`${dir}/.claude.json`];
}

export async function readLabel(dir: string): Promise<Label | null> {
  for (const path of configFilePaths(dir)) {
    let parsed: { oauthAccount?: StoredAccount };
    try {
      parsed = JSON.parse(await Deno.readTextFile(path)) as { oauthAccount?: StoredAccount };
    } catch {
      continue;
    }
    const account = parsed.oauthAccount;
    if (!account?.emailAddress) continue;
    return {
      email: account.emailAddress,
      orgName: account.organizationName ?? null,
      subscriptionType: account.organizationType?.replace(/^claude_/, '') ?? null,
      tier: account.organizationRateLimitTier ?? null,
    };
  }
  return null;
}

export function projectsRoots(accounts: Account[]): Map<string, string[]> {
  const byReal = new Map<string, string[]>();
  for (const account of accounts) {
    let real: string;
    try {
      real = Deno.realPathSync(`${account.dir}/projects`);
    } catch {
      continue;
    }
    const owners = byReal.get(real) ?? [];
    owners.push(account.name);
    byReal.set(real, owners);
  }
  return byReal;
}
