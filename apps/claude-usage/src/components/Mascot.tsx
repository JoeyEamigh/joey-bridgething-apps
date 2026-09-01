export type Mood = 'relaxed' | 'working' | 'strained' | 'burnt' | 'asleep';

const RAYS = 8;

const SPIN_SECONDS: Record<Mood, number> = {
  relaxed: 26,
  working: 14,
  strained: 7,
  burnt: 3.4,
  asleep: 60,
};

const RAY_TILT: Record<Mood, number> = {
  relaxed: 0,
  working: 0,
  strained: -4,
  burnt: -9,
  asleep: -12,
};

function Eyes({ mood }: { mood: Mood }) {
  if (mood === 'asleep') {
    return (
      <g stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" fill="none">
        <path d="M -14 -3 q 6 6 12 0" />
        <path d="M 2 -3 q 6 6 12 0" />
      </g>
    );
  }
  if (mood === 'burnt') {
    return (
      <g stroke="currentColor" strokeWidth={3.4} strokeLinecap="round" fill="none">
        <path d="M -13 -4 l 7 4 l -7 4" />
        <path d="M 13 -4 l -7 4 l 7 4" />
      </g>
    );
  }
  const squint = mood === 'strained' ? 1.7 : 1;
  return (
    <g fill="currentColor">
      <ellipse cx={-7} cy={0} rx={3.1} ry={3.1 / squint} />
      <ellipse cx={7} cy={0} rx={3.1} ry={3.1 / squint} />
    </g>
  );
}

function Mouth({ mood }: { mood: Mood }) {
  const path =
    mood === 'relaxed'
      ? 'M -6 9 q 6 6 12 0'
      : mood === 'working'
        ? 'M -6 10 q 6 3 12 0'
        : mood === 'strained'
          ? 'M -6 11 h 12'
          : mood === 'burnt'
            ? 'M -6 12 q 6 -6 12 0'
            : 'M -5 12 q 5 4 10 0';
  return <path d={path} stroke="currentColor" strokeWidth={3} strokeLinecap="round" fill="none" />;
}

export function Mascot({ mood, size = 132 }: { mood: Mood; size?: number }) {
  const rays = Array.from({ length: RAYS }, (_, index) => (index * 360) / RAYS + RAY_TILT[mood]);
  const reach = mood === 'burnt' ? 26 : mood === 'asleep' ? 20 : 30;

  return (
    <svg viewBox="-60 -60 120 120" width={size} height={size} className="text-screen" aria-hidden="true">
      <g
        className="mascot-spin"
        style={{
          animationDuration: `${SPIN_SECONDS[mood]}s`,
          animationDirection: mood === 'asleep' ? 'reverse' : 'normal',
        }}>
        {rays.map(angle => (
          <path
            key={angle}
            d={`M 0 -${reach} l 5.5 -13 l -5.5 -12 l -5.5 12 z`}
            transform={`rotate(${angle})`}
            className="fill-accent"
            opacity={mood === 'asleep' ? 0.4 : 1}
          />
        ))}
      </g>
      <g className="mascot-breathe" style={{ animationDuration: mood === 'asleep' ? '5.5s' : '3s' }}>
        <circle r={30} className="fill-accent" />
        <g className="text-screen">
          <Eyes mood={mood} />
          <Mouth mood={mood} />
        </g>
      </g>
      {mood === 'asleep' && (
        <g className="fill-accent font-display" opacity={0.75}>
          <text x={30} y={-32} fontSize={15} className="snooze-1">
            z
          </text>
          <text x={41} y={-45} fontSize={20} className="snooze-2">
            z
          </text>
        </g>
      )}
    </svg>
  );
}

export function moodFor(percent: number | null): Mood {
  if (percent === null) return 'relaxed';
  if (percent >= 90) return 'burnt';
  if (percent >= 70) return 'strained';
  if (percent >= 25) return 'working';
  return 'relaxed';
}
