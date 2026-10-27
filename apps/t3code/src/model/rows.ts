import { projectAttention } from '../t3/attention';
import type { ThreadShellRow } from '../t3/contracts';
import type { NativeLimitReport } from '../t3/limits';

export function live(row: ThreadShellRow): boolean {
  const busy =
    Boolean(row.activityRunStatus) || (row.pendingBackgroundTasks?.length ?? 0) > 0 || row.blockedOnThreadWait;
  return Boolean(busy) && row.settledOverride !== 'settled' && !row.archivedAt && !row.deletedAt;
}

export function keepRow(row: ThreadShellRow, now: number): boolean {
  if (projectAttention(row, now) || live(row)) return true;
  const snoozed = row.snoozedUntil ? Date.parse(row.snoozedUntil) > now : false;
  return snoozed && row.settledOverride !== 'settled' && !row.archivedAt && !row.deletedAt;
}

function nativeLimits(providers: any[]): NativeLimitReport[] {
  return providers
    .filter(provider => provider?.enabled !== false)
    .map(provider => ({
      driver: provider.driver,
      instanceId: provider.instanceId,
      ...(provider.auth?.email ? { email: provider.auth.email } : {}),
      ...(provider.auth?.workspaceId ? { workspaceId: provider.auth.workspaceId } : {}),
      usageLimits: provider.usageLimits ?? null,
    }));
}

export type ConfigEvent =
  { type: 'native'; native: NativeLimitReport[] } | { type: 'sources'; sources: unknown[] } | { type: 'ignored' };

export function shrink(tag: string, value: any, now: number): unknown {
  if (tag === 'orchestration.subscribeShell') {
    if (value?.kind === 'snapshot' && value.resolvedRepositoryIdentityRoots === undefined) {
      const threads = (value.snapshot?.threads ?? []).filter((row: ThreadShellRow) => keepRow(row, now));
      return { ...value, snapshot: { ...value.snapshot, threads, archivedThreads: [] } };
    }
    if (value?.kind === 'thread.updated' && !(value.location === 'active' && keepRow(value.thread, now))) {
      return { kind: 'thread.removed', sequence: value.sequence, location: value.location, threadId: value.thread.id };
    }
    return value;
  }
  if (tag === 'subscribeServerConfig') {
    if (value?.type === 'snapshot') return { type: 'native', native: nativeLimits(value.config?.providers ?? []) };
    if (value?.type === 'providerStatuses')
      return { type: 'native', native: nativeLimits(value.payload?.providers ?? []) };
    if (value?.type === 'usageLimitSourcesUpdated') return { type: 'sources', sources: value.payload?.sources ?? [] };
    return { type: 'ignored' };
  }
  return value;
}
