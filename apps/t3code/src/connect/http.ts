import type { BridgethingClient } from '@bridgething/client';

export type HttpReply = { status: number; header(name: string): string | null; json(): unknown };

export type Http = (
  url: string,
  init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string },
) => Promise<HttpReply>;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const browserHttp: Http = async (url, init) => {
  const response = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
  const text = await response.text();
  return { status: response.status, header: name => response.headers.get(name), json: () => parse(text) };
};

export function phoneHttp(client: BridgethingClient): Http {
  return async (url, init) => {
    const result = await client.net.fetch(
      {
        request: {
          url,
          method: init.method,
          headers: Object.entries(init.headers ?? {}).map(([name, value]) => ({ name, value })),
          body: init.body === undefined ? null : encoder.encode(init.body),
          timeoutMs: 20_000,
          redirect: 'error',
        },
      },
      { timeoutMs: 25_000 },
    );
    if (!result.ok) throw new HttpError(0, 'Your phone could not reach T3 Code.');
    const response = result.response.response;
    const text = decoder.decode(new Uint8Array(response.body as unknown as ArrayLike<number>));
    const headers = new Map(response.headers.map(header => [header.name.toLowerCase(), header.value]));
    return {
      status: response.status,
      header: name => headers.get(name.toLowerCase()) ?? null,
      json: () => parse(text),
    };
  };
}

export function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}
