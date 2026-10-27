import { useEffect, useRef, useState } from 'react';
import { duration } from './format';
import type { HubState } from './hub';
import { Inbox } from './screens/Inbox';
import { Limits } from './screens/Limits';
import { Usage } from './screens/Usage';
import { useHub } from './useHub';

export type Controls = { wheel?(step: number): void; enter?(): void; back?(): boolean };

const SCREENS = ['inbox', 'limits', 'tokens', 'cost'] as const;
type Screen = (typeof SCREENS)[number];

function staleLabel(state: HubState): string | null {
  const offline = state.environments.filter(env => env.status !== 'online' && env.onlineAt);
  if (!offline.length || offline.length === state.environments.length) {
    const newest = Math.max(0, ...state.environments.map(env => env.onlineAt ?? 0));
    if (!offline.length || !newest) return null;
    return `${duration(state.now - newest)} ago`;
  }
  return offline.map(env => `${env.label} ${duration(state.now - env.onlineAt!)} ago`).join(', ');
}

export default function App() {
  const { state, showNames } = useHub();
  const [screen, setScreen] = useState<Screen>('inbox');
  const controls = useRef<Controls>({});
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!state.error) return;
    setToast(state.error);
    const timer = setTimeout(() => setToast(null), 5_000);
    return () => clearTimeout(timer);
  }, [state.error]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const preset = ['1', '2', '3', '4'].indexOf(event.key);
      if (preset >= 0) {
        setScreen(SCREENS[preset]!);
        return;
      }
      if (event.repeat) return;
      if (event.key === 'Enter') controls.current.enter?.();
      if (event.key === 'Escape') {
        if (!controls.current.back?.()) setScreen('inbox');
      }
    };
    const wheel = (event: WheelEvent) => {
      if (!event.deltaX) return;
      event.preventDefault();
      controls.current.wheel?.(Math.sign(event.deltaX));
    };
    window.addEventListener('keydown', key);
    window.addEventListener('wheel', wheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('wheel', wheel);
    };
  }, []);

  const bind = (next: Controls) => {
    controls.current = next;
  };
  const stale = staleLabel(state);

  let body;
  if (state.phase === 'signed-out') {
    body = (
      <div className="empty">
        <div className="big">Sign in to T3 Code</div>
        <div className="small">Open this app's settings in the bridgething app on your phone.</div>
      </div>
    );
  } else if (state.phase === 'starting') {
    body = null;
  } else if (screen === 'inbox') {
    body = <Inbox state={state} bind={bind} />;
  } else if (screen === 'limits') {
    body = <Limits state={state} bind={bind} showNames={showNames} />;
  } else {
    body = <Usage state={state} bind={bind} unit={screen === 'tokens' ? 'tokens' : 'cost'} stale={stale} />;
  }

  return (
    <>
      <div className="presets">
        {SCREENS.map((name, index) => (
          <button key={name} type="button" onClick={() => setScreen(name)}>
            <i className={[screen === name ? 'on' : '', index === 0 && state.inbox.length ? 'call' : ''].join(' ')} />
          </button>
        ))}
      </div>
      {body}
      {toast ? <div className="toast">{toast}</div> : null}
    </>
  );
}
