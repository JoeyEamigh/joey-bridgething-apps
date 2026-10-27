import { useState } from 'react';
import type { Controls } from '../App';
import { duration } from '../format';
import type { HubState } from '../hub';

const VISIBLE = 4;

export function Working({ state, bind }: { state: HubState; bind(controls: Controls): void }) {
  const [offset, setOffset] = useState(0);
  const items = state.working;
  const start = Math.min(offset, Math.max(0, items.length - VISIBLE));

  bind({
    wheel(step) {
      setOffset(value => Math.max(0, Math.min(items.length - VISIBLE, value + step)));
    },
  });

  return (
    <div className="working">
      {items.slice(start, start + VISIBLE).map(item => (
        <div className={`job${item.waiting ? ' waiting' : ''}`} key={item.key}>
          <div className="state">
            <span className="elapsed num">{duration(state.now - item.since)}</span>
            <span>{item.waiting ? 'Waiting' : 'Working'}</span>
          </div>
          <div className="what">
            <div className="job-title">{item.title}</div>
            <div className="job-where">{[item.repo, item.branch].filter(Boolean).join(' / ')}</div>
          </div>
          <div className="side">
            <span className={item.envOnline ? undefined : 'stale'}>{item.envLabel}</span>
            {item.background ? <span>{item.background}</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}
