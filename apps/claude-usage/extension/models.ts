import type { KvStore } from '@bridgething/extension';

const MODELS_URL = 'https://api.anthropic.com/v1/models';
const OAUTH_BETA = 'oauth-2025-04-20';
const API_VERSION = '2023-06-01';
const KV_MODELS = 'models.limits';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;

interface Entry {
  limit: number | null;
  at: number;
}

export class ModelLimits {
  private cache: Record<string, Entry> = {};
  private loaded = false;
  private inflight = new Set<string>();

  constructor(
    private readonly kv: KvStore,
    private readonly log: (message: string) => void,
  ) {}

  async ready(): Promise<void> {
    if (this.loaded) return;
    this.cache = (await this.kv.get<Record<string, Entry>>(KV_MODELS)) ?? {};
    this.loaded = true;
  }

  limit(model: string | null | undefined): number | null {
    if (!model) return null;
    return this.cache[model]?.limit ?? null;
  }

  async prime(models: Iterable<string>, accessToken: string): Promise<boolean> {
    await this.ready();
    const now = Date.now();
    const wanted = [...new Set(models)].filter(model => {
      if (!model || model.startsWith('<') || this.inflight.has(model)) return false;
      const held = this.cache[model];
      if (!held) return true;
      return now - held.at > (held.limit === null ? MISS_TTL_MS : TTL_MS);
    });
    if (wanted.length === 0) return false;

    for (const model of wanted) this.inflight.add(model);
    try {
      const found = await Promise.all(wanted.map(model => this.fetchOne(model, accessToken)));
      for (const [index, limit] of found.entries()) {
        this.cache[wanted[index]!] = { limit, at: Date.now() };
      }
      await this.kv.set(KV_MODELS, this.cache).catch(() => {});
    } finally {
      for (const model of wanted) this.inflight.delete(model);
    }
    return true;
  }

  private async fetchOne(model: string, accessToken: string): Promise<number | null> {
    try {
      const response = await fetch(`${MODELS_URL}/${encodeURIComponent(model)}`, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          'anthropic-beta': OAUTH_BETA,
          'anthropic-version': API_VERSION,
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      const body = (await response.json()) as { max_input_tokens?: number };
      return typeof body.max_input_tokens === 'number' ? body.max_input_tokens : null;
    } catch (err) {
      this.log(`could not read the context window for ${model}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
