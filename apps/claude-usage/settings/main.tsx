import { settings } from '@bridgething/client/settings';
import { useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';

import { DISCOVERED_DOC_KEY, type DiscoveredAccount } from '../shared/protocol.ts';
import './style.css';

interface AccountSpec {
  dir: string;
  label?: string;
  refresh?: boolean;
}

const SCREENS = ['usage', 'machine', 'sessions', 'ambient'];

function parseSpecs(raw: string): AccountSpec[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(entry => entry as Partial<AccountSpec>)
      .filter((entry): entry is AccountSpec => typeof entry.dir === 'string' && entry.dir.length > 0);
  } catch {
    return [];
  }
}

function shortName(dir: string): string {
  const base = dir.slice(dir.lastIndexOf('/') + 1);
  return base === '.claude' ? 'default' : base.replace(/^\.claude-?/, '') || base;
}

function Settings() {
  const [discovered, setDiscovered] = useState<DiscoveredAccount[]>([]);
  const [specs, setSpecs] = useState<AccountSpec[]>([]);
  const [pinned, setPinned] = useState(false);
  const [poll, setPoll] = useState('120');
  const [home, setHome] = useState('usage');
  const [ambientIdle, setAmbientIdle] = useState(true);
  const [manual, setManual] = useState('');
  const [hooks, setHooks] = useState(false);
  const [hookTools, setHookTools] = useState('Bash|Write|Edit|NotebookEdit');
  const [hookSeconds, setHookSeconds] = useState('25');
  const [hookPort, setHookPort] = useState('8791');
  const [status, setStatus] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const [entries, doc] = await Promise.all([
          settings.config.list(),
          settings.doc.get(DISCOVERED_DOC_KEY).catch(() => ({ key: DISCOVERED_DOC_KEY, value: null })),
        ]);
        const values = Object.fromEntries(entries.map(entry => [entry.key, entry.value]));
        const configured = parseSpecs(values.accounts ?? '');
        setSpecs(configured);
        setPinned(configured.length > 0);
        setPoll(values.pollSeconds || '120');
        setHome(values.home || 'usage');
        setAmbientIdle(values.ambientIdle !== 'false');
        setHooks(values.hooks === 'true');
        setHookTools(values.hookTools || 'Bash|Write|Edit|NotebookEdit');
        setHookSeconds(values.hookSeconds || '25');
        setHookPort(values.hookPort || '8791');
        if (doc.value) setDiscovered(JSON.parse(doc.value) as DiscoveredAccount[]);
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  const rows: AccountSpec[] = pinned
    ? specs
    : discovered.map(account => ({ dir: account.dir, label: undefined, refresh: false }));

  function edit(dir: string, patch: Partial<AccountSpec>): void {
    setPinned(true);
    setSpecs(current => {
      const base = current.length > 0 ? current : rows;
      return base.map(spec => (spec.dir === dir ? { ...spec, ...patch } : spec));
    });
  }

  function move(dir: string, by: number): void {
    setPinned(true);
    setSpecs(current => {
      const base = [...(current.length > 0 ? current : rows)];
      const at = base.findIndex(spec => spec.dir === dir);
      const to = at + by;
      if (at < 0 || to < 0 || to >= base.length) return base;
      [base[at], base[to]] = [base[to]!, base[at]!];
      return base;
    });
  }

  function drop(dir: string): void {
    setPinned(true);
    setSpecs(current => (current.length > 0 ? current : rows).filter(spec => spec.dir !== dir));
  }

  function addManual(): void {
    const dir = manual.trim().replace(/\/+$/, '');
    if (!dir || rows.some(spec => spec.dir === dir)) return;
    setPinned(true);
    setSpecs([...(specs.length > 0 ? specs : rows), { dir }]);
    setManual('');
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setStatus('saving...');
    try {
      const payload = pinned
        ? JSON.stringify(
            rows.map(spec => ({
              dir: spec.dir,
              ...(spec.label ? { label: spec.label } : {}),
              ...(spec.refresh ? { refresh: true } : {}),
            })),
          )
        : '';
      await settings.config.set('accounts', payload);
      await settings.config.set('pollSeconds', poll);
      await settings.config.set('home', home);
      await settings.config.set('ambientIdle', ambientIdle ? 'true' : 'false');
      await settings.config.set('hooks', hooks ? 'true' : 'false');
      await settings.config.set('hookTools', hookTools);
      await settings.config.set('hookSeconds', hookSeconds);
      await settings.config.set('hookPort', hookPort);
      setStatus('saved');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main>
      <h1>Claude Usage</h1>
      <p className="hint">
        The desktop extension reads these accounts on the host. Leave the list untouched to auto-discover every
        <code> ~/.claude*</code> config directory.
      </p>

      <form onSubmit={save}>
        <h2>Accounts</h2>
        {rows.length === 0 && (
          <p className="hint">
            {discovered.length === 0
              ? 'Nothing discovered yet. Open the app on the device with the desktop app running.'
              : 'Every account removed. Save to show nothing, or re-add one below.'}
          </p>
        )}

        {rows.map((spec, index) => (
          <div className="account" key={spec.dir}>
            <div className="account-head">
              <input
                type="text"
                value={spec.label ?? ''}
                placeholder={shortName(spec.dir)}
                onInput={event => edit(spec.dir, { label: (event.target as HTMLInputElement).value || undefined })}
              />
              <button type="button" className="icon" disabled={index === 0} onClick={() => move(spec.dir, -1)}>
                &uarr;
              </button>
              <button
                type="button"
                className="icon"
                disabled={index === rows.length - 1}
                onClick={() => move(spec.dir, 1)}>
                &darr;
              </button>
              <button type="button" className="icon danger" onClick={() => drop(spec.dir)}>
                &times;
              </button>
            </div>
            <code className="path">{spec.dir}</code>
            <label className="toggle">
              <input
                type="checkbox"
                checked={spec.refresh === true}
                onChange={event => edit(spec.dir, { refresh: (event.target as HTMLInputElement).checked })}
              />
              <span>
                Refresh this account&rsquo;s token when it expires. Rotation invalidates the refresh token an idle
                <code> claude</code> process still holds in memory, and that process has to re-read the store to
                recover. Off means a stale reading and a badge instead.
              </span>
            </label>
          </div>
        ))}

        {discovered
          .filter(account => !rows.some(spec => spec.dir === account.dir))
          .map(account => (
            <div className="account muted" key={account.dir}>
              <code className="path">{account.dir}</code>
              <button type="button" onClick={() => setSpecs([...(specs.length > 0 ? specs : rows), { dir: account.dir }])}>
                Add back
              </button>
            </div>
          ))}

        <div className="field">
          <label htmlFor="manual">Add a config directory by path</label>
          <div className="row">
            <input
              id="manual"
              type="text"
              value={manual}
              placeholder="/Users/you/.claude-work"
              onInput={event => setManual((event.target as HTMLInputElement).value)}
            />
            <button type="button" onClick={addManual}>
              Add
            </button>
          </div>
        </div>

        <h2>Display</h2>
        <div className="field">
          <label htmlFor="poll">Seconds between usage readings</label>
          <input
            id="poll"
            type="number"
            min={15}
            max={600}
            step={5}
            value={poll}
            onInput={event => setPoll((event.target as HTMLInputElement).value)}
          />
        </div>

        <div className="field">
          <label htmlFor="home">Screen to open on</label>
          <select id="home" value={home} onInput={event => setHome((event.target as HTMLSelectElement).value)}>
            {SCREENS.map(name => (
              <option value={name} key={name}>
                {name}
              </option>
            ))}
          </select>
        </div>

        <label className="toggle">
          <input
            type="checkbox"
            checked={ambientIdle}
            onChange={event => setAmbientIdle((event.target as HTMLInputElement).checked)}
          />
          <span>Fall back to the ambient screen after 90 seconds untouched.</span>
        </label>

        <h2>Answering prompts from the dial</h2>
        <label className="toggle">
          <input type="checkbox" checked={hooks} onChange={event => setHooks((event.target as HTMLInputElement).checked)} />
          <span>
            Let the Car Thing answer permission prompts. This writes a global <code>PreToolUse</code> hook into every
            listed account&rsquo;s <code>settings.json</code>, backing the file up first, so it applies to every Claude
            Code session on that machine.
          </span>
        </label>

        {hooks && (
          <>
            <p className="hint">
              A tool call is only held while someone has touched the device in the last few minutes and this app is on
              screen. Otherwise the hook answers instantly and changes nothing. Running out of time never denies: the
              question goes back to the terminal. Turning this off removes the hook again.
            </p>
            <div className="field">
              <label htmlFor="hookTools">Tools to intercept</label>
              <input
                id="hookTools"
                type="text"
                value={hookTools}
                onInput={event => setHookTools((event.target as HTMLInputElement).value)}
              />
            </div>
            <div className="field">
              <label htmlFor="hookSeconds">Seconds to hold a prompt on the device</label>
              <input
                id="hookSeconds"
                type="number"
                min={5}
                max={120}
                step={5}
                value={hookSeconds}
                onInput={event => setHookSeconds((event.target as HTMLInputElement).value)}
              />
            </div>
            <div className="field">
              <label htmlFor="hookPort">Loopback port</label>
              <input
                id="hookPort"
                type="number"
                min={1024}
                max={65535}
                value={hookPort}
                onInput={event => setHookPort((event.target as HTMLInputElement).value)}
              />
            </div>
          </>
        )}

        <div className="row">
          <button type="submit">Save</button>
          <button type="button" className="secondary" onClick={() => settings.done()}>
            Done
          </button>
        </div>
      </form>

      <p className="status">{status}</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Settings />);
