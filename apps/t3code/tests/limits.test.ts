import { describe, expect, test } from 'bun:test';

import type {
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshot,
} from '../src/t3/contracts';
import { collectLimitAccounts, collectLimitPools, type LimitAccount } from '../src/t3/limits';

const NOW = Date.parse('2030-01-10T12:00:00.000Z');
const HOUR = 3_600_000;

const iso = (ms: number) => new Date(ms).toISOString();

function window(
  id: string,
  kind: ServerProviderUsageWindow['kind'],
  usedPercent: number,
  extra: Partial<ServerProviderUsageWindow> = {},
): ServerProviderUsageWindow {
  return { id, kind, label: id, usedPercent, ...extra };
}

function limits(windows: ServerProviderUsageWindow[], checkedAt = iso(NOW)): ServerProviderUsageLimits {
  return { checkedAt, windows };
}

function account(key: string, driver: string, windows: ServerProviderUsageWindow[], email?: string): LimitAccount {
  return {
    key,
    driver,
    ...(email === undefined ? {} : { email }),
    via: [],
    checkedAt: iso(NOW),
    usageLimits: limits(windows),
  };
}

function source(id: string, accounts: UsageLimitSourceSnapshot['accounts']): UsageLimitSourceSnapshot {
  return { id, kind: 'cliproxy', label: `hub ${id}`, checkedAt: iso(NOW), accounts };
}

describe('collectLimitAccounts', () => {
  test('merges one login across environments and keeps the freshest reading', () => {
    const older = limits([window('five_hour', 'session', 10)], iso(NOW - HOUR));
    const newer = limits([window('five_hour', 'session', 40)], iso(NOW));
    const accounts = collectLimitAccounts([
      {
        environment: 'alpha',
        sources: [],
        native: [{ driver: 'claudeAgent', instanceId: 'claude', email: 'One@Example.test', usageLimits: older }],
      },
      {
        environment: 'beta',
        sources: [],
        native: [{ driver: 'claudeAgent', instanceId: 'claude', email: 'one@example.test', usageLimits: newer }],
      },
    ]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.key).toBe('claudeAgent:one@example.test');
    expect(accounts[0]!.email).toBe('One@Example.test');
    expect(accounts[0]!.via).toEqual(['alpha', 'beta']);
    expect(accounts[0]!.checkedAt).toBe(iso(NOW));
    expect(accounts[0]!.usageLimits.windows[0]!.usedPercent).toBe(40);
  });

  test('a hub account joins the native login and drops its source label', () => {
    const accounts = collectLimitAccounts([
      {
        environment: 'alpha',
        sources: [
          source('hub', [
            {
              id: 'one.json',
              driver: 'codex',
              email: 'one@example.test',
              plan: 'pro',
              usageLimits: limits([window('primary', 'session', 70)], iso(NOW + 1000)),
            },
          ]),
        ],
        native: [
          {
            driver: 'codex',
            instanceId: 'codex',
            email: 'one@example.test',
            usageLimits: limits([window('primary', 'session', 20)]),
          },
        ],
      },
    ]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.via).toEqual(['alpha']);
    expect(accounts[0]!.plan).toBe('pro');
    expect(accounts[0]!.usageLimits.windows[0]!.usedPercent).toBe(70);
  });

  test('a login without a workspace adopts the only workspace seen for it', () => {
    const accounts = collectLimitAccounts([
      {
        environment: 'alpha',
        sources: [
          source('hub', [
            {
              id: 'a',
              driver: 'codex',
              email: 'one@example.test',
              workspaceId: 'ws1',
              usageLimits: limits([window('primary', 'session', 5)]),
            },
          ]),
        ],
        native: [
          {
            driver: 'codex',
            instanceId: 'codex',
            email: 'one@example.test',
            usageLimits: limits([window('primary', 'session', 9)]),
          },
        ],
      },
    ]);
    expect(accounts.map(entry => entry.key)).toEqual(['codex:one@example.test:ws1']);
  });

  test('labels hub accounts with the environment when there are several', () => {
    const accounts = collectLimitAccounts([
      {
        environment: 'alpha',
        sources: [
          source('hub', [
            {
              id: 'a',
              driver: 'claudeAgent',
              usageLimits: { ...limits([window('five_hour', 'session', 5)]), credentialFingerprint: 'fp1' },
            },
          ]),
        ],
        native: [],
      },
      { environment: 'beta', sources: [], native: [] },
    ]);
    expect(accounts[0]!.key).toBe('claudeAgent:credential:fp1');
    expect(accounts[0]!.via).toEqual(['alpha · hub hub']);
  });

  test('skips unreadable, unsupported and empty readings', () => {
    const accounts = collectLimitAccounts([
      {
        environment: 'alpha',
        sources: [],
        native: [
          { driver: 'claudeAgent', instanceId: 'a', email: 'a@example.test', usageLimits: null },
          {
            driver: 'claudeAgent',
            instanceId: 'b',
            email: 'b@example.test',
            usageLimits: { ...limits([]), unavailable: { reason: 'unsupported' } },
          },
          { driver: 'claudeAgent', instanceId: 'c', email: 'c@example.test', usageLimits: limits([]) },
          {
            driver: 'claudeAgent',
            instanceId: 'd',
            email: 'd@example.test',
            usageLimits: limits([{ ...window('x', 'session', 5), kind: 'daily' as 'session' }]),
          },
        ],
      },
    ]);
    expect(accounts).toEqual([]);
  });
});

describe('collectLimitPools', () => {
  test('orders session, weekly, then model-scoped weekly and averages remaining', () => {
    const pools = collectLimitPools(
      [
        account('k1', 'claudeAgent', [
          window('five_hour', 'session', 30),
          window('seven_day', 'weekly', 50),
          window('seven_day_opus', 'weekly', 10),
        ]),
        account('k2', 'claudeAgent', [window('five_hour', 'session', 61), window('seven_day', 'weekly', 20)]),
      ],
      NOW,
    );
    expect(pools.map(pool => pool.id)).toEqual([
      'claudeAgent:session:five_hour',
      'claudeAgent:weekly:seven_day',
      'claudeAgent:weekly:seven_day_opus',
    ]);
    expect(pools[0]!.remainingPercent).toBe(55);
    expect(pools[0]!.members.map(member => member.remainingPercent)).toEqual([70, 39]);
    expect(pools[2]!.members).toHaveLength(1);
  });

  test('members keep one stable order across pools regardless of reset time', () => {
    const pools = collectLimitPools(
      [
        account(
          'zeta',
          'claudeAgent',
          [
            window('five_hour', 'session', 10, { resetsAt: iso(NOW + HOUR) }),
            window('seven_day', 'weekly', 10, { resetsAt: iso(NOW + 100 * HOUR) }),
          ],
          'zed@example.test',
        ),
        account(
          'alpha',
          'claudeAgent',
          [
            window('five_hour', 'session', 10, { resetsAt: iso(NOW + 4 * HOUR) }),
            window('seven_day', 'weekly', 10, { resetsAt: iso(NOW + 10 * HOUR) }),
          ],
          'amy@example.test',
        ),
        account('claudeAgent:credential:fp', 'claudeAgent', [window('five_hour', 'session', 10)]),
      ],
      NOW,
    );
    expect(pools[0]!.members.map(member => member.accountKey)).toEqual(['alpha', 'claudeAgent:credential:fp', 'zeta']);
    expect(pools[1]!.members.map(member => member.accountKey)).toEqual(['alpha', 'zeta']);
  });

  test('a spent weekly window makes the session fully used until the weekly reset', () => {
    const pools = collectLimitPools(
      [
        account('a', 'claudeAgent', [
          window('five_hour', 'session', 20, { resetsAt: iso(NOW + HOUR), windowDurationMins: 300 }),
          window('seven_day', 'weekly', 100, { resetsAt: iso(NOW + 48 * HOUR) }),
        ]),
        account('b', 'claudeAgent', [
          window('five_hour', 'session', 0, { resetsAt: iso(NOW + 2 * HOUR) }),
          window('seven_day', 'weekly', 40, { resetsAt: iso(NOW + 72 * HOUR) }),
        ]),
      ],
      NOW,
    );
    const session = pools[0]!;
    expect(session.remainingPercent).toBe(50);
    expect(session.members[0]).toEqual({
      accountKey: 'a',
      remainingPercent: 0,
      resetsAt: NOW + 48 * HOUR,
      paceRemainingPercent: null,
      pace: null,
      exhausted: true,
    });
    expect(session.refill).toEqual({ percent: 50, at: NOW + 48 * HOUR });
  });

  test('an idle session behind a spent weekly window refills at the weekly reset', () => {
    const pools = collectLimitPools(
      [
        account('a', 'claudeAgent', [
          window('five_hour', 'session', 0),
          window('seven_day', 'weekly', 100, { resetsAt: iso(NOW + 30 * HOUR) }),
        ]),
        account('b', 'claudeAgent', [
          window('five_hour', 'session', 0),
          window('seven_day', 'weekly', 40, { resetsAt: iso(NOW + 72 * HOUR) }),
        ]),
      ],
      NOW,
    );
    expect(pools[0]!.members[0]!.resetsAt).toBe(NOW + 30 * HOUR);
    expect(pools[0]!.refill).toEqual({ percent: 50, at: NOW + 30 * HOUR });
  });

  test('a session that outlives the spent weekly window refills only what it has left', () => {
    const pools = collectLimitPools(
      [
        account('a', 'codex', [
          window('primary', 'session', 30, { resetsAt: iso(NOW + 5 * HOUR) }),
          window('secondary', 'weekly', 100, { resetsAt: iso(NOW + HOUR) }),
        ]),
        account('b', 'codex', [window('primary', 'session', 0)]),
      ],
      NOW,
    );
    expect(pools[0]!.members[0]!.resetsAt).toBe(NOW + HOUR);
    expect(pools[0]!.refill).toEqual({ percent: 35, at: NOW + HOUR });
  });

  test('codex pools windows by kind across slot ids', () => {
    const pools = collectLimitPools(
      [
        account('a', 'codex', [window('primary', 'weekly', 20)]),
        account('b', 'codex', [window('primary', 'session', 10), window('secondary', 'weekly', 60)]),
      ],
      NOW,
    );
    expect(pools.map(pool => pool.id)).toEqual(['codex:session:session', 'codex:weekly:weekly']);
    expect(pools[1]!.remainingPercent).toBe(60);
    expect(pools[1]!.members.map(member => member.accountKey)).toEqual(['a', 'b']);
  });

  test('a reset already in the past counts as fully remaining', () => {
    const pools = collectLimitPools(
      [
        account('a', 'claudeAgent', [
          window('five_hour', 'session', 20, { resetsAt: iso(NOW + HOUR) }),
          window('seven_day', 'weekly', 100, { resetsAt: iso(NOW - HOUR) }),
        ]),
      ],
      NOW,
    );
    expect(pools[0]!.members[0]!.remainingPercent).toBe(80);
    expect(pools[1]!.remainingPercent).toBe(100);
    expect(pools[1]!.members[0]!.resetsAt).toBeNull();
    expect(pools[1]!.members[0]!.exhausted).toBe(false);
  });

  test('pace compares spend against elapsed window time', () => {
    const pools = collectLimitPools(
      [
        account('a', 'claudeAgent', [
          window('five_hour', 'session', 80, { resetsAt: iso(NOW + 2.5 * HOUR), windowDurationMins: 300 }),
          window('seven_day', 'weekly', 10, { resetsAt: iso(NOW + 84 * HOUR), windowDurationMins: 10080 }),
        ]),
      ],
      NOW,
    );
    expect(pools[0]!.members[0]!.paceRemainingPercent).toBe(50);
    expect(pools[0]!.members[0]!.pace).toBe('ahead');
    expect(pools[1]!.members[0]!.pace).toBe('under');
  });

  test('a single account pool shows no refill', () => {
    const pools = collectLimitPools(
      [account('a', 'claudeAgent', [window('five_hour', 'session', 40, { resetsAt: iso(NOW + HOUR) })])],
      NOW,
    );
    expect(pools[0]!.refill).toBeNull();
  });

  test('rounds the pool to whole percents', () => {
    const pools = collectLimitPools(
      [
        account('a', 'claudeAgent', [window('five_hour', 'session', 33.4)]),
        account('b', 'claudeAgent', [window('five_hour', 'session', 33.3)]),
        account('c', 'claudeAgent', [window('five_hour', 'session', 33.6)]),
      ],
      NOW,
    );
    expect(pools[0]!.remainingPercent).toBe(67);
    expect(pools[0]!.members.map(member => member.remainingPercent)).toEqual([67, 67, 66]);
  });

  test('cursor hides the overall window when both pools report and renames the rest', () => {
    const pools = collectLimitPools(
      [
        account('a', 'cursor', [
          window('apiPercentUsed', 'monthly', 10),
          window('totalPercentUsed', 'monthly', 20),
          window('autoPercentUsed', 'monthly', 30),
        ]),
      ],
      NOW,
    );
    expect(pools.map(pool => pool.label)).toEqual(['Cursor Models', 'Other Models']);
  });

  test('keeps drivers in account order', () => {
    const pools = collectLimitPools(
      [
        account('a', 'codex', [window('primary', 'session', 1)]),
        account('b', 'claudeAgent', [window('five_hour', 'session', 1)]),
      ],
      NOW,
    );
    expect(pools.map(pool => pool.driver)).toEqual(['codex', 'claudeAgent']);
  });
});
