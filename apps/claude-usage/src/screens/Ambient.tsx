import type { AccountView, SessionView } from '../../shared/protocol.ts';
import { Mascot } from '../components/Mascot';
import { clockText, dateText, meridiem, untilText } from '../format';

function headline(sessions: SessionView[], accounts: AccountView[], now: number): string {
  const waiting = sessions.filter(session => session.status === 'waiting').length;
  if (waiting > 0) return `${waiting} session${waiting === 1 ? '' : 's'} stopped at a tool call`;

  const running = sessions.filter(session => session.status === 'running').length;
  if (running > 0) return `${running} session${running === 1 ? '' : 's'} running`;

  const soonest = accounts
    .flatMap(account => account.limits.filter(limit => limit.isActive && limit.resetsAt))
    .sort((a, b) => a.resetsAt! - b.resetsAt!)[0];
  if (soonest) return `${soonest.label.toLowerCase()} resets in ${untilText(soonest.resetsAt!, now)}`;
  return 'nothing needs a person';
}

export function AmbientScreen({
  accounts,
  sessions,
  now,
}: {
  accounts: AccountView[];
  sessions: SessionView[];
  now: number;
}) {
  const active = accounts
    .flatMap(account => account.limits.filter(limit => limit.isActive))
    .reduce<number | null>((into, limit) => Math.max(into ?? 0, limit.percent), null);

  return (
    <div className="flex h-full items-center justify-center gap-16">
      <div className="flex flex-col items-end">
        <div className="flex items-baseline gap-3">
          <span className="font-display text-[7rem] leading-none font-light tracking-display tabular-nums">
            {clockText(now)}
          </span>
          <span className="font-mono text-title text-dim">{meridiem(now)}</span>
        </div>
        <div className="mt-1 font-display text-title text-soft tracking-display">{dateText(now)}</div>
        <div className="mt-4 font-mono text-body text-soft">{headline(sessions, accounts, now)}</div>
        {active !== null && (
          <div className="mt-1 font-mono text-eyebrow tracking-[0.2em] text-dim uppercase">
            {active}% of the active limit
          </div>
        )}
      </div>
      <Mascot mood="asleep" size={176} />
    </div>
  );
}
