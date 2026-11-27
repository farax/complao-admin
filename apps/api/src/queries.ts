import {
  buildTree,
  daysBetween,
  deriveStatus,
  emptyBuckets,
  flattenTree,
  mergeBuckets,
  missingSteps,
  percentile,
  type ActionRecord,
  type ActionStatus,
  type ActionStore,
  type HealthWindow,
  type PortalConfig,
  type StepRecord,
} from '@complao/core/browser';

export interface ActionRow {
  actionId: string;
  actionType: string | null;
  caseId: string | null;
  actorId: string | null;
  actorRole: string | null;
  sessionId: string | null;
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

export function toRow(a: ActionRecord, cfg: PortalConfig, now = Date.now()): ActionRow {
  const status = deriveStatus(a, cfg, now);
  return {
    actionId: a.actionId,
    actionType: a.actionType,
    caseId: a.caseId,
    actorId: a.actorId,
    actorRole: a.actorRole,
    sessionId: a.sessionId,
    startedAt: a.startedAt,
    status,
    incomplete: missingSteps(a).incomplete,
    durationMs: a.hasEnd ? a.latencyMs : null,
    runningForMs: a.hasEnd ? null : now - new Date(a.startedAt).getTime(),
    aiCostUsd: a.aiCostUsd,
    aiCalls: a.aiCalls,
    stepCount: a.stepIds.length,
    failedSteps: a.failedStepIds.length,
    lastEventAt: a.lastEventAt,
  };
}

// ---------------------------------------------------------------- cursor

interface Cursor {
  d: number; // index into the day list
  n: unknown; // store continuation within that day
}
// Cursors are JSON in URL-safe base64. Works in Node and in the browser preview build.
const b64 = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/'));
export const encodeCursor = (c: Cursor) => b64(JSON.stringify(c));
export function decodeCursor(s: unknown): Cursor | null {
  if (typeof s !== 'string' || !s) return null;
  try {
    return JSON.parse(unb64(s));
  } catch {
    return null;
  }
}

/**
 * Walk day partitions newest first, applying in-memory filters, until `limit` rows match
 * or the scan budget is spent. Returns a cursor to continue from.
 */
export async function walkDays<T>(
  days: string[],
  fetchPage: (day: string, next: unknown) => Promise<{ items: T[]; next: unknown | null }>,
  keep: (item: T) => boolean,
  limit: number,
  cursor: Cursor | null,
  scanBudget = 3000,
): Promise<{ items: T[]; cursor: string | null; scanned: number }> {
  const out: T[] = [];
  let d = cursor?.d ?? 0;
  let next: unknown = cursor?.n ?? null;
  let scanned = 0;
  while (d < days.length) {
    const page = await fetchPage(days[d], next);
    scanned += page.items.length;
    for (const it of page.items) if (keep(it)) out.push(it);
    if (page.next) next = page.next;
    else {
      d++;
      next = null;
    }
    if (out.length >= limit || scanned >= scanBudget) break;
  }
  const done = d >= days.length;
  return { items: out, cursor: done ? null : encodeCursor({ d, n: next }), scanned };
}

// ---------------------------------------------------------------- action list (R4)

export interface ListFilters {
  from: string;
  to: string;
  types?: string[];
  statuses?: (ActionStatus | 'incomplete')[];
  actor?: string;
  roles?: string[];
  caseId?: string;
  limit: number;
  cursor?: string;
}

export async function listActions(store: ActionStore, cfg: PortalConfig, f: ListFilters) {
  const now = Date.now();
  if (f.caseId) {
    const rows = (await store.queryActionsByCase(f.caseId)).map((a) => toRow(a, cfg, now)).reverse();
    return { items: rows.filter((r) => matches(r, f)), cursor: null };
  }
  const days = daysBetween(f.from, f.to);
  const res = await walkDays(
    days,
    (day, next) => store.queryActionsByDay(day, { fromIso: f.from, toIso: f.to, limit: hasFilters(f) ? 200 : f.limit, next, newestFirst: true }),
    (a: ActionRecord) => matches(toRow(a, cfg, now), f),
    f.limit,
    decodeCursor(f.cursor),
  );
  // A page fetch can overshoot the limit; anything cut here would be skipped by the cursor,
  // so we return the whole fetched set (still newest first) rather than trimming.
  return { items: res.items.map((a) => toRow(a, cfg, now)), cursor: res.cursor };
}

const hasFilters = (f: ListFilters) => Boolean(f.types?.length || f.statuses?.length || f.actor || f.roles?.length);

function matches(r: ActionRow, f: ListFilters): boolean {
  if (f.types?.length && !f.types.includes(r.actionType ?? '')) return false;
  if (f.actor && r.actorId !== f.actor) return false;
  if (f.roles?.length && !f.roles.includes(r.actorRole ?? '')) return false;
  if (f.statuses?.length) {
    const ok = f.statuses.some((s) => (s === 'incomplete' ? r.incomplete : r.status === s));
    if (!ok) return false;
  }
  return true;
}

// ---------------------------------------------------------------- action detail (R6)

export interface StepView extends Omit<StepRecord, 'actionId' | 'actorId' | 'caseId'> {
  depth: number;
  hasChildren: boolean;
  offsetMs: number;
  slowest: boolean;
  orphan: boolean;
}

export async function actionDetail(store: ActionStore, cfg: PortalConfig, actionId: string) {
  const [action, steps] = await Promise.all([store.getAction(actionId), store.getSteps(actionId)]);
  if (!action) return null;
  const row = toRow(action, cfg);
  const flat = flattenTree(buildTree(steps));
  const t0 = new Date(action.startedAt).getTime();
  const slowest = flat.reduce<(typeof flat)[number] | null>((m, s) => (!m || s.latencyMs > m.latencyMs ? s : m), null);
  const endMs = Math.max(
    action.endedAt ? new Date(action.endedAt).getTime() : 0,
    ...flat.map((s) => new Date(s.startedAt).getTime() + s.latencyMs),
    t0 + 1,
  );
  const views: StepView[] = flat.map((s) => ({
    stepId: s.stepId,
    parentStepId: s.parentStepId,
    stepName: s.stepName,
    component: s.component,
    startedAt: s.startedAt,
    latencyMs: s.latencyMs,
    status: s.status,
    responseCode: s.responseCode,
    details: s.details,
    aiCostUsd: s.aiCostUsd,
    serverFailure: s.serverFailure,
    depth: s.depth,
    hasChildren: s.children.length > 0,
    offsetMs: new Date(s.startedAt).getTime() - t0,
    slowest: slowest?.stepId === s.stepId && flat.length > 1,
    orphan: s.orphan,
  }));
  const journey = action.caseId ? (await store.queryActionsByCase(action.caseId)).map((a) => toRow(a, cfg)) : [];
  const gaps = missingSteps(action);
  return {
    action: { ...row, endedAt: action.endedAt, hasStart: action.hasStart, hasEnd: action.hasEnd, tokensIn: action.tokensIn, tokensOut: action.tokensOut, components: action.components },
    steps: views,
    spanMs: endMs - t0,
    missing: gaps,
    journey,
  };
}

// ---------------------------------------------------------------- journeys (R18)

export async function journey(store: ActionStore, cfg: PortalConfig, caseId: string) {
  const actions = (await store.queryActionsByCase(caseId)).map((a) => toRow(a, cfg));
  const withGaps = actions.map((a, i) => {
    const prev = actions[i - 1];
    const prevEnd = prev ? new Date(prev.startedAt).getTime() + (prev.durationMs ?? prev.runningForMs ?? 0) : null;
    return { ...a, waitBeforeMs: prevEnd === null ? null : Math.max(0, new Date(a.startedAt).getTime() - prevEnd) };
  });
  const first = actions[0];
  const last = actions[actions.length - 1];
  const totalMs = first && last ? new Date(last.startedAt).getTime() + (last.durationMs ?? last.runningForMs ?? 0) - new Date(first.startedAt).getTime() : 0;
  return { caseId, actions: withGaps, totalMs };
}

// ---------------------------------------------------------------- component health (R19, R20)

export const PERIODS = {
  '1h': { ms: 3_600_000, points: 12 },
  '24h': { ms: 86_400_000, points: 24 },
  '7d': { ms: 7 * 86_400_000, points: 28 },
} as const;
export type Period = keyof typeof PERIODS;

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

function summarise(ws: HealthWindow[]) {
  const buckets = emptyBuckets();
  let count = 0,
    failures = 0,
    serverFailures = 0,
    maxMs = 0;
  for (const w of ws) {
    mergeBuckets(buckets, w.buckets);
    count += w.count;
    failures += w.failures;
    serverFailures += w.serverFailures;
    maxMs = Math.max(maxMs, w.maxMs);
  }
  return {
    count,
    failures,
    serverFailures,
    maxMs,
    successRate: count ? (count - failures) / count : null,
    p50: percentile(buckets, 50, maxMs),
    p95: percentile(buckets, 95, maxMs),
  };
}

export async function componentHealth(store: ActionStore, cfg: PortalConfig, period: Period, now = Date.now()): Promise<HealthRow[]> {
  const { ms, points } = PERIODS[period];
  const from = now - ms;
  const prevFrom = from - ms;
  const components = await store.listRegistry('component');
  const rows = await Promise.all(
    components.map(async (component) => {
      const all = await store.getHealthWindows(component, new Date(prevFrom).toISOString(), new Date(now).toISOString());
      const fromIso = new Date(from - 5 * 60_000 + 1).toISOString(); // include the window that straddles `from`
      const cur = all.filter((w) => w.windowStart >= fromIso);
      const prev = all.filter((w) => w.windowStart < fromIso);
      const c = summarise(cur);
      const p = summarise(prev);
      const reasons: string[] = [];
      if (c.serverFailures > 0) reasons.push(`${c.serverFailures} server-side failure${c.serverFailures === 1 ? '' : 's'}`);
      if (c.maxMs > cfg.slowStepMs) reasons.push(`a step took ${(c.maxMs / 1000).toFixed(1)} s (limit ${cfg.slowStepMs / 1000} s)`);
      const step = ms / points;
      const series = Array.from({ length: points }, (_, i) => ({ t: new Date(from + i * step).toISOString(), requests: 0, failures: 0 }));
      for (const w of cur) {
        const i = Math.min(points - 1, Math.max(0, Math.floor((new Date(w.windowStart).getTime() - from) / step)));
        series[i].requests += w.count;
        series[i].failures += w.failures;
      }
      return {
        component,
        requests: c.count,
        failures: c.failures,
        serverFailures: c.serverFailures,
        successRate: c.successRate,
        p50Ms: c.p50,
        p95Ms: c.p95,
        maxMs: c.maxMs,
        degraded: reasons.length > 0,
        degradedReasons: reasons,
        previous: { requests: p.count, successRate: p.successRate, p50Ms: p.p50, p95Ms: p.p95 },
        series,
      } satisfies HealthRow;
    }),
  );
  return rows.sort((a, b) => Number(b.degraded) - Number(a.degraded) || b.requests - a.requests);
}

// ---------------------------------------------------------------- logs by area (R8)

export interface StepFilters {
  component: string;
  from: string;
  to: string;
  stepName?: string;
  status?: string;
  responseCode?: string;
  actionId?: string;
  failedFirst?: boolean;
  limit: number;
  cursor?: string;
}

export async function stepsByArea(store: ActionStore, f: StepFilters) {
  const keep = (s: StepRecord) =>
    (!f.stepName || s.stepName.toLowerCase().includes(f.stepName.toLowerCase())) &&
    (!f.status || s.status === f.status) &&
    (!f.responseCode || (s.responseCode ?? '') === f.responseCode) &&
    (!f.actionId || s.actionId === f.actionId);

  if (f.actionId) {
    const items = (await store.getSteps(f.actionId)).filter((s) => s.component === f.component && keep(s)).reverse();
    return { items: f.failedFirst ? failedFirst(items) : items, cursor: null, truncated: false };
  }

  const days = daysBetween(f.from, f.to);
  const fetchPage = (day: string, next: unknown) =>
    store.queryStepsByComponentDay(f.component, day, { fromIso: f.from, toIso: f.to, limit: f.stepName || f.status || f.responseCode ? 500 : f.limit, next, newestFirst: true });

  if (f.failedFirst) {
    // Failed-first needs the whole period ordered, so read it in full (bounded).
    const cap = 5000;
    const res = await walkDays(days, fetchPage, keep, cap, null, 20_000);
    const sorted = failedFirst(res.items);
    const offset = Number(decodeCursor(f.cursor)?.n ?? 0) || 0;
    const page = sorted.slice(offset, offset + f.limit);
    const more = offset + f.limit < sorted.length;
    return { items: page, cursor: more ? encodeCursor({ d: -1, n: offset + f.limit }) : null, truncated: res.cursor !== null };
  }
  const res = await walkDays(days, fetchPage, keep, f.limit, decodeCursor(f.cursor));
  return { items: res.items, cursor: res.cursor, truncated: false };
}

function failedFirst(items: StepRecord[]) {
  const rank = (s: StepRecord) => (s.status === 'failure' ? (s.serverFailure ? 0 : 1) : 2);
  return [...items].sort((a, b) => rank(a) - rank(b) || b.startedAt.localeCompare(a.startedAt));
}

/** Component drill-down: the failed and slowest steps behind the health numbers. */
export async function componentDrilldown(store: ActionStore, component: string, period: Period, now = Date.now()) {
  const from = new Date(now - PERIODS[period].ms).toISOString();
  const to = new Date(now).toISOString();
  const res = await walkDays(
    daysBetween(from, to),
    (day, next) => store.queryStepsByComponentDay(component, day, { fromIso: from, toIso: to, limit: 1000, next, newestFirst: true }),
    () => true,
    20_000,
    null,
    20_000,
  );
  const failed = failedFirst(res.items.filter((s) => s.status === 'failure')).slice(0, 50);
  const slowest = [...res.items].sort((a, b) => b.latencyMs - a.latencyMs).slice(0, 20);
  return { component, failed, slowest, scanned: res.items.length };
}
