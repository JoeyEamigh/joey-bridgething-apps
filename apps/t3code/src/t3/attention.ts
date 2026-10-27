import type { PendingBackgroundTask, RunStatus, ThreadShellRow } from './contracts';

export type AttentionKind = 'approval' | 'input' | 'failed' | 'limited' | 'done';

export type Attention = { kind: AttentionKind; since: number; requestId: string | null };

type RuntimeStatus = RunStatus | 'idle';

type PresentedRow = {
  latestRun: { status: RunStatus; completedAt: string | null } | null;
  runtime: { status: RuntimeStatus; updatedAt: string } | null;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
};

const KIND_RANK: Record<AttentionKind, number> = { approval: 0, input: 0, failed: 1, limited: 1, done: 2 };

const ACTIVE_RUNTIME_STATUSES = new Set<RuntimeStatus>(['preparing', 'queued', 'starting', 'running', 'waiting']);

const TERMINAL_RUN_STATUSES = new Set<RuntimeStatus>([
  'completed',
  'interrupted',
  'failed',
  'cancelled',
  'rolled_back',
]);

function backgroundWorkHoldsCompletion(tasks: Pick<PendingBackgroundTask, 'kind'>[]): boolean {
  return tasks.some(task => task.kind === 'subagent' || task.kind === 'monitor' || task.kind === 'background_task');
}

function present(row: ThreadShellRow): PresentedRow {
  const holdsCompletion = backgroundWorkHoldsCompletion(row.pendingBackgroundTasks ?? []);
  const latestRun =
    row.latestRunId === null
      ? null
      : {
          status: row.status === 'idle' ? 'completed' : row.status,
          completedAt:
            row.latestRunCompletedAt === undefined
              ? TERMINAL_RUN_STATUSES.has(row.status) || row.status === 'idle'
                ? row.updatedAt
                : null
              : row.latestRunCompletedAt,
        };
  const parkAtIdle = holdsCompletion && row.status !== 'failed';
  const runtime =
    row.latestRunId === null && row.activeProviderThreadId === null && !parkAtIdle
      ? null
      : { status: parkAtIdle ? 'idle' : (row.activityRunStatus ?? row.status), updatedAt: row.updatedAt };
  const request = row.pendingRuntimeRequest;
  const runtimeIsWorking =
    runtime?.status === 'preparing' || runtime?.status === 'starting' || runtime?.status === 'running';
  return {
    latestRun,
    runtime,
    hasPendingApprovals: request !== null && request.kind !== 'user_input' && request.kind !== 'auth_refresh',
    hasPendingUserInput: request?.kind === 'user_input' && (request.blocking !== false || !runtimeIsWorking),
  };
}

function failureEdgeAt(presented: PresentedRow): string | null | undefined {
  if (presented.runtime?.status !== 'failed') return undefined;
  if (presented.latestRun?.status === 'failed' && presented.latestRun.completedAt != null) {
    return presented.latestRun.completedAt;
  }
  return presented.runtime.updatedAt;
}

function raisedHandWhileSnoozed(row: ThreadShellRow, presented: PresentedRow): boolean {
  if (presented.hasPendingApprovals || presented.hasPendingUserInput) return true;
  if (row.pendingRuntimeRequest != null) return true;
  const failedAt = failureEdgeAt(presented);
  return (
    failedAt !== undefined &&
    (row.snoozedAt == null || (failedAt != null && Date.parse(failedAt) > Date.parse(row.snoozedAt)))
  );
}

function effectiveSnoozed(row: ThreadShellRow, presented: PresentedRow, nowMs: number): boolean {
  if (row.snoozedUntil == null) return false;
  const wakeAtMs = Date.parse(row.snoozedUntil);
  if (Number.isNaN(wakeAtMs) || wakeAtMs <= nowMs) return false;
  return !raisedHandWhileSnoozed(row, presented);
}

function hasUnseenFailure(row: ThreadShellRow, presented: PresentedRow): boolean {
  if (presented.latestRun?.status !== 'failed') return false;
  if (!row.lastVisitedAt) return true;
  const completedAt = Date.parse(presented.latestRun.completedAt ?? '');
  const lastVisitedAt = Date.parse(row.lastVisitedAt);
  if (Number.isNaN(completedAt) || Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

function hasUnseenCompletion(row: ThreadShellRow, presented: PresentedRow): boolean {
  if (!presented.latestRun?.completedAt) return false;
  const completedAt = Date.parse(presented.latestRun.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!row.lastVisitedAt) return false;
  const lastVisitedAt = Date.parse(row.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

function requestAttention(row: ThreadShellRow, kind: 'approval' | 'input'): Attention {
  const request = row.pendingRuntimeRequest!;
  return { kind, since: Date.parse(request.createdAt), requestId: request.id };
}

function firstValidMs(...candidates: Array<string | null | undefined>): number {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

export function projectAttention(row: ThreadShellRow, nowMs: number): Attention | null {
  if (row.lineage.relationshipToParent === 'subagent' || row.archivedAt !== null || row.deletedAt !== null) {
    return null;
  }
  const presented = present(row);
  if (effectiveSnoozed(row, presented, nowMs)) return null;
  if (presented.hasPendingApprovals) return requestAttention(row, 'approval');
  if (presented.hasPendingUserInput) return requestAttention(row, 'input');
  const status = presented.runtime?.status;
  if (status !== undefined && (ACTIVE_RUNTIME_STATUSES.has(status) || status === 'idle')) return null;
  const holdsCompletion = backgroundWorkHoldsCompletion(row.pendingBackgroundTasks ?? []);
  if (row.settledOverride === 'settled' && !holdsCompletion) return null;
  if (status === 'failed') {
    if (!hasUnseenFailure(row, presented)) return null;
    return {
      kind: row.lastErrorClass === 'usage_limit' ? 'limited' : 'failed',
      since: firstValidMs(presented.latestRun?.completedAt, row.updatedAt),
      requestId: null,
    };
  }
  const runStatus = row.activityRunStatus ?? row.status;
  if (runStatus !== 'completed' || holdsCompletion || row.latestRunStopRequested === true) return null;
  if (!hasUnseenCompletion(row, presented)) return null;
  return { kind: 'done', since: Date.parse(presented.latestRun!.completedAt!), requestId: null };
}

export function compareAttention(a: Attention, b: Attention): number {
  return KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.since - b.since;
}
