import { DEFAULT_CONFIG, MemoryStore, ingestEvents, validateEvent, type LogEvent } from '@complao/core';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../apps/api/src/app';
import { loadEnv } from '../apps/api/src/env';
import { cached } from '../apps/api/src/names';
import { A, T0, sampleAudit } from './helpers';

const secret = authenticator.generateSecret();
const env = loadEnv({
  NODE_ENV: 'test',
  ADMIN_PASSWORD_HASH: bcrypt.hashSync('correct horse battery', 4),
  ADMIN_TOTP_SECRET: secret,
  SESSION_SECRET: 'x'.repeat(40),
} as NodeJS.ProcessEnv);

async function setup() {
  const store = new MemoryStore();
  const evs = sampleAudit(A(1), Date.now() - 120_000).map((x) => validateEvent(x.e).event!) as LogEvent[];
  await ingestEvents(store, evs, DEFAULT_CONFIG);
  const names = cached(async (ids) => Object.fromEntries(ids.map((i) => [i, i === 'usr_auditor17' ? 'Auditor 17' : i])));
  return { store, app: createApp(env, store, names) };
}

async function signIn(app: ReturnType<typeof createApp>) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ email: 'admin@complao.com', password: 'correct horse battery' }).expect(200);
  await agent.post('/api/auth/mfa').send({ code: authenticator.generate(secret) }).expect(200);
  return agent;
}

describe('R13: one login with multi-factor authentication', () => {
  it('no API route responds without the session', async () => {
    const { app } = await setup();
    for (const path of ['/api/meta', '/api/actions', `/api/actions/${A(1)}`, '/api/cases/x', '/api/health', '/api/health/x', '/api/cost', '/api/steps?component=x', '/api/settings/pull', '/api/settings/config', '/api/search?q=x'])
      await request(app).get(path).expect(401);
    await request(app).put('/api/settings/pull').send({ intervalSeconds: 60, paused: true }).expect(401);
  });

  it('a password alone is not enough', async () => {
    const { app } = await setup();
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: 'admin@complao.com', password: 'correct horse battery' }).expect(200);
    await agent.get('/api/meta').expect(401);
    await agent.post('/api/auth/mfa').send({ code: '000000' }).expect(401);
    await agent.get('/api/meta').expect(401);
  });

  it('rejects a wrong password and other emails', async () => {
    const { app } = await setup();
    await request(app).post('/api/auth/login').send({ email: 'admin@complao.com', password: 'nope' }).expect(401);
    await request(app).post('/api/auth/login').send({ email: 'someone@complao.com', password: 'correct horse battery' }).expect(401);
  });

  it('password plus code grants the session', async () => {
    const { app } = await setup();
    const agent = await signIn(app);
    const meta = await agent.get('/api/meta').expect(200);
    expect(meta.body.types).toContain('Audit');
  });
});

describe('R5, R15, R16 through the API', () => {
  it('search by action ID or case ID opens the audit; names are resolved but never stored', async () => {
    const { app, store } = await setup();
    const agent = await signIn(app);
    expect((await agent.get(`/api/search?q=${A(1)}`)).body).toMatchObject({ kind: 'action', actionId: A(1) });
    expect((await agent.get(`/api/search?q=00-${A(1)}-0123456789abcdef-01`)).body.actionId).toBe(A(1));
    expect((await agent.get('/api/search?q=c7e2f0aa-1111-4222-8333-944455556666')).body).toMatchObject({ kind: 'action', actionId: A(1) });

    const d = await agent.get(`/api/actions/${A(1)}`).expect(200);
    expect(d.body.names.usr_auditor17).toBe('Auditor 17');
    expect(JSON.stringify([...store.actions.values()].map((a) => ({ ...a, stepIds: [...a.stepIds] })))).not.toContain('Auditor 17');
    expect(await store.countViews(A(1))).toBe(1);
    await agent.get(`/api/actions/${A(1)}?refresh=1`).expect(200);
    expect(await store.countViews(A(1))).toBe(1);
  });

  it('accepts pull intervals from 30 seconds to 24 hours only', async () => {
    const { app } = await setup();
    const agent = await signIn(app);
    await agent.put('/api/settings/pull').send({ intervalSeconds: 10, paused: false }).expect(400);
    await agent.put('/api/settings/pull').send({ intervalSeconds: 90_000, paused: false }).expect(400);
    const ok = await agent.put('/api/settings/pull').send({ intervalSeconds: 30, paused: true }).expect(200);
    expect(ok.body).toMatchObject({ intervalSeconds: 30, paused: true });
  });

  it('meets the R11 latency budget on the in-memory store', async () => {
    const { app } = await setup();
    const agent = await signIn(app);
    const t = performance.now();
    for (let i = 0; i < 20; i++) await agent.get('/api/actions').expect(200);
    expect((performance.now() - t) / 20).toBeLessThan(200);
  });
});

void T0;
