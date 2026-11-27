import { DEFAULT_CONFIG, ingestEvents, validateEvent, type ActionStore, type LogEvent } from '@complao/core';
import type { LogSource } from '@complao/ingest';

export const A = (n: number) => n.toString(16).padStart(32, 'a');
export const T0 = Date.parse('2026-11-13T01:31:00.000Z');
export const iso = (ms: number) => new Date(ms).toISOString();

/** A log source backed by an array; events become visible at their timestamp. */
export class ArraySource implements LogSource {
  events: { ts: number; message: string }[] = [];
  constructor(public now: () => number) {}
  add(ts: number, ev: Partial<LogEvent> & Record<string, unknown>) {
    this.events.push({ ts, message: JSON.stringify(ev) });
  }
  async listGroups() {
    return ['/complao/test'];
  }
  async fetch(_g: string, s: number, e: number, onPage: (m: { message: string; timestamp: number }[]) => Promise<void>) {
    const page = this.events.filter((x) => x.ts >= s && x.ts <= Math.min(e, this.now())).map((x) => ({ message: x.message, timestamp: x.ts }));
    if (page.length) await onPage(page);
  }
}

/** A sample audit (the doc's screen 2): 3 Bedrock calls, one nested validation. */
export function sampleAudit(actionId: string, start: number, opts: { caseId?: string; actor?: string; failBedrock?: boolean; end?: boolean } = {}) {
  const actor = opts.actor ?? 'usr_auditor17';
  const caseId = opts.caseId ?? 'c7e2f0aa-1111-4222-8333-944455556666';
  const ev: { ts: number; e: Record<string, unknown> }[] = [];
  const base = { action_id: actionId, actor_id: actor, case_id: caseId };
  ev.push({ ts: start, e: { ...base, event_type: 'action_start', action_type: 'Audit', component: 'Audit engine', started_at: iso(start) } });
  let t = start + 5;
  const step = (id: string, name: string, component: string, lat: number, extra: Record<string, unknown> = {}) => {
    ev.push({ ts: t + lat, e: { ...base, event_type: 'step', step_id: id, step_name: name, component, started_at: iso(t), latency_ms: lat, status: 'success', response_code: 200, ...extra } });
    t += lat + 2;
  };
  step('s1', 'Audit started', 'Audit engine', 120, { details: { participant_ids: ['usr_auditor17', 'usr_tic08'] } });
  step('s2', 'Load audit template', 'Audit engine', 45);
  step('s3', 'Bedrock call', 'Amazon Bedrock', 8400, { details: { model: 'model-a', input_tokens: 3100, output_tokens: 900 } });
  step('s4', 'Response validation', 'Audit engine', 12, { parent_step_id: 's3', response_code: 'ok' });
  step('s5', 'Bedrock call', 'Amazon Bedrock', 9100, { details: { model: 'model-a', input_tokens: 2800, output_tokens: 1100 } });
  if (opts.failBedrock) step('s6', 'Bedrock call', 'Amazon Bedrock', 4000, { status: 'failure', response_code: 503, details: { model: 'model-a', input_tokens: 3400, output_tokens: 0 } });
  else step('s6', 'Bedrock call', 'Amazon Bedrock', 22700, { details: { model: 'model-a', input_tokens: 3400, output_tokens: 1600 } });
  step('s7', 'Report saved', 'Document store', 310, { response_code: 201 });
  if (opts.end !== false) ev.push({ ts: t + 3, e: { ...base, event_type: 'action_end', component: 'Audit engine', started_at: iso(start), latency_ms: t + 3 - start, status: opts.failBedrock ? 'failure' : 'success' } });
  return ev;
}

// ---------------------------------------------------------------- sessions scenario (R22–R24)
export const CASE = 'audit-0001';
const cfg = DEFAULT_CONFIG;
export type Ev = Record<string, unknown>;
const base = (n: number, actor: string, role: string, session: string, caseId: string | null) => ({ action_id: A(n), actor_id: actor, actor_role: role, session_id: session, case_id: caseId });
export function action(n: number, type: string, actor: string, role: string, session: string, caseId: string | null, at: number, opts: { fail?: boolean; open?: boolean; ms?: number } = {}): Ev[] {
  const b = base(5000 + n, actor, role, session, caseId); // own ID range: the emulator table is shared between tests
  const ms = opts.ms ?? 300;
  const out: Ev[] = [
    { ...b, event_type: 'action_start', action_type: type, component: 'Audit engine', started_at: iso(at) },
    { ...b, event_type: 'step', step_id: 's1', step_name: type, component: 'Audit engine', started_at: iso(at + 1), latency_ms: ms, status: opts.fail ? 'failure' : 'success', response_code: opts.fail ? 503 : 200 },
  ];
  if (!opts.open) out.push({ ...b, event_type: 'action_end', component: 'Audit engine', started_at: iso(at), latency_ms: ms + 5, status: opts.fail ? 'failure' : 'success' });
  return out;
}

/** Two people working on one audit, each in their own session, plus a visit that touches no case. */
export function scenario(now: number): LogEvent[] {
  const m = (min: number) => now - min * 60_000;
  const evs: Ev[] = [
    ...action(1, 'Login', 'usr_aud', 'Auditor', 'sess_a', null, m(25)),
    ...action(2, 'Start audit', 'usr_aud', 'Auditor', 'sess_a', CASE, m(24)),
    ...action(3, 'Audit', 'usr_aud', 'Auditor', 'sess_a', CASE, m(10), { fail: true }),
    ...action(4, 'Login', 'usr_tic', 'TIC', 'sess_t', null, m(20)),
    ...action(5, 'Answer query', 'usr_tic', 'TIC', 'sess_t', CASE, m(18)),
    ...action(6, 'Upload evidence', 'usr_tic', 'TIC', 'sess_t', CASE, m(1), { open: true }),
    ...action(7, 'Logout', 'usr_tic', 'TIC', 'sess_t_old', null, m(200)),
    ...action(8, 'Login', 'usr_cb', 'CB', 'sess_c', null, m(12)),
    ...action(9, 'Logout', 'usr_cb', 'CB', 'sess_c', null, m(11)),
  ];
  return evs.map((e) => validateEvent(e).event!).filter(Boolean) as LogEvent[];
}

export async function load(store: ActionStore, now: number) {
  await ingestEvents(store, scenario(now), cfg);
}

