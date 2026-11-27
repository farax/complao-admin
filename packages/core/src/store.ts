import type { ActionRecord, CostDay, HealthWindow, PortalConfig, PullSetting, SessionRecord, StepRecord, StepStatus } from './types';

export type RegistryKind = 'type' | 'component' | 'role';

/** Who did it and in which visit: carried by every action-level write. */
export interface Who {
  sessionId: string | null;
  actorRole: string | null;
}

export interface ActionStartInput extends Who {
  actionId: string;
  actionType: string;
  actorId: string;
  caseId: string | null;
  component: string;
  startedAt: string;
}

export interface ActionEndInput extends Who {
  actionId: string;
  actorId: string;
  caseId: string | null;
  component: string;
  startedAt: string;
  endedAt: string;
  latencyMs: number;
  status: StepStatus;
}

export interface StepTouch extends Who {
  step: StepRecord;
  isNew: boolean;
  completedAt: string;
  ai: { costUsd: number; tokensIn: number; tokensOut: number } | null;
}

export interface SessionTouch {
  sessionId: string;
  actorId: string;
  actorRole: string | null;
  /** When the event happened (its completion time). */
  at: string;
  actionId: string;
  caseId: string | null;
  failed: boolean;
  login: boolean;
  logout: boolean;
}

export interface Page<T> {
  items: T[];
  /** Opaque continuation for the same partition, or null when the partition is exhausted. */
  next: unknown | null;
}

export interface RangeQuery {
  fromIso: string;
  toIso: string;
  limit: number;
  next?: unknown | null;
  newestFirst?: boolean;
}

/**
 * The action store (section 6.4, Appendix B). Two implementations share this contract:
 * DynamoStore for AWS and MemoryStore for local demo and tests.
 *
 * Ingestion writes are idempotent: an event read twice (the 2-minute overlap) overwrites
 * itself, and counters only move the first time a step is seen.
 */
export interface ActionStore {
  // ---- ingestion writes ----
  /** Write a step. Returns true if it was not in the store before. */
  putStep(step: StepRecord): Promise<boolean>;
  applyActionStart(input: ActionStartInput): Promise<void>;
  applyActionEnd(input: ActionEndInput): Promise<void>;
  touchActionFromStep(t: StepTouch): Promise<void>;
  addHealth(component: string, windowStart: string, latencyMs: number, failure: boolean, serverFailure: boolean): Promise<void>;
  addCost(day: string, costUsd: number, tokensIn: number, tokensOut: number): Promise<void>;
  touchSession(t: SessionTouch): Promise<void>;
  register(kind: RegistryKind, value: string): Promise<void>;
  getCheckpoint(logGroup: string): Promise<number | null>;
  putCheckpoint(logGroup: string, ms: number): Promise<void>;
  recordPull(update: Partial<PullSetting>): Promise<void>;

  // ---- portal reads ----
  getAction(actionId: string): Promise<ActionRecord | null>;
  getActions(actionIds: string[]): Promise<ActionRecord[]>;
  getSteps(actionId: string): Promise<StepRecord[]>;
  queryActionsByDay(day: string, q: RangeQuery): Promise<Page<ActionRecord>>;
  queryActionsByCase(caseId: string): Promise<ActionRecord[]>;
  queryStepsByComponentDay(component: string, day: string, q: RangeQuery): Promise<Page<StepRecord>>;
  getHealthWindows(component: string, fromIso: string, toIso: string): Promise<HealthWindow[]>;
  getCostDays(fromDay: string, toDay: string): Promise<CostDay[]>;
  listRegistry(kind: RegistryKind): Promise<string[]>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  /** Sessions that started on this day (UTC), newest first. */
  querySessionsByDay(day: string, q: RangeQuery): Promise<Page<SessionRecord>>;
  queryActionsBySession(sessionId: string): Promise<ActionRecord[]>;
  getPull(): Promise<PullSetting>;
  getConfig(): Promise<PortalConfig>;

  // ---- portal writes (the only ones the portal role may make, see infra/template.yaml) ----
  putPullSetting(update: Pick<PullSetting, 'intervalSeconds' | 'paused'>): Promise<PullSetting>;
  putConfig(cfg: PortalConfig): Promise<void>;
  recordView(actionId: string, atIso: string): Promise<void>;
  countViews(actionId: string): Promise<number>;
}

export function mergeConfig<T extends object>(base: T, override: Partial<T> | undefined): T {
  if (!override) return structuredClone(base);
  const out: any = structuredClone(base);
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object') out[k] = { ...out[k], ...v };
    else if (v !== undefined) out[k] = v;
  }
  return out;
}
