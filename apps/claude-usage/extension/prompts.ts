import type { PromptView } from '../shared/protocol.ts';
import { HOOK_PATH } from './hookconfig.ts';

const PRESENCE_MS = 3 * 60 * 1000;
const HOLDING_MODES = new Set(['default', 'plan']);

interface HookPayload {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  permission_mode?: string;
  tool_use_id?: string;
}

interface Pending {
  view: PromptView;
  settle: (decision: 'allow' | 'deny' | null) => void;
}

function projectName(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}

function oneLine(value: unknown, limit: number): string {
  return String(value).replace(/\s+/g, ' ').trim().slice(0, limit);
}

function describe(tool: string, input: Record<string, unknown>): { summary: string; detail: string | null } {
  const path = input.file_path ?? input.notebook_path ?? input.path;
  if (typeof input.command === 'string') {
    return { summary: oneLine(input.command, 160), detail: oneLine(input.description ?? '', 120) || null };
  }
  if (typeof path === 'string') return { summary: oneLine(path, 160), detail: null };
  if (typeof input.url === 'string') return { summary: oneLine(input.url, 160), detail: null };
  if (typeof input.pattern === 'string') return { summary: oneLine(input.pattern, 160), detail: null };
  const keys = Object.keys(input);
  return { summary: keys.length > 0 ? oneLine(JSON.stringify(input), 160) : tool, detail: null };
}

function decisionBody(decision: 'allow' | 'deny'): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: decision === 'allow' ? 'Allowed from the Car Thing.' : 'Denied from the Car Thing.',
    },
  });
}

const PASS = '{}';

export class PromptServer {
  private server: Deno.HttpServer | undefined;
  private readonly pending = new Map<string, Pending>();
  private presentAt = 0;
  private holdMs = 25_000;
  listening = false;
  error: string | null = null;

  constructor(
    private readonly onChange: () => void,
    private readonly canHold: () => boolean,
    private readonly log: (message: string) => void,
  ) {}

  url(port: number): string {
    return `http://127.0.0.1:${port}${HOOK_PATH}`;
  }

  markPresent(): void {
    this.presentAt = Date.now();
  }

  get holding(): boolean {
    return this.pending.size > 0;
  }

  queue(): PromptView[] {
    return [...this.pending.values()].map(entry => entry.view).sort((a, b) => a.askedAt - b.askedAt);
  }

  answer(id: string, decision: 'allow' | 'deny'): void {
    this.pending.get(id)?.settle(decision);
  }

  start(port: number, holdSeconds: number): void {
    this.holdMs = Math.max(5, holdSeconds) * 1000;
    if (this.server) return;
    this.error = null;
    try {
      this.server = Deno.serve({ port, hostname: '127.0.0.1', onListen: () => void 0 }, request =>
        this.handle(request),
      );
      this.listening = true;
    } catch (err) {
      this.listening = false;
      this.error = err instanceof Error ? err.message : String(err);
    }
    this.onChange();
  }

  async stop(): Promise<void> {
    for (const entry of [...this.pending.values()]) entry.settle(null);
    this.listening = false;
    const server = this.server;
    this.server = undefined;
    await server?.shutdown().catch(() => {});
    this.onChange();
  }

  private async handle(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== HOOK_PATH) return new Response('not found', { status: 404 });

    let payload: HookPayload;
    try {
      payload = (await request.json()) as HookPayload;
    } catch {
      return json(PASS);
    }

    const mode = payload.permission_mode ?? 'default';
    const skip = !HOLDING_MODES.has(mode)
      ? `permission mode ${mode}`
      : Date.now() - this.presentAt >= PRESENCE_MS
        ? 'nobody at the device'
        : !this.canHold()
          ? 'no car thing showing this app'
          : null;
    if (skip) {
      this.log(`passed ${payload.tool_name ?? 'tool'} through: ${skip}`);
      return json(PASS);
    }

    const cwd = payload.cwd ?? '';
    const tool = payload.tool_name ?? 'tool';
    const { summary, detail } = describe(tool, payload.tool_input ?? {});
    const askedAt = Date.now();
    const id = payload.tool_use_id ?? crypto.randomUUID();
    const view: PromptView = {
      id,
      tool,
      summary,
      detail,
      project: cwd ? projectName(cwd) : 'unknown',
      session: (payload.session_id ?? '').slice(0, 8),
      mode,
      askedAt,
      expiresAt: askedAt + this.holdMs,
    };

    const decision = await new Promise<'allow' | 'deny' | null>(resolve => {
      let done = false;
      const settle = (value: 'allow' | 'deny' | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pending.delete(id);
        this.onChange();
        resolve(value);
      };
      const timer = setTimeout(() => settle(null), this.holdMs);
      this.pending.set(id, { view, settle });
      this.onChange();
    });

    return json(decision ? decisionBody(decision) : PASS);
  }
}

function json(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}
