export const HOOK_PATH = '/bridgething-claude-usage';

interface CommandHook {
  type?: string;
  url?: string;
  timeout?: number;
  statusMessage?: string;
}

interface Matcher {
  matcher?: string;
  hooks?: CommandHook[];
}

interface Settings {
  hooks?: Record<string, Matcher[]>;
  [key: string]: unknown;
}

function settingsPath(dir: string): string {
  return `${dir}/settings.json`;
}

async function readSettings(path: string): Promise<Settings> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path)) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Settings) : {};
  } catch {
    return {};
  }
}

async function writeSettings(path: string, settings: Settings): Promise<void> {
  const scratch = `${path}.${crypto.randomUUID()}`;
  await Deno.writeTextFile(scratch, `${JSON.stringify(settings, null, 2)}\n`);
  await Deno.rename(scratch, path);
}

async function backupOnce(path: string): Promise<void> {
  const backup = `${path}.before-claude-usage`;
  try {
    await Deno.stat(backup);
    return;
  } catch {
    // no backup yet
  }
  try {
    await Deno.writeTextFile(backup, await Deno.readTextFile(path));
  } catch {
    // nothing to back up
  }
}

function ours(hook: CommandHook): boolean {
  return hook.type === 'http' && typeof hook.url === 'string' && hook.url.includes(HOOK_PATH);
}

function withoutOurs(matchers: Matcher[]): Matcher[] {
  return matchers
    .map(entry => ({ ...entry, hooks: (entry.hooks ?? []).filter(hook => !ours(hook)) }))
    .filter(entry => (entry.hooks ?? []).length > 0);
}

export function plan(settings: Settings, matcher: string, url: string, seconds: number): Settings {
  const hooks = { ...(settings.hooks ?? {}) };
  const preToolUse = withoutOurs(hooks.PreToolUse ?? []);
  preToolUse.push({
    matcher,
    hooks: [{ type: 'http', url, timeout: seconds, statusMessage: 'Asking the Car Thing...' }],
  });
  hooks.PreToolUse = preToolUse;
  return { ...settings, hooks };
}

export function unplan(settings: Settings): Settings {
  const hooks = { ...(settings.hooks ?? {}) };
  const preToolUse = withoutOurs(hooks.PreToolUse ?? []);
  if (preToolUse.length > 0) hooks.PreToolUse = preToolUse;
  else delete hooks.PreToolUse;
  if (Object.keys(hooks).length === 0) {
    const rest = { ...settings };
    delete rest.hooks;
    return rest;
  }
  return { ...settings, hooks };
}

export interface Applied {
  touched: string[];
  failed: { path: string; detail: string }[];
}

async function apply(dirs: string[], rewrite: (settings: Settings) => Settings, backup: boolean): Promise<Applied> {
  const result: Applied = { touched: [], failed: [] };
  for (const dir of dirs) {
    const path = settingsPath(dir);
    try {
      const settings = await readSettings(path);
      const next = rewrite(settings);
      if (JSON.stringify(next) === JSON.stringify(settings)) continue;
      if (backup) await backupOnce(path);
      await writeSettings(path, next);
      result.touched.push(path);
    } catch (err) {
      result.failed.push({ path, detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

export function install(dirs: string[], matcher: string, url: string, seconds: number): Promise<Applied> {
  return apply(dirs, settings => plan(settings, matcher, url, seconds), true);
}

export function uninstall(dirs: string[]): Promise<Applied> {
  return apply(dirs, unplan, false);
}
