import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Mascot, moodFor } from './components/Mascot';
import { PromptModal, type Choice } from './components/Prompt';
import { useLink, useNow } from './link';
import { AmbientScreen } from './screens/Ambient';
import { MachineScreen } from './screens/Machine';
import { SessionsScreen } from './screens/Sessions';
import { UsageScreen } from './screens/Usage';

const SCREENS = ['usage', 'machine', 'sessions', 'ambient'] as const;
type Screen = (typeof SCREENS)[number];

const CARD_STRIDE = 384;
const ROW_STRIDE = 86;
const LIST_HEIGHT = 404;
const IDLE_TO_AMBIENT_MS = 90_000;
const PRESENCE_EVERY_MS = 20_000;

function useScroll(screen: Screen, max: number): [number, (delta: number) => void] {
  const [scroll, setScroll] = useState(0);
  useEffect(() => setScroll(0), [screen]);
  const nudge = useCallback((delta: number) => setScroll(at => Math.max(0, Math.min(max, at + delta))), [max]);
  useEffect(() => setScroll(at => Math.min(at, Math.max(0, max))), [max]);
  return [scroll, nudge];
}

export default function App() {
  const link = useLink();
  const now = useNow(link.offsetMs);
  const [screen, setScreen] = useState<Screen | null>(null);
  const [choice, setChoice] = useState<Choice>('allow');
  const lastTouch = useRef(Date.now());
  const lastPresent = useRef(0);

  const home = (SCREENS as readonly string[]).includes(link.config.home ?? '') ? (link.config.home as Screen) : 'usage';
  const ambientIdle = link.config.ambientIdle !== 'false';
  const current = screen ?? home;
  const prompt = link.prompts[0] ?? null;

  const scrollMax =
    current === 'usage'
      ? Math.max(0, link.accounts.length * CARD_STRIDE - 788)
      : current === 'sessions'
        ? Math.max(0, link.sessions.length * ROW_STRIDE - 8 - LIST_HEIGHT)
        : 0;
  const [scroll, nudge] = useScroll(current, scrollMax);

  const touched = useCallback(() => {
    lastTouch.current = Date.now();
    if (Date.now() - lastPresent.current < PRESENCE_EVERY_MS) return;
    lastPresent.current = Date.now();
    link.present();
  }, [link]);

  const go = useCallback(
    (next: Screen) => {
      touched();
      setScreen(next);
    },
    [touched],
  );

  useEffect(() => setChoice('allow'), [prompt?.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      touched();
      if (prompt) {
        if (event.key === '1') return setChoice('allow');
        if (event.key === '2') return setChoice('deny');
        if (event.key === 'Enter' || event.key === 'm') return link.answer(prompt.id, choice);
        if (event.key === 'Escape') return setChoice(at => (at === 'allow' ? 'deny' : 'allow'));
        return;
      }
      const preset = SCREENS[Number(event.key) - 1];
      if (preset) return setScreen(preset);
      if (event.key === 'm') return setScreen(at => SCREENS[(SCREENS.indexOf(at ?? home) + 1) % SCREENS.length]!);
      if (event.key === 'Escape') return setScreen('usage');
      if (event.key === 'r') link.refresh();
    };
    const onWheel = (event: WheelEvent) => {
      touched();
      if (prompt) return setChoice(event.deltaX > 0 ? 'deny' : 'allow');
      nudge(event.deltaX * (current === 'usage' ? 1.6 : 1.1));
    };
    const onPointer = () => touched();

    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, [choice, current, home, link, nudge, prompt, touched]);

  useEffect(() => {
    if (!ambientIdle) return;
    const timer = setInterval(() => {
      if (Date.now() - lastTouch.current > IDLE_TO_AMBIENT_MS) setScreen('ambient');
    }, 5_000);
    return () => clearInterval(timer);
  }, [ambientIdle]);

  const worst = useMemo(() => {
    const active = link.accounts.flatMap(account => account.limits.filter(limit => limit.isActive));
    return active.length > 0 ? Math.max(...active.map(limit => limit.percent)) : null;
  }, [link.accounts]);

  const waiting = link.sessions.filter(session => session.status === 'waiting').length;

  if (current === 'ambient' && !prompt) {
    return (
      <main className="h-full w-full bg-bg p-6 text-off-white" onPointerDown={() => go('usage')}>
        <AmbientScreen accounts={link.accounts} sessions={link.sessions} now={now} />
      </main>
    );
  }

  return (
    <main className="relative flex h-full w-full flex-col bg-bg px-5 py-4 text-off-white">
      <header className="flex shrink-0 items-center gap-4 pb-3">
        <Mascot mood={moodFor(worst)} size={44} />

        <nav className="flex gap-1">
          {SCREENS.map((name, index) => (
            <button
              key={name}
              onClick={() => go(name)}
              className={`border px-3 py-1.5 font-mono text-hint tracking-[0.16em] uppercase transition ${
                current === name ? 'border-accent bg-accent text-screen' : 'border-edge text-soft'
              }`}>
              <span className="mr-2 opacity-50">{index + 1}</span>
              {name}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-4 font-mono text-eyebrow">
          {waiting > 0 && <span className="text-warn">{waiting} waiting</span>}
          {link.hook?.enabled && (
            <span className={link.hook.listening ? 'text-ok' : 'text-err'}>
              {link.hook.listening ? 'dial answers' : 'hook down'}
            </span>
          )}
          {!link.hasExtension && <span className="text-warn">no host</span>}
          <span className={link.polling ? 'text-accent' : 'text-dim'}>{link.polling ? 'reading' : 'idle'}</span>
        </div>
      </header>

      <div className="min-h-0 flex-1">
        {current === 'usage' && (
          <UsageScreen accounts={link.accounts} now={now} scroll={scroll} hasHost={link.hasExtension} />
        )}
        {current === 'machine' && <MachineScreen machine={link.machine} hasHost={link.hasExtension} />}
        {current === 'sessions' && (
          <SessionsScreen sessions={link.sessions} now={now} scroll={scroll} hasHost={link.hasExtension} />
        )}
        {current === 'ambient' && <AmbientScreen accounts={link.accounts} sessions={link.sessions} now={now} />}
      </div>

      {prompt && (
        <PromptModal
          prompt={prompt}
          queued={link.prompts.length}
          now={now}
          choice={choice}
          onChoose={setChoice}
          onAnswer={decision => link.answer(prompt.id, decision)}
        />
      )}
    </main>
  );
}
