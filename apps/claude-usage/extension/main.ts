import { asJson, defineExtension, json, type Device, type ExtensionContext } from '@bridgething/extension';

import type { AccountView, DiscoveredAccount, HookStatus, Pull, Push, StaleView } from '../shared/protocol.ts';
import { discover, displayName, projectsRoots, readCredential, readLabel, type Label } from './accounts.ts';
import { install, uninstall } from './hookconfig.ts';
import { PromptServer } from './prompts.ts';
import { needsRefresh, refreshCredential } from './refresh.ts';
import { ModelLimits } from './models.ts';
import { TranscriptScanner } from './transcripts.ts';
import { fetchUsage, UsageError, type UsageReading } from './usage.ts';

const DEFAULT_POLL_SECONDS = 120;
const SCAN_INTERVAL_MS = 15_000;
const LABEL_TTL_MS = 30 * 60 * 1000;
const KV_READINGS = 'usage.readings';
const DEFAULT_HOOK_PORT = 8791;
const DEFAULT_HOOK_SECONDS = 25;
const DEFAULT_HOOK_TOOLS = 'Bash|Write|Edit|NotebookEdit';

interface AccountSpec {
  dir: string;
  label?: string;
  refresh?: boolean;
}

interface Slot {
  spec: AccountSpec;
  label: Label | null;
  labelAt: number;
  plan: string | null;
  tier: string | null;
  reading: UsageReading | null;
  readingAt: number | null;
  stale: StaleView | null;
  retryAfter: number;
}

interface StoredReading {
  reading: UsageReading;
  at: number;
}

function parseSpecs(raw: string | undefined): AccountSpec[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(entry => entry as Partial<AccountSpec>)
      .filter((entry): entry is AccountSpec => typeof entry.dir === 'string' && entry.dir.length > 0)
      .map(entry => ({ dir: entry.dir, label: entry.label, refresh: entry.refresh === true }));
  } catch {
    return [];
  }
}

type Config = Readonly<Record<string, string>>;

function num(config: Config, key: string, fallback: number, min: number): number {
  const parsed = Number(config[key]);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function pollSeconds(config: Config): number {
  return num(config, 'pollSeconds', DEFAULT_POLL_SECONDS, 15);
}

interface HookSettings {
  enabled: boolean;
  port: number;
  seconds: number;
  tools: string;
}

function hookSettings(config: Config): HookSettings {
  return {
    enabled: config.hooks === 'true',
    port: num(config, 'hookPort', DEFAULT_HOOK_PORT, 1024),
    seconds: num(config, 'hookSeconds', DEFAULT_HOOK_SECONDS, 5),
    tools: config.hookTools?.trim() || DEFAULT_HOOK_TOOLS,
  };
}

function view(slot: Slot): AccountView {
  const reading = slot.reading;
  return {
    id: slot.spec.dir,
    dir: slot.spec.dir,
    label: slot.spec.label ?? slot.label?.email ?? displayName(slot.spec.dir),
    org: slot.label?.orgName ?? null,
    plan: slot.label?.subscriptionType ?? slot.plan,
    tier: slot.label?.tier ?? slot.tier,
    limits: reading?.limits ?? [],
    extra: reading?.extra ?? null,
    spend: reading?.spend ?? null,
    readingAt: slot.readingAt,
    stale: slot.stale,
    refreshEnabled: slot.spec.refresh === true,
  };
}

class Runner {
  private readonly slots = new Map<string, Slot>();
  private readonly scanner: TranscriptScanner;
  private readonly limits: ModelLimits;
  private usageTimer: ReturnType<typeof setInterval> | undefined;
  private scanTimer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private sharedBy: string[] = [];
  private readonly prompts: PromptServer;
  private hookInstalledIn: string[] = [];
  private hookWanted: HookSettings | null = null;
  private discovered: DiscoveredAccount[] = [];

  constructor(private readonly ctx: ExtensionContext) {
    this.scanner = new TranscriptScanner(ctx.kv, message => ctx.log.warn(message));
    this.limits = new ModelLimits(ctx.kv, message => ctx.log.warn(message));
    this.prompts = new PromptServer(
      () => this.pushPrompts(),
      () => this.ctx.devices.some(device => device.connected && device.active),
      message => this.ctx.log.debug(message),
    );
  }

  private send(push: Push, device?: Device): void {
    if (device) device.send(json(push));
    else this.ctx.broadcast(json(push));
  }

  private specs(): AccountSpec[] {
    this.rediscover();
    for (const device of this.ctx.devices) {
      const configured = parseSpecs(device.config.accounts);
      if (configured.length > 0) return configured;
    }
    return this.discovered.map(account => ({ dir: account.dir }));
  }

  private rediscover(): void {
    this.discovered = discover().map(account => ({ dir: account.dir, name: account.name }));
  }

  private settings(): Config {
    return this.ctx.devices[0]?.config ?? {};
  }

  private interval(): number {
    return pollSeconds(this.settings()) * 1000;
  }

  async start(): Promise<void> {
    await this.limits.ready();
    const stored = (await this.ctx.kv.get<Record<string, StoredReading>>(KV_READINGS)) ?? {};
    for (const spec of this.specs()) {
      const held = stored[spec.dir];
      this.slots.set(spec.dir, {
        spec,
        label: null,
        labelAt: 0,
        plan: null,
        tier: null,
        reading: held?.reading ?? null,
        readingAt: held?.at ?? null,
        stale: null,
        retryAfter: 0,
      });
    }
    this.pushAccounts();
    this.arm();
    void this.syncHook();
    void this.pollUsage();
    void this.pollTranscripts();
  }

  private async syncHook(): Promise<void> {
    const wanted = hookSettings(this.settings());
    const same = JSON.stringify(wanted) === JSON.stringify(this.hookWanted);
    if (same && wanted.enabled === this.prompts.listening) return;
    this.hookWanted = wanted;

    const dirs = [...this.slots.keys()];
    try {
      if (!wanted.enabled) {
        await this.prompts.stop();
        this.hookInstalledIn = [];
        const removed = await uninstall(dirs);
        if (removed.touched.length > 0) {
          this.ctx.log.info(`removed the PreToolUse hook from ${removed.touched.join(', ')}`);
        }
      } else {
        await this.prompts.stop();
        this.prompts.start(wanted.port, wanted.seconds);
        if (!this.prompts.listening) {
          this.ctx.log.error(`could not listen on 127.0.0.1:${wanted.port}: ${this.prompts.error}`);
          await uninstall(dirs);
          this.hookInstalledIn = [];
        } else {
          const applied = await install(dirs, wanted.tools, this.prompts.url(wanted.port), wanted.seconds);
          this.hookInstalledIn = applied.touched;
          for (const failure of applied.failed) {
            this.ctx.log.error(`could not write ${failure.path}: ${failure.detail}`);
          }
          this.ctx.log.info(`PreToolUse hook for ${wanted.tools} in ${applied.touched.join(', ') || 'nothing new'}`);
        }
      }
    } catch (err) {
      this.ctx.log.error(`hook sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.pushPrompts();
  }

  private hookStatus(): HookStatus {
    return {
      enabled: this.hookWanted?.enabled === true,
      listening: this.prompts.listening,
      holding: this.prompts.holding,
      installedIn: this.hookInstalledIn,
      error: this.prompts.error,
    };
  }

  pushPrompts(device?: Device): void {
    this.send({ t: 'prompts', at: Date.now(), prompts: this.prompts.queue(), hook: this.hookStatus() }, device);
  }

  present(): void {
    this.prompts.markPresent();
  }

  answer(id: string, decision: 'allow' | 'deny'): void {
    this.prompts.answer(id, decision);
  }

  private arm(): void {
    clearInterval(this.usageTimer);
    clearInterval(this.scanTimer);
    this.usageTimer = setInterval(() => void this.pollUsage(), this.interval());
    this.scanTimer = setInterval(() => void this.pollTranscripts(), SCAN_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    clearInterval(this.usageTimer);
    clearInterval(this.scanTimer);
    await this.prompts.stop();
  }

  reconfigure(): void {
    const wanted = this.specs();
    const keep = new Set(wanted.map(spec => spec.dir));
    for (const dir of [...this.slots.keys()]) if (!keep.has(dir)) this.slots.delete(dir);
    for (const spec of wanted) {
      const existing = this.slots.get(spec.dir);
      if (existing) existing.spec = spec;
      else
        this.slots.set(spec.dir, {
          spec,
          label: null,
          labelAt: 0,
          plan: null,
          tier: null,
          reading: null,
          readingAt: null,
          stale: null,
          retryAfter: 0,
        });
    }
    this.arm();
    void this.syncHook();
    void this.pollUsage();
  }

  pushAccounts(device?: Device): void {
    const accounts = [...this.slots.values()].map(view);
    this.send({ t: 'accounts', at: Date.now(), accounts, discovered: this.discovered, polling: this.polling }, device);
  }

  pushMachine(device?: Device): void {
    this.send({ t: 'machine', at: Date.now(), machine: this.scanner.machine(this.sharedBy) }, device);
  }

  pushSessions(device?: Device): void {
    const sessions = this.scanner.sessions(model => this.limits.limit(model));
    this.send({ t: 'sessions', at: Date.now(), sessions }, device);
  }

  pushAll(device?: Device): void {
    this.pushAccounts(device);
    this.pushMachine(device);
    this.pushSessions(device);
    this.pushPrompts(device);
  }

  private async primeLimits(): Promise<boolean> {
    const models = this.scanner.liveModels();
    if (models.length === 0) return false;
    for (const slot of this.slots.values()) {
      if (slot.stale) continue;
      const credential = await readCredential(slot.spec.dir);
      if (!credential || credential.expiresAt <= Date.now()) continue;
      return await this.limits.prime(models, credential.accessToken);
    }
    return false;
  }

  async pollUsage(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    this.rediscover();
    this.pushAccounts();
    try {
      await Promise.all([...this.slots.values()].map(slot => this.pollOne(slot)));
      const stored: Record<string, StoredReading> = {};
      for (const slot of this.slots.values()) {
        if (slot.reading && slot.readingAt) stored[slot.spec.dir] = { reading: slot.reading, at: slot.readingAt };
      }
      await this.ctx.kv.set(KV_READINGS, stored).catch(() => {});
    } finally {
      this.polling = false;
      this.pushAccounts();
    }
  }

  private async pollOne(slot: Slot): Promise<void> {
    const now = Date.now();
    if (now < slot.retryAfter) return;
    if (!slot.label || now - slot.labelAt > LABEL_TTL_MS) {
      slot.label = await readLabel(slot.spec.dir);
      slot.labelAt = now;
    }

    let credential = await readCredential(slot.spec.dir);
    if (!credential) {
      slot.stale = { reason: 'no-credential', detail: 'no token in the store', since: slot.readingAt ?? now };
      return;
    }
    slot.plan = credential.subscriptionType;
    slot.tier = credential.rateLimitTier;

    if (needsRefresh(credential)) {
      if (slot.spec.refresh) {
        const outcome = await refreshCredential(slot.spec.dir, this.ctx.dataDir);
        if (outcome.kind === 'refreshed' || outcome.kind === 'already-fresh') credential = outcome.credential;
        else if (outcome.kind === 'failed') this.ctx.log.warn(`refresh failed for ${slot.spec.dir}: ${outcome.detail}`);
      }
      if (credential.expiresAt <= Date.now()) {
        slot.stale = {
          reason: 'expired',
          detail: 'run claude in this account to refresh',
          since: slot.readingAt ?? now,
        };
        return;
      }
    }

    try {
      slot.reading = await fetchUsage(credential.accessToken);
      slot.readingAt = Date.now();
      slot.stale = null;
    } catch (err) {
      if (err instanceof UsageError && err.kind === 'rate-limited') {
        slot.retryAfter = Date.now() + err.retryAfterMs;
        return;
      }
      const reason = err instanceof UsageError && err.kind === 'unauthorized' ? 'unauthorized' : 'network';
      const detail = err instanceof Error ? err.message : String(err);
      slot.stale = { reason, detail, since: slot.readingAt ?? now };
    }
  }

  async pollTranscripts(): Promise<void> {
    const accounts = [...this.slots.values()].map(slot => ({
      dir: slot.spec.dir,
      name: slot.spec.label ?? displayName(slot.spec.dir),
      isDefault: false,
    }));
    const roots = projectsRoots(accounts);
    this.sharedBy = [...roots.values()].find(owners => owners.length > 1) ?? [];
    await this.scanner.scan([...roots.keys()], () => {
      this.pushMachine();
      this.pushSessions();
    });
    this.pushMachine();
    this.pushSessions();
    if (await this.primeLimits()) this.pushSessions();
  }
}

let runner: Runner | undefined;

defineExtension({
  start(ctx) {
    const active = new Runner(ctx);
    runner = active;

    ctx.on('device', event => {
      if (event.type === 'disconnected') return;
      if (event.device.active) active.pushAll(event.device);
    });

    ctx.on('message', (device, message) => {
      const pull = asJson<Pull>(message);
      if (!pull) return;
      if (pull.t === 'hello') active.pushAll(device);
      else if (pull.t === 'refresh') void active.pollUsage().then(() => void active.pollTranscripts());
      else if (pull.t === 'present') active.present();
      else if (pull.t === 'answer') active.answer(pull.id, pull.decision);
    });

    ctx.on('config', () => active.reconfigure());

    return active.start();
  },
  stop() {
    return runner?.stop();
  },
});
