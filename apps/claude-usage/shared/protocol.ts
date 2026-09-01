export type Severity = 'normal' | 'warning' | 'critical' | string;

export type LimitKind = 'session' | 'weekly_all' | 'weekly_scoped' | string;

export interface LimitView {
  kind: LimitKind;
  group: string;
  label: string;
  percent: number;
  severity: Severity;
  resetsAt: number | null;
  isActive: boolean;
}

export interface ExtraUsageView {
  enabled: boolean;
  utilization: number | null;
  usedCredits: number | null;
  monthlyLimit: number | null;
  currency: string;
  disabledReason: string | null;
}

export interface SpendView {
  enabled: boolean;
  percent: number;
  severity: Severity;
  usedMinor: number;
  currency: string;
  exponent: number;
  capMinor: number | null;
}

export type StaleReason = 'expired' | 'unauthorized' | 'network' | 'no-credential';

export interface StaleView {
  reason: StaleReason;
  detail: string;
  since: number;
}

export interface AccountView {
  id: string;
  dir: string;
  label: string;
  org: string | null;
  plan: string | null;
  tier: string | null;
  limits: LimitView[];
  extra: ExtraUsageView | null;
  spend: SpendView | null;
  readingAt: number | null;
  stale: StaleView | null;
  refreshEnabled: boolean;
}

export interface Toks {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export interface DayBucket {
  day: string;
  toks: Toks;
  messages: number;
}

export interface ProjectBucket {
  name: string;
  path: string;
  toks: Toks;
}

export interface ModelBucket {
  model: string;
  toks: Toks;
}

export interface MachineView {
  days: DayBucket[];
  projects: ProjectBucket[];
  models: ModelBucket[];
  totals: Toks;
  totalMessages: number;
  totalSessions: number;
  scan: { done: number; total: number; running: boolean };
  sharedBy: string[];
}

export type SessionStatus = 'running' | 'waiting' | 'idle';

export interface SessionView {
  id: string;
  project: string;
  cwd: string;
  title: string | null;
  branch: string | null;
  model: string | null;
  contextTokens: number;
  contextLimit: number | null;
  lastAt: number;
  status: SessionStatus;
  pendingTool: string | null;
}

export interface DiscoveredAccount {
  dir: string;
  name: string;
}

export const DISCOVERED_DOC_KEY = 'discovered-accounts';

export interface PromptView {
  id: string;
  tool: string;
  summary: string;
  detail: string | null;
  project: string;
  session: string;
  mode: string;
  askedAt: number;
  expiresAt: number;
}

export interface HookStatus {
  enabled: boolean;
  listening: boolean;
  holding: boolean;
  installedIn: string[];
  error: string | null;
}

export type Push =
  | { t: 'accounts'; at: number; accounts: AccountView[]; discovered: DiscoveredAccount[]; polling: boolean }
  | { t: 'machine'; at: number; machine: MachineView }
  | { t: 'sessions'; at: number; sessions: SessionView[] }
  | { t: 'prompts'; at: number; prompts: PromptView[]; hook: HookStatus }
  | { t: 'notice'; at: number; level: 'info' | 'warn' | 'error'; text: string };

export type Pull =
  | { t: 'hello' }
  | { t: 'refresh' }
  | { t: 'present' }
  | { t: 'answer'; id: string; decision: 'allow' | 'deny' };
