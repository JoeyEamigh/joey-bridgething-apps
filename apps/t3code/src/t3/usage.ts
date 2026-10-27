import type {
  UsageBucket,
  UsageProviderKind,
  UsageSource,
  UsageSourceFingerprint,
  UsageSummary,
  UsageSummaryInput,
  UsageTokenTotals,
} from './contracts';

const USAGE_CONTRACT_VERSION = 6;
const USAGE_MERGE_COMPATIBLE_SINCE = 4;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const PROVIDER_ORDER: UsageProviderKind[] = ['codex', 'claude', 'grok', 'cursor', 'opencode', 'antigravity', 'pi'];
const KNOWN_PROVIDERS = new Set<string>(PROVIDER_ORDER);

const RANGE_DAYS = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 } as const;

export type UsageRange = keyof typeof RANGE_DAYS;

export type ProviderTotals = {
  provider: UsageProviderKind;
  costUsd: number;
  totalTokens: number;
  records: number;
  sessions: number;
  costShare: number;
  tokenShare: number;
};

export type ModelTotals = {
  model: string;
  provider: UsageProviderKind;
  costUsd: number;
  totalTokens: number;
  tokens: UsageTokenTotals;
  records: number;
  unpricedRecords: number;
  unpricedTokens: number;
  costShare: number;
  tokenShare: number;
};

export type PeriodProviderTotals = Map<UsageProviderKind, { costUsd: number; totalTokens: number }>;

export type DailyTotals = {
  day: string;
  costUsd: number;
  totalTokens: number;
  byProvider: PeriodProviderTotals;
};

export type HourlyTotals = {
  day: string;
  hourStart: string;
  costUsd: number;
  totalTokens: number;
  byProvider: PeriodProviderTotals;
};

export type CostQuality = {
  providerReportedShare: number;
  modelPricedShare: number;
  unpricedShare: number;
  cacheSavingsUsd: number;
};

export type CategoryCost = { input: number; cacheRead: number; cacheWrite: number; output: number; unsplit: number };

export type SpeedCost = { standard: number; fast: number; ultrafast: number; premium: number };

export type UsageContractMismatch = {
  summaryIndex: number;
  direction: 'serverBehind' | 'clientBehind';
  contractVersion: number;
};

export type UsageTotals = {
  costUsd: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  records: number;
  sessions: number;
  providers: ProviderTotals[];
  models: ModelTotals[];
  daily: DailyTotals[];
  hourly: HourlyTotals[];
  costQuality: CostQuality;
  categoryCost: CategoryCost;
  speedCost: SpeedCost;
};

export type MergedUsage = UsageTotals & {
  buckets: UsageBucket[];
  duplicateSources: string[];
  contributingSummaries: number[];
  contractMismatches: UsageContractMismatch[];
};

export type UsagePoint = { key: string; tokens: number; costUsd: number };

export type UsageView = {
  totalTokens: number;
  costUsd: number;
  cacheSavingsUsd: number;
  sessions: number;
  tokens: { uncachedInput: number; cachedInput: number; cacheWrite: number; output: number };
  cost: { input: number; cacheRead: number; cacheWrite: number; output: number; other: number };
  providers: Array<{ provider: string; tokens: number; costUsd: number; sessions: number }>;
  models: Array<{ model: string; provider: string; tokens: number; costUsd: number }>;
  series: UsagePoint[];
};

type IndexedSummary = { index: number; summary: UsageSummary };

type Contribution = { buckets: UsageBucket[]; sessionsByProvider: Map<UsageProviderKind, number> };

const CURRENCY = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const INTEGER = new Intl.NumberFormat('en-US');

export function formatUsd(value: number): string {
  return CURRENCY.format(value);
}

export function formatCount(value: number): string {
  return INTEGER.format(Math.round(value));
}

function trimDigits(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value.toFixed(digits).replace(/\.0+$/, '');
}

export function formatTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${trimDigits(value / 1e12)}T`;
  if (abs >= 1e9) return `${trimDigits(value / 1e9)}B`;
  if (abs >= 1e6) return `${trimDigits(value / 1e6)}M`;
  if (abs >= 1e3) return `${trimDigits(value / 1e3)}K`;
  return INTEGER.format(Math.round(value));
}

export function formatPercent(share: number, digits = 1): string {
  const percent = share * 100;
  const smallest = 10 ** -digits;
  if (percent > 0 && percent < smallest) return `<${smallest.toFixed(digits)}%`;
  return `${percent.toFixed(digits)}%`;
}

function dayFormatter(timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
}

export function makeWindow(range: UsageRange, nowMs: number, timeZone: string): UsageSummaryInput {
  let zone = timeZone || 'UTC';
  let format: Intl.DateTimeFormat;
  try {
    format = dayFormatter(zone);
  } catch {
    zone = 'UTC';
    format = dayFormatter(zone);
  }
  if (range === '24h') {
    const untilTimeMs = Math.floor(nowMs / 60_000) * 60_000;
    const sinceTime = new Date(untilTimeMs - 24 * HOUR_MS);
    const untilTime = new Date(untilTimeMs);
    return {
      sinceDay: format.format(sinceTime),
      untilDay: format.format(untilTime),
      timeZone: zone,
      resolution: 'hour',
      sinceTime: sinceTime.toISOString(),
      untilTime: untilTime.toISOString(),
    };
  }
  const untilDay = format.format(new Date(nowMs));
  const [year = 0, month = 1, dayOfMonth = 1] = untilDay.split('-').map(part => Number.parseInt(part, 10));
  const start = new Date(Date.UTC(year, month - 1, dayOfMonth - (RANGE_DAYS[range] - 1)));
  return { sinceDay: start.toISOString().slice(0, 10), untilDay, timeZone: zone, resolution: 'day' };
}

export function enumerateDays(sinceDay: string, untilDay: string): string[] {
  const days: string[] = [];
  const start = Date.parse(`${sinceDay}T00:00:00Z`);
  const end = Date.parse(`${untilDay}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return days;
  for (let cursor = start; cursor <= end; cursor += DAY_MS) days.push(new Date(cursor).toISOString().slice(0, 10));
  return days;
}

export function enumerateHourStarts(sinceTime: string, untilTime: string): string[] {
  const starts: string[] = [];
  const start = Date.parse(sinceTime);
  const end = Date.parse(untilTime);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return starts;
  for (let cursor = start; cursor < end; cursor += HOUR_MS) starts.push(new Date(cursor).toISOString());
  return starts;
}

function fingerprintKey(fingerprint: UsageSourceFingerprint): string {
  return [fingerprint.hostId, fingerprint.provider, fingerprint.resolvedHomePath, fingerprint.volumeId].join(' ');
}

function bucketsForSource(summary: UsageSummary, source: UsageSource): UsageBucket[] {
  const providerSources = summary.sources.filter(entry => entry.fingerprint.provider === source.fingerprint.provider);
  return summary.buckets.filter(
    bucket =>
      bucket.provider === source.fingerprint.provider &&
      (bucket.sourcePath === source.fingerprint.resolvedHomePath ||
        (bucket.sourcePath === undefined && providerSources.length === 1)),
  );
}

function bucketKey(bucket: UsageBucket): string {
  return JSON.stringify([bucket.day, bucket.hourStart ?? null, bucket.provider, bucket.model]);
}

function bucketTokens(bucket: UsageBucket): number {
  return (
    bucket.totals.uncachedInputTokens +
    bucket.totals.cachedInputTokens +
    bucket.totals.cacheCreationTokens +
    bucket.totals.outputTokens
  );
}

function claimSources(environments: IndexedSummary[]) {
  const ownerByFingerprint = new Map<string, number>();
  const ownerScanByFingerprint = new Map<string, { environment: IndexedSummary; source: UsageSource }>();
  const seenBucketKeysByFingerprint = new Map<string, Set<string>>();
  const supplementalBucketsByEnvironment = new Map<number, Set<UsageBucket>>();
  const sessionsByFingerprint = new Map<string, number>();
  const duplicates: string[] = [];
  const ordered = [...environments].sort(
    (a, b) => (Date.parse(b.summary.readAt) || 0) - (Date.parse(a.summary.readAt) || 0) || a.index - b.index,
  );
  for (const status of ['ok', 'partial', 'failed'] as const) {
    for (const environment of ordered) {
      for (const source of environment.summary.sources) {
        if (source.status !== status) continue;
        const key = fingerprintKey(source.fingerprint);
        if (ownerByFingerprint.has(key)) {
          duplicates.push(source.fingerprint.resolvedHomePath);
          continue;
        }
        ownerByFingerprint.set(key, environment.index);
        ownerScanByFingerprint.set(key, { environment, source });
        sessionsByFingerprint.set(key, source.distinctSessions);
      }
    }
  }
  for (const environment of ordered) {
    for (const source of environment.summary.sources) {
      if (source.status !== 'partial') continue;
      const key = fingerprintKey(source.fingerprint);
      const owner = ownerScanByFingerprint.get(key);
      if (
        owner?.source.status !== 'ok' ||
        Date.parse(environment.summary.readAt) <= Date.parse(owner.environment.summary.readAt)
      ) {
        continue;
      }
      let seen = seenBucketKeysByFingerprint.get(key);
      if (seen === undefined) {
        seen = new Set(bucketsForSource(owner.environment.summary, owner.source).map(bucketKey));
        seenBucketKeysByFingerprint.set(key, seen);
      }
      const supplemental = supplementalBucketsByEnvironment.get(environment.index) ?? new Set<UsageBucket>();
      let added = false;
      for (const bucket of bucketsForSource(environment.summary, source)) {
        const cell = bucketKey(bucket);
        if (seen.has(cell)) continue;
        seen.add(cell);
        supplemental.add(bucket);
        added = true;
      }
      if (!added) continue;
      supplementalBucketsByEnvironment.set(environment.index, supplemental);
      sessionsByFingerprint.set(key, Math.max(sessionsByFingerprint.get(key) ?? 0, source.distinctSessions));
    }
  }
  return { ownerByFingerprint, supplementalBucketsByEnvironment, sessionsByFingerprint, duplicates };
}

function ownedContribution(
  environment: IndexedSummary,
  ownerByFingerprint: Map<string, number>,
  supplementalBuckets: Set<UsageBucket>,
  sessionsByFingerprint: Map<string, number>,
): Contribution {
  const ownedProviders = new Set<UsageProviderKind>();
  const ownedSources = new Set<string>();
  const sessionsByProvider = new Map<UsageProviderKind, number>();
  for (const source of environment.summary.sources) {
    if (source.status === 'missing') continue;
    const key = fingerprintKey(source.fingerprint);
    if (ownerByFingerprint.get(key) !== environment.index) continue;
    const provider = source.fingerprint.provider;
    ownedProviders.add(provider);
    ownedSources.add(`${provider}\u0000${source.fingerprint.resolvedHomePath}`);
    sessionsByProvider.set(
      provider,
      (sessionsByProvider.get(provider) ?? 0) + (sessionsByFingerprint.get(key) ?? source.distinctSessions),
    );
  }
  return {
    buckets: environment.summary.buckets.filter(
      bucket =>
        supplementalBuckets.has(bucket) ||
        (bucket.sourcePath === undefined
          ? ownedProviders.has(bucket.provider)
          : ownedSources.has(`${bucket.provider}\u0000${bucket.sourcePath}`)),
    ),
    sessionsByProvider,
  };
}

function emptyPeriodTotals(): { costUsd: number; totalTokens: number; byProvider: PeriodProviderTotals } {
  return { costUsd: 0, totalTokens: 0, byProvider: new Map() };
}

function addToPeriod(
  period: { costUsd: number; totalTokens: number; byProvider: PeriodProviderTotals },
  bucket: UsageBucket,
  tokens: number,
) {
  period.costUsd += bucket.costUsd;
  period.totalTokens += tokens;
  const provider = period.byProvider.get(bucket.provider) ?? { costUsd: 0, totalTokens: 0 };
  provider.costUsd += bucket.costUsd;
  provider.totalTokens += tokens;
  period.byProvider.set(bucket.provider, provider);
}

function summarize(contributions: Contribution[]): UsageTotals {
  let costUsd = 0;
  let uncachedInputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let records = 0;
  let sessions = 0;
  let cacheSavingsUsd = 0;
  let providerReportedRecords = 0;
  let unpricedRecords = 0;
  const categoryCost = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const speedCost = { fast: 0, ultrafast: 0, premium: 0 };
  const providerAccumulator = new Map<
    UsageProviderKind,
    { costUsd: number; totalTokens: number; records: number; sessions: number }
  >();
  const modelAccumulator = new Map<string, Omit<ModelTotals, 'model' | 'costShare' | 'tokenShare'>>();
  const dailyAccumulator = new Map<string, ReturnType<typeof emptyPeriodTotals>>();
  const hourlyAccumulator = new Map<string, HourlyTotals>();
  const providerEntry = (provider: UsageProviderKind) => {
    const entry = providerAccumulator.get(provider) ?? { costUsd: 0, totalTokens: 0, records: 0, sessions: 0 };
    providerAccumulator.set(provider, entry);
    return entry;
  };

  for (const { buckets, sessionsByProvider } of contributions) {
    for (const [provider, providerSessions] of sessionsByProvider) {
      sessions += providerSessions;
      if (providerSessions === 0) continue;
      providerEntry(provider).sessions += providerSessions;
    }
    for (const bucket of buckets) {
      const tokens = bucketTokens(bucket);
      costUsd += bucket.costUsd;
      cacheSavingsUsd += bucket.cacheSavingsUsd;
      uncachedInputTokens += bucket.totals.uncachedInputTokens;
      cachedInputTokens += bucket.totals.cachedInputTokens;
      cacheCreationTokens += bucket.totals.cacheCreationTokens;
      outputTokens += bucket.totals.outputTokens;
      reasoningTokens += bucket.totals.reasoningTokens;
      records += bucket.records;
      unpricedRecords += bucket.unpricedRecords;
      if (bucket.costSource === 'providerReported') providerReportedRecords += bucket.records;
      if (bucket.categoryCostUsd !== undefined) {
        categoryCost.input += bucket.categoryCostUsd.input;
        categoryCost.cacheRead += bucket.categoryCostUsd.cacheRead;
        categoryCost.cacheWrite += bucket.categoryCostUsd.cacheWrite;
        categoryCost.output += bucket.categoryCostUsd.output;
      }
      speedCost.fast += bucket.fastCostUsd ?? 0;
      speedCost.ultrafast += bucket.ultrafastCostUsd ?? 0;
      speedCost.premium += bucket.speedPremiumUsd ?? 0;

      const provider = providerEntry(bucket.provider);
      provider.costUsd += bucket.costUsd;
      provider.totalTokens += tokens;
      provider.records += bucket.records;

      const modelKey = `${bucket.provider} ${bucket.model}`;
      const model = modelAccumulator.get(modelKey) ?? {
        provider: bucket.provider,
        costUsd: 0,
        totalTokens: 0,
        tokens: {
          uncachedInputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
        records: 0,
        unpricedRecords: 0,
        unpricedTokens: 0,
      };
      model.costUsd += bucket.costUsd;
      model.totalTokens += tokens;
      model.tokens = {
        uncachedInputTokens: model.tokens.uncachedInputTokens + bucket.totals.uncachedInputTokens,
        cachedInputTokens: model.tokens.cachedInputTokens + bucket.totals.cachedInputTokens,
        cacheCreationTokens: model.tokens.cacheCreationTokens + bucket.totals.cacheCreationTokens,
        outputTokens: model.tokens.outputTokens + bucket.totals.outputTokens,
        reasoningTokens: model.tokens.reasoningTokens + bucket.totals.reasoningTokens,
      };
      model.records += bucket.records;
      model.unpricedRecords += bucket.unpricedRecords;
      if (bucket.records > 0) model.unpricedTokens += (tokens * bucket.unpricedRecords) / bucket.records;
      modelAccumulator.set(modelKey, model);

      const day = dailyAccumulator.get(bucket.day) ?? emptyPeriodTotals();
      addToPeriod(day, bucket, tokens);
      dailyAccumulator.set(bucket.day, day);

      if (bucket.hourStart !== undefined) {
        const hour = hourlyAccumulator.get(bucket.hourStart) ?? {
          day: bucket.day,
          hourStart: bucket.hourStart,
          ...emptyPeriodTotals(),
        };
        addToPeriod(hour, bucket, tokens);
        hourlyAccumulator.set(bucket.hourStart, hour);
      }
    }
  }

  const totalTokens = uncachedInputTokens + cachedInputTokens + cacheCreationTokens + outputTokens;
  const costShare = (value: number) => (costUsd === 0 ? 0 : value / costUsd);
  const tokenShare = (value: number) => (totalTokens === 0 ? 0 : value / totalTokens);
  return {
    costUsd,
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    records,
    sessions,
    providers: [...providerAccumulator]
      .map(([provider, totals]) => ({
        provider,
        ...totals,
        costShare: costShare(totals.costUsd),
        tokenShare: tokenShare(totals.totalTokens),
      }))
      .sort((a, b) => b.costUsd - a.costUsd),
    models: [...modelAccumulator]
      .map(([key, totals]) => ({
        model: key.slice(key.indexOf(' ') + 1),
        ...totals,
        costShare: costShare(totals.costUsd),
        tokenShare: tokenShare(totals.totalTokens),
      }))
      .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens),
    daily: [...dailyAccumulator]
      .map(([day, totals]) => ({ day, ...totals }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    hourly: [...hourlyAccumulator.values()].sort((a, b) => a.hourStart.localeCompare(b.hourStart)),
    costQuality: {
      providerReportedShare: records === 0 ? 0 : providerReportedRecords / records,
      unpricedShare: records === 0 ? 0 : unpricedRecords / records,
      modelPricedShare: records === 0 ? 0 : (records - providerReportedRecords - unpricedRecords) / records,
      cacheSavingsUsd,
    },
    categoryCost: {
      ...categoryCost,
      unsplit: Math.max(
        0,
        costUsd - categoryCost.input - categoryCost.cacheRead - categoryCost.cacheWrite - categoryCost.output,
      ),
    },
    speedCost: { ...speedCost, standard: Math.max(0, costUsd - speedCost.fast - speedCost.ultrafast) },
  };
}

function withKnownProviders(summary: UsageSummary): UsageSummary {
  return {
    ...summary,
    buckets: summary.buckets.filter(bucket => KNOWN_PROVIDERS.has(bucket.provider)),
    sources: summary.sources.filter(source => KNOWN_PROVIDERS.has(source.fingerprint.provider)),
  };
}

export function mergeSummaries(summaries: UsageSummary[]): MergedUsage {
  const current: IndexedSummary[] = [];
  const contractMismatches: UsageContractMismatch[] = [];
  summaries.forEach((summary, index) => {
    const version = summary.contractVersion;
    if (version >= USAGE_MERGE_COMPATIBLE_SINCE && version <= USAGE_CONTRACT_VERSION) {
      current.push({ index, summary: withKnownProviders(summary) });
    } else {
      contractMismatches.push({
        summaryIndex: index,
        direction: version < USAGE_CONTRACT_VERSION ? 'serverBehind' : 'clientBehind',
        contractVersion: version,
      });
    }
  });
  const { ownerByFingerprint, supplementalBucketsByEnvironment, sessionsByFingerprint, duplicates } =
    claimSources(current);
  const contributingSummaries: number[] = [];
  const contributions = current.map(environment => {
    const contribution = ownedContribution(
      environment,
      ownerByFingerprint,
      supplementalBucketsByEnvironment.get(environment.index) ?? new Set(),
      sessionsByFingerprint,
    );
    if (contribution.buckets.length > 0) contributingSummaries.push(environment.index);
    return contribution;
  });
  return {
    ...summarize(contributions),
    buckets: contributions.flatMap(contribution => contribution.buckets),
    duplicateSources: duplicates,
    contributingSummaries,
    contractMismatches,
  };
}

function periodContribution(buckets: UsageBucket[], key: string, hourly: boolean): Contribution {
  const selected = buckets.filter(bucket => (hourly ? bucket.hourStart === key : bucket.day === key));
  const peakBySource = new Map<string, { provider: UsageProviderKind; sessions: number }>();
  for (const bucket of selected) {
    const sourceKey = `${bucket.provider}\u0000${bucket.sourcePath ?? ''}`;
    const peak = peakBySource.get(sourceKey);
    if (!peak || bucket.sessions > peak.sessions) {
      peakBySource.set(sourceKey, { provider: bucket.provider, sessions: bucket.sessions });
    }
  }
  const sessionsByProvider = new Map<UsageProviderKind, number>();
  for (const { provider, sessions } of peakBySource.values()) {
    sessionsByProvider.set(provider, (sessionsByProvider.get(provider) ?? 0) + sessions);
  }
  return { buckets: selected, sessionsByProvider };
}

export function buildUsageView(merged: MergedUsage, input: UsageSummaryInput, selectedKey?: string): UsageView {
  const hourly = input.resolution === 'hour';
  const totals =
    selectedKey === undefined ? merged : summarize([periodContribution(merged.buckets, selectedKey, hourly)]);
  const periods = hourly
    ? input.sinceTime === undefined || input.untilTime === undefined
      ? []
      : enumerateHourStarts(input.sinceTime, input.untilTime)
    : enumerateDays(input.sinceDay, input.untilDay);
  const byPeriod = new Map<string, { costUsd: number; totalTokens: number }>(
    hourly ? merged.hourly.map(entry => [entry.hourStart, entry]) : merged.daily.map(entry => [entry.day, entry]),
  );
  const active = new Set(
    totals.providers.filter(entry => entry.totalTokens > 0 || entry.costUsd > 0).map(entry => entry.provider),
  );
  const unsplit = totals.categoryCost.unsplit;
  return {
    totalTokens: totals.totalTokens,
    costUsd: totals.costUsd,
    cacheSavingsUsd: totals.costQuality.cacheSavingsUsd,
    sessions: totals.sessions,
    tokens: {
      uncachedInput: totals.uncachedInputTokens,
      cachedInput: totals.cachedInputTokens,
      cacheWrite: totals.cacheCreationTokens,
      output: totals.outputTokens,
    },
    cost: {
      input: totals.categoryCost.input,
      cacheRead: totals.categoryCost.cacheRead,
      cacheWrite: totals.categoryCost.cacheWrite,
      output: totals.categoryCost.output,
      other: unsplit >= 0.005 ? unsplit : 0,
    },
    providers: PROVIDER_ORDER.filter(provider => active.has(provider)).map(provider => {
      const entry = totals.providers.find(candidate => candidate.provider === provider)!;
      return { provider, tokens: entry.totalTokens, costUsd: entry.costUsd, sessions: entry.sessions };
    }),
    models: totals.models.map(model => ({
      model: model.model,
      provider: model.provider,
      tokens: model.totalTokens,
      costUsd: model.costUsd,
    })),
    series: periods.map(key => {
      const period = byPeriod.get(key);
      return { key, tokens: period?.totalTokens ?? 0, costUsd: period?.costUsd ?? 0 };
    }),
  };
}
