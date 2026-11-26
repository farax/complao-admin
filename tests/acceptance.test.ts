import { DEFAULT_CONFIG, MemoryStore, ingestEvents, parseLogMessage, percentile, emptyBuckets, bucketIndex, validateEvent, type LogEvent } from '@complao/core';
import { pullOnce, runInvocation } from '@complao/ingest';
import { createActionLogger, parseTraceparent } from '@complao/logger';
import { describe, expect, it } from 'vitest';
import { actionDetail, componentHealth, journey, listActions, stepsByArea, toRow } from '../apps/api/src/queries';
import { A, ArraySource, T0, iso, sampleAudit } from './helpers';

const cfg = { ...DEFAULT_CONFIG, prices: { 'model-a': { inputPer1k: 0.003, outputPer1k: 0.015 }, '*': { inputPer1k: 0.001, outputPer1k: 0.001 } } };

async function load(store: MemoryStore, evs: { e: Record<string, unknown> }[]) {
  const parsed = evs.map((x) => validateEvent(x.e).event!).filter(Boolean) as LogEvent[];
  await store.putConfig(cfg);
  return ingestEvents(store, parsed, cfg);
}

describe('schema (Appendix A) and privacy (R3)', () => {
  it('reads a Lambda-prefixed line', () => {
    const r = parseLogMessage(`2026-11-13T01:31:00.000Z\tabc\tINFO\t{"event_type":"action_start","action_id":"${A(1)}","action_type":"Login","component":"Login service","started_at":"2026-11-13T01:31:00Z","actor_id":"u1"}`);
    expect(r.event?.action_type).toBe('Login');
  });
  it('rejects malformed events', () => {
    expect(validateEvent({ event_type: 'step', action_id: 'short', component: 'x', actor_id: 'u', started_at: iso(T0) }).error).toBe('bad action_id');
    expect(validateEvent({ event_type: 'step', action_id: A(1), component: 'x', actor_id: 'u', started_at: iso(T0), step_id: 's', step_name: 'n', status: 'ok', latency_ms: 1 }).error).toBe('bad status');
  });
  it('strips names, emails, prompts and content from details', () => {
    const r = validateEvent({
      event_type: 'step', action_id: A(1), step_id: 's', step_name: 'n', component: 'c', actor_id: 'u', started_at: iso(T0), latency_ms: 3, status: 'success',
      details: { model: 'm', input_tokens: 4, user_name: 'Jane', email: 'j@x.com', prompt: 'secret', document_text: 'x', participant_ids: ['u1'] },
    });
    expect(r.event?.details).toEqual({ model: 'm', input_tokens: 4, participant_ids: ['u1'] });
  });
});

describe('R1, R6: one event per step, nested under the right parent, in order', () => {
  it('builds the sample audit tree', async () => {
    const s = new MemoryStore();
    await load(s, sampleAudit(A(1), T0));
    const d = (await actionDetail(s, cfg, A(1)))!;
    expect(d.steps.map((x) => `${'  '.repeat(x.depth)}${x.stepName}`)).toEqual([
      'Audit started', 'Load audit template', 'Bedrock call', '  Response validation', 'Bedrock call', 'Bedrock call', 'Report saved',
    ]);
    expect(d.steps.find((x) => x.slowest)?.latencyMs).toBe(22700);
    expect(d.action.status).toBe('completed');
    expect(d.missing.incomplete).toBe(false);
  });
});

describe('R7: statuses', () => {
  it('shows In progress, then Stalled after 10 minutes without an event', async () => {
    const s = new MemoryStore();
    await load(s, sampleAudit(A(2), T0, { end: false }));
    const a = (await s.getAction(A(2)))!;
    const last = new Date(a.lastEventAt).getTime();
    expect(toRow(a, cfg, last + 9 * 60_000).status).toBe('in_progress');
    expect(toRow(a, cfg, last + 10 * 60_000).status).toBe('stalled');
    expect(toRow(a, { ...cfg, stalledMinutes: 30 }, last + 10 * 60_000).status).toBe('in_progress');
  });
  it('Failed, Partial and Incomplete', async () => {
    const s = new MemoryStore();
    await load(s, sampleAudit(A(3), T0, { failBedrock: true }));
    expect(toRow((await s.getAction(A(3)))!, cfg).status).toBe('failed');

    const partial = sampleAudit(A(4), T0);
    const save = partial.find((x) => x.e.step_name === 'Report saved')!;
    save.e = { ...save.e, status: 'failure', response_code: 502 };
    await load(s, partial);
    expect(toRow((await s.getAction(A(4)))!, cfg).status).toBe('partial');

    const dropped = sampleAudit(A(5), T0).filter((x) => x.e.step_id !== 's3');
    await load(s, dropped);
    const row = toRow((await s.getAction(A(5)))!, cfg);
    expect(row.incomplete).toBe(true);
    expect(row.status).toBe('completed');
  });
});

describe('R9: pull interval, pause and resume', () => {
  it('after a 1-hour pause, every event from that hour appears exactly once', async () => {
    let now = T0;
    const clock = { now: () => now, sleep: async (ms: number) => void (now += ms) };
    const store = new MemoryStore();
    const src = new ArraySource(() => now);
    await store.putPullSetting({ intervalSeconds: 60, paused: false });
    const deadline = () => now + 60_000;

    // An audit every 5 minutes for 2 hours, events landing as steps finish.
    for (let i = 0; i < 24; i++) for (const x of sampleAudit(A(100 + i), T0 + i * 5 * 60_000)) src.add(x.ts, x.e);

    const tick = async () => {
      await runInvocation(store, src, deadline(), undefined, clock);
      now += 60_000;
    };
    for (let m = 0; m < 30; m++) await tick();
    await store.putPullSetting({ intervalSeconds: 60, paused: true });
    for (let m = 0; m < 60; m++) await tick(); // paused for an hour
    expect((await store.queryActionsByDay('2026-11-13', { fromIso: iso(T0 + 31 * 60_000), toIso: iso(T0 + 90 * 60_000), limit: 100 })).items).toHaveLength(0);
    await store.putPullSetting({ intervalSeconds: 60, paused: false });
    for (let m = 0; m < 40; m++) await tick();

    expect(store.actions.size).toBe(24);
    for (const id of store.actions.keys()) {
      const steps = await store.getSteps(id);
      expect(steps).toHaveLength(7);
      expect(new Set(steps.map((x) => x.stepId)).size).toBe(7);
    }
    // health counts each step once despite the 2-minute overlap re-reading events
    const bedrock = await store.getHealthWindows('Amazon Bedrock', iso(T0 - 3600_000), iso(T0 + 5 * 3600_000));
    expect(bedrock.reduce((a, w) => a + w.count, 0)).toBe(24 * 3);
  });

  it('pulls twice a minute at the 30-second setting, and skips when the interval has not elapsed', async () => {
    let now = T0;
    const slept: number[] = [];
    const clock = { now: () => now, sleep: async (ms: number) => void (slept.push(ms), (now += ms)) };
    const store = new MemoryStore();
    const src = new ArraySource(() => now);
    await store.putPullSetting({ intervalSeconds: 30, paused: false });
    const r1 = await runInvocation(store, src, now + 60_000, undefined, clock);
    expect(r1.filter((r) => r.pulled)).toHaveLength(2);
    expect(slept[0]).toBeGreaterThanOrEqual(29_000);

    await store.putPullSetting({ intervalSeconds: 300, paused: false });
    now += 30_000;
    const r2 = await runInvocation(store, src, now + 60_000, undefined, clock);
    expect(r2[0].pulled).toBe(false);
  });

  it('catches up in bounded windows after a long pause and resumes from the checkpoint', async () => {
    let now = T0 + 3 * 86_400_000;
    const store = new MemoryStore();
    const src = new ArraySource(() => now);
    for (let d = 0; d < 3; d++) for (const x of sampleAudit(A(200 + d), T0 + d * 86_400_000)) src.add(x.ts, x.e);
    await store.putCheckpoint('/complao/test', T0 - 60_000);
    let calls = 0;
    const clock = { now: () => (calls++ > 6 ? Number.MAX_SAFE_INTEGER : now), sleep: async () => {} };
    const first = await pullOnce(store, src, now, undefined, clock);
    expect(first.groups[0].caughtUp).toBe(false);
    const ck = (await store.getCheckpoint('/complao/test'))!;
    expect(ck).toBeLessThan(now);
    await pullOnce(store, src, now + 60_000, undefined, { now: () => now, sleep: async () => {} });
    expect(store.actions.size).toBe(3);
  });
});

describe('R4, R5, R8, R12, R18', () => {
  it('lists newest first with filters, and an unseen type appears without a code change', async () => {
    const s = new MemoryStore();
    await load(s, sampleAudit(A(10), T0));
    await load(s, sampleAudit(A(11), T0 + 60_000, { failBedrock: true, actor: 'usr_tic08' }));
    await load(s, [
      { e: { event_type: 'action_start', action_id: A(12), action_type: 'Test', component: 'Test harness', actor_id: 'svc', started_at: iso(T0 + 120_000) } },
      { e: { event_type: 'action_end', action_id: A(12), component: 'Test harness', actor_id: 'svc', started_at: iso(T0 + 120_000), latency_ms: 50, status: 'success' } },
    ]);
    const all = await listActions(s, cfg, { from: iso(T0 - 1000), to: iso(T0 + 3_600_000), limit: 50 });
    expect(all.items.map((r) => r.actionId)).toEqual([A(12), A(11), A(10)]);
    expect(await s.listRegistry('type')).toContain('Test');
    expect((await listActions(s, cfg, { from: iso(T0 - 1000), to: iso(T0 + 3_600_000), limit: 50, types: ['Test'] })).items).toHaveLength(1);
    expect((await listActions(s, cfg, { from: iso(T0 - 1000), to: iso(T0 + 3_600_000), limit: 50, statuses: ['failed'] })).items.map((r) => r.actionId)).toEqual([A(11)]);
    expect((await listActions(s, cfg, { from: iso(T0 - 1000), to: iso(T0 + 3_600_000), limit: 50, actor: 'usr_tic08' })).items).toHaveLength(1);
  });

  it('logs by area returns exactly the failed login steps for a day, failed first', async () => {
    const s = new MemoryStore();
    const login = (n: number, code: number, t: number) => [
      { e: { event_type: 'action_start', action_id: A(n), action_type: 'Login', component: 'Login service', actor_id: 'u', started_at: iso(t) } },
      { e: { event_type: 'step', action_id: A(n), step_id: 'v', step_name: 'Validate credentials', component: 'Login service', actor_id: 'u', started_at: iso(t + 1), latency_ms: 100, status: code === 200 ? 'success' : 'failure', response_code: code } },
    ];
    await load(s, [...login(301, 200, T0), ...login(302, 401, T0 + 1000), ...login(303, 500, T0 + 2000), ...login(304, 200, T0 + 3000)]);
    const failed = await stepsByArea(s, { component: 'Login service', from: '2026-11-13T00:00:00.000Z', to: '2026-11-13T23:59:59.999Z', status: 'failure', limit: 100 });
    expect(failed.items.map((x) => x.actionId).sort()).toEqual([A(302), A(303)]);
    const ff = await stepsByArea(s, { component: 'Login service', from: '2026-11-13T00:00:00.000Z', to: '2026-11-13T23:59:59.999Z', failedFirst: true, limit: 100 });
    expect(ff.items.map((x) => x.responseCode)).toEqual(['500', '401', '200', '200']);
  });

  it('joins a registration submitted one day and approved on a later day into one journey', async () => {
    const s = new MemoryStore();
    const caseId = 'reg-0001';
    const stage = (n: number, type: string, t: number) => [
      { e: { event_type: 'action_start', action_id: A(n), action_type: type, component: 'Registration services', actor_id: 'u', case_id: caseId, started_at: iso(t) } },
      { e: { event_type: 'action_end', action_id: A(n), component: 'Registration services', actor_id: 'u', case_id: caseId, started_at: iso(t), latency_ms: 500, status: 'success' } },
    ];
    await load(s, [...stage(401, 'CB registration', T0), ...stage(402, 'Admin approval', T0 + 3 * 86_400_000)]);
    const j = await journey(s, cfg, caseId);
    expect(j.actions.map((a) => a.actionType)).toEqual(['CB registration', 'Admin approval']);
    expect(j.actions[1].waitBeforeMs).toBe(3 * 86_400_000 - 500);
  });
});

describe('R19, R20, R21: health and AI cost', () => {
  it('counts match, a server failure flags the component, a wrong password does not', async () => {
    const s = new MemoryStore();
    const now = T0 + 3_600_000;
    await load(s, sampleAudit(A(20), T0));
    await load(s, [
      { e: { event_type: 'step', action_id: A(21), step_id: 'v', step_name: 'Validate credentials', component: 'Login service', actor_id: 'u', started_at: iso(T0), latency_ms: 90, status: 'failure', response_code: 401 } },
    ]);
    let rows = await componentHealth(s, cfg, '24h', now);
    const login = rows.find((r) => r.component === 'Login service')!;
    expect(login.degraded).toBe(false);
    expect(login.successRate).toBe(0);
    expect(rows.find((r) => r.component === 'Amazon Bedrock')!.requests).toBe(3);

    await load(s, sampleAudit(A(22), T0 + 60_000, { failBedrock: true }));
    rows = await componentHealth(s, cfg, '24h', now);
    expect(rows.find((r) => r.component === 'Amazon Bedrock')!.degraded).toBe(true);
    expect(rows.find((r) => r.component === 'Audit engine')!.degraded).toBe(false);
  });

  it('flags a step longer than the configurable threshold', async () => {
    const s = new MemoryStore();
    await load(s, sampleAudit(A(23), T0));
    const strict = { ...cfg, slowStepMs: 20_000 };
    const rows = await componentHealth(s, strict, '1h', T0 + 60_000);
    expect(rows.find((r) => r.component === 'Amazon Bedrock')!.degradedReasons[0]).toMatch(/22\.7 s/);
  });

  it('audit cost equals token counts times the price table', async () => {
    const s = new MemoryStore();
    await load(s, sampleAudit(A(24), T0));
    const a = (await s.getAction(A(24)))!;
    const expected = ((3100 + 2800 + 3400) / 1000) * 0.003 + ((900 + 1100 + 1600) / 1000) * 0.015;
    expect(a.aiCostUsd).toBeCloseTo(expected, 6);
    expect(a.aiCalls).toBe(3);
    expect((await s.getCostDays('2026-11-13', '2026-11-13'))[0].costUsd).toBeCloseTo(expected, 6);
  });

  it('histogram percentiles are within a bucket of the true value', () => {
    const values = Array.from({ length: 1000 }, (_, i) => 50 + i * 10);
    const b = emptyBuckets();
    values.forEach((v) => b[bucketIndex(v)]++);
    const p95 = percentile(b, 95, Math.max(...values))!;
    expect(Math.abs(p95 - 9540) / 9540).toBeLessThan(0.11);
  });
});

describe('R2: logging never fails or slows an action', () => {
  it('drops events when the sink throws, and keeps the action result and its errors unchanged', async () => {
    const log = createActionLogger({ component: 'Audit engine', sink: () => { throw new Error('CloudWatch unreachable'); } });
    const a = log.startAction({ actionType: 'Audit', actorId: 'u1' });
    const out = await a.run(() => log.step('Load audit template', async () => 42));
    expect(out).toBe(42);
    await expect(a.run(() => log.step('Bedrock call', async () => { throw new Error('model down'); }))).rejects.toThrow('model down');
    expect(() => a.end('success')).not.toThrow();
  });

  it('writes nested steps with the action ID and propagates it through traceparent', async () => {
    const lines: any[] = [];
    const log = createActionLogger({ component: 'Audit engine', sink: (l) => lines.push(JSON.parse(l)) });
    const a = log.startAction({ actionType: 'Audit', actorId: 'u1', caseId: 'case-1' });
    await a.run(() => log.step('Bedrock call', async () => log.step('Response validation', async () => 1), { component: 'Amazon Bedrock' }));
    a.end('success');
    const ids = new Set(lines.map((l) => l.action_id));
    expect(ids.size).toBe(1);
    const parent = lines.find((l) => l.step_name === 'Bedrock call');
    expect(lines.find((l) => l.step_name === 'Response validation').parent_step_id).toBe(parent.step_id);
    expect(parseTraceparent(a.traceparent())).toBe(a.ctx.actionId);
    for (const l of lines) expect(validateEvent(l).error).toBeUndefined();
  });
});
