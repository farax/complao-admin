import { DEFAULT_CONFIG, MemoryStore, ingestEvents, validateEvent, type ActionStore, type LogEvent } from '@complao/core';
import { createActionLogger } from '@complao/logger';
import { describe, expect, it } from 'vitest';
import { caseLanes, liveView, listSessions, sessionDetail } from '../apps/api/src/live';
import { A, T0, iso, CASE, action, load, type Ev } from './helpers';

const cfg = DEFAULT_CONFIG;

describe('R22: sessions', () => {
  it('reads session_id and actor_role from events', () => {
    const r = validateEvent({ event_type: 'action_start', action_id: A(1), action_type: 'Login', component: 'Login service', actor_id: 'u', actor_role: 'Auditor', session_id: 'sess_1', started_at: iso(T0) });
    expect(r.event).toMatchObject({ session_id: 'sess_1', actor_role: 'Auditor' });
  });

  it('builds one session per sign-in with its actions, cases and failures', async () => {
    const now = Date.now();
    const s = new MemoryStore();
    await load(s, now);
    const a = (await sessionDetail(s, cfg, 'sess_a', now))!;
    expect(a.session).toMatchObject({ actorId: 'usr_aud', actorRole: 'Auditor', actionCount: 3, failedActions: 1, caseIds: [CASE] });
    expect(a.actions.map((x) => x.actionType)).toEqual(['Login', 'Start audit', 'Audit']);
    expect(a.actions[0].kind).toBe('login');
    expect(a.cases).toEqual([{ caseId: CASE, kind: 'Audit', actionsInSession: 2, totalActions: 4 }]);
    expect(a.actions[2].gapBeforeMs).toBeGreaterThan(13 * 60_000);
  });

  it('derives Active, Idle, Ended and Expired', async () => {
    const now = Date.now();
    const s = new MemoryStore();
    await load(s, now);
    const status = async (id: string, at = now) => (await sessionDetail(s, cfg, id, at))!.session.status;
    expect(await status('sess_t')).toBe('active'); // acted a minute ago
    expect(await status('sess_a')).toBe('idle'); // 10 minutes ago, past the 5-minute idle limit
    expect(await status('sess_c')).toBe('ended'); // signed out
    expect(await status('sess_a', now + 31 * 60_000)).toBe('expired'); // no sign-out, past the 30-minute timeout
  });

  it('lists sessions newest first and filters by status and role', async () => {
    const now = Date.now();
    const s = new MemoryStore();
    await load(s, now);
    const range = { from: new Date(now - 6 * 3_600_000).toISOString(), to: new Date(now).toISOString(), limit: 50 };
    const all = await listSessions(s, cfg, range, now);
    expect(all.items.map((x) => x.sessionId)).toEqual(['sess_c', 'sess_t', 'sess_a', 'sess_t_old']);
    expect((await listSessions(s, cfg, { ...range, roles: ['TIC'] }, now)).items.map((x) => x.sessionId)).toEqual(['sess_t', 'sess_t_old']);
    expect((await listSessions(s, cfg, { ...range, statuses: ['active'] }, now)).items.map((x) => x.sessionId)).toEqual(['sess_t']);
  });

  it('the service logger stamps every event with the session and role', async () => {
    const lines: Ev[] = [];
    const log = createActionLogger({ component: 'Audit engine', sink: (l) => lines.push(JSON.parse(l)) });
    const a = log.startAction({ actionType: 'Answer query', actorId: 'usr_tic', actorRole: 'TIC', sessionId: 'sess_t', caseId: CASE });
    await a.run(() => log.step('Save response', async () => 1));
    a.end('success');
    expect(lines.every((l) => l.session_id === 'sess_t' && l.actor_role === 'TIC')).toBe(true);
  });
});

describe('R23: live view', () => {
  it('groups the last 30 minutes by case, one lane per person, with sign-ins in the case they led to', async () => {
    const now = Date.now();
    const s = new MemoryStore();
    await load(s, now);
    const v = await liveView(s, cfg, 30, now);
    const audit = v.groups.find((g) => g.caseId === CASE)!;
    expect(audit.kind).toBe('Audit');
    expect(audit.lanes.map((l) => `${l.actorRole}:${l.items.map((i) => i.kind === 'action' ? i.actionType : i.kind).join(',')}`)).toEqual([
      'Auditor:login,Start audit,Audit',
      'TIC:login,Answer query,Upload evidence',
    ]);
    expect(audit.failed).toBe(1);
    expect(audit.running).toBe(1); // the TIC's upload is still running
    // The CB signed in and out without touching a case; the 200-minute-old logout is outside the window.
    const other = v.groups.find((g) => g.caseId === null)!;
    expect(other.lanes.map((l) => l.actorId)).toEqual(['usr_cb']);
    expect(v.groups[v.groups.length - 1].caseId).toBeNull();
    expect(v.stats).toMatchObject({ activeSessions: 1, idleSessions: 1, cases: 1, failed: 1, running: 1 });
  });

  it('puts a case with a failure above one that is on track', async () => {
    const now = Date.now();
    const s = new MemoryStore();
    await load(s, now);
    await ingestEvents(s, action(20, 'Start audit', 'usr_aud2', 'Auditor', 'sess_x', 'audit-0002', now - 60_000).map((e) => validateEvent(e).event!) as LogEvent[], cfg);
    const v = await liveView(s, cfg, 30, now);
    expect(v.groups.map((g) => g.caseId)).toEqual([CASE, 'audit-0002', null]);
  });
});

describe('R24: multi-person journeys', () => {
  it('shows everyone who worked on a case, with the sign-ins of their sessions', async () => {
    const now = Date.now();
    const s = new MemoryStore();
    await load(s, now);
    const j = await caseLanes(s, cfg, CASE, now);
    expect(j.kind).toBe('Audit');
    expect(j.sessions).toBe(2);
    expect(j.lanes.map((l) => [l.actorRole, l.items.length])).toEqual([
      ['Auditor', 3],
      ['TIC', 3],
    ]);
  });
});

