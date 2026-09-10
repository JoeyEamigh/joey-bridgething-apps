import type { BridgethingClient, NetFetchReply } from '@bridgething/client';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { emptyDay, isAiCategory, parseDays, parseProfile, type Connection, type Profile, type Report } from './model';

type Snapshot = { version: 1; account: string; profile: Profile | null; reports: [string, Report][] };

export class WakapiRepository {
  profile: Profile | null = null;
  cacheError = false;
  private reports = new Map<string, Report>();
  private flights = new Map<string, Promise<Report>>();
  private retries = new Map<string, { at: number; failures: number; error: Error }>();
  private persistence: Promise<void> = Promise.resolve();
  private account: string;
  private hydration: Promise<void> | null = null;
  private profileFlight: Promise<Profile> | null = null;

  constructor(
    private client: BridgethingClient,
    private connection: Connection,
  ) {
    this.account = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(connection))));
  }

  key(start: string, end: string, project = ''): string {
    return JSON.stringify([start, end, project]);
  }
  cached(start: string, end: string, project = ''): Report | null {
    return this.reports.get(this.key(start, end, project)) ?? null;
  }

  hydrate(): Promise<void> {
    this.hydration ??= this.readCache();
    return this.hydration;
  }

  private async readCache(): Promise<void> {
    try {
      const result = await this.client.store.get({ key: `summaries-${this.account}` });
      if (!result.ok) throw new Error('Storage unavailable');
      if (!result.response.value) return;
      const saved = JSON.parse(result.response.value) as Snapshot;
      if (saved.version !== 1 || saved.account !== this.account) return;
      if (saved.profile?.timezone) {
        new Intl.DateTimeFormat('en-US', { timeZone: saved.profile.timezone }).format();
        this.profile = saved.profile;
      }
      if (
        Array.isArray(saved.reports) &&
        saved.reports.every(([key, report]) => typeof key === 'string' && validReport(report))
      )
        this.reports = new Map(saved.reports);
    } catch {
      this.cacheError = true;
    }
  }

  private persist(): void {
    const saved: Snapshot = { version: 1, account: this.account, profile: this.profile, reports: [...this.reports] };
    while (JSON.stringify(saved).length > 450_000 && saved.reports.length > 0) saved.reports.shift();
    const value = JSON.stringify(saved);
    this.persistence = this.persistence.then(async () => {
      try {
        const result = await this.client.store.put({ key: `summaries-${this.account}`, value });
        this.cacheError = !result.ok;
      } catch {
        this.cacheError = true;
      }
    });
  }

  private async json(path: string): Promise<unknown> {
    let reply;
    try {
      reply = await this.client.net.fetch(
        {
          request: {
            url: `${this.connection.server}/api/compat/wakatime/v1/users/current${path}`,
            method: 'GET',
            headers: [{ name: 'Authorization', value: `Basic ${btoa(this.connection.apiKey)}` }],
            body: null,
            timeoutMs: 20_000,
            redirect: 'error',
          },
        },
        { timeoutMs: 25_000 },
      );
    } catch {
      throw new Error('Cannot reach the companion. Reconnect and try again.');
    }
    if (!reply.ok) throw new Error('Cannot reach Wakapi through the companion.');
    const response = (reply.response as NetFetchReply).response;
    if (response.status === 401 || response.status === 403)
      throw new Error('Wakapi rejected the API key. Check companion settings.');
    if (response.status === 429) throw new Error('Wakapi is rate limiting requests. Retrying shortly.');
    if (response.status !== 200) throw new Error(`Wakapi returned HTTP ${response.status}. Check the server URL.`);
    try {
      return JSON.parse(new TextDecoder().decode(new Uint8Array(response.body as unknown as number[])));
    } catch {
      throw new Error('The server did not return JSON. Check the Wakapi server URL.');
    }
  }

  refreshProfile(): Promise<Profile> {
    this.profileFlight ??= (async () => {
      await this.hydrate();
      this.profile = parseProfile(await this.json(''));
      this.persist();
      return this.profile;
    })().finally(() => {
      this.profileFlight = null;
    });
    return this.profileFlight;
  }

  async load(start: string, end: string, project = '', force = false): Promise<Report> {
    const key = this.key(start, end, project);
    const running = this.flights.get(key);
    if (running) return running;
    const retry = this.retries.get(key);
    if (!force && retry && Date.now() < retry.at) throw retry.error;
    const task = this.fetchReport(start, end, project)
      .then(report => {
        this.retries.delete(key);
        this.reports.delete(key);
        this.reports.set(key, report);
        while (this.reports.size > 12) this.reports.delete(this.reports.keys().next().value!);
        this.persist();
        return report;
      })
      .catch((error: Error) => {
        const failures = (retry?.failures ?? 0) + 1;
        this.retries.set(key, { failures, error, at: Date.now() + Math.min(300_000, 15_000 * 2 ** (failures - 1)) });
        throw error;
      })
      .finally(() => this.flights.delete(key));
    this.flights.set(key, task);
    return task;
  }

  private async fetchReport(start: string, end: string, project: string): Promise<Report> {
    if (!this.profile) throw new Error('Waiting for the Wakapi account.');
    const previous = this.cached(start, end, project);
    const updateLastDay = previous && Date.now() - previous.historyFetchedAt < 900_000;
    const requestStart = updateLastDay ? end : start;
    const query = new URLSearchParams({ start: requestStart, end, timezone: this.profile.timezone });
    if (project) query.set('project', project);
    const all = parseDays(await this.json(`/summaries?${query}`), requestStart, end, this.profile.timezone);
    let ai = all.map(day => emptyDay(day.date));
    if (all.some(day => day.categories.some(row => isAiCategory(row.name) && row.seconds > 0))) {
      query.set('category', 'ai coding');
      ai = parseDays(await this.json(`/summaries?${query}`), requestStart, end, this.profile.timezone);
      if (ai.some(day => day.categories.some(row => !isAiCategory(row.name) && row.seconds > 0))) {
        throw new Error('This server does not support Wakapi category filters.');
      }
    }
    return {
      all: updateLastDay ? [...previous.all.filter(day => day.date !== end), ...all] : all,
      ai: updateLastDay ? [...previous.ai.filter(day => day.date !== end), ...ai] : ai,
      fetchedAt: Date.now(),
      historyFetchedAt: updateLastDay ? previous.historyFetchedAt : Date.now(),
    };
  }
}

function validReport(report: Report): boolean {
  if (
    !report ||
    !Number.isFinite(report.fetchedAt) ||
    !Number.isFinite(report.historyFetchedAt) ||
    !Array.isArray(report.all) ||
    !Array.isArray(report.ai)
  )
    return false;
  if (!report.all.length || report.all.length !== report.ai.length) return false;
  return [...report.all, ...report.ai].every(
    day =>
      typeof day.date === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(day.date) &&
      Number.isFinite(day.seconds) &&
      day.seconds >= 0 &&
      ['projects', 'categories', 'editors', 'languages', 'machines', 'operating_systems', 'branches', 'entities'].every(
        key =>
          Array.isArray(day[key as keyof typeof day]) &&
          (day[key as keyof typeof day] as { name: string; seconds: number }[]).every(
            row => typeof row.name === 'string' && Number.isFinite(row.seconds) && row.seconds >= 0,
          ),
      ),
  );
}
