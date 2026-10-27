import { useMemo, useState } from 'react';
import type { Controls } from '../App';
import { dayLabel, dayTitle, modelName } from '../format';
import { RANGES, type HubState } from '../hub';
import { formatTokens, formatUsd, type UsageRange } from '../t3/usage';
import { hub } from '../useHub';

const RANGE_LABEL: Record<UsageRange, string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
};

export function Usage({
  state,
  bind,
  unit,
  stale,
}: {
  state: HubState;
  bind(controls: Controls): void;
  unit: 'tokens' | 'cost';
  stale: string | null;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const series = state.usage?.series ?? [];
  const index = selected === null ? null : Math.min(selected, series.length - 1);
  const key = index === null ? null : (series[index]?.key ?? null);
  const view = useMemo(() => (key ? hub.usageFor(key) : state.usage), [key, state.usage]);

  bind({
    wheel(step) {
      if (!series.length) return;
      setSelected(value => Math.max(0, Math.min(series.length - 1, (value ?? series.length) + step)));
    },
    enter() {
      setSelected(null);
      hub.setRange(RANGES[(RANGES.indexOf(state.range) + 1) % RANGES.length]!);
    },
    back() {
      if (selected === null) return false;
      setSelected(null);
      return true;
    },
  });

  if (!view) {
    return (
      <div className="empty">
        <div className="big">{state.usageLoading ? 'Reading usage' : 'Waiting for usage'}</div>
      </div>
    );
  }

  const value = (point: { tokens: number; costUsd: number }) => (unit === 'tokens' ? point.tokens : point.costUsd);
  const max = Math.max(1, ...series.map(value));
  const width = 100 / Math.max(1, series.length);
  const gap = series.length > 40 ? 0.18 : series.length > 10 ? 0.22 : 0.28;
  const labelEvery = Math.max(1, Math.ceil(series.length / 7));
  const models = [...view.models]
    .sort((a, b) => (unit === 'tokens' ? b.tokens - a.tokens : b.costUsd - a.costUsd))
    .filter(model => value(model) > 0)
    .slice(0, 4);
  const total = unit === 'tokens' ? view.totalTokens : view.costUsd;

  return (
    <div className="usage">
      <div className="head">
        <span className="total num">{unit === 'tokens' ? formatTokens(total) : formatUsd(total)}</span>
        <span className="range">{key ? dayTitle(key) : RANGE_LABEL[state.range]}</span>
        {stale ? <span className="stale">{stale}</span> : null}
      </div>
      <div className="chart">
        <svg>
          {series.map((point, position) => {
            const height = (value(point) / max) * 100;
            return (
              <rect
                key={point.key}
                x={`${position * width + (width * gap) / 2}%`}
                y={`${100 - height}%`}
                width={`${width * (1 - gap)}%`}
                height={`${height}%`}
                rx={series.length > 40 ? 2 : 6}
                fill={position === (index ?? series.length - 1) ? 'var(--gauge)' : 'var(--gauge-dim)'}
              />
            );
          })}
        </svg>
      </div>
      <div className="days">
        {series.map((point, position) =>
          position === index || (index === null && (series.length - 1 - position) % labelEvery === 0) ? (
            <span
              key={point.key}
              className={position === (index ?? series.length - 1) ? 'sel' : undefined}
              style={{ left: `${(position + 0.5) * width}%` }}>
              {dayLabel(point.key, series.length)}
            </span>
          ) : null,
        )}
      </div>
      <aside>
        {models.map(model => (
          <div className="model" key={`${model.provider}:${model.model}`}>
            <span>{modelName(model.model)}</span>
            <span>{unit === 'tokens' ? formatTokens(model.tokens) : formatUsd(model.costUsd)}</span>
            <div className="bar">
              <i style={{ width: `${total ? (value(model) / total) * 100 : 0}%` }} />
            </div>
          </div>
        ))}
        {unit === 'tokens' ? (
          <div className="key">
            <span>Cache read</span>
            <b>{formatTokens(view.tokens.cachedInput)}</b>
            <span>Cache write</span>
            <b>{formatTokens(view.tokens.cacheWrite)}</b>
            <span>Output</span>
            <b>{formatTokens(view.tokens.output)}</b>
            <span>Input</span>
            <b>{formatTokens(view.tokens.uncachedInput)}</b>
          </div>
        ) : (
          <div className="savings">
            Saved by caching
            <b>{formatUsd(view.cacheSavingsUsd)}</b>
          </div>
        )}
      </aside>
    </div>
  );
}
