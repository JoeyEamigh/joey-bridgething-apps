import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';

const encoder = new TextEncoder();

export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function hash(value: string): string {
  return base64Url(sha256(encoder.encode(value)));
}

export function uuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type PublicJwk = { kty: string; crv: string; x: string; y: string };

export type StoredKey = { privateJwk: PublicJwk & { d: string }; publicJwk: PublicJwk };

export class DpopKey {
  private constructor(
    private readonly secret: Uint8Array,
    readonly publicJwk: PublicJwk,
    readonly thumbprint: string,
  ) {}

  static generate(): StoredKey {
    const secret = p256.utils.randomSecretKey();
    const point = p256.getPublicKey(secret, false);
    const publicJwk = { kty: 'EC', crv: 'P-256', x: base64Url(point.slice(1, 33)), y: base64Url(point.slice(33, 65)) };
    return { privateJwk: { ...publicJwk, d: base64Url(secret) }, publicJwk };
  }

  static load(stored: StoredKey): DpopKey {
    const { crv, kty, x, y } = stored.publicJwk;
    return new DpopKey(
      fromBase64Url(stored.privateJwk.d),
      { kty, crv, x, y },
      hash(JSON.stringify({ crv, kty, x, y })),
    );
  }

  proof(method: string, url: string, accessToken?: string): string {
    const target = new URL(url);
    target.search = '';
    target.hash = '';
    const header = base64Url(encoder.encode(JSON.stringify({ typ: 'dpop+jwt', alg: 'ES256', jwk: this.publicJwk })));
    const payload = base64Url(
      encoder.encode(
        JSON.stringify({
          htm: method,
          htu: target.toString(),
          jti: uuid(),
          iat: Math.floor(Date.now() / 1000),
          ...(accessToken ? { ath: hash(accessToken) } : {}),
        }),
      ),
    );
    const signature = p256.sign(encoder.encode(`${header}.${payload}`), this.secret);
    return `${header}.${payload}.${base64Url(signature)}`;
  }
}
