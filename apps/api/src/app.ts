import {
  DEFAULT_CONFIG,
  MAX_INTERVAL_SECONDS,
  MIN_INTERVAL_SECONDS,
  type ActionStatus,
  type ActionStore,
  type PortalConfig,
} from '@complao/core';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { authRouter } from './auth';
import type { Env } from './env';
import { collectUserIds, type NameResolver } from './names';
import { caseLanes, liveView, listSessions, sessionDetail } from './live';
import { actionDetail, componentDrilldown, componentHealth, journey, listActions, PERIODS, stepsByArea, type Period } from './queries';

const TRACE_ID = /^[0-9a-f]{32}$/i;
const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i;

export function createApp(env: Env, store: ActionStore, names: NameResolver) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], scriptSrc: ["'self'"] },
      },
    }),
  );
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());

  const { router: auth, requireSession } = authRouter(env);
  app.use('/api/auth', auth);

  const api = express.Router();
  api.use(requireSession);
  api.use((_req, res, next) => {
    res.set('cache-control', 'no-store');
    next();
  });

  const config = () => store.getConfig();

  // ---------------------------------------------------------------- meta
  api.get('/meta', async (_req, res) => {
    const [types, components, roles, cfg, pull] = await Promise.all([store.listRegistry('type'), store.listRegistry('component'), store.listRegistry('role'), config(), store.getPull()]);
    res.json({ types, components, roles, config: cfg, pull, serverTime: new Date().toISOString(), demo: env.demo });
  });

  // ---------------------------------------------------------------- search (R5)
  api.get('/search', async (req, res) => {
    const raw = String(req.query.q ?? '').trim();
    const tp = TRACEPARENT.exec(raw);
    const q = (tp ? tp[1] : raw).toLowerCase();
    if (!q) return res.json({ kind: 'none' });
    if (TRACE_ID.test(q)) {
      const a = await store.getAction(q);
      if (a) return res.json({ kind: 'action', actionId: a.actionId });
    }
    const byCase = await store.queryActionsByCase(raw);
    if (byCase.length === 1) return res.json({ kind: 'action', actionId: byCase[0].actionId, caseId: raw });
    if (byCase.length > 1) return res.json({ kind: 'case', caseId: raw, count: byCase.length });
    res.json({ kind: 'none' });
  });

  // ---------------------------------------------------------------- action list (R4)
  api.get('/actions', async (req, res) => {
    const q = z
      .object({
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        type: z.string().optional(),
        status: z.string().optional(),
        actor: z.string().optional(),
        role: z.string().optional(),
        caseId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        cursor: z.string().optional(),
      })
      .parse(req.query);
    const to = q.to ?? new Date().toISOString();
    const from = q.from ?? new Date(Date.now() - 86_400_000).toISOString();
    const cfg = await config();
    const result = await listActions(store, cfg, {
      from,
      to,
      types: q.type?.split(',').filter(Boolean),
      statuses: q.status?.split(',').filter(Boolean) as (ActionStatus | 'incomplete')[],
      actor: q.actor,
      roles: q.role?.split(',').filter(Boolean),
      caseId: q.caseId,
      limit: q.limit,
      cursor: q.cursor,
    });
    const nameMap = await names.resolve(result.items.map((r) => r.actorId ?? ''));
    res.json({ ...result, names: nameMap });
  });

  // ---------------------------------------------------------------- action detail (R6, R16)
  api.get('/actions/:id', async (req, res) => {
    const id = String(req.params.id).toLowerCase();
    if (!TRACE_ID.test(id)) return res.status(400).json({ error: 'Action IDs are 32 hex characters.' });
    const cfg = await config();
    const detail = await actionDetail(store, cfg, id);
    if (!detail) return res.status(404).json({ error: 'No action with that ID yet. It may appear after the next pull.' });
    if (req.query.refresh !== '1') await store.recordView(id, new Date().toISOString());
    const ids = [detail.action.actorId ?? '', ...detail.journey.map((j) => j.actorId ?? ''), ...detail.steps.flatMap((s) => collectUserIds(s.details))];
    res.json({ ...detail, names: await names.resolve(ids), views: await store.countViews(id) });
  });

  // ---------------------------------------------------------------- journey (R18)
  api.get('/cases/:caseId', async (req, res) => {
    const cfg = await config();
    const j = await journey(store, cfg, String(req.params.caseId));
    if (!j.actions.length) return res.status(404).json({ error: 'No actions carry that case ID.' });
    const lanes = await caseLanes(store, cfg, String(req.params.caseId));
    res.json({ ...j, lanes, names: await names.resolve([...j.actions.map((a) => a.actorId ?? ''), ...lanes.lanes.map((l) => l.actorId)]) });
  });

  // ---------------------------------------------------------------- live and sessions (R22, R23)
  api.get('/live', async (req, res) => {
    const minutes = Math.min(Math.max(Number(req.query.minutes ?? 30), 5), 240);
    const v = await liveView(store, await config(), minutes);
    const ids = [...v.groups.flatMap((g) => g.lanes.map((l) => l.actorId)), ...v.sessions.map((s) => s.actorId ?? '')];
    res.json({ ...v, names: await names.resolve(ids) });
  });

  api.get('/sessions', async (req, res) => {
    const q = z
      .object({
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        status: z.string().optional(),
        role: z.string().optional(),
        actor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        cursor: z.string().optional(),
      })
      .parse(req.query);
    const r = await listSessions(store, await config(), {
      from: q.from ?? new Date(Date.now() - 86_400_000).toISOString(),
      to: q.to ?? new Date().toISOString(),
      statuses: q.status?.split(',').filter(Boolean) as never,
      roles: q.role?.split(',').filter(Boolean),
      actor: q.actor,
      limit: q.limit,
      cursor: q.cursor,
    });
    res.json({ ...r, names: await names.resolve(r.items.map((s) => s.actorId ?? '')) });
  });

  api.get('/sessions/:id', async (req, res) => {
    const d = await sessionDetail(store, await config(), String(req.params.id));
    if (!d) return res.status(404).json({ error: 'No session with that ID yet. It may appear after the next pull.' });
    res.json({ ...d, names: await names.resolve([d.session.actorId ?? '']) });
  });

  // ---------------------------------------------------------------- component health (R19, R20, R21)
  const period = (v: unknown): Period => (typeof v === 'string' && v in PERIODS ? (v as Period) : '24h');

  api.get('/health', async (req, res) => {
    const cfg = await config();
    const p = period(req.query.period);
    res.json({ period: p, rows: await componentHealth(store, cfg, p), thresholds: { slowStepMs: cfg.slowStepMs } });
  });

  api.get('/health/:component', async (req, res) => {
    const d = await componentDrilldown(store, String(req.params.component), period(req.query.period));
    res.json(d);
  });

  api.get('/cost', async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days ?? 14), 1), 90);
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 86_400_000);
    const rows = await store.getCostDays(from.toISOString().slice(0, 10), to.toISOString().slice(0, 10));
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const series = Array.from({ length: days }, (_, i) => {
      const day = new Date(from.getTime() + i * 86_400_000).toISOString().slice(0, 10);
      return byDay.get(day) ?? { day, costUsd: 0, calls: 0, tokensIn: 0, tokensOut: 0 };
    });
    const last7 = series.slice(-7);
    const prev7 = series.slice(-14, -7);
    const sum = (xs: typeof series) => xs.reduce((a, b) => a + b.costUsd, 0);
    res.json({ series, week: sum(last7), // Only compare against a full earlier week of data, not the partial week logging began in.
      previousWeek: prev7.length === 7 && prev7[0].calls > 0 ? sum(prev7) : null, today: series[series.length - 1]?.costUsd ?? 0 });
  });

  // ---------------------------------------------------------------- logs by area (R8)
  api.get('/steps', async (req, res) => {
    const q = z
      .object({
        component: z.string().min(1),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        stepName: z.string().optional(),
        status: z.enum(['success', 'failure', 'skipped']).optional(),
        responseCode: z.string().optional(),
        actionId: z.string().optional(),
        failedFirst: z.enum(['1', '0', 'true', 'false']).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        cursor: z.string().optional(),
      })
      .parse(req.query);
    const r = await stepsByArea(store, {
      component: q.component,
      from: q.from ?? new Date(Date.now() - 86_400_000).toISOString(),
      to: q.to ?? new Date().toISOString(),
      stepName: q.stepName || undefined,
      status: q.status,
      responseCode: q.responseCode || undefined,
      actionId: q.actionId?.toLowerCase() || undefined,
      failedFirst: q.failedFirst === '1' || q.failedFirst === 'true',
      limit: q.limit,
      cursor: q.cursor,
    });
    res.json({ ...r, names: await names.resolve(r.items.map((s) => s.actorId)) });
  });

  // ---------------------------------------------------------------- settings (R9, R12, R20, R21)
  api.get('/settings/pull', async (_req, res) => res.json(await store.getPull()));

  api.put('/settings/pull', async (req, res) => {
    const body = z
      .object({ intervalSeconds: z.number().int().min(MIN_INTERVAL_SECONDS).max(MAX_INTERVAL_SECONDS), paused: z.boolean() })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: `Interval must be between ${MIN_INTERVAL_SECONDS} seconds and 24 hours.` });
    res.json(await store.putPullSetting(body.data));
  });

  const priceSchema = z.object({ inputPer1k: z.number().min(0), outputPer1k: z.number().min(0) });
  const configSchema = z.object({
    stalledMinutes: z.number().min(1).max(1440),
    sessionIdleMinutes: z.number().min(1).max(240),
    sessionTimeoutMinutes: z.number().min(5).max(1440),
    slowStepMs: z.number().min(1000).max(3_600_000),
    serverErrorMinCode: z.number().int().min(400).max(599),
    displayNames: z.object({ actionTypes: z.record(z.string(), z.string()), components: z.record(z.string(), z.string()) }),
    prices: z.record(z.string(), priceSchema),
    currency: z.object({ primary: z.enum(['AUD', 'USD']), usdToAud: z.number().positive(), showSecondary: z.boolean() }),
  });

  api.get('/settings/config', async (_req, res) => res.json(await config()));
  api.put('/settings/config', async (req, res) => {
    const body = configSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const cfg: PortalConfig = { ...DEFAULT_CONFIG, ...body.data };
    await store.putConfig(cfg);
    res.json(cfg);
  });

  app.use('/api', api);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // ---------------------------------------------------------------- web app
  const dist = env.webDist ?? path.resolve(process.cwd(), 'apps/web/dist');
  if (existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong reading the action store.' });
  });

  return app;
}
