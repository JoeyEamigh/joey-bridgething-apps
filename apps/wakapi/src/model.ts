export const activityModes = ['all', 'exclude-ai', 'ai'] as const;
export type ActivityMode = (typeof activityModes)[number];
export const activityLabels: Record<ActivityMode, string> = {
  all: 'All activity',
  'exclude-ai': 'Exclude AI',
  ai: 'AI only',
};
export const dimensions = [
  'categories',
  'editors',
  'languages',
  'machines',
  'operating_systems',
  'branches',
  'entities',
] as const;
export type Dimension = (typeof dimensions)[number];
export type Metric = { name: string; seconds: number };
export type Day = { date: string; seconds: number; projects: Metric[] } & Record<Dimension, Metric[]>;
export type Report = { all: Day[]; ai: Day[]; fetchedAt: number; historyFetchedAt: number };
export type Profile = { name: string; timezone: string; lastProject: string; lastHeartbeat: string };
export type Connection = { server: string; apiKey: string };

export function serverRoot(input: string): string {
  const url = new URL(input.includes('://') ? input : `https://${input}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Enter an HTTP or HTTPS Wakapi server URL.');
  }
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/api(?:\/compat\/wakatime\/v1)?$/, '');
  return url.toString().replace(/\/$/, '');
}

export function dateInZone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function addDays(date: string, amount: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

export function dateLabel(
  date: string,
  options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' },
): string {
  return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
}

export function duration(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  if (seconds > 0 && minutes === 0) return '<1m';
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

export function emptyDay(date: string): Day {
  return {
    date,
    seconds: 0,
    projects: [],
    categories: [],
    editors: [],
    languages: [],
    machines: [],
    operating_systems: [],
    branches: [],
    entities: [],
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Wakapi returned an invalid response.');
  return value as Record<string, unknown>;
}

function seconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error('Wakapi returned an invalid duration.');
  return value;
}

function metrics(value: unknown): Metric[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('Wakapi returned an invalid breakdown.');
  return value
    .map(item => {
      const row = object(item);
      if (typeof row.name !== 'string') throw new Error('Wakapi returned an unnamed breakdown.');
      return { name: row.name, seconds: seconds(row.total_seconds) };
    })
    .filter(row => row.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name));
}

export function parseDays(value: unknown, start: string, end: string, timezone: string): Day[] {
  const data = object(value).data;
  if (!Array.isArray(data)) throw new Error('Wakapi did not return daily summaries.');
  const byDate = new Map<string, Day>();
  for (const item of data) {
    const raw = object(item);
    const range = object(raw.range);
    if (typeof range.start !== 'string' || !Number.isFinite(Date.parse(range.start))) {
      throw new Error('Wakapi returned an invalid day.');
    }
    const date = dateInZone(new Date(range.start), timezone);
    if (date < start || date > end || byDate.has(date)) throw new Error('Wakapi returned unexpected summary dates.');
    const day = emptyDay(date);
    day.seconds = seconds(object(raw.grand_total).total_seconds);
    for (const key of ['projects', ...dimensions] as const) day[key] = metrics(raw[key]);
    byDate.set(date, day);
  }
  const result: Day[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    const day = byDate.get(date);
    if (!day) throw new Error('Wakapi returned an incomplete date range.');
    result.push(day);
  }
  return result;
}

export function parseProfile(value: unknown): Profile {
  const raw = object(object(value).data);
  if (typeof raw.timezone !== 'string') throw new Error('Wakapi did not return your timezone.');
  dateInZone(new Date(), raw.timezone);
  return {
    name: typeof raw.display_name === 'string' ? raw.display_name : String(raw.username ?? ''),
    timezone: raw.timezone,
    lastProject: typeof raw.last_project === 'string' ? raw.last_project : '',
    lastHeartbeat: typeof raw.last_heartbeat_at === 'string' ? raw.last_heartbeat_at : '',
  };
}

export function isAiCategory(name: string): boolean {
  return name.trim().toLowerCase() === 'ai coding';
}

function subtractMetrics(all: Metric[], ai: Metric[]): Metric[] {
  const excluded = new Map(ai.map(row => [row.name, row.seconds]));
  return all
    .map(row => ({ name: row.name, seconds: Math.max(0, row.seconds - (excluded.get(row.name) ?? 0)) }))
    .filter(row => row.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name));
}

export function filterReport(report: Report, mode: ActivityMode): Day[] {
  if (mode === 'all') return report.all;
  if (mode === 'ai') return report.ai;
  const aiByDate = new Map(report.ai.map(day => [day.date, day]));
  return report.all.map(all => {
    const ai = aiByDate.get(all.date);
    if (!ai) throw new Error('AI summary is missing a day.');
    const day = emptyDay(all.date);
    day.seconds = Math.max(0, all.seconds - ai.seconds);
    for (const key of ['projects', ...dimensions] as const) day[key] = subtractMetrics(all[key], ai[key]);
    day.categories = day.categories.filter(row => !isAiCategory(row.name));
    return day;
  });
}

export function combineDays(days: Day[]): Day {
  const combined = emptyDay(days[0]?.date ?? '');
  combined.seconds = days.reduce((sum, day) => sum + day.seconds, 0);
  for (const key of ['projects', ...dimensions] as const) {
    const totals = new Map<string, number>();
    for (const day of days) for (const row of day[key]) totals.set(row.name, (totals.get(row.name) ?? 0) + row.seconds);
    combined[key] = Array.from(totals, ([name, seconds]) => ({ name, seconds })).sort(
      (a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name),
    );
  }
  return combined;
}

export function displayName(name: string): string {
  const names: Record<string, string> = {
    Unknown: 'Unspecified',
    '': 'Unspecified',
    'ai coding': 'AI coding',
    coding: 'Coding',
    Typescript: 'TypeScript',
    Javascript: 'JavaScript',
    Markdown: 'Markdown',
    Macos: 'macOS',
    Iterm2: 'iTerm2',
    Vscode: 'VS Code',
    Firefoxdeveloperedition: 'Firefox Developer Edition',
    'writing tests': 'Writing tests',
    'writing docs': 'Writing docs',
    'code reviewing': 'Code review',
    browsing: 'Browsing',
    meeting: 'Meetings',
  };
  return names[name] ?? name;
}
