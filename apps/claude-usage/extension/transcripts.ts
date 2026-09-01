import type { KvStore } from '@bridgething/extension';

import type { MachineView, SessionStatus, SessionView, Toks } from '../shared/protocol.ts';

const CHUNK = 1 << 20;
const DAYS_SHOWN = 21;
const TOP_PROJECTS = 6;
const SESSION_HORIZON_MS = 12 * 60 * 60 * 1000;
const RUNNING_MS = 60_000;
const KV_FILES = 'scan.files';
const KV_ROLLUP = 'scan.rollup';
const KV_SCHEMA = 'scan.schema';
const SCHEMA = 3;
const MAX_DEPTH = 4;

type Quad = [number, number, number, number];

interface Entry {
  path: string;
  size: number;
  mtime: number;
  sub: boolean;
}

interface FileState {
  o: number;
  s: number;
  m: number;
  sid?: string;
  cwd?: string;
  br?: string | null;
  ti?: string | null;
  md?: string | null;
  cx?: number;
  pt?: string | null;
  at?: number;
  sb?: true;
}

interface Rollup {
  days: Record<string, Quad>;
  models: Record<string, Quad>;
  projects: Record<string, Quad>;
  messages: number;
  dayMessages: Record<string, number>;
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function contextFill(usage: Usage & { iterations?: Usage[] }): number {
  const last = usage.iterations?.at(-1) ?? usage;
  return (last.input_tokens ?? 0) + (last.cache_creation_input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0);
}

interface AssistantRecord {
  cwd?: string;
  gitBranch?: string | null;
  sessionId?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: {
    model?: string;
    content?: unknown;
    usage?: Usage & { iterations?: Usage[] };
  };
}

function emptyRollup(): Rollup {
  return { days: {}, models: {}, projects: {}, messages: 0, dayMessages: {} };
}

function add(into: Record<string, Quad>, key: string, quad: Quad): void {
  const at = (into[key] ??= [0, 0, 0, 0]);
  at[0] += quad[0];
  at[1] += quad[1];
  at[2] += quad[2];
  at[3] += quad[3];
}

function toks(quad: Quad | undefined): Toks {
  const [input, cacheWrite, cacheRead, output] = quad ?? [0, 0, 0, 0];
  return { input, cacheWrite, cacheRead, output };
}

function localDay(iso: string | undefined, fallback: number): string {
  const at = iso ? Date.parse(iso) : NaN;
  const date = new Date(Number.isFinite(at) ? at : fallback);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function lastToolUseId(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (let at = content.length - 1; at >= 0; at--) {
    const block = content[at] as { type?: string; id?: string } | null;
    if (block?.type === 'tool_use' && block.id) return block.id;
  }
  return null;
}

const DECODER = new TextDecoder();
const ENCODER = new TextEncoder();
const NEWLINE = 0x0a;

function encode(value: string): Uint8Array {
  return ENCODER.encode(value);
}

const ASSISTANT = encode('"type":"assistant"');
const AI_TITLE = encode('"aiTitle"');

function includesBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  const last = haystack.length - needle.length;
  const head = needle[0]!;
  outer: for (let at = 0; at <= last; at++) {
    if (haystack[at] !== head) continue;
    for (let index = 1; index < needle.length; index++) {
      if (haystack[at + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> {
  if (left.length === 0) return right.slice();
  const out = new Uint8Array(left.length + right.length);
  out.set(left);
  out.set(right, left.length);
  return out;
}

function projectName(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}

export class TranscriptScanner {
  private files: Record<string, FileState> = {};
  private rollup: Rollup = emptyRollup();
  private loaded = false;
  private done = 0;
  private total = 0;
  private running = false;

  constructor(
    private readonly kv: KvStore,
    private readonly log: (message: string) => void,
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    const schema = await this.kv.get<number>(KV_SCHEMA);
    if (schema === SCHEMA) {
      this.files = (await this.kv.get<Record<string, FileState>>(KV_FILES)) ?? {};
      this.rollup = (await this.kv.get<Rollup>(KV_ROLLUP)) ?? emptyRollup();
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await this.kv.set(KV_FILES, this.files);
    await this.kv.set(KV_ROLLUP, this.rollup);
    await this.kv.set(KV_SCHEMA, SCHEMA);
  }

  private list(root: string): Entry[] {
    const out: Entry[] = [];
    const walk = (dir: string, depth: number, sub: boolean): void => {
      if (depth > MAX_DEPTH) return;
      let entries: Deno.DirEntry[];
      try {
        entries = [...Deno.readDirSync(dir)];
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory) walk(path, depth + 1, sub || entry.name === 'subagents');
        else if (entry.isFile && entry.name.endsWith('.jsonl')) {
          try {
            const info = Deno.statSync(path);
            out.push({ path, size: info.size, mtime: info.mtime?.getTime() ?? 0, sub });
          } catch {
            continue;
          }
        }
      }
    };
    walk(root, 0, false);
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  }

  private consume(state: FileState, line: string, mtime: number): void {
    let record: AssistantRecord;
    try {
      record = JSON.parse(line) as AssistantRecord;
    } catch {
      return;
    }

    state.sid ??= record.sessionId;
    state.cwd ??= record.cwd;

    const usage = record.message?.usage;
    if (usage) {
      const quad: Quad = [
        usage.input_tokens ?? 0,
        usage.cache_creation_input_tokens ?? 0,
        usage.cache_read_input_tokens ?? 0,
        usage.output_tokens ?? 0,
      ];
      const day = localDay(record.timestamp, mtime);
      add(this.rollup.days, day, quad);
      this.rollup.dayMessages[day] = (this.rollup.dayMessages[day] ?? 0) + 1;
      this.rollup.messages += 1;
      if (record.message?.model && !record.message.model.startsWith('<')) {
        add(this.rollup.models, record.message.model, quad);
      }
      if (state.cwd) add(this.rollup.projects, state.cwd, quad);
    }

    if (record.timestamp) state.at = Date.parse(record.timestamp);

    if (record.isSidechain === true) return;
    state.br = record.gitBranch ?? null;
    if (record.message?.model) state.md = record.message.model;
    if (usage) state.cx = contextFill(usage);
    state.pt = lastToolUseId(record.message?.content);
  }

  private title(state: FileState, line: string): void {
    try {
      const record = JSON.parse(line) as { aiTitle?: string };
      if (record.aiTitle) state.ti = record.aiTitle;
    } catch {
      return;
    }
  }

  private line(state: FileState, bytes: Uint8Array, mtime: number): void {
    if (bytes.length === 0) return;
    if (includesBytes(bytes, ASSISTANT)) {
      this.consume(state, DECODER.decode(bytes), mtime);
      return;
    }
    if (state.pt && includesBytes(bytes, encode(state.pt))) {
      state.pt = null;
      return;
    }
    if (includesBytes(bytes, AI_TITLE)) this.title(state, DECODER.decode(bytes));
  }

  private async scanFile({ path, size, mtime, sub }: Entry): Promise<void> {
    const state = (this.files[path] ??= { o: 0, s: 0, m: 0 });
    if (sub) state.sb = true;
    if (size < state.o) state.o = 0;
    if (size === state.s && mtime === state.m) return;

    let file: Deno.FsFile;
    try {
      file = await Deno.open(path, { read: true });
    } catch {
      return;
    }
    try {
      await file.seek(state.o, Deno.SeekMode.Start);
      const buffer = new Uint8Array(CHUNK);
      let carry: Uint8Array<ArrayBuffer> = new Uint8Array(0);
      let consumed = state.o;
      for (;;) {
        const read = await file.read(buffer);
        if (read === null) break;
        const chunk = buffer.subarray(0, read);
        const cut = chunk.lastIndexOf(NEWLINE);
        if (cut < 0) {
          carry = concat(carry, chunk);
          continue;
        }
        const complete = concat(carry, chunk.subarray(0, cut + 1));
        let at = 0;
        for (;;) {
          const next = complete.indexOf(NEWLINE, at);
          if (next < 0) break;
          this.line(state, complete.subarray(at, next), mtime);
          at = next + 1;
        }
        consumed += complete.length;
        carry = chunk.slice(cut + 1);
      }
      state.o = consumed;
      state.s = size;
      state.m = mtime;
    } finally {
      file.close();
    }
  }

  async scan(roots: string[], onProgress?: () => void): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.load();
    try {
      const work = roots.flatMap(root => this.list(root));
      this.total = work.length;
      this.done = 0;
      let sinceReport = 0;
      for (const entry of work) {
        await this.scanFile(entry);
        this.done += 1;
        if (++sinceReport >= 150) {
          sinceReport = 0;
          await this.persist();
          onProgress?.();
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
      await this.persist();
    } catch (err) {
      this.log(`transcript scan failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
      onProgress?.();
    }
  }

  machine(sharedBy: string[]): MachineView {
    const days = Object.keys(this.rollup.days)
      .sort()
      .slice(-DAYS_SHOWN)
      .map(day => ({ day, toks: toks(this.rollup.days[day]), messages: this.rollup.dayMessages[day] ?? 0 }));

    const sessionCount = Object.values(this.files).filter(state => !state.sb).length;

    const projects = Object.entries(this.rollup.projects)
      .map(([path, quad]) => ({ name: projectName(path), path, toks: toks(quad) }))
      .sort((a, b) => total(b.toks) - total(a.toks))
      .slice(0, TOP_PROJECTS);

    const models = Object.entries(this.rollup.models)
      .filter(([model]) => !model.startsWith('<'))
      .map(([model, quad]) => ({ model, toks: toks(quad) }))
      .sort((a, b) => total(b.toks) - total(a.toks));

    const totals: Toks = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    for (const quad of Object.values(this.rollup.days)) {
      totals.input += quad[0];
      totals.cacheWrite += quad[1];
      totals.cacheRead += quad[2];
      totals.output += quad[3];
    }

    return {
      days,
      projects,
      models,
      totals,
      totalMessages: this.rollup.messages,
      totalSessions: sessionCount,
      scan: { done: this.done, total: this.total, running: this.running },
      sharedBy,
    };
  }

  liveModels(now = Date.now()): string[] {
    const out = new Set<string>();
    for (const state of Object.values(this.files)) {
      const lastAt = state.at ?? state.m;
      if (state.sb || !lastAt || now - lastAt > SESSION_HORIZON_MS) continue;
      if (state.md) out.add(state.md);
    }
    return [...out];
  }

  sessions(limitFor: (model: string | null) => number | null, now = Date.now()): SessionView[] {
    const out: SessionView[] = [];
    for (const [path, state] of Object.entries(this.files)) {
      const lastAt = state.at ?? state.m;
      if (state.sb || !state.cwd || !lastAt || now - lastAt > SESSION_HORIZON_MS) continue;
      const age = now - state.m;
      const status: SessionStatus = age < RUNNING_MS ? 'running' : state.pt ? 'waiting' : 'idle';
      out.push({
        id: state.sid ?? path.slice(path.lastIndexOf('/') + 1).replace(/\.jsonl$/, ''),
        project: projectName(state.cwd),
        cwd: state.cwd,
        title: state.ti ?? null,
        branch: state.br ?? null,
        model: state.md ?? null,
        contextTokens: state.cx ?? 0,
        contextLimit: limitFor(state.md ?? null),
        lastAt: state.m,
        status,
        pendingTool: state.pt ?? null,
      });
    }
    const rank: Record<SessionStatus, number> = { waiting: 0, running: 1, idle: 2 };
    out.sort((a, b) => rank[a.status] - rank[b.status] || b.lastAt - a.lastAt);
    return out;
  }
}

export function total(value: Toks): number {
  return value.input + value.cacheWrite + value.cacheRead + value.output;
}
