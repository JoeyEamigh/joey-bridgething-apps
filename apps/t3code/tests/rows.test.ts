import { describe, expect, test } from 'bun:test';
import { shrink } from '../src/model/rows';

const NOW = Date.parse('2026-10-27T05:00:00Z');

function row(id: string, fields: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    projectId: 'p',
    status: 'idle',
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    settledOverride: null,
    archivedAt: null,
    deletedAt: null,
    snoozedUntil: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    lastVisitedAt: '2026-10-27T04:00:00Z',
    createdAt: '2026-10-27T03:00:00Z',
    updatedAt: '2026-10-27T04:00:00Z',
    ...fields,
  };
}

describe('shrink', () => {
  test('an authoritative shell snapshot keeps only rows the device shows', () => {
    const running = row('running', { activityRunStatus: 'running', activityRunStartedAt: '2026-10-27T04:30:00Z' });
    const quiet = row('quiet');
    const result = shrink(
      'orchestration.subscribeShell',
      {
        kind: 'snapshot',
        snapshot: { snapshotSequence: 9, projects: [], threads: [running, quiet], archivedThreads: [quiet] },
      },
      NOW,
    ) as any;
    expect(result.snapshot.threads.map((entry: any) => entry.id)).toEqual(['running']);
    expect(result.snapshot.archivedThreads).toEqual([]);
    expect(result.snapshot.snapshotSequence).toBe(9);
  });

  test('a project refresh snapshot passes through untouched', () => {
    const item = {
      kind: 'snapshot',
      snapshot: { threads: [], projects: [{ id: 'p' }] },
      resolvedRepositoryIdentityRoots: [],
    };
    expect(shrink('orchestration.subscribeShell', item, NOW)).toBe(item);
  });

  test('an update for a row the device drops becomes a removal', () => {
    const result = shrink(
      'orchestration.subscribeShell',
      { kind: 'thread.updated', sequence: 4, location: 'active', thread: row('quiet') },
      NOW,
    );
    expect(result).toEqual({ kind: 'thread.removed', sequence: 4, location: 'active', threadId: 'quiet' });
  });

  test('config events reduce to limit readings', () => {
    const providers = [
      {
        driver: 'claudeAgent',
        instanceId: 'a',
        enabled: true,
        auth: { email: 'x@example.test' },
        models: [1, 2, 3],
        usageLimits: null,
      },
      { driver: 'codex', instanceId: 'b', enabled: false },
    ];
    expect(shrink('subscribeServerConfig', { type: 'snapshot', config: { providers, keybindings: [] } }, NOW)).toEqual({
      type: 'native',
      native: [{ driver: 'claudeAgent', instanceId: 'a', email: 'x@example.test', usageLimits: null }],
    });
    expect(
      shrink('subscribeServerConfig', { type: 'usageLimitSourcesUpdated', payload: { sources: [1] } }, NOW),
    ).toEqual({
      type: 'sources',
      sources: [1],
    });
    expect(shrink('subscribeServerConfig', { type: 'settingsUpdated', payload: {} }, NOW)).toEqual({ type: 'ignored' });
  });
});
