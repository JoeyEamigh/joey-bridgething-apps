import { SignedOutError } from './clerk';
import { HttpError } from './http';
import { OfflineError, type EnvironmentSession, type Relay, type RelayEnvironment } from './relay';
import { RpcSocket } from './rpc';

export type LinkStatus = 'connecting' | 'online' | 'offline' | 'failed';

export type LinkHandlers = {
  status(status: LinkStatus, detail: string | null): void;
  ready(socket: RpcSocket): void;
  signedOut(): void;
  session(session: EnvironmentSession): void;
};

const BACKOFF = [3_000, 10_000, 30_000, 60_000, 180_000, 300_000];

export class EnvironmentLink {
  private socket: RpcSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  status: LinkStatus = 'connecting';

  constructor(
    readonly env: RelayEnvironment,
    private readonly relay: Relay,
    private readonly handlers: LinkHandlers,
    private session: EnvironmentSession | null,
  ) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.socket?.close();
    this.socket = null;
  }

  retryNow(): void {
    if (this.stopped || this.socket?.isOpen) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
    void this.connect();
  }

  get rpc(): RpcSocket | null {
    return this.socket?.isOpen ? this.socket : null;
  }

  private setStatus(status: LinkStatus, detail: string | null): void {
    this.status = status;
    this.handlers.status(status, detail);
  }

  private async renew(): Promise<EnvironmentSession> {
    this.session = await this.relay.connect(this.env);
    this.handlers.session(this.session);
    return this.session;
  }

  private async ticket(): Promise<string> {
    const session = this.session && this.session.expiresAt > Date.now() + 60_000 ? this.session : await this.renew();
    try {
      return await this.relay.ticket(session);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 401) throw error;
      return this.relay.ticket(await this.renew());
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setStatus('connecting', null);
    try {
      const ticket = await this.ticket();
      const wsBase = this.session!.base.replace(/^http/, 'ws');
      const socket = await RpcSocket.open(
        `${wsBase}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`,
      );
      if (this.stopped) {
        socket.close();
        return;
      }
      this.socket = socket;
      this.attempt = 0;
      socket.onClose(() => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.schedule('offline', `${this.env.label} disconnected.`);
      });
      this.setStatus('online', null);
      this.handlers.ready(socket);
    } catch (error) {
      if (error instanceof SignedOutError) {
        this.stop();
        this.handlers.signedOut();
        return;
      }
      if (error instanceof OfflineError) this.schedule('offline', error.message);
      else this.schedule('failed', (error as Error).message);
    }
  }

  private schedule(status: LinkStatus, detail: string): void {
    if (this.stopped) return;
    this.setStatus(status, detail);
    const delay = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)]!;
    this.attempt += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay);
  }
}
