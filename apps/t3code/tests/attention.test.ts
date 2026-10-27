import { describe, expect, test } from 'bun:test';

import type { ThreadShellRow } from '../src/t3/contracts';
import { compareAttention, projectAttention, type Attention } from '../src/t3/attention';

const NOW = Date.parse('2030-05-01T12:00:00.000Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function row(extra: Partial<ThreadShellRow> = {}): ThreadShellRow {
  return {
    id: 'thread-1',
    projectId: 'project-1',
    title: 'Sample thread',
    providerInstanceId: 'claudeAgent',
    modelSelection: { instanceId: 'claudeAgent', model: 'sample-model' },
    branch: null,
    worktreePath: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: 'thread-1' },
    activeProviderThreadId: 'provider-thread-1',
    latestRunId: 'run-1',
    latestRunRequestedAt: at(30),
    latestRunStartedAt: at(30),
    latestRunCompletedAt: at(10),
    activeRunId: null,
    activityRunStatus: null,
    status: 'completed',
    pendingRuntimeRequest: null,
    latestUserMessageAt: at(30),
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    createdAt: at(60),
    updatedAt: at(10),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: at(20),
    deletedAt: null,
    ...extra,
  };
}

const running = {
  status: 'running',
  activityRunStatus: 'running',
  activeRunId: 'run-1',
  latestRunCompletedAt: null,
} as const;

describe('projectAttention', () => {
  test('an unseen completion is done since it completed', () => {
    expect(projectAttention(row(), NOW)).toEqual({ kind: 'done', since: NOW - 10 * 60_000, requestId: null });
  });

  test('a seen completion needs nothing', () => {
    expect(projectAttention(row({ lastVisitedAt: at(5) }), NOW)).toBeNull();
  });

  test('a thread never visited does not count as an unseen completion', () => {
    expect(projectAttention(row({ lastVisitedAt: null }), NOW)).toBeNull();
    expect(projectAttention(row({ lastVisitedAt: undefined }), NOW)).toBeNull();
  });

  test('a pending approval is approval with its request', () => {
    const attention = projectAttention(
      row({ ...running, pendingRuntimeRequest: { id: 'req-1', kind: 'command', createdAt: at(3) } }),
      NOW,
    );
    expect(attention).toEqual({ kind: 'approval', since: NOW - 3 * 60_000, requestId: 'req-1' });
  });

  test('an auth refresh is not an approval', () => {
    expect(
      projectAttention(
        row({ ...running, pendingRuntimeRequest: { id: 'r', kind: 'auth_refresh', createdAt: at(3) } }),
        NOW,
      ),
    ).toBeNull();
  });

  test('a user input request is input', () => {
    expect(
      projectAttention(
        row({ ...running, pendingRuntimeRequest: { id: 'q', kind: 'user_input', createdAt: at(2) } }),
        NOW,
      )?.kind,
    ).toBe('input');
  });

  test('a nonblocking question waits until the run stops working', () => {
    const request = { id: 'q', kind: 'user_input', createdAt: at(2), blocking: false } as const;
    expect(projectAttention(row({ ...running, pendingRuntimeRequest: request }), NOW)).toBeNull();
    expect(projectAttention(row({ pendingRuntimeRequest: request }), NOW)?.kind).toBe('input');
  });

  test('working, parked and thread-wait states are not attention', () => {
    expect(projectAttention(row(running), NOW)).toBeNull();
    expect(projectAttention(row({ ...running, blockedOnThreadWait: true }), NOW)).toBeNull();
    expect(projectAttention(row({ pendingBackgroundTasks: [{ taskId: 't', kind: 'monitor' }] }), NOW)).toBeNull();
    expect(projectAttention(row({ pendingBackgroundTasks: [{ taskId: 't', kind: 'command' }] }), NOW)?.kind).toBe(
      'done',
    );
  });

  test('a failure is failed until seen, even on a thread never visited', () => {
    expect(projectAttention(row({ status: 'failed', lastVisitedAt: null }), NOW)).toEqual({
      kind: 'failed',
      since: NOW - 10 * 60_000,
      requestId: null,
    });
    expect(projectAttention(row({ status: 'failed', lastVisitedAt: at(5) }), NOW)).toBeNull();
  });

  test('a usage limit failure is limited', () => {
    expect(projectAttention(row({ status: 'failed', lastErrorClass: 'usage_limit' }), NOW)?.kind).toBe('limited');
  });

  test('a stop the user asked for is not done', () => {
    expect(projectAttention(row({ latestRunStopRequested: true }), NOW)).toBeNull();
    expect(projectAttention(row({ status: 'interrupted' }), NOW)).toBeNull();
  });

  test('subagents, archived and deleted threads are excluded', () => {
    expect(
      projectAttention(
        row({ lineage: { parentThreadId: 'p', relationshipToParent: 'subagent', rootThreadId: 'p' } }),
        NOW,
      ),
    ).toBeNull();
    expect(projectAttention(row({ archivedAt: at(1) }), NOW)).toBeNull();
    expect(projectAttention(row({ deletedAt: at(1) }), NOW)).toBeNull();
  });

  test('settling hides done and failed but not a request', () => {
    expect(projectAttention(row({ settledOverride: 'settled' }), NOW)).toBeNull();
    expect(projectAttention(row({ settledOverride: 'settled', status: 'failed' }), NOW)).toBeNull();
    expect(
      projectAttention(
        row({ settledOverride: 'settled', pendingRuntimeRequest: { id: 'r', kind: 'permission', createdAt: at(1) } }),
        NOW,
      )?.kind,
    ).toBe('approval');
  });

  test('a snoozed thread stays hidden through a completion', () => {
    expect(projectAttention(row({ snoozedUntil: at(-60), snoozedAt: at(15) }), NOW)).toBeNull();
  });

  test('a snoozed thread wakes early for a request or a failure after snoozing', () => {
    const snoozed = { snoozedUntil: at(-60), snoozedAt: at(15) };
    expect(
      projectAttention(
        row({ ...snoozed, ...running, pendingRuntimeRequest: { id: 'r', kind: 'user_input', createdAt: at(1) } }),
        NOW,
      )?.kind,
    ).toBe('input');
    expect(projectAttention(row({ ...snoozed, status: 'failed' }), NOW)?.kind).toBe('failed');
    expect(projectAttention(row({ ...snoozed, status: 'failed', latestRunCompletedAt: at(20) }), NOW)).toBeNull();
  });

  test('an expired snooze no longer hides the thread', () => {
    expect(projectAttention(row({ snoozedUntil: at(1), snoozedAt: at(15) }), NOW)?.kind).toBe('done');
  });

  test('a run without a completion time falls back to the last update', () => {
    const { latestRunCompletedAt: _latestRunCompletedAt, ...legacy } = row({ updatedAt: at(8) });
    expect(projectAttention(legacy, NOW)?.since).toBe(NOW - 8 * 60_000);
  });
});

describe('compareAttention', () => {
  test('requests first, then failures, then completions, oldest first within each', () => {
    const items: Attention[] = [
      { kind: 'done', since: 1, requestId: null },
      { kind: 'limited', since: 5, requestId: null },
      { kind: 'input', since: 9, requestId: 'b' },
      { kind: 'failed', since: 2, requestId: null },
      { kind: 'approval', since: 3, requestId: 'a' },
    ];
    expect(items.sort(compareAttention).map(item => item.kind)).toEqual([
      'approval',
      'input',
      'failed',
      'limited',
      'done',
    ]);
  });
});
