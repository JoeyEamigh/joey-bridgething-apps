import type { BridgethingClient } from '@bridgething/client';
import { relayJwt, SignedOutError, type Account } from './connect/clerk';
import { DpopKey, uuid, type StoredKey } from './connect/dpop';
import { EnvironmentLink, type LinkStatus } from './connect/environment';
import { phoneHttp } from './connect/http';
import { Relay, type EnvironmentSession, type RelayEnvironment, type RelayToken } from './connect/relay';
import type { RpcSocket } from './connect/rpc';
import { live, type ConfigEvent } from './model/rows';
import { compareAttention, projectAttention, type Attention } from './t3/attention';
import type { ThreadShellRow, UsageLimitSourceSnapshot, UsageSummary, UsageSummaryInput } from './t3/contracts';
import {
  collectLimitAccounts,
  collectLimitPools,
  type LimitAccount,
  type LimitPool,
  type NativeLimitReport,
} from './t3/limits';
import { buildUsageView, makeWindow, mergeSummaries, type UsageRange, type UsageView } from './t3/usage';

type ProjectInfo = { title: string };

const CACHE_VERSION = 4;

type SavedSessions = { relay: RelayToken | null; environments: Record<string, EnvironmentSession> };

type EnvCache = {
  version: number;
  id: string;
  label: string;
  onlineAt: number | null;
  shell: { sequence: number | null; projects: Record<string, ProjectInfo>; rows: Record<string, ThreadShellRow> };
  limits: { sources: UsageLimitSourceSnapshot[]; native: NativeLimitReport[] } | null;
  usage: Partial<Record<UsageRange, { input: UsageSummaryInput; summary: UsageSummary; fetchedAt: number }>>;
};

export type QuestionOption = { label: string; value: string };
export type RequestDetail =
  | { type: 'approval'; kind: string; text: string | null; command: string | null }
  | { type: 'input'; questions: Array<{ id: string; text: string; options: QuestionOption[]; multi: boolean }> };

export type InboxItem = {
  key: string;
  envId: string;
  envLabel: string;
  envOnline: boolean;
  threadId: string;
  title: string;
  repo: string | null;
  branch: string | null;
  pr: { number: number; checks: string | null } | null;
  attention: Attention;
  runMs: number | null;
  error: string | null;
  resumesAt: number | null;
  detail: RequestDetail | null;
};

export type WorkingItem = {
  key: string;
  envLabel: string;
  envOnline: boolean;
  title: string;
  repo: string | null;
  branch: string | null;
  since: number;
  waiting: boolean;
  background: string | null;
};

const TASK_NAMES: Record<string, [string, string]> = {
  subagent: ['agent', 'agents'],
  command: ['command', 'commands'],
  monitor: ['monitor', 'monitors'],
  background_task: ['task', 'tasks'],
};

function backgroundSummary(row: ThreadShellRow): string | null {
  const counts = new Map<string, number>();
  for (const task of row.pendingBackgroundTasks ?? []) counts.set(task.kind, (counts.get(task.kind) ?? 0) + 1);
  if (!counts.size) return null;
  return Object.keys(TASK_NAMES)
    .filter(kind => counts.has(kind))
    .map(kind => `${counts.get(kind)} ${TASK_NAMES[kind]![counts.get(kind) === 1 ? 0 : 1]}`)
    .join(', ');
}

export type EnvState = { id: string; label: string; status: LinkStatus; onlineAt: number | null };

export type HubState = {
  phase: 'starting' | 'signed-out' | 'ready';
  error: string | null;
  environments: EnvState[];
  inbox: InboxItem[];
  working: WorkingItem[];
  limits: { pools: LimitPool[]; accounts: LimitAccount[] };
  range: UsageRange;
  usage: UsageView | null;
  usageInput: UsageSummaryInput;
  usageLoading: boolean;
  busy: Record<string, boolean>;
  now: number;
};

export const RANGES: UsageRange[] = ['24h', '7d', '30d', '90d'];
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const ACCOUNT_KEY = 'account';

function emptyCache(env: { id: string; label: string }): EnvCache {
  return {
    version: CACHE_VERSION,
    id: env.id,
    label: env.label,
    onlineAt: null,
    shell: { sequence: null, projects: {}, rows: {} },
    limits: null,
    usage: {},
  };
}

function repoName(project: any): string {
  const identity = project?.repositoryIdentity;
  const name = identity?.displayName;
  if (name && identity?.owner && !name.includes('/')) return `${identity.owner}/${name}`;
  return name ?? project?.title ?? '';
}

function detailOf(item: any): RequestDetail | null {
  if (!item) return null;
  if (item.type === 'approval_request') {
    return { type: 'approval', kind: item.requestKind, text: item.prompt ?? item.reason ?? null, command: null };
  }
  if (item.type === 'user_input_request') {
    return {
      type: 'input',
      questions: (item.questions ?? []).map((question: any) => ({
        id: question.id,
        text: question.question,
        multi: question.multiSelect === true,
        options: (question.options ?? []).map((option: any) => ({
          label: option.label,
          value: option.value ?? option.label,
        })),
      })),
    };
  }
  return null;
}

export class Hub {
  private readonly listeners = new Set<() => void>();
  private caches = new Map<string, EnvCache>();
  private links = new Map<string, EnvironmentLink>();
  private details = new Map<string, RequestDetail | null>();
  private statuses = new Map<string, LinkStatus>();
  private subscriptions = new Map<string, Array<() => void>>();
  private relay: Relay | null = null;
  private account: Account | null = null;
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private usageTimer: ReturnType<typeof setInterval> | null = null;
  private listTimer: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private saved: { key: string; value: SavedSessions } | null = null;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private loads = 0;
  private merged: ReturnType<typeof mergeSummaries> | null = null;
  private state: HubState;

  constructor(private readonly client: BridgethingClient) {
    const now = Date.now();
    this.state = {
      phase: 'starting',
      error: null,
      environments: [],
      inbox: [],
      working: [],
      limits: { pools: [], accounts: [] },
      range: '7d',
      usage: null,
      usageInput: makeWindow('7d', now, TIME_ZONE),
      usageLoading: false,
      busy: {},
      now,
    };
    setInterval(() => this.recompute(), 30_000);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): HubState => this.state;

  private emit(patch: Partial<HubState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private async storeGet<T>(key: string): Promise<T | null> {
    const result = await this.client.store.get({ key }).catch(() => null);
    if (!result?.ok || typeof result.response.value !== 'string') return null;
    try {
      return JSON.parse(result.response.value) as T;
    } catch {
      return null;
    }
  }

  private storePut(key: string, value: unknown): void {
    void this.client.store.put({ key, value: JSON.stringify(value) }).catch(() => undefined);
  }

  private persist(id: string): void {
    clearTimeout(this.saveTimers.get(id));
    this.saveTimers.set(
      id,
      setTimeout(() => {
        const cache = this.caches.get(id);
        if (cache) this.storePut(`env:${id}`, cache);
      }, 2_000),
    );
  }

  async configure(config: Record<string, string>): Promise<void> {
    const generation = ++this.generation;
    this.teardown();
    let account: Account | null = null;
    try {
      const parsed = JSON.parse(config[ACCOUNT_KEY] || 'null');
      if (parsed?.client && parsed?.session) account = parsed;
    } catch {
      account = null;
    }
    const known = (await this.storeGet<RelayEnvironment[]>('environments')) ?? [];
    for (const env of known) {
      if (this.caches.has(env.id)) continue;
      const stored = await this.storeGet<EnvCache>(`env:${env.id}`);
      this.caches.set(env.id, stored?.version === CACHE_VERSION ? stored : emptyCache(env));
    }
    if (generation !== this.generation) return;
    if (!account) {
      this.emit({ phase: 'signed-out', error: null });
      this.recompute();
      return;
    }
    const rotated = await this.storeGet<{ session: string; client: string }>('clerk-client');
    this.account = rotated?.session === account.session ? { ...account, client: rotated.client } : account;
    let stored = await this.storeGet<StoredKey>('dpop-key');
    if (!stored) {
      stored = DpopKey.generate();
      this.storePut('dpop-key', stored);
    }
    let deviceId = await this.storeGet<string>('device-id');
    if (!deviceId) {
      deviceId = `carthing-${uuid()}`;
      this.storePut('device-id', deviceId);
    }
    const key = DpopKey.load(stored);
    const sessionsKey = `sessions:${account.session}`;
    const saved = (await this.storeGet<SavedSessions>(sessionsKey)) ?? { relay: null, environments: {} };
    if (generation !== this.generation) return;
    this.saved = { key: sessionsKey, value: saved };
    this.relay = new Relay(
      () => this.mintJwt(),
      key,
      deviceId,
      saved.relay,
      token => {
        saved.relay = token;
        this.storePut(sessionsKey, saved);
      },
    );
    this.emit({ phase: 'ready', error: null });
    for (const env of known) if (env.base) this.ensureLink(env);
    this.recompute();
    void this.refreshEnvironments();
    this.listTimer = setInterval(() => void this.refreshEnvironments(), 15 * 60_000);
    this.usageTimer = setInterval(() => void this.refreshUsage(), 2 * 60_000);
  }

  private async mintJwt(): Promise<string> {
    if (!this.account) throw new SignedOutError();
    const minted = await relayJwt(phoneHttp(this.client), this.account);
    if (minted.client !== this.account.client) {
      this.account = { ...this.account, client: minted.client };
      this.storePut('clerk-client', { session: this.account.session, client: minted.client });
    }
    return minted.jwt;
  }

  private ensureLink(env: RelayEnvironment): void {
    const relay = this.relay;
    if (!relay || this.links.has(env.id)) return;
    const saved = this.saved;
    const link = new EnvironmentLink(
      env,
      relay,
      {
        status: status => {
          this.statuses.set(env.id, status);
          this.recompute();
        },
        ready: socket => this.attach(env.id, socket),
        signedOut: () => this.signedOut(),
        session: session => {
          if (!saved) return;
          saved.value.environments[env.id] = session;
          this.storePut(saved.key, saved.value);
        },
      },
      saved?.value.environments[env.id] ?? null,
    );
    this.links.set(env.id, link);
    link.start();
  }

  private teardown(): void {
    for (const link of this.links.values()) link.stop();
    this.links.clear();
    for (const stops of this.subscriptions.values()) for (const stop of stops) stop();
    this.subscriptions.clear();
    if (this.usageTimer) clearInterval(this.usageTimer);
    if (this.listTimer) clearInterval(this.listTimer);
    this.usageTimer = null;
    this.listTimer = null;
    this.relay = null;
    this.saved = null;
  }

  private signedOut(): void {
    this.teardown();
    this.emit({ phase: 'signed-out', error: null });
  }

  private async refreshEnvironments(): Promise<void> {
    const relay = this.relay;
    if (!relay) return;
    let envs: RelayEnvironment[];
    try {
      envs = await relay.environments();
    } catch (error) {
      if (error instanceof SignedOutError) this.signedOut();
      else this.emit({ error: (error as Error).message });
      return;
    }
    if (relay !== this.relay) return;
    this.storePut('environments', envs);
    for (const env of envs) {
      const cache = this.caches.get(env.id) ?? emptyCache(env);
      cache.label = env.label;
      this.caches.set(env.id, cache);
      const existing = this.links.get(env.id);
      if (existing && existing.env.base !== env.base) {
        existing.stop();
        this.links.delete(env.id);
      }
      this.ensureLink(env);
    }
    for (const id of [...this.caches.keys()]) {
      if (envs.some(env => env.id === id)) continue;
      this.caches.delete(id);
      this.links.get(id)?.stop();
      this.links.delete(id);
    }
    this.emit({ error: null });
    this.recompute();
  }

  private attach(envId: string, socket: RpcSocket): void {
    for (const stop of this.subscriptions.get(envId) ?? []) stop();
    const cache = this.caches.get(envId);
    if (!cache) return;
    cache.onlineAt = Date.now();
    let authoritative = false;
    const stopShell = socket.stream<any>(
      'orchestration.subscribeShell',
      cache.shell.sequence === null ? {} : { afterSequence: cache.shell.sequence },
      item =>
        this.applyShell(
          envId,
          item,
          () => authoritative,
          value => (authoritative = value),
        ),
      () => {
        if (socket.isOpen) socket.close();
      },
    );
    const stopConfig = socket.stream<any>(
      'subscribeServerConfig',
      { usageLimitSources: true },
      (event: ConfigEvent) => this.applyConfig(envId, event),
      () => {
        if (socket.isOpen) socket.close();
      },
    );
    this.subscriptions.set(envId, [stopShell, stopConfig]);
    socket.onClose(() => {
      const current = this.caches.get(envId);
      if (current) current.onlineAt = Date.now();
      this.persist(envId);
      this.recompute();
    });
    void this.prefetchUsage(envId, socket);
    this.recompute();
  }

  private applyShell(envId: string, item: any, wasAuthoritative: () => boolean, mark: (value: boolean) => void): void {
    const cache = this.caches.get(envId);
    if (!cache) return;
    const now = Date.now();
    const shell = cache.shell;
    if (item.kind === 'snapshot') {
      const snapshot = item.snapshot;
      const projects: Record<string, ProjectInfo> =
        item.resolvedRepositoryIdentityRoots === undefined ? {} : shell.projects;
      for (const project of snapshot.projects ?? []) projects[project.id] = { title: repoName(project) };
      if (item.resolvedRepositoryIdentityRoots === undefined) {
        const rows: Record<string, ThreadShellRow> = {};
        for (const row of snapshot.threads ?? []) rows[row.id] = row;
        cache.shell = { sequence: snapshot.snapshotSequence, projects, rows };
        mark(true);
      } else {
        shell.projects = projects;
        if (!wasAuthoritative() && shell.sequence !== null)
          shell.sequence = Math.max(shell.sequence, snapshot.snapshotSequence);
      }
    } else if (item.kind === 'project.updated') {
      shell.projects[item.project.id] = { title: repoName(item.project) };
      shell.sequence = Math.max(shell.sequence ?? 0, item.sequence);
    } else if (item.kind === 'project.removed') {
      delete shell.projects[item.projectId];
      shell.sequence = Math.max(shell.sequence ?? 0, item.sequence);
    } else if (item.kind === 'thread.updated') {
      shell.rows[item.thread.id] = item.thread;
      shell.sequence = Math.max(shell.sequence ?? 0, item.sequence);
    } else if (item.kind === 'thread.removed') {
      delete shell.rows[item.threadId];
      shell.sequence = Math.max(shell.sequence ?? 0, item.sequence);
    } else {
      return;
    }
    cache.onlineAt = now;
    this.persist(envId);
    this.recompute();
  }

  private applyConfig(envId: string, event: ConfigEvent): void {
    const cache = this.caches.get(envId);
    if (!cache) return;
    const limits = cache.limits ?? { sources: [], native: [] };
    if (event.type === 'native') limits.native = event.native;
    else if (event.type === 'sources') limits.sources = event.sources as UsageLimitSourceSnapshot[];
    else return;
    cache.limits = limits;
    cache.onlineAt = Date.now();
    this.persist(envId);
    this.recompute();
  }

  setRange(range: UsageRange): void {
    const input = makeWindow(range, Date.now(), TIME_ZONE);
    this.emit({ range, usageInput: input });
    this.recompute();
    void this.refreshUsage();
  }

  refreshUsage(): Promise<void> {
    const range = this.state.range;
    return Promise.all(
      [...this.links.entries()].map(([envId, link]) =>
        link.rpc ? this.fetchUsage(envId, link.rpc, range) : undefined,
      ),
    ).then(() => undefined);
  }

  private async prefetchUsage(envId: string, socket: RpcSocket): Promise<void> {
    const current = this.state.range;
    for (const range of [current, ...RANGES.filter(other => other !== current)]) {
      if (!socket.isOpen) return;
      await this.fetchUsage(envId, socket, range);
    }
  }

  private async fetchUsage(envId: string, socket: RpcSocket, range: UsageRange): Promise<void> {
    const input = makeWindow(range, Date.now(), TIME_ZONE);
    const store = (summary: UsageSummary) => {
      const cache = this.caches.get(envId);
      if (!cache) return;
      cache.usage[range] = { input, summary, fetchedAt: Date.now() };
      cache.onlineAt = Date.now();
      this.persist(envId);
      this.recompute();
    };
    this.loads += 1;
    this.emit({ usageLoading: true });
    try {
      const summary = await socket.request<UsageSummary & { refreshing?: boolean }>('server.getUsageSummary', input);
      store(summary);
      if (summary.refreshing) {
        store(await socket.request('server.getUsageSummary', { ...input, awaitRefresh: true }, 90_000));
      }
    } catch {
      return;
    } finally {
      this.loads -= 1;
      this.emit({ usageLoading: this.loads > 0 });
    }
  }

  async ensureDetail(item: InboxItem): Promise<void> {
    const requestId = item.attention.requestId;
    if (!requestId || this.details.has(item.key)) return;
    const socket = this.links.get(item.envId)?.rpc;
    if (!socket) return;
    this.details.set(item.key, null);
    try {
      const result = await socket.request<{ item: unknown }>('orchestration.getTurnItem', {
        threadId: item.threadId,
        itemId: `turn-item:runtime-request:${encodeURIComponent(requestId)}`,
      });
      const detail = detailOf(result.item);
      const tool = /:native-request:([^:]+):/.exec(requestId)?.[1];
      if (detail?.type === 'approval' && detail.kind === 'command' && tool) {
        const call = await socket
          .request<{ item: { type?: string; input?: string } | null }>('orchestration.getTurnItem', {
            threadId: item.threadId,
            itemId: `turn-item:provider:claudeAgent:native-item:${tool}`,
          })
          .catch(() => null);
        if (call?.item?.type === 'command_execution' && call.item.input) detail.command = call.item.input;
      }
      this.details.set(item.key, detail);
    } catch {
      this.details.delete(item.key);
    }
    this.recompute();
  }

  private async dispatch(item: InboxItem, command: Record<string, unknown>): Promise<boolean> {
    const socket = this.links.get(item.envId)?.rpc;
    if (!socket) {
      this.emit({ error: `${item.envLabel} is offline.` });
      return false;
    }
    this.emit({ busy: { ...this.state.busy, [item.key]: true } });
    try {
      await socket.request('orchestration.dispatchCommand', {
        commandId: uuid(),
        threadId: item.threadId,
        ...command,
      });
      this.emit({ error: null });
      return true;
    } catch (error) {
      this.emit({ error: (error as Error).message });
      return false;
    } finally {
      const busy = { ...this.state.busy };
      delete busy[item.key];
      this.emit({ busy });
    }
  }

  approve(item: InboxItem, accept: boolean): Promise<boolean> {
    return this.dispatch(item, {
      type: 'runtime-request.respond',
      requestId: item.attention.requestId,
      decision: accept ? 'accept' : 'decline',
    });
  }

  answer(item: InboxItem, answers: Record<string, string | string[]>): Promise<boolean> {
    return this.dispatch(item, { type: 'runtime-request.respond', requestId: item.attention.requestId, answers });
  }

  async answerStep(item: InboxItem, picked: string[], value: string): Promise<string[] | null> {
    if (item.detail?.type !== 'input') return null;
    const next = [...picked, value];
    const questions = item.detail.questions;
    if (next.length < questions.length) return next;
    const answers = Object.fromEntries(
      questions.map((question, index) => [question.id, question.multi ? [next[index]!] : next[index]!]),
    );
    return (await this.answer(item, answers)) ? [] : picked;
  }

  settle(item: InboxItem): Promise<boolean> {
    return this.dispatch(item, { type: 'thread.settle' });
  }

  snooze(item: InboxItem, ms: number): Promise<boolean> {
    return this.dispatch(item, { type: 'thread.snooze', snoozedUntil: new Date(Date.now() + ms).toISOString() });
  }

  usageFor(key: string): UsageView | null {
    return this.merged ? buildUsageView(this.merged, this.state.usageInput, key) : null;
  }

  retry(): void {
    for (const link of this.links.values()) link.retryNow();
    if (this.relay && this.links.size === 0) void this.refreshEnvironments();
  }

  private recompute(): void {
    if (this.rebuildTimer) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.rebuild();
    }, 150);
  }

  private rebuild(): void {
    const now = Date.now();
    const environments: EnvState[] = [...this.caches.values()]
      .map(cache => ({
        id: cache.id,
        label: cache.label,
        status: this.statuses.get(cache.id) ?? 'connecting',
        onlineAt: cache.onlineAt,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const online = new Set(environments.filter(env => env.status === 'online').map(env => env.id));

    const inbox: InboxItem[] = [];
    for (const cache of this.caches.values()) {
      for (const row of Object.values(cache.shell.rows)) {
        const attention = projectAttention(row, now);
        if (!attention) continue;
        const key = `${cache.id}:${row.id}:${attention.requestId ?? attention.kind}`;
        const pr = (row.pullRequests ?? [])[0] as any;
        const started = row.latestRunStartedAt ? Date.parse(row.latestRunStartedAt) : null;
        const completed = row.latestRunCompletedAt ? Date.parse(row.latestRunCompletedAt) : null;
        inbox.push({
          key,
          envId: cache.id,
          envLabel: cache.label,
          envOnline: online.has(cache.id),
          threadId: row.id,
          title: row.title,
          repo: cache.shell.projects[row.projectId]?.title ?? null,
          branch: row.branch ?? null,
          pr: pr ? { number: pr.number ?? pr.snapshot?.number, checks: pr.snapshot?.checksState ?? null } : null,
          attention,
          runMs: started && completed && completed > started ? completed - started : null,
          error: typeof row.lastError === 'string' ? row.lastError.split('\n')[0]! : null,
          resumesAt: row.usageLimitResetAt ? Date.parse(row.usageLimitResetAt) : null,
          detail: this.details.get(key) ?? null,
        });
      }
    }
    inbox.sort((a, b) => compareAttention(a.attention, b.attention));

    const working: WorkingItem[] = [];
    for (const cache of this.caches.values()) {
      for (const row of Object.values(cache.shell.rows).filter(live)) {
        if (row.lineage.relationshipToParent === 'subagent' || projectAttention(row, now)) continue;
        working.push({
          key: `${cache.id}:${row.id}`,
          envLabel: cache.label,
          envOnline: online.has(cache.id),
          title: row.title,
          repo: cache.shell.projects[row.projectId]?.title ?? null,
          branch: row.branch ?? null,
          since: Date.parse(row.activityRunStartedAt ?? row.latestRunCompletedAt ?? row.updatedAt),
          waiting: row.activityRunStatus !== 'running',
          background: backgroundSummary(row),
        });
      }
    }
    working.sort((a, b) => a.since - b.since);

    const accounts = collectLimitAccounts(
      [...this.caches.values()]
        .filter(cache => cache.limits)
        .map(cache => ({ environment: cache.label, sources: cache.limits!.sources, native: cache.limits!.native })),
    );
    const pools = collectLimitPools(accounts, now);

    const range = this.state.range;
    const input = makeWindow(range, now, TIME_ZONE);
    const summaries = [...this.caches.values()].flatMap(cache =>
      cache.usage[range] ? [cache.usage[range]!.summary] : [],
    );
    this.merged = summaries.length ? mergeSummaries(summaries) : null;
    const usage = this.merged ? buildUsageView(this.merged, input) : null;

    this.emit({ environments, inbox, working, limits: { pools, accounts }, usage, usageInput: input, now });
  }
}

export const ACCOUNT_CONFIG_KEY = ACCOUNT_KEY;
