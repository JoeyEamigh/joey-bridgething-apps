import { form, HttpError, type Http, type HttpReply } from './http';

const FRONTEND_API = 'https://clerk.t3.codes/v1';
const RELAY_TEMPLATE = 't3-relay';

export type Account = { email: string; client: string; session: string };

export class SignedOutError extends Error {
  constructor() {
    super('Signed out of T3 Code. Sign in again from the app settings.');
  }
}

type ClerkError = { errors?: Array<{ code?: string; long_message?: string; message?: string }> };

function failure(reply: HttpReply): Error {
  const body = reply.json() as ClerkError | null;
  const first = body?.errors?.[0];
  if (reply.status === 401 || first?.code === 'authentication_invalid' || first?.code === 'resource_not_found') {
    return new SignedOutError();
  }
  return new HttpError(
    reply.status,
    first?.long_message ?? first?.message ?? `T3 Code sign-in failed (${reply.status}).`,
  );
}

async function call(http: Http, client: string | null, path: string, values?: Record<string, string>) {
  const reply = await http(`${FRONTEND_API}${path}?_is_native=1`, {
    method: 'POST',
    headers: {
      ...(client ? { Authorization: client } : {}),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form(values ?? {}),
  });
  if (reply.status < 200 || reply.status >= 300) throw failure(reply);
  return { body: reply.json() as Record<string, any>, client: reply.header('authorization') ?? client };
}

export type PendingSignIn = { email: string; client: string; signInId: string };

export async function startSignIn(http: Http, email: string): Promise<PendingSignIn> {
  const created = await call(http, null, '/client/sign_ins', { identifier: email });
  const signIn = created.body.response;
  const factor = (signIn?.supported_first_factors ?? []).find((f: { strategy: string }) => f.strategy === 'email_code');
  if (!factor) throw new Error('This T3 Code account cannot sign in with an email code.');
  if (!created.client) throw new Error('T3 Code did not start a sign-in session.');
  const prepared = await call(http, created.client, `/client/sign_ins/${signIn.id}/prepare_first_factor`, {
    strategy: 'email_code',
    email_address_id: factor.email_address_id,
  });
  return { email, client: prepared.client!, signInId: signIn.id };
}

export async function finishSignIn(http: Http, pending: PendingSignIn, code: string): Promise<Account> {
  const attempt = await call(http, pending.client, `/client/sign_ins/${pending.signInId}/attempt_first_factor`, {
    strategy: 'email_code',
    code,
  });
  const session = attempt.body.response?.created_session_id;
  if (attempt.body.response?.status !== 'complete' || typeof session !== 'string') {
    throw new Error('That code did not work. Check the newest email and try again.');
  }
  return { email: pending.email, client: attempt.client!, session };
}

export async function signOut(http: Http, account: Account): Promise<void> {
  await call(http, account.client, `/client/sessions/${account.session}/remove`).catch(() => undefined);
}

export async function relayJwt(http: Http, account: Account): Promise<{ jwt: string; client: string }> {
  const minted = await call(http, account.client, `/client/sessions/${account.session}/tokens/${RELAY_TEMPLATE}`);
  if (typeof minted.body.jwt !== 'string') throw new SignedOutError();
  return { jwt: minted.body.jwt, client: minted.client! };
}
