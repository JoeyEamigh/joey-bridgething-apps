import { useEffect, useState } from 'react';

import type { PromptView } from '../../shared/protocol.ts';

export type Choice = 'allow' | 'deny';

export function PromptModal({
  prompt,
  queued,
  now,
  choice,
  onChoose,
  onAnswer,
}: {
  prompt: PromptView;
  queued: number;
  now: number;
  choice: Choice;
  onChoose: (next: Choice) => void;
  onAnswer: (decision: Choice) => void;
}) {
  const [sent, setSent] = useState<Choice | null>(null);
  useEffect(() => setSent(null), [prompt.id]);

  const left = Math.max(0, Math.ceil((prompt.expiresAt - now) / 1000));
  const span = Math.max(1, (prompt.expiresAt - prompt.askedAt) / 1000);

  const answer = (decision: Choice) => {
    setSent(decision);
    onAnswer(decision);
  };

  return (
    <div className="absolute inset-0 z-10 flex flex-col border-t-2 border-accent bg-bg px-8 py-6">
      <div className="flex items-baseline justify-between font-mono text-eyebrow tracking-[0.2em] text-dim uppercase">
        <span>
          {prompt.project} · {prompt.tool}
          {prompt.mode !== 'default' && ` · ${prompt.mode}`}
        </span>
        <span className="tabular-nums">
          {queued > 1 && <span className="mr-3">{queued - 1} more</span>}
          {left}s
        </span>
      </div>

      <div className="mt-1 h-0.5 w-full bg-neutral-soft">
        <div className="h-full bg-accent" style={{ width: `${(left / span) * 100}%` }} />
      </div>

      <div className="mt-6 min-h-0 flex-1">
        <div className="line-clamp-4 font-mono text-row-lg leading-relaxed break-all text-off-white">
          {prompt.summary}
        </div>
        {prompt.detail && <div className="mt-3 text-body text-soft">{prompt.detail}</div>}
      </div>

      <div className="flex gap-3">
        {(['allow', 'deny'] as const).map(option => (
          <button
            key={option}
            onPointerDown={() => onChoose(option)}
            onClick={() => answer(option)}
            className={`flex-1 border py-4 font-display text-title tracking-display transition ${
              choice === option
                ? option === 'allow'
                  ? 'border-ok bg-ok text-screen'
                  : 'border-err bg-err text-screen'
                : 'border-edge text-soft'
            } ${sent === option ? 'opacity-60' : ''}`}>
            {option === 'allow' ? 'Allow' : 'Deny'}
          </button>
        ))}
      </div>

      <div className="mt-3 text-center font-mono text-eyebrow text-dim">
        {sent ? 'sent' : 'turn to choose, press to answer · timing out hands it back to the terminal'}
      </div>
    </div>
  );
}
