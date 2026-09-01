export function Sparkline({
  values,
  width,
  height,
  className = 'stroke-accent',
}: {
  values: number[];
  width: number;
  height: number;
  className?: string;
}) {
  if (values.length < 2) return <div style={{ width, height }} />;
  const peak = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const points = values.map((value, index) => `${(index * step).toFixed(1)},${(height - (value / peak) * height).toFixed(1)}`);

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polygon className="fill-accent-soft" points={`0,${height} ${points.join(' ')} ${width},${height}`} />
      <polyline className={className} strokeWidth={2} fill="none" points={points.join(' ')} />
    </svg>
  );
}

export function Bars({
  values,
  width,
  height,
  highlight,
}: {
  values: number[];
  width: number;
  height: number;
  highlight: number;
}) {
  const peak = Math.max(...values, 1);
  const gap = 2;
  const slot = width / Math.max(values.length, 1);
  const barWidth = Math.max(2, slot - gap);

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {values.map((value, index) => {
        const tall = Math.max(1, (value / peak) * height);
        return (
          <rect
            key={index}
            x={index * slot}
            y={height - tall}
            width={barWidth}
            height={tall}
            className={index === highlight ? 'fill-accent' : 'fill-edge'}
          />
        );
      })}
    </svg>
  );
}
