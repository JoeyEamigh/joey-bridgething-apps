import { settings } from '@bridgething/client/settings';
import { useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { finishSignIn, signOut, startSignIn, type Account, type PendingSignIn } from '../src/connect/clerk';
import type { Http } from '../src/connect/http';
import './style.css';

const settingsHttp: Http = async (url, init) => {
  const response = await settings.fetch(url, { method: init.method, headers: init.headers, body: init.body });
  const text = await response.text();
  return {
    status: response.status,
    header: name => response.headers.get(name),
    json: () => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
  };
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function Settings() {
  const [account, setAccount] = useState<Account | null>(null);
  const [names, setNames] = useState(false);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState<PendingSignIn | null>(null);
  const [ready, setReady] = useState(false);
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    settings.config
      .list()
      .then(entries => {
        const values = Object.fromEntries(entries.map(entry => [entry.key, entry.value]));
        try {
          const saved = JSON.parse(values.account || 'null');
          if (saved?.client && saved?.session) setAccount(saved);
        } catch {
          setAccount(null);
        }
        setNames(values.accountNames === 'true');
        setReady(true);
      })
      .catch(() => setStatus('Unable to read settings. Close and reopen this page.'));
  }, []);

  async function run(task: () => Promise<void>) {
    setWorking(true);
    setStatus('');
    try {
      await task();
    } catch (error) {
      setStatus(message(error));
    } finally {
      setWorking(false);
    }
  }

  function sendCode(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      setPending(await startSignIn(settingsHttp, email.trim()));
      setCode('');
      setStatus(`Code sent to ${email.trim()}.`);
    });
  }

  function verify(event: FormEvent) {
    event.preventDefault();
    if (!pending) return;
    void run(async () => {
      const signedIn = await finishSignIn(settingsHttp, pending, code.trim());
      await settings.config.set('account', JSON.stringify(signedIn));
      setAccount(signedIn);
      setPending(null);
      setStatus('Signed in. Your Car Thing connects to your machines now.');
    });
  }

  function leave() {
    if (!account) return;
    void run(async () => {
      await signOut(settingsHttp, account);
      await settings.config.delete('account');
      setAccount(null);
      setStatus('Signed out.');
    });
  }

  function toggleNames(value: boolean) {
    setNames(value);
    void settings.config.set('accountNames', value ? 'true' : 'false').catch(error => setStatus(message(error)));
  }

  return (
    <main>
      <h1>T3 Code</h1>
      {account ? (
        <section>
          <p>
            Signed in as <strong>{account.email}</strong>. Every machine linked to T3 Connect shows up on your Car
            Thing.
          </p>
          <button type="button" className="secondary" disabled={working} onClick={leave}>
            Sign out
          </button>
        </section>
      ) : pending ? (
        <form onSubmit={verify}>
          <label htmlFor="code">Code from your email</label>
          <input
            id="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={event => setCode(event.target.value)}
          />
          <div className="row">
            <button type="submit" disabled={working}>
              {working ? 'Signing in...' : 'Sign in'}
            </button>
            <button type="button" className="secondary" disabled={working} onClick={() => setPending(null)}>
              Use another email
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={sendCode}>
          <p>Sign in with the email you use for T3 Code. You get a code by email, nothing opens on this phone.</p>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            disabled={!ready}
            value={email}
            onChange={event => setEmail(event.target.value)}
          />
          <div className="row">
            <button type="submit" disabled={!ready || working}>
              {working ? 'Sending...' : 'Send code'}
            </button>
          </div>
        </form>
      )}
      <label className="toggle">
        <input
          type="checkbox"
          checked={names}
          disabled={!ready}
          onChange={event => toggleNames(event.target.checked)}
        />
        Show account names on limits
      </label>
      <p className="status" role="status">
        {status}
      </p>
      <div className="row">
        <button type="button" className="secondary" onClick={() => settings.done()}>
          Done
        </button>
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Settings />);
