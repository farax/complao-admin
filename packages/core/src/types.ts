/** Appendix A: one JSON log event written by a Complao service. */
export type EventType = 'action_start' | 'step' | 'action_end';
export type StepStatus = 'success' | 'failure' | 'skipped';

export interface LogEvent {
  event_type: EventType;
  action_id: string;
  action_type?: string;
  step_id?: string;
  parent_step_id?: string | null;
  step_name?: string;
  component: string;
  started_at: string; // ISO UTC to the millisecond
  latency_ms?: number;
  status?: StepStatus;
  response_code?: string | number;
  actor_id: string;
  case_id?: string | null;
  details?: Record<string, unknown>;
}

/** Derived action status (R7). */
export type ActionStatus = 'in_progress' | 'completed' | 'failed' | 'partial' | 'stalled';

/** Action header item as kept in the store. Never holds names (R3, R15). */
export interface ActionRecord {
  actionId: string;
  actionType: string | null;
  actorId: string | null;
  caseId: string | null;
  startedAt: string; // from action_start, or the earliest step if the start event is missing
  hasStart: boolean;
  hasEnd: boolean;
  endedAt: string | null;
  latencyMs: number | null;
  endStatus: StepStatus | null;
  lastEventAt: string;
  stepIds: string[];
  parentIds: string[];
  failedStepIds: string[];
  components: string[];
  aiCostUsd: number;
  aiCalls: number;
  tokensIn: number;
  tokensOut: number;
}

export interface StepRecord {
  actionId: string;
  stepId: string;
  parentStepId: string | null;
  stepName: string;
  component: string;
  startedAt: string;
  latencyMs: number;
  status: StepStatus;
  responseCode: string | null;
  actorId: string;
  caseId: string | null;
  details: Record<string, unknown>;
  aiCostUsd: number | null;
  serverFailure: boolean;
}

/** One 5-minute summary window for one component (section 6.4). */
export interface HealthWindow {
  component: string;
  windowStart: string;
  count: number;
  failures: number;
  serverFailures: number;
  maxMs: number;
  sumMs: number;
  buckets: number[]; // histogram counts, see histogram.ts
}

export interface CostDay {
  day: string; // YYYY-MM-DD (UTC)
  costUsd: number;
  calls: number;
  tokensIn: number;
  tokensOut: number;
}

export interface PullSetting {
  intervalSeconds: number; // 30 .. 86400
  paused: boolean;
  lastPullAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastEventsIngested: number;
  updatedAt: string | null;
}

export interface PriceEntry {
  /** USD per 1,000 input tokens */
  inputPer1k: number;
  /** USD per 1,000 output tokens */
  outputPer1k: number;
}

export interface PortalConfig {
  /** Minutes with no event before an unfinished action shows Stalled (R7). */
  stalledMinutes: number;
  /** A step longer than this flags its component Degraded (R20). */
  slowStepMs: number;
  /** A failed step with a response code at or above this counts as server-side (R20). */
  serverErrorMinCode: number;
  displayNames: { actionTypes: Record<string, string>; components: Record<string, string> };
  /** Model ID -> price. "*" is the fallback. */
  prices: Record<string, PriceEntry>;
  currency: { primary: 'AUD' | 'USD'; usdToAud: number; showSecondary: boolean };
}

export const DEFAULT_CONFIG: PortalConfig = {
  stalledMinutes: 10,
  slowStepMs: 60_000,
  serverErrorMinCode: 500,
  displayNames: {
    actionTypes: {
      'CB registration': 'Certification body registration',
    },
    components: {},
  },
  prices: {
    '*': { inputPer1k: 0.003, outputPer1k: 0.015 },
  },
  currency: { primary: 'AUD', usdToAud: 1.53, showSecondary: true },
};

export const DEFAULT_PULL: PullSetting = {
  intervalSeconds: 60,
  paused: false,
  lastPullAt: null,
  lastSuccessAt: null,
  lastError: null,
  lastEventsIngested: 0,
  updatedAt: null,
};

export const MIN_INTERVAL_SECONDS = 30;
export const MAX_INTERVAL_SECONDS = 86_400;
