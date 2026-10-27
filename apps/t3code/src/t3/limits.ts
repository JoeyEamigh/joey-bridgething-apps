import type {
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  ServerProviderUsageWindowKind,
  UsageLimitSourceSnapshot,
} from './contracts';

const MINUTE = 60_000;

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindowKind, number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

const CURSOR_WINDOW_LABELS = [
  { id: 'totalPercentUsed', label: 'Overall' },
  { id: 'autoPercentUsed', label: 'Cursor Models' },
  { id: 'apiPercentUsed', label: 'Other Models' },
] as const;

export type LimitAccount = {
  key: string;
  driver: string;
  email?: string;
  plan?: string;
  via: string[];
  checkedAt: string;
  usageLimits: ServerProviderUsageLimits;
};

export type NativeLimitReport = {
  driver: string;
  instanceId: string;
  email?: string;
  workspaceId?: string;
  plan?: string;
  usageLimits: ServerProviderUsageLimits | null;
};

export type LimitEnvironment = {
  environment: string;
  sources: UsageLimitSourceSnapshot[];
  native: NativeLimitReport[];
};

export type PoolMember = {
  accountKey: string;
  email?: string;
  remainingPercent: number;
  resetsAt: number | null;
  paceRemainingPercent: number | null;
  pace: 'ahead' | 'on' | 'under' | null;
  exhausted: boolean;
};

export type LimitPool = {
  id: string;
  label: string;
  kind: string;
  driver: string;
  remainingPercent: number;
  refill: { percent: number; at: number } | null;
  members: PoolMember[];
};

type AccountReport = {
  driver: string;
  email?: string | undefined;
  workspaceId?: string | undefined;
  usageLimits?: ServerProviderUsageLimits | null | undefined;
};

type Candidate = {
  driver: string;
  email: string | undefined;
  plan: string | undefined;
  environments: string[];
  sourceLabel: string | null;
  limits: ServerProviderUsageLimits;
};

function accountKey(driver: string, email: string | undefined, limits?: ServerProviderUsageLimits | null) {
  const normalizedEmail = email?.trim().toLowerCase();
  if (normalizedEmail) return `${driver}:${normalizedEmail}`;
  return limits?.credentialFingerprint ? `${driver}:credential:${limits.credentialFingerprint}` : null;
}

function accountKeyResolver(reports: Iterable<AccountReport>) {
  const workspaces = new Map<string, Set<string>>();
  for (const report of reports) {
    const key = accountKey(report.driver, report.email, report.usageLimits);
    if (key && report.workspaceId) workspaces.set(key, (workspaces.get(key) ?? new Set()).add(report.workspaceId));
  }
  return (report: AccountReport): string | null => {
    const key = accountKey(report.driver, report.email, report.usageLimits);
    if (!key) return null;
    if (report.workspaceId) return `${key}:${report.workspaceId}`;
    const known = workspaces.get(key);
    if (!known) return key;
    return known.size === 1 ? `${key}:${[...known][0]}` : null;
  };
}

function isKnownWindow(window: ServerProviderUsageWindow) {
  return window.kind in WINDOW_KIND_ORDER;
}

function withKnownWindows(limits: ServerProviderUsageLimits): ServerProviderUsageLimits {
  return { ...limits, windows: limits.windows.filter(isKnownWindow) };
}

function withoutResetCredits(limits: ServerProviderUsageLimits): ServerProviderUsageLimits {
  const { resetCredits: _resetCredits, ...rest } = limits;
  return rest;
}

function limitsNotice(limits: ServerProviderUsageLimits): string | null {
  if (limits.unavailable?.reason === 'unsupported') {
    return limits.unavailable.message ?? 'This account has no subscription limits.';
  }
  if (limits.unavailable?.reason === 'probeFailed') return limits.unavailable.message ?? 'Could not read limits.';
  return limits.windows.length === 0 ? 'No limits reported.' : null;
}

export function collectLimitAccounts(inputs: LimitEnvironment[]): LimitAccount[] {
  const accounts = new Map<string, Candidate>();
  const creditSources = new Map<string, Candidate>();
  const fresher = (next: Candidate, previous: Candidate) =>
    Date.parse(next.limits.checkedAt) > Date.parse(previous.limits.checkedAt);
  const merge = (key: string, next: Candidate) => {
    const previousCredit = creditSources.get(key);
    if (next.limits.resetCredits && (!previousCredit || fresher(next, previousCredit))) creditSources.set(key, next);
    const previous = accounts.get(key);
    if (!previous) {
      accounts.set(key, next);
      return;
    }
    const environments = [
      ...previous.environments,
      ...next.environments.filter(candidate => !previous.environments.includes(candidate)),
    ];
    const winner = fresher(next, previous) ? next : previous;
    const credits = creditSources.get(key)?.limits.resetCredits;
    accounts.set(key, {
      ...previous,
      plan: previous.plan ?? next.plan,
      environments,
      sourceLabel: environments.length > 0 ? null : (previous.sourceLabel ?? next.sourceLabel),
      limits: credits ? { ...winner.limits, resetCredits: credits } : withoutResetCredits(winner.limits),
    });
  };
  const resolveKey = accountKeyResolver(
    inputs.flatMap(input => [...input.native, ...input.sources.flatMap(source => source.accounts)]),
  );
  for (const input of inputs) {
    for (const provider of input.native) {
      if (!provider.usageLimits) continue;
      const limits = withKnownWindows(provider.usageLimits);
      if (limitsNotice(limits) !== null) continue;
      merge(resolveKey(provider) ?? `${input.environment}:${provider.instanceId}`, {
        driver: provider.driver,
        email: provider.email,
        plan: provider.plan,
        environments: [input.environment],
        sourceLabel: null,
        limits,
      });
    }
  }
  const labelEnvironment = inputs.length > 1;
  for (const input of inputs) {
    for (const source of input.sources) {
      const sourceLabel = labelEnvironment ? `${input.environment} · ${source.label}` : source.label;
      for (const account of source.accounts) {
        const limits = withKnownWindows(account.usageLimits);
        if (limitsNotice(limits) !== null) continue;
        const fallback = `${source.id}:${account.id}${account.workspaceId ? `:${account.workspaceId}` : ''}`;
        merge(resolveKey(account) ?? fallback, {
          driver: account.driver,
          email: account.email,
          plan: account.plan,
          environments: [],
          sourceLabel,
          limits,
        });
      }
    }
  }
  return [...accounts].map(([key, candidate]) => ({
    key,
    driver: candidate.driver,
    ...(candidate.email === undefined ? {} : { email: candidate.email }),
    ...(candidate.plan === undefined ? {} : { plan: candidate.plan }),
    via:
      candidate.environments.length > 0
        ? candidate.environments
        : candidate.sourceLabel === null
          ? []
          : [candidate.sourceLabel],
    checkedAt: candidate.limits.checkedAt,
    usageLimits: candidate.limits,
  }));
}

function resetMillis(window: ServerProviderUsageWindow): number | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

function elapsedShare(window: ServerProviderUsageWindow, now: number): number | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null || window.windowDurationMins === undefined) return null;
  const length = window.windowDurationMins * MINUTE;
  if (length <= 0) return null;
  return Math.max(0, Math.min(1, (length - (resetsAt - now)) / length));
}

function remainingPercent(window: ServerProviderUsageWindow): number {
  return Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)));
}

function paceRemainingPercent(window: ServerProviderUsageWindow, now: number): number | null {
  const elapsed = elapsedShare(window, now);
  return elapsed === null ? null : Math.round((1 - elapsed) * 100);
}

function paceOfShares(usedPercent: number, elapsed: number): 'ahead' | 'on' | 'under' {
  const gap = usedPercent - elapsed * 100;
  if (gap > 5) return 'ahead';
  if (gap < -5) return 'under';
  return 'on';
}

function paceOf(window: ServerProviderUsageWindow, now: number) {
  const elapsed = elapsedShare(window, now);
  return elapsed === null ? null : paceOfShares(window.usedPercent, elapsed);
}

function poolKey(driver: string, window: ServerProviderUsageWindow): string {
  return driver === 'codex' ? window.kind : `${window.kind}:${window.id}`;
}

function resetPassed(account: LimitAccount, now: number): LimitAccount {
  const windows = account.usageLimits.windows.map(window => {
    const at = resetMillis(window);
    if (at === null || at > now) return window;
    const { resetsAt: _resetsAt, ...rest } = window;
    return { ...rest, usedPercent: 0 };
  });
  return { ...account, usageLimits: { ...account.usageLimits, windows } };
}

type Member = { account: LimitAccount; window: ServerProviderUsageWindow; refillPercent: number };

function poolMember(account: LimitAccount, reported: ServerProviderUsageWindow, now: number): Member {
  const spentWeekly =
    reported.kind === 'session'
      ? account.usageLimits.windows.find(
          window =>
            window.usedPercent >= 100 &&
            (account.driver === 'claudeAgent'
              ? window.id === 'seven_day'
              : account.driver === 'codex' && window.kind === 'weekly'),
        )
      : undefined;
  if (!spentWeekly) return { account, window: reported, refillPercent: reported.usedPercent };

  const weeklyReset = resetMillis(spentWeekly);
  const sessionReset = resetMillis(reported);
  const cutoff = Math.max(now, Date.parse(account.usageLimits.checkedAt));
  let resetsAt: string | undefined;
  let refillPercent = 0;
  if (weeklyReset !== null && weeklyReset > cutoff && (sessionReset === null || sessionReset <= cutoff)) {
    resetsAt = spentWeekly.resetsAt;
    refillPercent = 100;
  } else if (weeklyReset !== null && sessionReset !== null && weeklyReset > cutoff && sessionReset > cutoff) {
    if (sessionReset <= weeklyReset) {
      resetsAt = spentWeekly.resetsAt;
      refillPercent = 100;
    } else if (reported.usedPercent >= 100) {
      resetsAt = reported.resetsAt;
      refillPercent = 100;
    } else {
      resetsAt = spentWeekly.resetsAt;
      refillPercent = 100 - Math.max(0, Math.min(100, reported.usedPercent));
    }
  }
  const { resetsAt: _resetsAt, windowDurationMins: _windowDurationMins, ...rest } = reported;
  return {
    account,
    window: { ...rest, usedPercent: 100, ...(resetsAt === undefined ? {} : { resetsAt }) },
    refillPercent,
  };
}

type PoolWindow = {
  id: string;
  kind: ServerProviderUsageWindowKind;
  label: string;
  members: Member[];
  columns: number;
  remainingPercent: number;
  resets: Array<{ at: number; restoresPercent: number }>;
};

function poolWindows(accounts: LimitAccount[], now: number): PoolWindow[] {
  const byKey = new Map<string, Member[]>();
  for (const account of accounts) {
    for (const reported of account.usageLimits.windows) {
      const member = poolMember(account, reported, now);
      const { window } = member;
      const pooled = poolKey(account.driver, window);
      const key = byKey.get(pooled)?.some(existing => existing.account === account)
        ? `${window.kind}:${window.id}`
        : pooled;
      const list = byKey.get(key);
      if (list) list.push(member);
      else byKey.set(key, [member]);
    }
  }
  const pools = [...byKey].map(([key, members]): PoolWindow => {
    const first = members[0]!;
    const usedPercent = members.reduce((sum, member) => sum + member.window.usedPercent, 0) / members.length;
    const resets = members
      .flatMap(member => {
        const at = resetMillis(member.window);
        return at === null ? [] : [{ at, restoresPercent: Math.round(member.refillPercent / members.length) }];
      })
      .sort((left, right) => left.at - right.at);
    return {
      id: first.account.driver === 'codex' ? key : first.window.id,
      kind: first.window.kind,
      label: first.window.label,
      members,
      columns: accounts.length,
      remainingPercent: Math.round(100 - usedPercent),
      resets,
    };
  });
  return pools.sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind]);
}

function displayWindows(driver: string, windows: PoolWindow[]): PoolWindow[] {
  if (driver === 'antigravity') {
    const base = (id: string) => id.replace(/-(5h|weekly|quota)$/, '');
    return [...windows].sort(
      (left, right) =>
        Number(!left.id.startsWith('gemini-')) - Number(!right.id.startsWith('gemini-')) ||
        base(left.id).localeCompare(base(right.id)) ||
        WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind],
    );
  }
  if (driver !== 'cursor') return windows;
  const rank = (id: string) => {
    const index = CURSOR_WINDOW_LABELS.findIndex(entry => entry.id === id);
    return index < 0 ? CURSOR_WINDOW_LABELS.length : index;
  };
  const hasBothPools =
    windows.some(window => window.id === 'autoPercentUsed') && windows.some(window => window.id === 'apiPercentUsed');
  return windows
    .filter(window => !hasBothPools || window.id !== 'totalPercentUsed')
    .sort((left, right) => rank(left.id) - rank(right.id))
    .map(window => ({
      ...window,
      label: CURSOR_WINDOW_LABELS.find(entry => entry.id === window.id)?.label ?? window.label,
    }));
}

function memberSortKey(account: LimitAccount) {
  return (account.email?.trim() || account.key).toLowerCase();
}

export function collectLimitPools(accounts: LimitAccount[], nowMs: number): LimitPool[] {
  const byDriver = new Map<string, LimitAccount[]>();
  for (const account of accounts.map(entry => resetPassed(entry, nowMs))) {
    const list = byDriver.get(account.driver);
    if (list) list.push(account);
    else byDriver.set(account.driver, [account]);
  }
  return [...byDriver].flatMap(([driver, members]) => {
    const orderWindow = members
      .flatMap(account => account.usageLimits.windows)
      .sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind])[0];
    const orderReset = (account: LimitAccount) => {
      const window = account.usageLimits.windows.find(
        candidate => orderWindow && poolKey(driver, candidate) === poolKey(driver, orderWindow),
      );
      return (window ? resetMillis(poolMember(account, window, nowMs).window) : null) ?? Number.POSITIVE_INFINITY;
    };
    const sorted = [...members].sort(
      (left, right) =>
        orderReset(left) - orderReset(right) ||
        memberSortKey(left).localeCompare(memberSortKey(right)) ||
        left.key.localeCompare(right.key),
    );
    return displayWindows(driver, poolWindows(sorted, nowMs)).map((window): LimitPool => {
      const nextRefill = window.resets.find(reset => reset.restoresPercent > 0);
      return {
        id: `${driver}:${window.kind}:${window.id}`,
        label: window.label,
        kind: window.kind,
        driver,
        remainingPercent: window.remainingPercent,
        refill: nextRefill && window.columns > 1 ? { percent: nextRefill.restoresPercent, at: nextRefill.at } : null,
        members: [...window.members]
          .sort(
            (left, right) =>
              memberSortKey(left.account).localeCompare(memberSortKey(right.account)) ||
              left.account.key.localeCompare(right.account.key),
          )
          .map(member => ({
            accountKey: member.account.key,
            ...(member.account.email === undefined ? {} : { email: member.account.email }),
            remainingPercent: remainingPercent(member.window),
            resetsAt: resetMillis(member.window),
            paceRemainingPercent: paceRemainingPercent(member.window, nowMs),
            pace: paceOf(member.window, nowMs),
            exhausted: member.window.usedPercent >= 100,
          })),
      };
    });
  });
}
