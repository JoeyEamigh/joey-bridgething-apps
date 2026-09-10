import { settings } from '@bridgething/client/settings';
import { useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { activityLabels, activityModes, serverRoot, type ActivityMode } from '../src/model';
import './style.css';

function Settings() {
  const [server, setServer] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [activity, setActivity] = useState<ActivityMode>('all');
  const [accent, setAccent] = useState('sage');
  const [visible, setVisible] = useState(false);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('Connecting to your companion...');
  useEffect(() => {
    let active = true;
    void settings.config
      .list()
      .then(entries => {
        if (!active) return;
        const values = Object.fromEntries(entries.map(entry => [entry.key, entry.value]));
        if (values.connection) {
          const connection = JSON.parse(values.connection);
          setServer(connection.server ?? '');
          setApiKey(connection.apiKey ?? '');
        }
        if (activityModes.includes(values.activity as ActivityMode)) setActivity(values.activity as ActivityMode);
        setAccent(values.accent === 'amber' ? 'amber' : 'sage');
        setReady(true);
        setStatus('');
      })
      .catch(() => {
        if (active) setStatus('Unable to read settings. Close and reopen this page from the companion.');
      });
    return () => {
      active = false;
    };
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setStatus('Saving...');
    try {
      const normalized = serverRoot(server.trim());
      if (!apiKey.trim() || /[^\x20-\x7e]/.test(apiKey.trim())) throw new Error('Enter your Wakapi API key.');
      await settings.config.set('connection', JSON.stringify({ server: normalized, apiKey: apiKey.trim() }));
      await settings.config.set('activity', activity);
      await settings.config.set('accent', accent);
      setServer(normalized);
      setStatus('Saved. Your Car Thing will refresh automatically.');
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main>
      <div className="kicker">WAKAPI</div>
      <h1>Your work, at a glance.</h1>
      <p className="intro">Connect your Wakapi account to your Car Thing.</p>
      <form onSubmit={save}>
        <fieldset disabled={!ready || saving}>
          <label htmlFor="server">Server URL</label>
          <input
            id="server"
            type="text"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="https://wakapi.dev"
            required
            value={server}
            onChange={event => setServer(event.target.value)}
          />
          <p className="hint">Use the address of your Wakapi server, including any installation subpath.</p>
          <label htmlFor="apiKey">Read-only API key</label>
          <div className="key-field">
            <input
              id="apiKey"
              type={visible ? 'text' : 'password'}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              required
              value={apiKey}
              onChange={event => setApiKey(event.target.value)}
            />
            <button type="button" className="secondary" onClick={() => setVisible(value => !value)}>
              {visible ? 'Hide' : 'Show'}
            </button>
          </div>
          <p className="hint">Create a read-only key in your Wakapi account settings.</p>
          <h2>Display</h2>
          <label htmlFor="activity">Default activity filter</label>
          <select id="activity" value={activity} onChange={event => setActivity(event.target.value as ActivityMode)}>
            {activityModes.map(value => (
              <option key={value} value={value}>
                {activityLabels[value]}
              </option>
            ))}
          </select>
          <p className="hint">
            AI only uses the "ai coding" category. Exclude AI subtracts it from all tracked activity. You can switch
            filters on the device.
          </p>
          <label htmlFor="accent">Accent</label>
          <select id="accent" value={accent} onChange={event => setAccent(event.target.value)}>
            <option value="sage">Sage</option>
            <option value="amber">Amber</option>
          </select>
          <div className="actions">
            <button type="submit">{saving ? 'Saving...' : 'Save settings'}</button>
            <button type="button" className="secondary" onClick={() => settings.done()}>
              Done
            </button>
          </div>
        </fieldset>
      </form>
      <p className="status" role="status">
        {status}
      </p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Settings />);
