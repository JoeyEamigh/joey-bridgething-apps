import { BridgethingClient } from '@bridgething/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { WakapiRepository } from './api';
import { daemonUrl } from './daemon';
import { activityModes, serverRoot, type ActivityMode, type Profile, type Report } from './model';

const client = new BridgethingClient({ url: daemonUrl() });

export function useWakapi() {
  const [config, setConfig] = useState<Record<string, string> | null>(null);
  const [connected, setConnected] = useState(client.connectionState === 'open');
  const [configError, setConfigError] = useState('');
  const [revision, setRevision] = useState(0);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [accountError, setAccountError] = useState('');
  const [ready, setReady] = useState<WakapiRepository | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let active = true;
    let generation = 0;
    let debounce: ReturnType<typeof setTimeout>;
    async function readConfig() {
      const request = ++generation;
      try {
        const result = await client.config.list();
        if (!result.ok) throw new Error('Cannot read app settings.');
        if (!active || request !== generation) return;
        setConfig(Object.fromEntries(result.response.entries.map(entry => [entry.key, entry.value ?? ''])));
        setConfigError('');
      } catch {
        if (active && request === generation) setConfigError('Cannot read settings from the device.');
      }
    }
    const off = client.on(event => {
      if (event.type === 'open') {
        setConnected(true);
        void readConfig();
        setRevision(value => value + 1);
      }
      if (event.type === 'close' || event.type === 'connecting') setConnected(false);
    });
    const changed = client.config.onChanged(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => void readConfig(), 300);
    });
    if (client.connectionState === 'open') void readConfig();
    const peers = client.peer.onSnapshot(() => setRevision(value => value + 1));
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    const visibility = () => {
      if (!document.hidden) {
        setNow(Date.now());
        setRevision(value => value + 1);
      }
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      active = false;
      off();
      changed();
      peers();
      clearTimeout(debounce);
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);

  const savedConnection = useMemo(() => {
    try {
      const saved = JSON.parse(config?.connection || '{}');
      return {
        server: typeof saved.server === 'string' ? saved.server.trim() : '',
        apiKey: typeof saved.apiKey === 'string' ? saved.apiKey.trim() : '',
      };
    } catch {
      return { server: '', apiKey: '' };
    }
  }, [config?.connection]);
  const { server, apiKey } = savedConnection;
  const connection = useMemo(() => {
    if (!server || !apiKey) return { repository: null, error: '' };
    try {
      return { repository: new WakapiRepository(client, { server: serverRoot(server), apiKey }), error: '' };
    } catch (error) {
      return { repository: null, error: (error as Error).message };
    }
  }, [server, apiKey]);

  useEffect(() => {
    let active = true;
    const repository = connection.repository;
    setReady(null);
    setProfile(null);
    setAccountError('');
    if (!repository) return;
    void (async () => {
      await repository.hydrate();
      if (!active) return;
      if (repository.profile) {
        setProfile(repository.profile);
        setReady(repository);
      }
      try {
        const next = await repository.refreshProfile();
        if (active) {
          setProfile(next);
          setReady(repository);
          setAccountError('');
        }
      } catch (error) {
        if (active) setAccountError((error as Error).message);
      }
    })();
    return () => {
      active = false;
    };
  }, [connection]);

  useEffect(() => {
    const repository = connection.repository;
    if (!repository || !connected) return;
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const next = await repository.refreshProfile();
        if (active) {
          setProfile(next);
          setReady(repository);
          setAccountError('');
        }
      } catch (error) {
        if (active) setAccountError((error as Error).message);
      } finally {
        pending = false;
      }
    };
    const timer = setInterval(() => void refresh(), 60_000);
    if (revision > 0) void refresh();
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [connection, connected, revision]);

  const defaultMode = activityModes.includes(config?.activity as ActivityMode)
    ? (config!.activity as ActivityMode)
    : 'all';
  return {
    repository: ready === connection.repository ? ready : null,
    profile,
    now,
    connected,
    revision,
    defaultMode,
    accent: config?.accent === 'amber' ? 'amber' : 'sage',
    needsSetup: config !== null && (!server || !apiKey),
    error: configError || connection.error || accountError,
    retry: () => setRevision(value => value + 1),
  };
}

export function useReport(
  repository: WakapiRepository | null,
  start: string,
  end: string,
  today: string,
  project: string,
  revision: number,
) {
  const [state, setState] = useState<{
    owner: WakapiRepository | null;
    key: string;
    report: Report | null;
    loading: boolean;
    error: string;
  }>({ owner: null, key: '', report: null, loading: false, error: '' });
  const key = JSON.stringify([start, end, project]);
  const [refreshId, setRefreshId] = useState(0);
  const lastRefresh = useRef(0);
  useEffect(() => {
    if (!repository || !start || !end) return;
    let active = true;
    let pending = false;
    let cached = repository.cached(start, end, project);
    setState({ owner: repository, key, report: cached, loading: !cached, error: '' });
    const load = async (force = false) => {
      if (pending || document.hidden) return;
      const lifetime = end >= today ? 60_000 : 900_000;
      if (!force && cached && Date.now() - cached.fetchedAt < lifetime) return;
      pending = true;
      setState(previous => ({ ...previous, loading: true }));
      try {
        const report = await repository.load(start, end, project, force);
        cached = report;
        if (active) setState({ owner: repository, key, report, loading: false, error: '' });
      } catch (error) {
        if (active)
          setState({ owner: repository, key, report: cached, loading: false, error: (error as Error).message });
      } finally {
        pending = false;
      }
    };
    const force = refreshId !== lastRefresh.current;
    lastRefresh.current = refreshId;
    void load(force);
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [repository, key, start, end, today, project, revision, refreshId]);
  const current =
    state.owner === repository && state.key === key ? state : { report: null, loading: !!repository, error: '' };
  return { ...current, refresh: () => setRefreshId(value => value + 1) };
}
