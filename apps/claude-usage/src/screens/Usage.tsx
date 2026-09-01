import type { AccountView, LimitView } from '../../shared/protocol.ts';
import { Bar } from '../components/Bar';
import { agoText, money, untilText } from '../format';

function LimitRow({ limit, now }: { limit: LimitView; now: number }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span
          className={`truncate font-mono text-hint tracking-[0.16em] uppercase ${
            limit.isActive ? 'text-near' : 'text-dim'
          }`}>
          {limit.label}
        </span>
        <span className="shrink-0 font-display text-row-lg tabular-nums">{limit.percent}%</span>
      </div>
      <Bar percent={limit.percent} severity={limit.severity} muted={!limit.isActive} />
      <div className="font-mono text-eyebrow text-dim">
        {limit.resetsAt ? `resets in ${untilText(limit.resetsAt, now)}` : 'no reset window'}
      </div>
    </div>
  );
}

function subline(account: AccountView): string {
  const dir = account.dir.slice(account.dir.lastIndexOf('/') + 1);
  const tier = account.tier?.replace(/^default_claude_/, '').replace(/_/g, ' ') ?? null;
  return tier ? `${dir} · ${tier}` : dir;
}

function Card({ account, now, wide }: { account: AccountView; now: number; wide: boolean }) {
  const extra = account.extra;
  const spend = account.spend;

  return (
    <section className={`flex shrink-0 flex-col gap-4 border border-rule bg-screen p-4 ${wide ? 'w-124' : 'w-93'}`}>
      <header className="flex items-baseline justify-between gap-3 border-b border-rule pb-3">
        <div className="min-w-0">
          <div className="truncate font-display text-title tracking-display">{account.label}</div>
          <div className="truncate font-mono text-eyebrow text-dim">{subline(account)}</div>
        </div>
        {account.plan && (
          <span className="shrink-0 border border-edge px-2 py-0.5 font-mono text-eyebrow tracking-[0.16em] text-soft uppercase">
            {account.plan}
          </span>
        )}
      </header>

      {account.limits.length > 0 ? (
        <div className="flex flex-1 flex-col justify-evenly gap-3.5">
          {account.limits.map(limit => (
            <LimitRow key={`${limit.kind}:${limit.label}`} limit={limit} now={now} />
          ))}
        </div>
      ) : (
        <div className="py-6 text-center font-mono text-body text-dim">
          {account.stale ? 'no reading yet' : 'waiting for the first reading'}
        </div>
      )}

      {(extra?.enabled || spend?.enabled) && (
        <div className="flex items-baseline justify-between border-t border-rule pt-3 font-mono text-hint">
          <span className="text-dim">extra usage</span>
          <span className="text-near tabular-nums">
            {spend ? money(spend.usedMinor, spend.exponent, spend.currency) : `${extra?.usedCredits ?? 0}`}
            {extra?.utilization !== null && extra?.utilization !== undefined
              ? ` · ${Math.round(extra.utilization)}%`
              : ''}
          </span>
        </div>
      )}

      <footer className="mt-auto flex items-baseline justify-between border-t border-rule pt-3 font-mono text-eyebrow">
        {account.stale ? (
          <span className="text-warn">
            stale · {account.stale.reason === 'expired' ? 'run claude to refresh' : account.stale.detail}
          </span>
        ) : (
          <span className="text-dim">live</span>
        )}
        <span className="text-dim tabular-nums">{account.readingAt ? agoText(account.readingAt, now) : 'never'}</span>
      </footer>
    </section>
  );
}

export function UsageScreen({
  accounts,
  now,
  scroll,
  hasHost,
}: {
  accounts: AccountView[];
  now: number;
  scroll: number;
  hasHost: boolean;
}) {
  if (accounts.length === 0) {
    return (
      <div className="grid h-full place-items-center font-mono text-body text-dim">
        {hasHost ? 'no claude accounts found on the host' : 'open the bridgething desktop app to see usage'}
      </div>
    );
  }

  return (
    <div className="h-full overflow-hidden">
      <div
        className="flex h-full gap-3 will-change-transform"
        style={{ transform: `translateX(${-scroll}px)`, transition: 'transform 180ms ease-out' }}>
        {accounts.map(account => (
          <Card key={account.id} account={account} now={now} wide={accounts.length === 1} />
        ))}
      </div>
    </div>
  );
}
