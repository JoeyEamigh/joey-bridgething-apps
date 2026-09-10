import { describe, expect, test } from 'bun:test';
import {
  addDays,
  combineDays,
  dateInZone,
  emptyDay,
  filterReport,
  parseDays,
  serverRoot,
  type Report,
} from '../src/model';

describe('activity filtering', () => {
  const all = {
    ...emptyDay('2026-09-09'),
    seconds: 7200,
    projects: [
      { name: 'one', seconds: 6000 },
      { name: 'two', seconds: 1200 },
    ],
    categories: [
      { name: 'ai coding', seconds: 3600 },
      { name: 'coding', seconds: 3000 },
      { name: 'browsing', seconds: 600 },
    ],
    languages: [
      { name: 'Rust', seconds: 6000 },
      { name: 'Unknown', seconds: 1200 },
    ],
    entities: [{ name: 'src/a.rs', seconds: 6000 }],
  };
  const ai = {
    ...emptyDay('2026-09-09'),
    seconds: 3600,
    projects: [{ name: 'one', seconds: 3600 }],
    categories: [{ name: 'ai coding', seconds: 3600 }],
    languages: [{ name: 'Rust', seconds: 3600 }],
    entities: [{ name: 'src/a.rs', seconds: 3600 }],
  };
  const report: Report = { all: [all], ai: [ai], fetchedAt: 1, historyFetchedAt: 1 };
  test('preserves complete all and AI snapshots', () => {
    expect(filterReport(report, 'all')).toEqual([all]);
    expect(filterReport(report, 'ai')).toEqual([ai]);
  });
  test('subtracts AI from total, projects, languages and entity detail', () => {
    const day = filterReport(report, 'exclude-ai')[0]!;
    expect(day.seconds).toBe(3600);
    expect(day.projects).toEqual([
      { name: 'one', seconds: 2400 },
      { name: 'two', seconds: 1200 },
    ]);
    expect(day.languages).toEqual([
      { name: 'Rust', seconds: 2400 },
      { name: 'Unknown', seconds: 1200 },
    ]);
    expect(day.entities).toEqual([{ name: 'src/a.rs', seconds: 2400 }]);
    expect(day.categories.map(row => row.name)).toEqual(['coding', 'browsing']);
    expect(report.all[0]?.seconds).toBe(7200);
  });
  test('matches dates instead of assuming response order', () => {
    const pair = {
      all: [all, { ...all, date: '2026-09-10' }],
      ai: [{ ...ai, date: '2026-09-10', seconds: 1200 }, ai],
      fetchedAt: 1,
      historyFetchedAt: 1,
    };
    expect(filterReport(pair, 'exclude-ai').map(day => day.seconds)).toEqual([3600, 6000]);
  });
  test('does not turn absent AI days into unfiltered data', () => {
    expect(() => filterReport({ ...report, ai: [] }, 'exclude-ai')).toThrow('missing a day');
  });
  test('clamps server rounding residuals without producing negative time', () => {
    const day = filterReport(
      { ...report, ai: [{ ...ai, seconds: 7201, projects: [{ name: 'one', seconds: 6001 }] }] },
      'exclude-ai',
    )[0]!;
    expect(day.seconds).toBe(0);
    expect(day.projects).toEqual([{ name: 'two', seconds: 1200 }]);
  });
  test('aggregates exact displayed dates and preserves unclassified activity', () => {
    const days = [all, { ...emptyDay('2026-09-10'), seconds: 60, projects: [{ name: 'two', seconds: 60 }] }];
    const result = combineDays(days);
    expect(result.seconds).toBe(7260);
    expect(result.projects).toEqual([
      { name: 'one', seconds: 6000 },
      { name: 'two', seconds: 1260 },
    ]);
  });
});

describe('calendar boundaries and parsing', () => {
  const raw = (start: string, total = 100) => ({
    range: { start, date: '2099-01-01' },
    grand_total: { total_seconds: total },
    projects: [{ name: 'project', total_seconds: total }],
    branches: null,
  });
  test('uses range.start instead of the request date field', () => {
    expect(
      parseDays({ data: [raw('2026-09-09T00:00:00-04:00')] }, '2026-09-09', '2026-09-09', 'America/New_York')[0]?.date,
    ).toBe('2026-09-09');
  });
  test('resolves UTC timestamps in the account timezone', () => {
    expect(
      parseDays({ data: [raw('2026-09-09T04:00:00Z')] }, '2026-09-09', '2026-09-09', 'America/New_York')[0]?.seconds,
    ).toBe(100);
    expect(dateInZone(new Date('2026-09-10T02:00:00Z'), 'America/New_York')).toBe('2026-09-09');
  });
  test('calendar arithmetic crosses DST and year boundaries', () => {
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
  });
  test('rejects missing days, duplicate dates and wrong timezone days', () => {
    expect(() => parseDays({ data: [] }, '2026-09-09', '2026-09-09', 'UTC')).toThrow('incomplete');
    expect(() =>
      parseDays(
        { data: [raw('2026-09-09T00:00:00Z'), raw('2026-09-09T00:00:00Z')] },
        '2026-09-09',
        '2026-09-09',
        'UTC',
      ),
    ).toThrow('unexpected');
    expect(() =>
      parseDays({ data: [raw('2026-09-09T00:00:00Z')] }, '2026-09-09', '2026-09-09', 'America/New_York'),
    ).toThrow('unexpected');
  });
  test('rejects malformed totals instead of displaying zero', () => {
    expect(() => parseDays({ data: [raw('2026-09-09T00:00:00Z', NaN)] }, '2026-09-09', '2026-09-09', 'UTC')).toThrow(
      'invalid duration',
    );
  });
  test('accepts empty optional breakdowns', () => {
    expect(
      parseDays({ data: [raw('2026-09-09T00:00:00Z', 0)] }, '2026-09-09', '2026-09-09', 'UTC')[0]?.branches,
    ).toEqual([]);
  });
  test('preserves server subpaths and normalizes pasted API URLs', () => {
    expect(serverRoot('stats.example.net/wakapi/api/compat/wakatime/v1/')).toBe('https://stats.example.net/wakapi');
    expect(serverRoot('http://stats.example.net:3000/api')).toBe('http://stats.example.net:3000');
    expect(() => serverRoot('https://user:pass@example.net')).toThrow();
    expect(() => serverRoot('file:///tmp')).toThrow();
  });
});
