import { BridgethingClient } from '@bridgething/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AccountView,
  DiscoveredAccount,
  HookStatus,
  MachineView,
  PromptView,
  Push,
  SessionView,
} from '../shared/protocol.ts';
import { DISCOVERED_DOC_KEY } from '../shared/protocol.ts';
import { daemonUrl } from './daemon';

export interface Link {
  client: BridgethingClient;
  connected: boolean;
  hasExtension: boolean;
  accounts: AccountView[];
  discovered: DiscoveredAccount[];
  machine: MachineView | null;
  sessions: SessionView[];
  prompts: PromptView[];
  hook: HookStatus | null;
  polling: boolean;
  config: Record<string, string>;
  lastPushAt: number | null;
  offsetMs: number;
  refresh: () => void;
  present: () => void;
  answer: (id: string, decision: 'allow' | 'deny') => void;
}

function useClockOffset(client: BridgethingClient): [number, (at: number) => void] {
  const [offset, setOffset] = useState(0);
  const fromPush = useRef(false);

  useEffect(() => {
    client.time.get().then(result => {
      if (fromPush.current || !result.ok) return;
      const seconds = result.response.time.wallClockUnixS;
      if (seconds) setOffset(seconds * 1000 - Date.now());
    });
  }, [client]);

  const adopt = useCallback((at: number) => {
    fromPush.current = true;
    setOffset(at - Date.now());
  }, []);

  return [offset, adopt];
}

export function useLink(): Link {
  const client = useMemo(() => new BridgethingClient({ url: daemonUrl() }), []);
  const [connected, setConnected] = useState(client.connectionState === 'open');
  const [hasExtension, setHasExtension] = useState(false);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredAccount[]>([]);
  const [machine, setMachine] = useState<MachineView | null>(null);
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [prompts, setPrompts] = useState<PromptView[]>([]);
  const [hook, setHook] = useState<HookStatus | null>(null);
  const [polling, setPolling] = useState(false);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [lastPushAt, setLastPushAt] = useState<number | null>(null);
  const [offsetMs, setOffset] = useClockOffset(client);
  const publishedDoc = useRef<string | null>(null);

  useEffect(() => {
    const hello = () => void client.forward.json({ t: 'hello' });

    const offLink = client.on(event => {
      if (event.type !== 'open' && event.type !== 'close' && event.type !== 'connecting') return;
      const open = client.connectionState === 'open';
      setConnected(open);
      if (open) hello();
    });

    const offCapabilities = client.capabilities.onSnapshot(snapshot =>
      setHasExtension(snapshot.capabilities.available.forward),
    );

    const offConfig = client.config.onChanged(changed =>
      setConfig(current => {
        const next = { ...current };
        if (changed.value === null) delete next[changed.key];
        else next[changed.key] = changed.value;
        return next;
      }),
    );

    client.config.list().then(result => {
      if (result.ok) setConfig(Object.fromEntries(result.response.entries.map(entry => [entry.key, entry.value])));
    });

    const offPush = client.forward.onJson(payload => {
      const push = payload as Push;
      setLastPushAt(Date.now());
      setOffset(push.at);
      if (push.t === 'accounts') {
        setAccounts(push.accounts);
        setDiscovered(push.discovered);
        setPolling(push.polling);
        const encoded = JSON.stringify(push.discovered);
        if (publishedDoc.current !== encoded) {
          publishedDoc.current = encoded;
          void client.doc.set({ key: DISCOVERED_DOC_KEY, value: encoded });
        }
      } else if (push.t === 'machine') setMachine(push.machine);
      else if (push.t === 'sessions') setSessions(push.sessions);
      else if (push.t === 'prompts') {
        setPrompts(push.prompts);
        setHook(push.hook);
      }
    });

    client.capabilities.get().then(result => {
      if (result.ok) setHasExtension(result.response.capabilities.available.forward);
    });
    if (client.connectionState === 'open') hello();

    return () => {
      offLink();
      offCapabilities();
      offConfig();
      offPush();
    };
  }, [client, setOffset]);

  const refresh = useCallback(() => void client.forward.json({ t: 'refresh' }), [client]);
  const present = useCallback(() => void client.forward.json({ t: 'present' }), [client]);
  const answer = useCallback(
    (id: string, decision: 'allow' | 'deny') => void client.forward.json({ t: 'answer', id, decision }),
    [client],
  );

  return {
    client,
    connected,
    hasExtension,
    accounts,
    discovered,
    machine,
    sessions,
    prompts,
    hook,
    polling,
    config,
    lastPushAt,
    offsetMs,
    refresh,
    present,
    answer,
  };
}

export function useNow(offsetMs: number, periodMs = 1000): number {
  const [now, setNow] = useState(() => Date.now() + offsetMs);
  useEffect(() => {
    setNow(Date.now() + offsetMs);
    const timer = setInterval(() => setNow(Date.now() + offsetMs), periodMs);
    return () => clearInterval(timer);
  }, [offsetMs, periodMs]);
  return now;
}
