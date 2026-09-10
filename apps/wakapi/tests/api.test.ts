import { expect, test } from 'bun:test';
import type { BridgethingClient } from '@bridgething/client';
import { WakapiRepository } from '../src/api';
import { addDays, filterReport } from '../src/model';

function rig() {
  const calls: URL[] = [];
  const headers: unknown[] = [];
  const storage = new Map<string, string>();
  let status: number | ((url: URL) => number) = 200;
  let ignoreCategory = false;
  const client = {
    store: {
      get: async ({ key }: { key: string }) => ({ ok: true, response: { key, value: storage.get(key) ?? null } }),
      put: async ({ key, value }: { key: string; value: string }) => {
        storage.set(key, value);
        return { ok: true, response: { key, value } };
      },
    },
    net: {
      fetch: async ({ request }: { request: { url: string; headers: unknown } }) => {
        const url = new URL(request.url);
        calls.push(url);
        headers.push(request.headers);
        let data: unknown;
        if (url.pathname.endsWith('/current'))
          data = { data: { timezone: 'America/New_York', display_name: 'Example' } };
        else {
          const ai = url.searchParams.has('category') && !ignoreCategory;
          const rows = [];
          for (
            let date = url.searchParams.get('start')!;
            date <= url.searchParams.get('end')!;
            date = addDays(date, 1)
          ) {
            const total = ai ? 3600 : 7200;
            rows.push({
              range: { start: `${date}T00:00:00-04:00` },
              grand_total: { total_seconds: total },
              projects: [{ name: 'R&D / app', total_seconds: total }],
              categories: ai
                ? [{ name: 'ai coding', total_seconds: 3600 }]
                : [
                    { name: 'ai coding', total_seconds: 3600 },
                    { name: 'coding', total_seconds: 3600 },
                  ],
            });
          }
          data = { data: rows };
        }
        return {
          ok: true,
          response: {
            response: {
              status: typeof status === 'function' ? status(url) : status,
              body: [...new TextEncoder().encode(JSON.stringify(data))],
            },
          },
        };
      },
    },
  } as unknown as BridgethingClient;
  const repository = new WakapiRepository(client, { server: 'https://example.net/wakapi', apiKey: 'test-read-key' });
  return {
    repository,
    client,
    calls,
    headers,
    storage,
    setStatus: (value: number | ((url: URL) => number)) => (status = value),
    ignoreCategory: () => (ignoreCategory = true),
  };
}

test('deduplicates profile initialization and summary requests', async () => {
  const r = rig();
  await Promise.all([r.repository.refreshProfile(), r.repository.refreshProfile()]);
  expect(r.calls.length).toBe(1);
  const reports = await Promise.all([
    r.repository.load('2026-09-09', '2026-09-09'),
    r.repository.load('2026-09-09', '2026-09-09'),
  ]);
  expect(r.calls.length).toBe(3);
  expect(reports[0]).toEqual(reports[1]);
  expect(filterReport(reports[0]!, 'exclude-ai')[0]?.seconds).toBe(3600);
  expect(r.headers[0]).toEqual([{ name: 'Authorization', value: `Basic ${btoa('test-read-key')}` }]);
});

test('refreshes only the last day while history remains fresh', async () => {
  const r = rig();
  await r.repository.refreshProfile();
  await r.repository.load('2026-09-03', '2026-09-09');
  const report = await r.repository.load('2026-09-03', '2026-09-09');
  expect(r.calls.slice(-2).every(url => url.searchParams.get('start') === '2026-09-09')).toBe(true);
  expect(report.all.length).toBe(7);
  expect(report.ai.length).toBe(7);
});

test('preserves project filters and encodes names without adding query parameters', async () => {
  const r = rig();
  await r.repository.refreshProfile();
  await r.repository.load('2026-09-09', '2026-09-09', 'R&D / app');
  expect(r.calls.slice(-2).every(url => url.searchParams.get('project') === 'R&D / app')).toBe(true);
  expect(r.calls.at(-1)?.searchParams.get('category')).toBe('ai coding');
  expect(r.calls.at(-1)?.searchParams.get('timezone')).toBe('America/New_York');
});

test('keeps a complete cached report if the next refresh fails', async () => {
  const r = rig();
  await r.repository.refreshProfile();
  const previous = await r.repository.load('2026-09-09', '2026-09-09');
  r.setStatus(500);
  await expect(r.repository.load('2026-09-09', '2026-09-09')).rejects.toThrow('HTTP 500');
  expect(r.repository.cached('2026-09-09', '2026-09-09')).toEqual(previous);
  const calls = r.calls.length;
  await expect(r.repository.load('2026-09-09', '2026-09-09')).rejects.toThrow();
  expect(r.calls.length).toBe(calls);
  r.setStatus(200);
  await expect(r.repository.load('2026-09-09', '2026-09-09', '', true)).resolves.toBeDefined();
});

test('rejects ignored category filters instead of showing an invented AI split', async () => {
  const r = rig();
  await r.repository.refreshProfile();
  r.ignoreCategory();
  await expect(r.repository.load('2026-09-09', '2026-09-09')).rejects.toThrow('does not support');
  expect(r.repository.cached('2026-09-09', '2026-09-09')).toBeNull();
});

test('hydrates offline readings and isolates changed credentials', async () => {
  const r = rig();
  await r.repository.refreshProfile();
  await r.repository.load('2026-09-09', '2026-09-09');
  await new Promise(resolve => setTimeout(resolve, 0));
  const same = new WakapiRepository(r.client, { server: 'https://example.net/wakapi', apiKey: 'test-read-key' });
  await same.hydrate();
  expect(same.cached('2026-09-09', '2026-09-09')?.all[0]?.seconds).toBe(7200);
  const other = new WakapiRepository(r.client, { server: 'https://example.net/wakapi', apiKey: 'other-key' });
  await other.hydrate();
  expect(other.profile).toBeNull();
  expect(other.cached('2026-09-09', '2026-09-09')).toBeNull();
  expect([...r.storage.values()].every(value => !value.includes('test-read-key'))).toBe(true);
});

test('does not cache a partial all-only result if AI retrieval fails', async () => {
  const r = rig();
  await r.repository.refreshProfile();
  r.setStatus(url => (url.searchParams.has('category') ? 500 : 200));
  await expect(r.repository.load('2026-09-09', '2026-09-09')).rejects.toThrow('HTTP 500');
  expect(r.repository.cached('2026-09-09', '2026-09-09')).toBeNull();
});
