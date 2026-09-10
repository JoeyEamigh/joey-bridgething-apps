import { useEffect, useRef, type ReactNode } from 'react';
import { dateLabel, displayName, duration, type Day, type Metric } from './model';

export function Total({ seconds }: { seconds: number }) {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  return (
    <div className="total" aria-label={duration(seconds)}>
      {minutes >= 60 && (
        <>
          <span>{Math.floor(minutes / 60)}</span>
          <small>h</small>
        </>
      )}
      <span>{minutes % 60}</span>
      <small>m</small>
    </div>
  );
}

export function MetricList({
  rows,
  total,
  selected = -1,
  onSelect,
  compact = false,
}: {
  rows: Metric[];
  total: number;
  selected?: number;
  onSelect: (row: Metric, index: number) => void;
  compact?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    container.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [selected]);
  if (!rows.length) return <div className="empty-inline">No activity in this view.</div>;
  return (
    <div ref={container} className={`metric-list ${compact ? 'compact' : ''}`}>
      {rows.map((row, index) => (
        <button
          type="button"
          key={row.name}
          className="metric"
          data-selected={index === selected}
          onClick={() => onSelect(row, index)}
          aria-label={`${displayName(row.name)}, ${duration(row.seconds)}`}>
          <div className="metric-line">
            <span className="metric-name">{displayName(row.name)}</span>
            <span className="metric-value">{duration(row.seconds)}</span>
          </div>
          <div className="track">
            <div style={{ width: `${Math.min(100, total > 0 ? (row.seconds / total) * 100 : 0)}%` }} />
          </div>
        </button>
      ))}
    </div>
  );
}

export function DayChart({
  days,
  selected,
  onSelect,
  large = false,
}: {
  days: Day[];
  selected: string;
  onSelect: (date: string) => void;
  large?: boolean;
}) {
  const ceiling = Math.max(1, Math.ceil(Math.max(...days.map(day => day.seconds), 1) / 3600));
  const dense = days.length > 7;
  return (
    <div className={`chart ${large ? 'large' : ''} ${dense ? 'dense' : ''}`}>
      <div className="chart-scale">
        <span>{ceiling}h</span>
        <span>0</span>
      </div>
      <div className="chart-bars" role="group" aria-label="Daily tracked hours">
        {days.map((day, index) => (
          <button
            type="button"
            key={day.date}
            className="chart-day"
            aria-pressed={day.date === selected}
            aria-label={`${dateLabel(day.date)}, ${duration(day.seconds)}`}
            onClick={() => onSelect(day.date)}>
            <div className="bar-space">
              <div
                className="day-bar"
                style={{ height: `${(day.seconds / (ceiling * 3600)) * 100}%`, minHeight: day.seconds > 0 ? 2 : 0 }}
              />
            </div>
            <span className="day-label">
              {dense
                ? index % 5 === 0 || index === days.length - 1
                  ? Number(day.date.slice(-2))
                  : ''
                : dateLabel(day.date, { weekday: 'short' })}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function EmptyState({ title, children, retry }: { title: string; children: ReactNode; retry?: () => void }) {
  return (
    <div className="empty-state">
      <div className="empty-mark" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </div>
      <h1>{title}</h1>
      <p>{children}</p>
      {retry && (
        <button className="action" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}
