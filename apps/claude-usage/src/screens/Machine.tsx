import type { MachineView, Toks } from '../../shared/protocol.ts';
import { Segments } from '../components/Bar';
import { Bars } from '../components/Sparkline';
import { compact, dayLabel, modelName, totalToks } from '../format';

const MODEL_TINTS = ['bg-accent', 'bg-ok', 'bg-experimental', 'bg-edge'];

const BREAKDOWN: { key: keyof Toks; label: string }[] = [
  { key: 'cacheRead', label: 'cache read' },
  { key: 'cacheWrite', label: 'cache write' },
  { key: 'input', label: 'input' },
  { key: 'output', label: 'output' },
];

export function MachineScreen({ machine, hasHost }: { machine: MachineView | null; hasHost: boolean }) {
  if (!machine) {
    return (
      <div className="grid h-full place-items-center font-mono text-body text-dim">
        {hasHost ? 'waiting for the first scan' : 'open the bridgething desktop app to see token history'}
      </div>
    );
  }

  const days = machine.days;
  const values = days.map(day => totalToks(day.toks));
  const today = values.at(-1) ?? 0;
  const week = values.slice(-7).reduce((into, value) => into + value, 0);
  const projectPeak = Math.max(...machine.projects.map(project => totalToks(project.toks)), 1);
  const modelTotal = machine.models.reduce((into, model) => into + totalToks(model.toks), 0) || 1;
  const models = machine.models
    .slice(0, MODEL_TINTS.length)
    .filter(model => totalToks(model.toks) / modelTotal >= 0.01);
  const allTime = totalToks(machine.totals) || 1;

  return (
    <div className="flex h-full gap-4">
      <div className="flex w-101 shrink-0 flex-col border border-rule bg-screen p-4">
        <div className="flex items-end justify-between">
          <div>
            <div className="font-mono text-eyebrow tracking-[0.2em] text-dim uppercase">tokens today</div>
            <div className="font-display text-screen-title leading-none tracking-display tabular-nums">
              {compact(today)}
            </div>
          </div>
          <div className="text-right">
            <div className="font-mono text-eyebrow tracking-[0.2em] text-dim uppercase">7 days</div>
            <div className="font-display text-hero text-soft tabular-nums">{compact(week)}</div>
          </div>
        </div>

        <div className="mt-3">
          <Bars values={values} width={372} height={124} highlight={values.length - 1} />
          <div className="flex justify-between font-mono text-eyebrow text-dim tabular-nums">
            <span>{days[0] ? dayLabel(days[0].day) : ''}</span>
            <span>{days.at(-1) ? dayLabel(days.at(-1)!.day) : ''}</span>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1.5 border-t border-rule pt-3 font-mono text-hint">
          {BREAKDOWN.map(part => (
            <div key={part.key} className="flex items-baseline justify-between">
              <span className="text-dim">{part.label}</span>
              <span className="text-soft tabular-nums">
                {compact(machine.totals[part.key])}
                <span className="ml-1.5 text-dim">{Math.round((machine.totals[part.key] / allTime) * 100)}%</span>
              </span>
            </div>
          ))}
        </div>

        <div className="mt-auto flex flex-col gap-2 border-t border-rule pt-3">
          <Segments
            parts={models.map((model, index) => ({
              key: model.model,
              value: totalToks(model.toks),
              className: MODEL_TINTS[index]!,
            }))}
          />
          <div className="flex flex-wrap gap-x-4 font-mono text-eyebrow">
            {models.map((model, index) => (
              <span key={model.model} className="flex items-center gap-1.5 text-soft">
                <span className={`inline-block h-2 w-2 ${MODEL_TINTS[index]}`} />
                {modelName(model.model)}
                <span className="text-dim tabular-nums">{Math.round((totalToks(model.toks) / modelTotal) * 100)}%</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col border border-rule bg-screen p-4">
        <div className="flex shrink-0 items-baseline justify-between pb-3">
          <span className="font-mono text-eyebrow tracking-[0.2em] text-dim uppercase">top projects</span>
          <span className="font-mono text-eyebrow text-dim tabular-nums">{compact(allTime)} all time</span>
        </div>

        <div className="flex min-h-0 flex-1 flex-col justify-between overflow-hidden">
          {machine.projects.map(project => {
            const tokens = totalToks(project.toks);
            return (
              <div key={project.path} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-row text-near">{project.name}</span>
                  <span className="shrink-0 font-mono text-hint text-soft tabular-nums">{compact(tokens)}</span>
                </div>
                <div className="h-1.5 w-full bg-neutral-soft">
                  <div className="h-full bg-accent" style={{ width: `${(tokens / projectPeak) * 100}%` }} />
                </div>
              </div>
            );
          })}
          {machine.projects.length === 0 && (
            <div className="grid flex-1 place-items-center font-mono text-body text-dim">nothing scanned yet</div>
          )}
        </div>

        <footer className="mt-3 flex shrink-0 items-baseline justify-between gap-3 border-t border-rule pt-2.5 font-mono text-eyebrow text-dim">
          <span className="shrink-0">
            {machine.scan.running
              ? `scanning ${machine.scan.done}/${machine.scan.total}`
              : `${machine.totalSessions} sessions · ${compact(machine.totalMessages)} turns`}
          </span>
          <span className="truncate">
            {machine.sharedBy.length > 1 ? `${machine.sharedBy.length} accounts` : 'machine-wide'}
          </span>
        </footer>
      </div>
    </div>
  );
}
