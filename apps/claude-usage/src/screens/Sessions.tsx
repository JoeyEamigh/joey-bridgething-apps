import type { SessionView } from '../../shared/protocol.ts';
import { agoText, compact, modelName } from '../format';

const STATUS_DOT: Record<SessionView['status'], string> = {
  running: 'bg-ok',
  waiting: 'bg-warn',
  idle: 'bg-dim',
};

const STATUS_TEXT: Record<SessionView['status'], string> = {
  running: 'running',
  waiting: 'at a tool call',
  idle: 'idle',
};

function Row({ session, now, peak }: { session: SessionView; now: number; peak: number }) {
  const against = session.contextLimit ?? peak;
  const fill = Math.min(100, (session.contextTokens / against) * 100);
  const tight = session.contextLimit !== null && fill > 80;
  return (
    <div className="flex items-center gap-3 border border-rule bg-screen px-3 py-2.5">
      <span
        className={`h-2.5 w-2.5 shrink-0 ${STATUS_DOT[session.status]} ${
          session.status === 'running' ? 'pulse-soft' : ''
        }`}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate font-display text-row-lg tracking-tight-1">
          {session.title ?? `${session.project} session`}
        </div>
        <div className="mt-1.5 flex items-center gap-2.5 font-mono text-eyebrow text-dim">
          <span className="shrink-0 text-soft">{session.project}</span>
          {session.branch && session.branch !== 'HEAD' && <span className="shrink-0">{session.branch}</span>}
          {session.model && <span className="shrink-0">{modelName(session.model)}</span>}
          <div className="ml-1 h-1 w-28 shrink-0 bg-neutral-soft">
            <div className={`h-full ${tight ? 'bg-warn' : 'bg-accent'}`} style={{ width: `${fill}%` }} />
          </div>
          <span className={`shrink-0 tabular-nums ${tight ? 'text-warn' : ''}`}>
            {session.contextLimit
              ? `${Math.round(fill)}% of ${compact(session.contextLimit)}`
              : `${compact(session.contextTokens)} ctx`}
          </span>
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className={`font-mono text-eyebrow ${session.status === 'waiting' ? 'text-warn' : 'text-dim'}`}>
          {STATUS_TEXT[session.status]}
        </div>
        <div className="font-mono text-eyebrow text-dim tabular-nums">{agoText(session.lastAt, now)}</div>
      </div>
    </div>
  );
}

export function SessionsScreen({
  sessions,
  now,
  scroll,
  hasHost,
}: {
  sessions: SessionView[];
  now: number;
  scroll: number;
  hasHost: boolean;
}) {
  if (sessions.length === 0) {
    return (
      <div className="grid h-full place-items-center font-mono text-body text-dim">
        {hasHost ? 'nothing running on this machine' : 'open the bridgething desktop app to see sessions'}
      </div>
    );
  }

  const peak = Math.max(...sessions.map(session => session.contextTokens), 1);

  return (
    <div className="h-full overflow-hidden">
      <div
        className="flex flex-col gap-2 will-change-transform"
        style={{ transform: `translateY(${-scroll}px)`, transition: 'transform 180ms ease-out' }}>
        {sessions.map(session => (
          <Row key={session.id} session={session} now={now} peak={peak} />
        ))}
      </div>
    </div>
  );
}
