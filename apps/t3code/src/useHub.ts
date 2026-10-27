import { BridgethingClient } from '@bridgething/client';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { daemonUrl } from './daemon';
import { Hub } from './hub';

const client = new BridgethingClient({ url: daemonUrl() });
export const hub = new Hub(client);

export function useHub() {
  const state = useSyncExternalStore(hub.subscribe, hub.snapshot);
  const [config, setConfig] = useState<Record<string, string>>({});
  const account = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    let debounce: ReturnType<typeof setTimeout>;
    async function read() {
      const result = await client.config.list().catch(() => null);
      if (!active || !result?.ok) return;
      const values = Object.fromEntries(result.response.entries.map(entry => [entry.key, entry.value ?? '']));
      setConfig(values);
      if (values.account !== account.current) {
        account.current = values.account ?? '';
        void hub.configure(values);
      }
    }
    const off = client.on(event => {
      if (event.type === 'open') void read();
    });
    const changed = client.config.onChanged(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => void read(), 300);
    });
    if (client.connectionState === 'open') void read();
    return () => {
      active = false;
      off();
      changed();
      clearTimeout(debounce);
    };
  }, []);

  return { state, showNames: config.accountNames === 'true' };
}
