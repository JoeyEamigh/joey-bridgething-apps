import type { DpopKey } from './dpop';
import { browserHttp, form, HttpError, type Http, type HttpReply } from './http';

const RELAY = 'https://relay.t3.codes';
const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN = 'urn:ietf:params:oauth:token-type:access_token';

export type RelayEnvironment = { id: string; label: string; base: string };

export type EnvironmentSession = { environmentId: string; base: string; accessToken: string; expiresAt: number };

export type RelayToken = { value: string; expiresAt: number };

export class OfflineError extends Error {
  constructor(label: string) {
    super(`${label} is offline.`);
  }
}

function check(reply: HttpReply, what: string): Record<string, any> {
  if (reply.status >= 200 && reply.status < 300) return (reply.json() ?? {}) as Record<string, any>;
  const body = reply.json() as { message?: string; error_description?: string; code?: string } | null;
  throw new HttpError(reply.status, body?.error_description ?? body?.message ?? `${what} failed (${reply.status}).`);
}

export class Relay {
  private pendingToken: Promise<string> | null = null;

  constructor(
    private readonly jwt: () => Promise<string>,
    private readonly key: DpopKey,
    private readonly deviceId: string,
    private relayToken: RelayToken | null,
    private readonly saveToken: (token: RelayToken) => void,
    private readonly http: Http = browserHttp,
  ) {}

  async environments(): Promise<RelayEnvironment[]> {
    const reply = await this.http(`${RELAY}/v1/environments`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${await this.jwt()}` },
    });
    const body = check(reply, 'Listing your machines');
    return (body.environments ?? []).map((env: any) => ({
      id: env.environmentId,
      label: env.label,
      base: String(env.endpoint?.httpBaseUrl ?? '').replace(/\/$/, ''),
    }));
  }

  private token(): Promise<string> {
    if (this.relayToken && this.relayToken.expiresAt > Date.now() + 30_000)
      return Promise.resolve(this.relayToken.value);
    this.pendingToken ??= this.exchange().finally(() => {
      this.pendingToken = null;
    });
    return this.pendingToken;
  }

  private async exchange(): Promise<string> {
    const url = `${RELAY}/v1/client/dpop-token`;
    const reply = await this.http(url, {
      method: 'POST',
      headers: { DPoP: this.key.proof('POST', url), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: TOKEN_EXCHANGE,
        subject_token: await this.jwt(),
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        requested_token_type: ACCESS_TOKEN,
        resource: RELAY,
        scope: 'environment:connect environment:status',
        client_id: 't3-web',
      }),
    });
    const body = check(reply, 'Connecting to T3 Connect');
    this.relayToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    this.saveToken(this.relayToken);
    return this.relayToken.value;
  }

  async connect(env: RelayEnvironment): Promise<EnvironmentSession> {
    const token = await this.token();
    const url = `${RELAY}/v1/environments/${env.id}/connect`;
    const reply = await this.http(url, {
      method: 'POST',
      headers: {
        Authorization: `DPoP ${token}`,
        DPoP: this.key.proof('POST', url, token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ deviceId: this.deviceId, clientProofKeyThumbprint: this.key.thumbprint }),
    });
    const code = (reply.json() as { code?: string } | null)?.code;
    if (code === 'environment_endpoint_unavailable' || code === 'environment_endpoint_timed_out') {
      throw new OfflineError(env.label);
    }
    const connection = check(reply, `Connecting to ${env.label}`);
    const base = String(connection.endpoint?.httpBaseUrl ?? env.base).replace(/\/$/, '');
    const exchangeUrl = `${base}/oauth/token`;
    const exchange = await this.http(exchangeUrl, {
      method: 'POST',
      headers: { DPoP: this.key.proof('POST', exchangeUrl), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: TOKEN_EXCHANGE,
        subject_token: connection.credential,
        subject_token_type: 'urn:t3:params:oauth:token-type:environment-bootstrap',
        requested_token_type: ACCESS_TOKEN,
        client_label: 'Car Thing',
        client_device_type: 'bot',
      }),
    }).catch(() => {
      throw new OfflineError(env.label);
    });
    const session = check(exchange, `Signing in to ${env.label}`);
    return {
      environmentId: env.id,
      base,
      accessToken: session.access_token,
      expiresAt: Date.now() + session.expires_in * 1000,
    };
  }

  async ticket(session: EnvironmentSession): Promise<string> {
    const url = `${session.base}/api/auth/websocket-ticket`;
    const reply = await this.http(url, {
      method: 'POST',
      headers: {
        Authorization: `DPoP ${session.accessToken}`,
        DPoP: this.key.proof('POST', url, session.accessToken),
      },
    });
    return check(reply, 'Opening a connection').ticket;
  }
}
