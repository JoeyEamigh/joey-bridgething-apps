import type { Severity } from '../../shared/protocol.ts';

const TRACK: Record<string, string> = {
  normal: 'bg-accent',
  warning: 'bg-warn',
  critical: 'bg-err',
};

export function severityClass(severity: Severity): string {
  return TRACK[severity] ?? TRACK.normal!;
}

export function Bar({
  percent,
  severity = 'normal',
  height = 'h-2.5',
  muted = false,
}: {
  percent: number;
  severity?: Severity;
  height?: string;
  muted?: boolean;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className={`w-full ${height} bg-neutral-soft`}>
      <div
        className={`h-full origin-left ${muted ? 'bg-dim' : severityClass(severity)} bar-fill`}
        style={{ transform: `scaleX(${clamped / 100})` }}
      />
    </div>
  );
}

export function Segments({ parts }: { parts: { key: string; value: number; className: string }[] }) {
  const sum = parts.reduce((into, part) => into + part.value, 0) || 1;
  return (
    <div className="flex h-2.5 w-full overflow-hidden bg-neutral-soft">
      {parts.map(part => (
        <div key={part.key} className={part.className} style={{ width: `${(part.value / sum) * 100}%` }} />
      ))}
    </div>
  );
}
