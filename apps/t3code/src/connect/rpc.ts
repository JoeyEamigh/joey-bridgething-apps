import { uuid } from './dpop';
import type { FromWorker, ToWorker, WireFrame } from './socket.worker';

type Exit = { _tag: 'Success'; value: unknown } | { _tag: 'Failure'; cause: unknown };

type Frame =
  | { _tag: 'Chunk'; requestId: string; values: unknown[] }
  | { _tag: 'Exit'; requestId: string; exit: Exit }
  | { _tag: 'Defect'; defect: unknown }
  | { _tag: 'Pong' }
  | { _tag: 'Ping' };

type Pending = {
  value?: (value: unknown) => void;
  done: (error: Error | null, value?: unknown) => void;
};

export class RpcError extends Error {
  constructor(
    message: string,
    readonly tag: string | null,
  ) {
    super(message);
  }
}

function failureOf(cause: unknown): RpcError {
  const first = Array.isArray(cause) ? cause[0] : cause;
  const error = (first as { error?: { _tag?: string; message?: string; detail?: string } } | undefined)?.error;
  const message = error?.message ?? error?.detail ?? (first as { _tag?: string } | undefined)?._tag ?? 'Request failed';
  return new RpcError(message, error?._tag ?? null);
}

const PING_EVERY = 25_000;
const SILENCE_LIMIT = 70_000;

type Handler = (message: FromWorker) => void;

let worker: Worker | null = null;
const handlers = new Map<string, Handler>();

function channel(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./socket.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<FromWorker>) => handlers.get(event.data.id)?.(event.data);
  return worker;
}

function tell(message: ToWorker): void {
  channel().postMessage(message);
}

export class RpcSocket {
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private lastHeard = Date.now();
  private readonly pinger: ReturnType<typeof setInterval>;
  private closed = false;

  private constructor(private readonly id: string) {
    handlers.set(id, message => {
      if (message.type === 'frames') this.receive(message.frames as Frame[]);
      else if (message.type === 'closed') this.shutdown(message.reason);
    });
    this.pinger = setInterval(() => {
      if (Date.now() - this.lastHeard > SILENCE_LIMIT) {
        this.close();
        return;
      }
      this.send({ _tag: 'Ping' });
    }, PING_EVERY);
  }

  static open(url: string, timeoutMs = 20_000): Promise<RpcSocket> {
    const id = uuid();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        handlers.delete(id);
        tell({ type: 'close', id });
        reject(new Error('Timed out opening a connection.'));
      }, timeoutMs);
      handlers.set(id, message => {
        clearTimeout(timer);
        if (message.type === 'open') resolve(new RpcSocket(id));
        else {
          handlers.delete(id);
          reject(new Error('Could not open a connection.'));
        }
      });
      tell({ type: 'open', id, url });
    });
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  request<T>(tag: string, payload: unknown, timeoutMs = 45_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.start(tag, payload, {
        done: (error, value) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve(value as T);
        },
      });
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.send({ _tag: 'Interrupt', requestId: id });
        reject(new RpcError(`${tag} timed out`, null));
      }, timeoutMs);
    });
  }

  stream<T>(
    tag: string,
    payload: unknown,
    onValue: (value: T) => void,
    onEnd: (error: Error | null) => void,
  ): () => void {
    const id = this.start(tag, payload, { value: onValue as (value: unknown) => void, done: error => onEnd(error) });
    return () => {
      if (!this.pending.delete(id)) return;
      this.send({ _tag: 'Interrupt', requestId: id });
    };
  }

  close(): void {
    tell({ type: 'close', id: this.id });
    this.shutdown('closed');
  }

  private start(tag: string, payload: unknown, pending: Pending): string {
    const id = String(this.nextId++);
    if (this.closed) {
      queueMicrotask(() => pending.done(new RpcError('Connection closed', null)));
      return id;
    }
    this.pending.set(id, pending);
    this.send({ _tag: 'Request', id, tag, payload, headers: [] });
    return id;
  }

  private send(frame: WireFrame): void {
    if (!this.closed) tell({ type: 'send', id: this.id, frame });
  }

  private receive(frames: Frame[]): void {
    this.lastHeard = Date.now();
    for (const frame of frames) {
      if (frame._tag === 'Chunk') {
        const pending = this.pending.get(frame.requestId);
        if (pending?.value) for (const value of frame.values) pending.value(value);
      } else if (frame._tag === 'Exit') {
        const pending = this.pending.get(frame.requestId);
        this.pending.delete(frame.requestId);
        if (!pending) continue;
        if (frame.exit._tag === 'Success') pending.done(null, frame.exit.value);
        else pending.done(failureOf(frame.exit.cause));
      } else if (frame._tag === 'Defect') {
        this.close();
      }
    }
  }

  private shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    handlers.delete(this.id);
    clearInterval(this.pinger);
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) entry.done(new RpcError(`Connection lost: ${reason}`, null));
    for (const listener of this.closeListeners) listener(reason);
  }
}
