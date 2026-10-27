import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Controls } from '../App';
import { duration } from '../format';
import type { HubState, InboxItem } from '../hub';
import { hub } from '../useHub';
import { Working } from './Working';

const KIND_LABEL = { approval: 'Approve', input: 'Answer', failed: 'Failed', limited: 'Limited', done: 'Your turn' };

const REQUEST_LABEL: Record<string, string> = {
  command: 'Run a command',
  'file-read': 'Read files',
  'file-change': 'Change files',
  'mcp-elicitation': 'Tool request',
  permission: 'Grant a permission',
};

const SNOOZE_MS = 60 * 60_000;

type Action = { label: string; primary: boolean; run(): Promise<boolean> };

function actionsFor(item: InboxItem): Action[] {
  if (item.attention.kind === 'approval') {
    return [
      { label: 'Deny', primary: false, run: () => hub.approve(item, false) },
      { label: 'Approve', primary: true, run: () => hub.approve(item, true) },
    ];
  }
  return [
    { label: 'Snooze 1h', primary: false, run: () => hub.snooze(item, SNOOZE_MS) },
    { label: 'Settle', primary: true, run: () => hub.settle(item) },
  ];
}

function Where({ item }: { item: InboxItem }) {
  const place = [item.repo, item.branch].filter(Boolean).join(' / ');
  return (
    <div className="where">
      {place}
      {item.pr ? (
        <span className={item.pr.checks ? `checks-${item.pr.checks}` : undefined}>
          {place ? '  ' : ''}#{item.pr.number}
        </span>
      ) : null}
    </div>
  );
}

function Options({
  labels,
  selected,
  onPick,
}: {
  labels: string[];
  selected: number | null;
  onPick(index: number): void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ up: false, down: false });

  function measure() {
    const element = list.current;
    if (!element) return;
    const up = element.scrollTop > 2;
    const down = element.scrollTop + element.clientHeight < element.scrollHeight - 2;
    setEdges(current => (current.up === up && current.down === down ? current : { up, down }));
  }

  useLayoutEffect(() => {
    const element = list.current;
    const target = element?.children[selected ?? 0] as HTMLElement | undefined;
    if (!element || !target) return;
    const top = target.offsetTop;
    const bottom = top + target.offsetHeight;
    const reveal = target.offsetHeight / 2;
    if (top - reveal < element.scrollTop) element.scrollTo({ top: Math.max(0, top - reveal), behavior: 'smooth' });
    else if (bottom + reveal > element.scrollTop + element.clientHeight) {
      element.scrollTo({ top: bottom + reveal - element.clientHeight, behavior: 'smooth' });
    }
    measure();
  }, [selected, labels.length]);

  return (
    <div
      ref={list}
      className={['opts', edges.up ? 'more-up' : '', edges.down ? 'more-down' : ''].join(' ')}
      onScroll={measure}>
      {labels.map((label, index) => (
        <button
          key={index}
          type="button"
          className={`opt${selected === index ? ' sel' : ''}`}
          onClick={() => onPick(index)}>
          {label}
        </button>
      ))}
    </div>
  );
}

type BodyProps = {
  item: InboxItem;
  now: number;
  selected: number | null;
  picked: string[];
  onPick(index: number): void;
};

function Body({ item, now, selected, picked, onPick }: BodyProps) {
  const detail = item.detail;
  if (item.attention.kind === 'approval') {
    if (detail?.type !== 'approval') return <div className="cmd quiet">Loading the request</div>;
    const summary = detail.text ?? REQUEST_LABEL[detail.kind] ?? detail.kind;
    if (!detail.command) return <div className="cmd">{summary}</div>;
    return (
      <div className="request">
        <div className="request-note">{summary}</div>
        <div className="cmd">{detail.command}</div>
      </div>
    );
  }
  if (item.attention.kind === 'input') {
    const question = detail?.type === 'input' ? detail.questions[picked.length] : null;
    if (!question) return <div className="cmd quiet">Loading the question</div>;
    return <Options labels={question.options.map(option => option.label)} selected={selected} onPick={onPick} />;
  }
  if (item.attention.kind === 'failed' || item.attention.kind === 'limited') {
    return (
      <div className="failure">
        {item.error ? <div className="error-line">{item.error}</div> : null}
        {item.resumesAt && item.resumesAt > now ? (
          <div className="facts">
            <span>
              <small>Resumes in</small>
              {duration(item.resumesAt - now)}
            </span>
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className="facts">
      {item.runMs ? (
        <span>
          <small>Ran for</small>
          {duration(item.runMs)}
        </span>
      ) : null}
      {item.pr?.checks ? (
        <span>
          <small>Checks</small>
          {item.pr.checks.charAt(0).toUpperCase() + item.pr.checks.slice(1)}
        </span>
      ) : null}
    </div>
  );
}

export function Inbox({ state, bind }: { state: HubState; bind(controls: Controls): void }) {
  const items = state.inbox;
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [picked, setPicked] = useState<string[]>([]);

  const found = items.findIndex(item => item.key === focusKey);
  const index = found >= 0 ? found : 0;
  const item = items[index] ?? null;

  useEffect(() => {
    for (const entry of items) {
      if (entry.attention.kind === 'approval' || entry.attention.kind === 'input') void hub.ensureDetail(entry);
    }
  }, [items]);

  useEffect(() => {
    setPicked([]);
  }, [item?.key]);

  const question =
    item?.attention.kind === 'input' && item.detail?.type === 'input' ? item.detail.questions[picked.length] : null;
  const actions = item && item.attention.kind !== 'input' ? actionsFor(item) : [];
  const choices = question ? question.options.length : actions.length;
  const selected = choices ? (cursor < 0 ? choices - 1 : Math.min(cursor, choices - 1)) : 0;
  const busy = item ? state.busy[item.key] === true : false;
  const offline = item ? !item.envOnline : false;

  async function execute(position: number) {
    if (!item || busy || offline) return;
    if (question) {
      const option = question.options[position];
      if (!option) return;
      const next = await hub.answerStep(item, picked, option.value);
      if (next) setPicked(next);
      setCursor(0);
      return;
    }
    await actions[position]?.run();
  }

  function move(step: number) {
    const target = selected + step;
    if (choices && target >= 0 && target < choices) {
      setCursor(target);
      return;
    }
    const next = items[index + step];
    if (!next) return;
    setFocusKey(next.key);
    setCursor(step > 0 ? 0 : -1);
  }

  bind({
    wheel: move,
    enter() {
      if (item && choices) void execute(selected);
    },
    back() {
      if (picked.length) {
        setPicked([]);
        return true;
      }
      return false;
    },
  });

  if (!items.length) {
    if (state.working.length) return <Working state={state} bind={bind} />;
    const connecting = state.environments.every(env => env.status !== 'online');
    return (
      <div className="empty">
        <div className="big">
          {connecting && !state.environments.some(env => env.onlineAt) ? 'Connecting' : 'All clear'}
        </div>
      </div>
    );
  }
  if (!item) return null;

  const peeks = Math.min(items.length - index - 1, 3);
  return (
    <>
      {Array.from({ length: peeks }, (_, peek) => (
        <div
          key={peek}
          className="peek"
          style={{ right: 48 - peek * 18, top: 34 + peek * 12, bottom: 34 + peek * 12, opacity: 1 - peek * 0.28 }}
        />
      ))}
      <div className="focus">
        <div className="kind">
          <span className={`dot ${item.attention.kind}`} />
          {question && item.detail?.type === 'input' && item.detail.questions.length > 1
            ? `${KIND_LABEL.input} ${picked.length + 1} of ${item.detail.questions.length}`
            : KIND_LABEL[item.attention.kind]}
          <span className="age">{duration(state.now - item.attention.since)}</span>
          <span className={`env${offline ? ' stale' : ''}`}>{item.envLabel}</span>
        </div>
        <div className={question ? 'title one' : 'title'}>{item.title}</div>
        {question ? <div className="question">{question.text}</div> : <Where item={item} />}
        <div className={question ? 'body list' : 'body'}>
          <Body
            item={item}
            now={state.now}
            selected={question ? selected : null}
            picked={picked}
            onPick={position => void execute(position)}
          />
        </div>
        {actions.length ? (
          <div className="acts">
            {actions.map((action, position) => (
              <button
                key={action.label}
                type="button"
                disabled={busy || offline}
                className={['btn', action.primary ? 'go' : '', selected === position ? 'sel' : ''].join(' ')}
                onClick={() => void execute(position)}>
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}
