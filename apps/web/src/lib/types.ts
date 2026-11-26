import type { ActionStatus, PortalConfig, PullSetting, StepStatus } from '@complao/core/shared';
export type { ActionStatus, PortalConfig, PullSetting, StepStatus };

export interface Meta {
  types: string[];
  components: string[];
  config: PortalConfig;
  pull: PullSetting;
  serverTime: string;
  demo: boolean;
}

export interface ActionRow {
  actionId: string;
  actionType: string | null;
  caseId: string | null;
  actorId: string | null;
  startedAt: string;
  status: ActionStatus;
  incomplete: boolean;
  durationMs: number | null;
  runningForMs: number | null;
  aiCostUsd: number;
  aiCalls: number;
  stepCount: number;
  failedSteps: number;
  lastEventAt: string;
}

export type Names = Record<string, string>;

export interface ActionListResponse {
  items: ActionRow[];
  cursor: string | null;
  names: Names;
}

export interface StepView {
  stepId: string;
  parentStepId: string | null;
  stepName: string;
  component: string;
  startedAt: string;
  latencyMs: number;
  status: StepStatus;
  responseCode: string | null;
  details: Record<string, unknown>;
  aiCostUsd: number | null;
  serverFailure: boolean;
  depth: number;
  hasChildren: boolean;
  offsetMs: number;
  slowest: boolean;
  orphan: boolean;
}

export interface ActionDetailResponse {
  action: ActionRow & { endedAt: string | null; hasStart: boolean; hasEnd: boolean; tokensIn: number; tokensOut: number; components: string[] };
  steps: StepView[];
  spanMs: number;
  missing: { incomplete: boolean; missingParents: string[]; missingStart: boolean };
  journey: ActionRow[];
  names: Names;
  views: number;
}

export interface JourneyResponse {
  caseId: string;
  actions: (ActionRow & { waitBeforeMs: number | null })[];
  totalMs: number;
  names: Names;
}

export interface HealthRow {
  component: string;
  requests: number;
  failures: number;
  serverFailures: number;
  successRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number;
  degraded: boolean;
  degradedReasons: string[];
  previous: { requests: number; successRate: number | null; p50Ms: number | null; p95Ms: number | null };
  series: { t: string; requests: number; failures: number }[];
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

export interface CostResponse {
  series: { day: string; costUsd: number; calls: number; tokensIn: number; tokensOut: number }[];
  week: number;
  previousWeek: number | null;
  today: number;
}
