import type { ExtraUsageView, LimitView, SpendView } from '../shared/protocol.ts';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';

interface RawScope {
  model?: { id?: string | null; display_name?: string | null } | null;
  surface?: string | null;
}

interface RawLimit {
  kind?: string;
  group?: string;
  percent?: number;
  severity?: string;
  resets_at?: string | null;
  scope?: RawScope | null;
  is_active?: boolean;
}

interface RawUsage {
  limits?: RawLimit[];
  extra_usage?: {
    is_enabled?: boolean;
    utilization?: number | null;
    used_credits?: number | null;
    monthly_limit?: number | null;
    currency?: string | null;
    disabled_reason?: string | null;
  } | null;
  spend?: {
    enabled?: boolean;
    percent?: number;
    severity?: string;
    used?: { amount_minor?: number; currency?: string; exponent?: number } | null;
    cap?: { amount_minor?: number } | null;
  } | null;
}

export interface UsageReading {
  limits: LimitView[];
  extra: ExtraUsageView | null;
  spend: SpendView | null;
}

export class UsageError extends Error {
  constructor(
    readonly kind: 'unauthorized' | 'network' | 'rate-limited',
    message: string,
    readonly retryAfterMs = 0,
  ) {
    super(message);
  }
}

const DEFAULT_BACKOFF_MS = 5 * 60 * 1000;

function backoff(response: Response): number {
  const header = Number(response.headers.get('retry-after'));
  return Number.isFinite(header) && header > 0 ? header * 1000 : DEFAULT_BACKOFF_MS;
}

function titleize(kind: string): string {
  return kind
    .split(/[_-]/)
    .filter(Boolean)
    .map(word => word[0]!.toUpperCase() + word.slice(1))
    .join(' ');
}

function limitLabel(limit: RawLimit): string {
  const scoped = limit.scope?.model?.display_name ?? limit.scope?.surface ?? null;
  if (scoped) return scoped;
  if (limit.kind === 'session') return 'Session';
  if (limit.kind === 'weekly_all') return 'Weekly';
  if (limit.kind === 'weekly_scoped') return 'Weekly scoped';
  return titleize(limit.kind ?? 'limit');
}

function millis(value: string | null | undefined): number | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

function shape(raw: RawUsage): UsageReading {
  const limits = (raw.limits ?? []).map(limit => ({
    kind: limit.kind ?? 'unknown',
    group: limit.group ?? limit.kind ?? 'other',
    label: limitLabel(limit),
    percent: Math.max(0, Math.round(limit.percent ?? 0)),
    severity: limit.severity ?? 'normal',
    resetsAt: millis(limit.resets_at),
    isActive: limit.is_active === true,
  }));

  const rawExtra = raw.extra_usage ?? null;
  const extra: ExtraUsageView | null = rawExtra
    ? {
        enabled: rawExtra.is_enabled === true,
        utilization: rawExtra.utilization ?? null,
        usedCredits: rawExtra.used_credits ?? null,
        monthlyLimit: rawExtra.monthly_limit ?? null,
        currency: rawExtra.currency ?? 'USD',
        disabledReason: rawExtra.disabled_reason ?? null,
      }
    : null;

  const rawSpend = raw.spend ?? null;
  const spend: SpendView | null = rawSpend
    ? {
        enabled: rawSpend.enabled === true,
        percent: Math.max(0, Math.round(rawSpend.percent ?? 0)),
        severity: rawSpend.severity ?? 'normal',
        usedMinor: rawSpend.used?.amount_minor ?? 0,
        currency: rawSpend.used?.currency ?? 'USD',
        exponent: rawSpend.used?.exponent ?? 2,
        capMinor: rawSpend.cap?.amount_minor ?? null,
      }
    : null;

  return { limits, extra, spend };
}

export async function fetchUsage(accessToken: string, signal?: AbortSignal): Promise<UsageReading> {
  let response: Response;
  try {
    response = await fetch(USAGE_URL, {
      headers: { authorization: `Bearer ${accessToken}`, 'anthropic-beta': OAUTH_BETA },
      signal,
    });
  } catch (err) {
    throw new UsageError('network', err instanceof Error ? err.message : String(err));
  }

  if (response.status === 429) {
    await response.body?.cancel();
    throw new UsageError('rate-limited', 'the usage endpoint is rate limiting', backoff(response));
  }
  if (response.status === 401 || response.status === 403) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new UsageError('unauthorized', body?.error?.message ?? `http ${response.status}`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new UsageError('network', `http ${response.status}`);
  }
  return shape((await response.json()) as RawUsage);
}
