import type { Toks } from '../shared/protocol.ts';

export function totalToks(value: Toks): number {
  return value.input + value.cacheWrite + value.cacheRead + value.output;
}

export function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  return `${Math.round(value)}`;
}

export function money(minor: number, exponent: number, currency: string): string {
  const major = minor / 10 ** exponent;
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  return `${symbol}${major.toFixed(exponent)}`;
}

export function untilText(resetsAt: number, now: number): string {
  const left = resetsAt - now;
  if (left <= 0) return 'resetting';
  const seconds = Math.floor(left / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${`${minutes}`.padStart(2, '0')}m`;
  return `${minutes}m ${`${seconds % 60}`.padStart(2, '0')}s`;
}

export function agoText(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function clockText(at: number): string {
  const date = new Date(at);
  const hours = date.getHours() % 12 || 12;
  return `${hours}:${`${date.getMinutes()}`.padStart(2, '0')}`;
}

export function meridiem(at: number): string {
  return new Date(at).getHours() < 12 ? 'AM' : 'PM';
}

export function dayLabel(day: string): string {
  const [, month, date] = day.split('-');
  return `${Number(month)}/${Number(date)}`;
}

const MODEL_NAMES: [RegExp, string][] = [
  [/fable/, 'Fable'],
  [/opus/, 'Opus'],
  [/sonnet/, 'Sonnet'],
  [/haiku/, 'Haiku'],
];

export function modelName(model: string): string {
  const lower = model.toLowerCase();
  const match = MODEL_NAMES.find(([pattern]) => pattern.test(lower));
  const version = /(\d+(?:[.-]\d+)?)/.exec(lower.replace(/^claude-?/, ''))?.[1]?.replace('-', '.');
  return match ? `${match[1]}${version ? ` ${version}` : ''}` : model;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function dateText(at: number): string {
  const date = new Date(at);
  return `${WEEKDAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}`;
}
