import { useState } from 'react';
import type { Controls } from '../App';
import { duration } from '../format';
import type { HubState } from '../hub';

const VISIBLE = 3;

function localPart(email: string | undefined): string | null {
  return email ? email.split('@')[0]! : null;
}

export function Limits({
  state,
  bind,
  showNames,
}: {
  state: HubState;
  bind(controls: Controls): void;
  showNames: boolean;
}) {
  const [offset, setOffset] = useState(0);
  const pools = state.limits.pools;
  const columns: string[] = [];
  const emails = new Map<string, string | undefined>();
  for (const pool of pools) {
    for (const member of pool.members) {
      if (!columns.includes(member.accountKey)) columns.push(member.accountKey);
      if (member.email) emails.set(member.accountKey, member.email);
    }
  }
  const start = Math.min(offset, Math.max(0, pools.length - VISIBLE));
  const shown = pools.slice(start, start + VISIBLE);
  const allOffline = state.environments.length > 0 && state.environments.every(env => env.status !== 'online');
  const newest = Math.max(0, ...state.environments.map(env => env.onlineAt ?? 0));

  bind({
    wheel(step) {
      setOffset(value => Math.max(0, Math.min(pools.length - VISIBLE, value + step)));
    },
  });

  if (!pools.length) {
    return (
      <div className="empty">
        <div className="big">{allOffline || !newest ? 'Waiting for limits' : 'No subscription limits'}</div>
      </div>
    );
  }

  return (
    <div className={`limits${showNames ? ' named' : ''}`} style={{ ['--rows' as string]: VISIBLE }}>
      {showNames ? (
        <div className="names" style={{ ['--cols' as string]: columns.length }}>
          {columns.map(key => (
            <span key={key}>{localPart(emails.get(key)) ?? ''}</span>
          ))}
        </div>
      ) : null}
      {shown.map((pool, row) => (
        <div className="pool" key={pool.id}>
          <div className="left">
            <div className="big num">
              {pool.remainingPercent}
              <small>%</small>
            </div>
            <div className="name">{pool.label}</div>
            {row === 0 && allOffline && newest ? (
              <div className="stale">{duration(state.now - newest)} ago</div>
            ) : pool.refill && pool.refill.at > state.now ? (
              <div className="refill">
                <b>+{pool.refill.percent}%</b> in {duration(pool.refill.at - state.now)}
              </div>
            ) : null}
          </div>
          <div className="tanks" style={{ ['--cols' as string]: columns.length }}>
            {columns.map(key => {
              const member = pool.members.find(entry => entry.accountKey === key);
              if (!member) return <div className="tank absent" key={key} />;
              const remaining = member.remainingPercent;
              const classes = ['tank', member.exhausted ? 'spent' : remaining <= 20 ? 'low' : ''].join(' ');
              return (
                <div className={classes} key={key}>
                  {member.exhausted ? null : <div className="fill" style={{ height: `${remaining}%` }} />}
                  {member.paceRemainingPercent !== null && !member.exhausted ? (
                    <div className="pace" style={{ bottom: `${member.paceRemainingPercent}%` }} />
                  ) : null}
                  <span className="pct num">{remaining}</span>
                  {member.resetsAt && member.resetsAt > state.now && remaining < 100 ? (
                    <span className="reset">{duration(member.resetsAt - state.now)}</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
