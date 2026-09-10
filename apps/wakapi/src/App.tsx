import { useEffect, useMemo, useRef, useState } from 'react';
import { DayChart, EmptyState, MetricList, Total } from './components';
import {
  activityLabels,
  activityModes,
  addDays,
  combineDays,
  dateInZone,
  dateLabel,
  dimensions,
  displayName,
  duration,
  emptyDay,
  filterReport,
  type ActivityMode,
  type Dimension,
  type Metric,
} from './model';
import { useReport, useWakapi } from './useWakapi';

const screens = ['Overview', 'Projects', 'History', 'Breakdown'];
const dimensionLabels: Record<Dimension, string> = {
  categories: 'Categories',
  editors: 'Editors',
  languages: 'Languages',
  machines: 'Machines',
  operating_systems: 'Operating systems',
  branches: 'Branches',
  entities: 'Files & activity',
};
type Scope = 'day' | 'week' | 'month';

export default function App() {
  const account = useWakapi();
  const [screen, setScreen] = useState(0);
  const [mode, setMode] = useState<ActivityMode>('all');
  const [scope, setScope] = useState<Scope>('day');
  const [anchor, setAnchor] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [project, setProject] = useState('');
  const [dimension, setDimension] = useState<Dimension>('categories');
  const [selection, setSelection] = useState(0);
  const [detail, setDetail] = useState<Metric | null>(null);
  const [options, setOptions] = useState(false);
  const [optionIndex, setOptionIndex] = useState(0);
  const [detailTab, setDetailTab] = useState<'history' | 'breakdown'>('history');
  const wheelAt = useRef(0);
  const today = account.profile ? dateInZone(new Date(account.now), account.profile.timezone) : '';
  const end = anchor ?? today;
  const selectedDate = date ?? today;
  const count = scope === 'month' ? 30 : 7;
  const start = end ? addDays(end, 1 - count) : '';
  const report = useReport(account.repository, start, end, today, project, account.revision);
  const days = useMemo(() => (report.report ? filterReport(report.report, mode) : []), [report.report, mode]);
  const selected = days.find(day => day.date === selectedDate) ?? emptyDay(selectedDate);
  const period = useMemo(() => combineDays(days), [days]);
  const summary = scope === 'day' ? selected : period;
  const rows = screen === 1 && !project ? summary.projects : summary[dimension];
  const availableDimensions = project ? dimensions : dimensions.filter(key => key !== 'branches' && key !== 'entities');
  const label =
    scope === 'day'
      ? selectedDate === today
        ? 'Today'
        : selectedDate === addDays(today || '2000-01-01', -1)
          ? 'Yesterday'
          : dateLabel(selectedDate || '2000-01-01')
      : `Past ${count} days`;
  const error = report.error || account.error;

  useEffect(() => setMode(account.defaultMode), [account.defaultMode]);
  useEffect(() => {
    setSelection(0);
    setDetail(null);
  }, [screen, project, dimension, mode, scope, selectedDate]);
  useEffect(() => {
    if (!project && (dimension === 'branches' || dimension === 'entities')) setDimension('categories');
  }, [project, dimension]);

  function selectDate(next: string) {
    if (next > today) return;
    setDate(next);
    if (next < start || next > end) setAnchor(next);
  }
  function changeScope(next: Scope) {
    if (end && selectedDate < addDays(end, next === 'month' ? -29 : -6)) setAnchor(selectedDate);
    setScope(next);
  }
  function navigate(next: number) {
    setScreen(next);
    setProject('');
    setOptions(false);
    setDetail(null);
  }
  function back() {
    if (detail) setDetail(null);
    else if (options) setOptions(false);
    else if (project) {
      setProject('');
      setDimension('categories');
    } else navigate(0);
  }
  function openProject(row: Metric) {
    setProject(row.name);
    setDetailTab('history');
    setDimension('categories');
    setScreen(1);
  }

  const actionRef = useRef<{ key?: (e: KeyboardEvent) => void; wheel?: (e: WheelEvent) => void }>({});
  actionRef.current = {
    key: (event: KeyboardEvent) => {
      if (event.repeat && ['m', 'Enter', 'Escape'].includes(event.key)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        back();
        return;
      }
      if (event.key === 'm') {
        event.preventDefault();
        setDetail(null);
        setOptions(value => !value);
        setOptionIndex(0);
        return;
      }
      if (options) {
        const preset = Number(event.key) - 1;
        if (preset >= 0 && preset <= 2) {
          setMode(activityModes[preset]!);
          setOptions(false);
          return;
        }
        if (event.key === 'Enter') {
          if (optionIndex < 3) setMode(activityModes[optionIndex]!);
          else {
            report.refresh();
            account.retry();
          }
          setOptions(false);
          event.preventDefault();
        }
        return;
      }
      if (/^[1-4]$/.test(event.key)) {
        navigate(Number(event.key) - 1);
        return;
      }
      if (event.target instanceof HTMLSelectElement || event.target instanceof HTMLInputElement) return;
      if (detail) {
        if (event.key === 'Enter') {
          event.preventDefault();
          setDetail(null);
        }
        return;
      }
      if (!today) return;
      if (event.key === 'ArrowLeft') selectDate(addDays(selectedDate, -1));
      else if (event.key === 'ArrowRight') selectDate(addDays(selectedDate, 1));
      else if (event.key === 'Enter') {
        event.preventDefault();
        if (screen === 1 && !project && rows[selection]) openProject(rows[selection]!);
        else if (screen === 3 || (project && detailTab === 'breakdown')) {
          if (rows[selection]) setDetail(rows[selection]!);
        } else changeScope(scope === 'day' ? 'week' : scope === 'week' ? 'month' : 'day');
      }
    },
    wheel: (event: WheelEvent) => {
      if (!event.deltaX) return;
      event.preventDefault();
      if (Date.now() - wheelAt.current < 65) return;
      wheelAt.current = Date.now();
      const step = Math.sign(event.deltaX);
      if (options) {
        setOptionIndex(value => Math.max(0, Math.min(3, value + step)));
        return;
      }
      if (detail || !today) return;
      if ((screen === 1 && !project) || screen === 3 || (project && detailTab === 'breakdown'))
        setSelection(value => Math.max(0, Math.min(rows.length - 1, value + step)));
      else selectDate(addDays(selectedDate, step));
    },
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => actionRef.current.key?.(event);
    const wheel = (event: WheelEvent) => actionRef.current.wheel?.(event);
    window.addEventListener('keydown', key);
    window.addEventListener('wheel', wheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('wheel', wheel);
    };
  }, []);

  const lastActivity =
    account.profile?.lastHeartbeat && Number.isFinite(Date.parse(account.profile.lastHeartbeat))
      ? new Intl.DateTimeFormat('en-US', {
          timeZone: account.profile.timezone,
          hour: 'numeric',
          minute: '2-digit',
          ...(dateInZone(new Date(account.profile.lastHeartbeat), account.profile.timezone) === today
            ? {}
            : { month: 'short', day: 'numeric' }),
        }).format(new Date(account.profile.lastHeartbeat))
      : '';

  return (
    <main className={`app ${account.accent}`}>
      <header className="header">
        <button className="brand" onClick={() => navigate(0)} aria-label="Wakapi overview">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          wakapi
        </button>
        <div className="activity-filter" role="group" aria-label="Activity filter">
          {activityModes.map(value => (
            <button key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>
              {activityLabels[value]}
            </button>
          ))}
        </div>
        <button
          className="options-button"
          onClick={() => {
            setOptions(true);
            setOptionIndex(0);
          }}
          aria-label="View options">
          •••
        </button>
      </header>
      <div className="toolbar">
        <div className="date-controls">
          <button aria-label="Previous day" disabled={!today} onClick={() => selectDate(addDays(selectedDate, -1))}>
            ‹
          </button>
          <button
            className="date-current"
            onClick={() => {
              setDate(null);
              setAnchor(null);
            }}>
            {selectedDate === today ? 'Today' : dateLabel(selectedDate || '2000-01-01')}
            <span>{today && (selectedDate === today ? dateLabel(today) : 'Return to today')}</span>
          </button>
          <button
            aria-label="Next day"
            disabled={!today || selectedDate >= today}
            onClick={() => selectDate(addDays(selectedDate, 1))}>
            ›
          </button>
        </div>
        <div className="scope-switch" role="group" aria-label="Date range">
          {(['day', 'week', 'month'] as const).map(value => (
            <button key={value} aria-pressed={scope === value} onClick={() => changeScope(value)}>
              {value === 'day' ? 'Day' : value === 'week' ? '7 days' : '30 days'}
            </button>
          ))}
        </div>
      </div>
      <section className="content" aria-label={screens[screen]}>
        {account.needsSetup ? (
          <EmptyState title="Your work, at a glance">
            Open Wakapi settings in your companion app. Add your server URL and read-only API key to get started.
          </EmptyState>
        ) : !report.report ? (
          <EmptyState
            title={error ? 'Waiting for Wakapi' : 'Gathering your activity'}
            retry={
              error
                ? () => {
                    account.retry();
                    report.refresh();
                  }
                : undefined
            }>
            {error || 'Reading your account and daily summaries.'}
          </EmptyState>
        ) : project ? (
          <div className="project-detail">
            <div className="section-heading">
              <button className="breadcrumb" onClick={() => setProject('')}>
                ‹ Projects
              </button>
              <div className="detail-tabs">
                <button aria-pressed={detailTab === 'history'} onClick={() => setDetailTab('history')}>
                  History
                </button>
                <button aria-pressed={detailTab === 'breakdown'} onClick={() => setDetailTab('breakdown')}>
                  Breakdown
                </button>
              </div>
            </div>
            <div className="project-title">
              <h1>{project}</h1>
              <span>{duration(summary.seconds)}</span>
            </div>
            {detailTab === 'history' ? (
              <>
                <p className="quiet">
                  {label} · {activityLabels[mode]} · {dateLabel(start)} to {dateLabel(end)}
                </p>
                <DayChart days={days} selected={selectedDate} onSelect={selectDate} large />
              </>
            ) : (
              <>
                <select
                  className="dimension-picker"
                  aria-label="Project breakdown"
                  value={dimension}
                  onChange={event => setDimension(event.target.value as Dimension)}>
                  {availableDimensions.map(value => (
                    <option key={value} value={value}>
                      {dimensionLabels[value]}
                    </option>
                  ))}
                </select>
                <MetricList
                  rows={rows}
                  total={summary.seconds}
                  selected={selection}
                  onSelect={(row, index) => {
                    setSelection(index);
                    setDetail(row);
                  }}
                />
              </>
            )}
          </div>
        ) : screen === 0 ? (
          <div className="overview">
            <div className="overview-main">
              <div className="headline">
                <div className="eyebrow">{label} / tracked time</div>
                <Total seconds={summary.seconds} />
                <div className="last-activity">
                  {scope === 'day' && selectedDate === today && account.profile?.lastProject ? (
                    <>
                      <span>Last activity · {lastActivity}</span>
                      <strong>{account.profile.lastProject}</strong>
                      {mode !== 'all' && <small>Across all activity</small>}
                    </>
                  ) : (
                    <>
                      <span>{summary.projects.length} projects</span>
                      <strong>{activityLabels[mode]}</strong>
                    </>
                  )}
                </div>
              </div>
              <div className="top-projects">
                <div className="section-heading">
                  <span className="eyebrow">Projects</span>
                  <button onClick={() => navigate(1)}>View all ›</button>
                </div>
                <MetricList
                  rows={summary.projects.slice(0, 3)}
                  total={summary.seconds}
                  onSelect={openProject}
                  compact
                />
              </div>
            </div>
            <div className="overview-history">
              <div className="section-heading">
                <span className="eyebrow">
                  {dateLabel(start)} to {dateLabel(end)}
                </span>
                <span className="quiet">{duration(period.seconds)} tracked</span>
              </div>
              <DayChart days={days} selected={selectedDate} onSelect={selectDate} />
            </div>
          </div>
        ) : screen === 1 ? (
          <div className="list-screen">
            <div className="section-heading">
              <h1>Projects</h1>
              <span className="quiet">
                {summary.projects.length} projects · {duration(summary.seconds)}
              </span>
            </div>
            <MetricList rows={summary.projects} total={summary.seconds} selected={selection} onSelect={openProject} />
          </div>
        ) : screen === 2 ? (
          <div className="history-screen">
            <div className="section-heading">
              <div>
                <div className="eyebrow">
                  {dateLabel(start)} to {dateLabel(end)}
                </div>
                <h1>
                  {duration(period.seconds)} <span>tracked</span>
                </h1>
              </div>
              <div className="history-average">
                <strong>{duration(period.seconds / days.length)}</strong>
                <span>daily average</span>
              </div>
            </div>
            <DayChart days={days} selected={selectedDate} onSelect={selectDate} large />
            <div className="selected-day">
              <span>{dateLabel(selectedDate, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
              <strong>{duration(selected.seconds)}</strong>
              <span>{selected.projects[0]?.name ?? 'No activity'}</span>
            </div>
          </div>
        ) : (
          <div className="list-screen">
            <div className="section-heading">
              <h1>Breakdown</h1>
              <select
                className="dimension-picker"
                aria-label="Breakdown dimension"
                value={dimension}
                onChange={event => setDimension(event.target.value as Dimension)}>
                {availableDimensions.map(value => (
                  <option key={value} value={value}>
                    {dimensionLabels[value]}
                  </option>
                ))}
              </select>
            </div>
            <MetricList
              rows={summary[dimension]}
              total={summary.seconds}
              selected={selection}
              onSelect={(row, index) => {
                setSelection(index);
                setDetail(row);
              }}
            />
          </div>
        )}
      </section>
      <nav className="navigation" aria-label="Preset screens">
        {screens.map((name, index) => (
          <button key={name} aria-pressed={screen === index} onClick={() => navigate(index)}>
            <small>{index + 1}</small>
            {name}
          </button>
        ))}
      </nav>
      {options && (
        <div className="scrim" onClick={() => setOptions(false)}>
          <div
            className="options-panel"
            role="dialog"
            aria-modal="true"
            aria-label="View options"
            onClick={event => event.stopPropagation()}>
            <div className="section-heading">
              <h1>Activity</h1>
              <button className="close" aria-label="Close options" onClick={() => setOptions(false)}>
                ×
              </button>
            </div>
            <p className="quiet">Applies to every screen. AI activity uses Wakapi's "ai coding" category.</p>
            <div className="option-list">
              {activityModes.map((value, index) => (
                <button
                  key={value}
                  data-selected={optionIndex === index}
                  aria-pressed={mode === value}
                  onClick={() => {
                    setMode(value);
                    setOptions(false);
                  }}>
                  <span>{activityLabels[value]}</span>
                  <small>
                    {index + 1}
                    {mode === value ? ' · Selected' : ''}
                  </small>
                </button>
              ))}
              <button
                data-selected={optionIndex === 3}
                onClick={() => {
                  report.refresh();
                  account.retry();
                  setOptions(false);
                }}>
                Refresh now
              </button>
            </div>
            <p className="quiet">Server and API key are in the companion's Wakapi settings.</p>
            {error && <p className="error-text">{error}</p>}
          </div>
        </div>
      )}
      {detail && (
        <div className="scrim" onClick={() => setDetail(null)}>
          <div
            className="detail-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Activity detail"
            onClick={event => event.stopPropagation()}>
            <button className="close" aria-label="Close detail" onClick={() => setDetail(null)}>
              ×
            </button>
            <div className="eyebrow">
              {dimensionLabels[dimension]} / {label}
            </div>
            <h1>{displayName(detail.name)}</h1>
            <Total seconds={detail.seconds} />
            <p className="quiet">
              {activityLabels[mode]} ·{' '}
              {summary.seconds > 0 ? Math.min(100, (detail.seconds / summary.seconds) * 100).toFixed(1) : '0'}% of
              tracked time
            </p>
          </div>
        </div>
      )}
    </main>
  );
}
