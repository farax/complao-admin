/**
 * Static preview build: the API runs inside the page. It uses the same store, simulator,
 * puller and query code as the Node server; only the HTTP layer is swapped for this router.
 */
import { DEFAULT_CONFIG, MAX_INTERVAL_SECONDS, MIN_INTERVAL_SECONDS, MemoryStore, type ActionStatus, type PortalConfig } from '@complao/core/browser';
import { demoNames, startDemo } from '../../../api/src/demo/demo';
import { collectUserIds } from '../../../api/src/names';
import { actionDetail, componentDrilldown, componentHealth, journey, listActions, PERIODS, stepsByArea, type Period } from '../../../api/src/queries';

const store = new MemoryStore();
const names = demoNames;
let ready: Promise<void> | null = null;

export function boot() {
  ready ??= startDemo(store, 7, () => {});
  return ready;
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const TRACE_ID = /^[0-9a-f]{32}$/i;
const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i;
const period = (v: string | null): Period => (v && v in PERIODS ? (v as Period) : '24h');

export async function localApi(path: string, method = 'GET', body?: unknown): Promise<unknown> {
  await boot();
  const url = new URL(path, 'http://local');
  const q = url.searchParams;
  const p = url.pathname;
  const cfg = await store.getConfig();
  const list = (k: string) => q.get(k)?.split(',').filter(Boolean);

  if (p === '/auth/me') return { email: 'admin@complao.com', authDisabled: true };
  if (p.startsWith('/auth/')) return { ok: true, next: 'done' };

  if (p === '/meta') {
    const [types, components, pull] = await Promise.all([store.listRegistry('type'), store.listRegistry('component'), store.getPull()]);
    return { types, components, config: cfg, pull, serverTime: new Date().toISOString(), demo: true };
  }

  if (p === '/search') {
    const raw = (q.get('q') ?? '').trim();
    const tp = TRACEPARENT.exec(raw);
    const id = (tp ? tp[1] : raw).toLowerCase();
    if (TRACE_ID.test(id) && (await store.getAction(id))) return { kind: 'action', actionId: id };
    const byCase = await store.queryActionsByCase(raw);
    if (byCase.length === 1) return { kind: 'action', actionId: byCase[0].actionId };
    if (byCase.length > 1) return { kind: 'case', caseId: raw };
    return { kind: 'none' };
  }

  if (p === '/actions') {
    const r = await listActions(store, cfg, {
      from: q.get('from') ?? new Date(Date.now() - 86_400_000).toISOString(),
      to: q.get('to') ?? new Date().toISOString(),
      types: list('type'),
      statuses: list('status') as (ActionStatus | 'incomplete')[],
      actor: q.get('actor') ?? undefined,
      limit: Number(q.get('limit') ?? 50),
      cursor: q.get('cursor') ?? undefined,
    });
    return { ...r, names: await names.resolve(r.items.map((i) => i.actorId ?? '')) };
  }

  let m = /^\/actions\/([^/]+)$/.exec(p);
  if (m) {
    const id = m[1].toLowerCase();
    const d = await actionDetail(store, cfg, id);
    if (!d) throw new HttpError(404, 'No action with that ID yet. It may appear after the next pull.');
    if (q.get('refresh') !== '1') await store.recordView(id, new Date().toISOString());
    const ids = [d.action.actorId ?? '', ...d.journey.map((j) => j.actorId ?? ''), ...d.steps.flatMap((s) => collectUserIds(s.details))];
    return { ...d, names: await names.resolve(ids), views: await store.countViews(id) };
  }

  m = /^\/cases\/(.+)$/.exec(p);
  if (m) {
    const j = await journey(store, cfg, decodeURIComponent(m[1]));
    if (!j.actions.length) throw new HttpError(404, 'No actions carry that case ID.');
    return { ...j, names: await names.resolve(j.actions.map((a) => a.actorId ?? '')) };
  }

  if (p === '/health') return { period: period(q.get('period')), rows: await componentHealth(store, cfg, period(q.get('period'))), thresholds: { slowStepMs: cfg.slowStepMs } };
  m = /^\/health\/(.+)$/.exec(p);
  if (m) return componentDrilldown(store, decodeURIComponent(m[1]), period(q.get('period')));

  if (p === '/cost') {
    const days = Number(q.get('days') ?? 14);
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 86_400_000);
    const rows = await store.getCostDays(from.toISOString().slice(0, 10), to.toISOString().slice(0, 10));
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const series = Array.from({ length: days }, (_, i) => {
      const day = new Date(from.getTime() + i * 86_400_000).toISOString().slice(0, 10);
      return byDay.get(day) ?? { day, costUsd: 0, calls: 0, tokensIn: 0, tokensOut: 0 };
    });
    const sum = (xs: typeof series) => xs.reduce((a, b) => a + b.costUsd, 0);
    const prev7 = series.slice(-14, -7);
    return { series, week: sum(series.slice(-7)), previousWeek: prev7.length === 7 && prev7[0].calls > 0 ? sum(prev7) : null, today: series[series.length - 1]?.costUsd ?? 0 };
  }

  if (p === '/steps') {
    const r = await stepsByArea(store, {
      component: q.get('component') ?? '',
      from: q.get('from') ?? new Date(Date.now() - 86_400_000).toISOString(),
      to: q.get('to') ?? new Date().toISOString(),
      stepName: q.get('stepName') || undefined,
      status: q.get('status') || undefined,
      responseCode: q.get('responseCode') || undefined,
      actionId: q.get('actionId')?.toLowerCase() || undefined,
      failedFirst: q.get('failedFirst') === '1',
      limit: Number(q.get('limit') ?? 100),
      cursor: q.get('cursor') ?? undefined,
    });
    return { ...r, names: await names.resolve(r.items.map((s) => s.actorId)) };
  }

  if (p === '/settings/pull') {
    if (method === 'PUT') {
      const b = body as { intervalSeconds: number; paused: boolean };
      if (!(b.intervalSeconds >= MIN_INTERVAL_SECONDS && b.intervalSeconds <= MAX_INTERVAL_SECONDS))
        throw new HttpError(400, `Interval must be between ${MIN_INTERVAL_SECONDS} seconds and 24 hours.`);
      return store.putPullSetting({ intervalSeconds: b.intervalSeconds, paused: Boolean(b.paused) });
    }
    return store.getPull();
  }
  if (p === '/settings/config') {
    if (method === 'PUT') {
      const next: PortalConfig = { ...DEFAULT_CONFIG, ...(body as PortalConfig) };
      await store.putConfig(next);
      return next;
    }
    return cfg;
  }
  throw new HttpError(404, 'Not found');
}

export { HttpError };
