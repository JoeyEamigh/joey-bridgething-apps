import { describe, expect, test } from 'bun:test';

import type { UsageBucket, UsageSource, UsageSummary } from '../src/t3/contracts';
import { buildUsageView, formatTokens, formatUsd, makeWindow, mergeSummaries } from '../src/t3/usage';

function bucket(
  day: string,
  provider: UsageBucket['provider'],
  model: string,
  extra: Partial<UsageBucket> = {},
): UsageBucket {
  return {
    day,
    provider,
    model,
    sourcePath: `/home/${provider}`,
    totals: {
      uncachedInputTokens: 10,
      cachedInputTokens: 20,
      cacheCreationTokens: 30,
      outputTokens: 40,
      reasoningTokens: 15,
    },
    costUsd: 1,
    cacheSavingsUsd: 0.5,
    categoryCostUsd: { input: 0.1, cacheRead: 0.2, cacheWrite: 0.3, output: 0.39 },
    costSource: 'modelPriced',
    records: 2,
    unpricedRecords: 0,
    sessions: 1,
    ...extra,
  };
}

function source(
  provider: UsageSource['fingerprint']['provider'],
  distinctSessions: number,
  extra: Partial<UsageSource> = {},
): UsageSource {
  return {
    fingerprint: { hostId: 'host-a', provider, resolvedHomePath: `/home/${provider}`, volumeId: '1:2' },
    status: 'ok',
    scannedFiles: 1,
    skippedFiles: 0,
    malformedRecords: 0,
    distinctSessions,
    message: null,
    ...extra,
  };
}

function summary(buckets: UsageBucket[], sources: UsageSource[], extra: Partial<UsageSummary> = {}): UsageSummary {
  return {
    contractVersion: 6,
    readAt: '2030-03-07T12:00:00.000Z',
    timeZone: 'UTC',
    sinceDay: '2030-03-01',
    untilDay: '2030-03-07',
    buckets,
    sources,
    pricing: { status: 'fresh', source: 'test', fetchedAt: null, knownModels: 1 },
    scanDurationMs: 1,
    ...extra,
  };
}

describe('makeWindow', () => {
  test('day ranges end on the local calendar day', () => {
    const now = Date.parse('2030-03-07T03:00:00.000Z');
    expect(makeWindow('7d', now, 'America/New_York')).toEqual({
      sinceDay: '2030-02-28',
      untilDay: '2030-03-06',
      timeZone: 'America/New_York',
      resolution: 'day',
    });
    expect(makeWindow('30d', now, 'UTC').sinceDay).toBe('2030-02-06');
    expect(makeWindow('90d', now, 'UTC').sinceDay).toBe('2029-12-08');
  });

  test('day ranges count calendar days across a dst change', () => {
    const now = Date.parse('2030-03-12T04:30:00.000Z');
    expect(makeWindow('7d', now, 'America/New_York')).toMatchObject({ sinceDay: '2030-03-06', untilDay: '2030-03-12' });
  });

  test('24h is a rolling hourly window floored to the minute', () => {
    const now = Date.parse('2030-03-07T10:15:42.123Z');
    expect(makeWindow('24h', now, 'UTC')).toEqual({
      sinceDay: '2030-03-06',
      untilDay: '2030-03-07',
      timeZone: 'UTC',
      resolution: 'hour',
      sinceTime: '2030-03-06T10:15:00.000Z',
      untilTime: '2030-03-07T10:15:00.000Z',
    });
  });

  test('an unknown zone falls back to utc', () => {
    expect(makeWindow('7d', Date.parse('2030-03-07T03:00:00.000Z'), 'Not/AZone').timeZone).toBe('UTC');
  });
});

describe('mergeSummaries', () => {
  test('counts a shared transcript directory once, owned by the newest read', () => {
    const older = summary([bucket('2030-03-06', 'claude', 'opus', { costUsd: 5 })], [source('claude', 3)], {
      readAt: '2030-03-07T11:00:00.000Z',
    });
    const newer = summary([bucket('2030-03-06', 'claude', 'opus', { costUsd: 7 })], [source('claude', 4)]);
    const merged = mergeSummaries([older, newer]);
    expect(merged.costUsd).toBe(7);
    expect(merged.sessions).toBe(4);
    expect(merged.duplicateSources).toEqual(['/home/claude']);
    expect(merged.contributingSummaries).toEqual([1]);
  });

  test('distinct volumes on the same host and path both count', () => {
    const first = summary([bucket('2030-03-06', 'claude', 'opus')], [source('claude', 2)]);
    const second = summary(
      [bucket('2030-03-06', 'claude', 'opus')],
      [{ ...source('claude', 3), fingerprint: { ...source('claude', 3).fingerprint, volumeId: '9:9' } }],
    );
    const merged = mergeSummaries([first, second]);
    expect(merged.costUsd).toBe(2);
    expect(merged.sessions).toBe(5);
  });

  test('a newer partial scan adds only cells the complete scan lacks', () => {
    const complete = summary([bucket('2030-03-06', 'claude', 'opus', { costUsd: 5 })], [source('claude', 3)], {
      readAt: '2030-03-07T11:00:00.000Z',
    });
    const partial = summary(
      [bucket('2030-03-06', 'claude', 'opus', { costUsd: 9 }), bucket('2030-03-07', 'claude', 'opus', { costUsd: 2 })],
      [source('claude', 6, { status: 'partial' })],
    );
    const merged = mergeSummaries([complete, partial]);
    expect(merged.costUsd).toBe(7);
    expect(merged.sessions).toBe(6);
  });

  test('excludes incompatible contract versions and unknown providers', () => {
    const merged = mergeSummaries([
      summary([bucket('2030-03-06', 'claude', 'opus')], [source('claude', 1)], { contractVersion: 3 }),
      summary(
        [bucket('2030-03-06', 'codex', 'gpt'), bucket('2030-03-06', 'future' as 'codex', 'x')],
        [source('codex', 1), source('future' as 'codex', 1)],
      ),
    ]);
    expect(merged.contractMismatches).toEqual([{ summaryIndex: 0, direction: 'serverBehind', contractVersion: 3 }]);
    expect(merged.costUsd).toBe(1);
    expect(merged.providers.map(entry => entry.provider)).toEqual(['codex']);
  });

  test('total tokens leave reasoning out and sessions come from sources', () => {
    const merged = mergeSummaries([
      summary(
        [
          bucket('2030-03-06', 'claude', 'opus', { sessions: 5 }),
          bucket('2030-03-06', 'claude', 'haiku', { sessions: 5 }),
        ],
        [source('claude', 3)],
      ),
    ]);
    expect(merged.totalTokens).toBe(200);
    expect(merged.reasoningTokens).toBe(30);
    expect(merged.sessions).toBe(3);
  });
});

describe('buildUsageView', () => {
  const input = makeWindow('7d', Date.parse('2030-03-07T12:00:00.000Z'), 'UTC');
  const merged = mergeSummaries([
    summary(
      [
        bucket('2030-03-02', 'claude', 'opus', { costUsd: 3, sessions: 4 }),
        bucket('2030-03-02', 'claude', 'haiku', { costUsd: 0.5, categoryCostUsd: undefined, sessions: 2 }),
        bucket('2030-03-05', 'codex', 'gpt', { costUsd: 2, sessions: 1 }),
      ],
      [source('claude', 5), source('codex', 1)],
    ),
  ]);

  test('totals, breakdowns and a zero-filled series for the whole window', () => {
    const view = buildUsageView(merged, input);
    expect(view.totalTokens).toBe(300);
    expect(view.costUsd).toBe(5.5);
    expect(view.cacheSavingsUsd).toBe(1.5);
    expect(view.sessions).toBe(6);
    expect(view.tokens).toEqual({ uncachedInput: 30, cachedInput: 60, cacheWrite: 90, output: 120 });
    expect(view.cost.input).toBeCloseTo(0.2);
    expect(view.cost.other).toBeCloseTo(5.5 - 1.98);
    expect(view.providers).toEqual([
      { provider: 'codex', tokens: 100, costUsd: 2, sessions: 1 },
      { provider: 'claude', tokens: 200, costUsd: 3.5, sessions: 5 },
    ]);
    expect(view.models.map(model => model.model)).toEqual(['opus', 'gpt', 'haiku']);
    expect(view.series.map(point => point.key)).toEqual([
      '2030-03-01',
      '2030-03-02',
      '2030-03-03',
      '2030-03-04',
      '2030-03-05',
      '2030-03-06',
      '2030-03-07',
    ]);
    expect(view.series[1]).toEqual({ key: '2030-03-02', tokens: 200, costUsd: 3.5 });
    expect(view.series[0]).toEqual({ key: '2030-03-01', tokens: 0, costUsd: 0 });
  });

  test('a selected day narrows everything but the series', () => {
    const view = buildUsageView(merged, input, '2030-03-02');
    expect(view.costUsd).toBe(3.5);
    expect(view.totalTokens).toBe(200);
    expect(view.sessions).toBe(4);
    expect(view.providers.map(entry => entry.provider)).toEqual(['claude']);
    expect(view.models.map(model => model.model)).toEqual(['opus', 'haiku']);
    expect(view.series).toHaveLength(7);
  });

  test('other cost under half a cent reads as zero', () => {
    const view = buildUsageView(
      mergeSummaries([summary([bucket('2030-03-05', 'codex', 'gpt', { costUsd: 0.994 })], [source('codex', 1)])]),
      input,
    );
    expect(view.cost.other).toBe(0);
  });

  test('hourly windows key the series by rolling hour starts', () => {
    const hourly = makeWindow('24h', Date.parse('2030-03-07T10:15:00.000Z'), 'UTC');
    const hourStart = '2030-03-07T08:15:00.000Z';
    const view = buildUsageView(
      mergeSummaries([summary([bucket('2030-03-07', 'claude', 'opus', { hourStart })], [source('claude', 1)])]),
      hourly,
    );
    expect(view.series).toHaveLength(24);
    expect(view.series[0]!.key).toBe('2030-03-06T10:15:00.000Z');
    expect(view.series[22]).toEqual({ key: hourStart, tokens: 100, costUsd: 1 });
  });
});

describe('formatting', () => {
  test('matches the usage page', () => {
    expect(formatTokens(1_234_567)).toBe('1.23M');
    expect(formatTokens(45_600)).toBe('45.6K');
    expect(formatTokens(999)).toBe('999');
    expect(formatUsd(1234.5)).toBe('$1,234.50');
  });
});
