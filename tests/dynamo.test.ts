import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DEFAULT_CONFIG, DynamoStore, MemoryStore, ingestEvents, validateEvent, type ActionStore, type LogEvent } from '@complao/core';
import { pullOnce } from '@complao/ingest';
// @ts-expect-error no types
import dynalite from 'dynalite';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actionDetail, componentHealth, journey, listActions, stepsByArea } from '../apps/api/src/queries';
import { A, ArraySource, T0, iso, sampleAudit } from './helpers';

/**
 * Runs the same ingestion through DynamoStore (against a local DynamoDB emulator) and
 * MemoryStore, and checks every portal view comes out the same. This exercises the real
 * UpdateExpressions, conditional writes, string sets and the three GSIs from Appendix B.
 */
let server: any;
let client: DynamoDBClient;
const cfg = { ...DEFAULT_CONFIG, prices: { 'model-a': { inputPer1k: 0.003, outputPer1k: 0.015 }, '*': { inputPer1k: 0, outputPer1k: 0 } } };

beforeAll(async () => {
  server = dynalite({ createTableMs: 0, updateTableMs: 0 });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  client = new DynamoDBClient({ endpoint: `http://127.0.0.1:${port}`, region: 'local', credentials: { accessKeyId: 'x', secretAccessKey: 'x' } });
  const gsi = (n: number) => ({
    IndexName: `gsi${n}`,
    KeySchema: [{ AttributeName: `gsi${n}pk`, KeyType: 'HASH' as const }, { AttributeName: `gsi${n}sk`, KeyType: 'RANGE' as const }],
    Projection: { ProjectionType: 'ALL' as const },
  });
  await client.send(
    new CreateTableCommand({
      TableName: 'complao-test',
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: ['pk', 'sk', 'gsi1pk', 'gsi1sk', 'gsi2pk', 'gsi2sk', 'gsi3pk', 'gsi3sk'].map((n) => ({ AttributeName: n, AttributeType: 'S' as const })),
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
      GlobalSecondaryIndexes: [gsi(1), gsi(2), gsi(3)],
    }),
  );
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function fixture() {
  const evs: { ts: number; e: Record<string, unknown> }[] = [];
  evs.push(...sampleAudit(A(1), T0));
  evs.push(...sampleAudit(A(2), T0 + 600_000, { failBedrock: true, actor: 'usr_tic08' }));
  evs.push(...sampleAudit(A(3), T0 + 1_200_000, { end: false, caseId: 'case-shared' }));
  evs.push(...sampleAudit(A(4), T0 + 86_400_000, { caseId: 'case-shared' }).filter((x) => x.e.step_id !== 's3')); // next day, dropped parent
  // a step that arrives before its action_start (out of order)
  evs.push({ ts: T0 + 5, e: { event_type: 'step', action_id: A(5), step_id: 'x', step_name: 'Validate credentials', component: 'Login service', actor_id: 'u9', started_at: iso(T0 + 2), latency_ms: 80, status: 'failure', response_code: 401 } });
  evs.push({ ts: T0 + 1, e: { event_type: 'action_start', action_id: A(5), action_type: 'Login', component: 'Login service', actor_id: 'u9', started_at: iso(T0) } });
  return evs;
}

async function ingestTwice(store: ActionStore) {
  const evs = fixture().map((x) => validateEvent(x.e).event!) as LogEvent[];
  await ingestEvents(store, evs, cfg);
  await ingestEvents(store, evs.slice(5), cfg); // overlap: re-read part of the batch
}

describe('DynamoStore matches MemoryStore', () => {
  it('produces identical views', async () => {
    const dyn = new DynamoStore({ tableName: 'complao-test', client });
    const mem = new MemoryStore();
    await ingestTwice(dyn);
    await ingestTwice(mem);
    const now = T0 + 2 * 86_400_000;
    const range = { from: iso(T0 - 1000), to: iso(now), limit: 50 };

    const norm = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v) => (Array.isArray(v) && v.every((i) => typeof i === 'string') ? [...v].sort() : v)));
    const strip = (rows: any[]) => rows.map(({ runningForMs, ...r }) => r);

    const [ld, lm] = await Promise.all([listActions(dyn, cfg, range), listActions(mem, cfg, range)]);
    expect(strip(ld.items)).toEqual(strip(lm.items));
    expect(ld.items.map((r) => r.actionId)).toEqual([A(4), A(3), A(2), A(5), A(1)]); // A1 and A5 start together; ties sort by ID

    for (const id of [A(1), A(2), A(3), A(4), A(5)]) {
      const [d, m] = await Promise.all([actionDetail(dyn, cfg, id), actionDetail(mem, cfg, id)]);
      expect(norm({ ...d, action: { ...d!.action, runningForMs: 0 }, journey: strip(d!.journey) })).toEqual(norm({ ...m, action: { ...m!.action, runningForMs: 0 }, journey: strip(m!.journey) }));
    }
    expect((await actionDetail(dyn, cfg, A(4)))!.missing.incomplete).toBe(true);
    expect((await actionDetail(dyn, cfg, A(5)))!.action.actionType).toBe('Login');

    const [jd, jm] = await Promise.all([journey(dyn, cfg, 'case-shared'), journey(mem, cfg, 'case-shared')]);
    expect(jd.actions.map((a) => a.actionId)).toEqual(jm.actions.map((a) => a.actionId));

    const [hd, hm] = await Promise.all([componentHealth(dyn, cfg, '7d', now), componentHealth(mem, cfg, '7d', now)]);
    expect(norm(hd)).toEqual(norm(hm));
    expect(hd.find((h) => h.component === 'Amazon Bedrock')!.requests).toBe(11); // 3+3+3+2 (one dropped), none double counted despite the overlap

    const sd = await stepsByArea(dyn, { component: 'Amazon Bedrock', from: range.from, to: range.to, failedFirst: true, limit: 100 });
    const sm = await stepsByArea(mem, { component: 'Amazon Bedrock', from: range.from, to: range.to, failedFirst: true, limit: 100 });
    expect(sd.items.map((s) => s.actionId + s.stepId)).toEqual(sm.items.map((s) => s.actionId + s.stepId));
    expect(sd.items[0].status).toBe('failure');

    const r6 = (xs: { costUsd: number }[]) => xs.map((x) => ({ ...x, costUsd: Math.round(x.costUsd * 1e6) / 1e6 }));
    expect(r6(await dyn.getCostDays('2026-11-13', '2026-11-14'))).toEqual(r6(await mem.getCostDays('2026-11-13', '2026-11-14')));
    expect((await dyn.listRegistry('component')).sort()).toEqual((await mem.listRegistry('component')).sort());
  });

  it('keeps founder settings separate from ingestion run state', async () => {
    const dyn = new DynamoStore({ tableName: 'complao-test', client });
    await dyn.putPullSetting({ intervalSeconds: 300, paused: true });
    await dyn.recordPull({ lastPullAt: iso(T0), lastSuccessAt: iso(T0), lastEventsIngested: 7, intervalSeconds: 30, paused: false } as any);
    const p = await dyn.getPull();
    expect(p).toMatchObject({ intervalSeconds: 300, paused: true, lastEventsIngested: 7 });
    await dyn.recordView(A(1), iso(T0));
    expect(await dyn.countViews(A(1))).toBe(1);
  });

  it('runs the real puller against DynamoStore with checkpoints', async () => {
    const dyn = new DynamoStore({ tableName: 'complao-test', client });
    let now = T0 + 3 * 86_400_000;
    const src = new ArraySource(() => now);
    for (const x of sampleAudit(A(50), T0 + 2 * 86_400_000)) src.add(x.ts, x.e);
    await dyn.putCheckpoint('/complao/test', T0 + 2 * 86_400_000 - 60_000);
    const r = await pullOnce(dyn, src, now + 60_000, undefined, { now: () => now, sleep: async () => {} });
    expect(r.newSteps).toBe(7);
    const again = await pullOnce(dyn, src, now + 60_000, undefined, { now: () => now, sleep: async () => {} });
    expect(again.newSteps).toBe(0);
    expect(await dyn.getCheckpoint('/complao/test')).toBe(now);
  });
});
