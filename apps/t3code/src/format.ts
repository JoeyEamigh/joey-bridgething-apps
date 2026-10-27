export function modelName(model: string): string {
  const base = model
    .replace(/^~/, '')
    .split('/')
    .pop()!
    .replace(/-\d{8}$/, '');
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(base);
  if (claude) {
    const family = claude[1]!.charAt(0).toUpperCase() + claude[1]!.slice(1);
    return `${family} ${claude[3] ? `${claude[2]}.${claude[3]}` : claude[2]}`;
  }
  return base;
}

export function duration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

export function dayLabel(key: string, count: number): string {
  if (key.includes('T')) {
    const hour = new Date(key).getHours();
    return `${hour % 12 || 12}${hour < 12 ? 'a' : 'p'}`;
  }
  const date = new Date(`${key}T12:00:00`);
  if (count <= 7) return date.toLocaleDateString('en-US', { weekday: 'short' });
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function dayTitle(key: string): string {
  if (key.includes('T')) {
    const date = new Date(key);
    return date.toLocaleTimeString('en-US', { hour: 'numeric' });
  }
  return new Date(`${key}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
