export type UsageProviderKind = 'claude' | 'codex' | 'grok' | 'cursor' | 'opencode' | 'antigravity' | 'pi';

export type UsageResolution = 'day' | 'hour';

export type UsageCostSource = 'providerReported' | 'modelPriced' | 'unpriced';

export type UsageTokenTotals = {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
};

export type UsageCategoryCost = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
};

export type UsageBucket = {
  day: string;
  hourStart?: string;
  provider: UsageProviderKind;
  model: string;
  sourcePath?: string;
  totals: UsageTokenTotals;
  costUsd: number;
  cacheSavingsUsd: number;
  categoryCostUsd?: UsageCategoryCost;
  fastCostUsd?: number;
  ultrafastCostUsd?: number;
  speedPremiumUsd?: number;
  costSource: UsageCostSource;
  records: number;
  unpricedRecords: number;
  sessions: number;
};

export type UsageSourceFingerprint = {
  hostId: string;
  provider: UsageProviderKind;
  resolvedHomePath: string;
  volumeId: string;
};

export type UsageSourceStatus = 'ok' | 'missing' | 'partial' | 'failed';

export type UsageSource = {
  fingerprint: UsageSourceFingerprint;
  status: UsageSourceStatus;
  scannedFiles: number;
  skippedFiles: number;
  malformedRecords: number;
  distinctSessions: number;
  message: string | null;
  action?: 'enableCursorKeychain';
  refreshing?: true;
};

export type UsagePricing = {
  status: 'fresh' | 'cached' | 'unavailable';
  source: string;
  fetchedAt: string | null;
  knownModels: number;
};

export type UsageSummaryInput = {
  sinceDay: string;
  untilDay: string;
  timeZone: string;
  resolution?: UsageResolution;
  sinceTime?: string;
  untilTime?: string;
  awaitRefresh?: boolean;
};

export type UsageSummary = {
  contractVersion: number;
  readAt: string;
  timeZone: string;
  sinceDay: string;
  untilDay: string;
  buckets: UsageBucket[];
  sources: UsageSource[];
  pricing: UsagePricing;
  scanDurationMs: number;
};

export type ServerProviderUsageWindowKind = 'session' | 'weekly' | 'monthly' | 'other';

export type ServerProviderUsageWindow = {
  id: string;
  kind: ServerProviderUsageWindowKind;
  label: string;
  usedPercent: number;
  resetsAt?: string;
  windowDurationMins?: number;
};

export type ServerProviderResetCredits = {
  availableCount: number;
  nextExpiresAt?: string;
  nextCreditId?: string;
};

export type ServerProviderUsageLimits = {
  checkedAt: string;
  windows: ServerProviderUsageWindow[];
  credentialFingerprint?: string;
  resetCredits?: ServerProviderResetCredits;
  externalUsage?: { label: string; url: string };
  unavailable?: { reason: 'unsupported' | 'probeFailed'; message?: string };
};

export type UsageLimitSourceAccount = {
  id: string;
  driver: string;
  email?: string;
  plan?: string;
  workspaceId?: string;
  usageLimits: ServerProviderUsageLimits;
};

export type UsageLimitSourceSnapshot = {
  id: string;
  kind: 'cliproxy';
  label: string;
  checkedAt: string;
  accounts: UsageLimitSourceAccount[];
  error?: string;
};

export type RunStatus =
  | 'preparing'
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'cancelled'
  | 'rolled_back';

export type ShellThreadStatus = 'idle' | RunStatus;

export type ActivityRunStatus = 'preparing' | 'starting' | 'running' | 'waiting';

export type ProviderFailureClass =
  'usage_limit' | 'provider_error' | 'transport_error' | 'permission_error' | 'validation_error' | 'unknown';

export type RuntimeRequestKind =
  | 'command'
  | 'file-read'
  | 'file-change'
  | 'mcp-elicitation'
  | 'permission'
  | 'dynamic_tool_call'
  | 'user_input'
  | 'auth_refresh';

export type PendingRuntimeRequestSummary = {
  id: string;
  kind: RuntimeRequestKind;
  createdAt: string;
  blocking?: boolean;
};

export type PendingBackgroundTaskKind = 'subagent' | 'command' | 'monitor' | 'background_task';

export type PendingBackgroundTask = {
  taskId: string;
  description?: string;
  parentTaskId?: string;
  kind: PendingBackgroundTaskKind;
  providerInstanceId?: string;
  childThreadId?: string;
};

export type ThreadLineage = {
  parentThreadId: string | null;
  relationshipToParent: 'fork' | 'subagent' | null;
  rootThreadId: string;
};

export type ModelSelection = {
  instanceId: string;
  model: string;
  options?: unknown;
};

export type ThreadPullRequestLink = {
  host: string;
  repository: string;
  number: number;
  url: string;
  repositoryWebUrl?: string;
  source: 'manual' | 'created' | 'agent' | 'stack' | 'stack-dismissed';
  linkedAt: string;
  snapshot: unknown;
  stack: unknown;
  watch?: unknown;
  endedWatch?: unknown;
};

export type ThreadShellRow = {
  id: string;
  projectId: string;
  title: string;
  providerInstanceId: string;
  modelSelection: ModelSelection;
  branch: string | null;
  worktreePath: string | null;
  pullRequests?: ThreadPullRequestLink[];
  lineage: ThreadLineage;
  activeProviderThreadId: string | null;
  latestRunId: string | null;
  latestRunRequestedAt?: string | null;
  latestRunStartedAt?: string | null;
  latestRunCompletedAt?: string | null;
  latestRunStopRequested?: boolean;
  activeRunId: string | null;
  activityRunStartedAt?: string | null;
  activityRunStatus?: ActivityRunStatus | null;
  blockedOnThreadWait?: boolean;
  status: ShellThreadStatus;
  lastError?: string | null;
  lastErrorClass?: ProviderFailureClass | null;
  lastErrorCode?: string | null;
  usageLimitResetAt?: string | null;
  pendingRuntimeRequest: PendingRuntimeRequestSummary | null;
  latestUserMessageAt: string | null;
  latestUserAuthoredMessageAt?: string | null;
  hasActionableProposedPlan: boolean;
  pendingBackgroundTasks?: PendingBackgroundTask[];
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  settledOverride: 'settled' | 'active' | null;
  settledAt: string | null;
  unsettledAt?: string | null;
  snoozedUntil?: string | null;
  snoozedAt?: string | null;
  pinnedAt?: string | null;
  lastVisitedAt?: string | null;
  deletedAt: string | null;
};
