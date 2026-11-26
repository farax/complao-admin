import type { LogEvent } from '@complao/core';

/**
 * Generates realistic Complao action events (Appendix A) for the demo: six action types,
 * nested Bedrock calls, wrong passwords, throttles, model errors, multi-day registration
 * journeys, a stalled audit, a dropped event and an unseen "Test" type (R12).
 */

export interface Emitted {
  /** When the event lands in CloudWatch (step completion time). */
  ts: number;
  event: LogEvent;
}

// ---------------------------------------------------------------- deterministic randomness
export function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (a: number, b: number) => Math.floor(a + next() * (b - a + 1)),
    pick: <T>(xs: T[]) => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
    /** log-normal-ish latency around a median */
    lat: (median: number, spread = 0.5) => Math.max(1, Math.round(median * Math.exp((next() + next() + next() - 1.5) * spread * 1.6))),
    hex: (n: number) => Array.from({ length: n }, () => Math.floor(next() * 16).toString(16)).join(''),
  };
}
export type Rng = ReturnType<typeof rng>;

// ---------------------------------------------------------------- roster (IDs only; names come from the lookup)
export interface Person {
  id: string;
  name: string;
}
export function buildRoster(r: Rng) {
  const make = (label: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `usr_${r.hex(12)}`, name: `${label} ${String(i + 1).padStart(2, '0')}` }));
  return { auditors: make('Auditor', 40), tic: make('TIC', 12), cb: make('CB', 20), admins: make('Admin', 3) };
}
export type Roster = ReturnType<typeof buildRoster>;

const MODELS = ['anthropic.claude-sonnet-4-5-20250929-v1:0', 'anthropic.claude-haiku-4-5-20251001-v1:0'];

// ---------------------------------------------------------------- action builder
class Action {
  readonly id: string;
  readonly out: Emitted[] = [];
  private cursor: number;
  private n = 0;
  constructor(
    private r: Rng,
    readonly type: string,
    readonly actor: string,
    readonly caseId: string | null,
    readonly component: string,
    readonly start: number,
  ) {
    this.id = r.hex(32);
    this.cursor = start + r.int(2, 15);
    this.emit(start, { event_type: 'action_start', action_type: type, started_at: iso(start), component });
  }

  private emit(ts: number, partial: Partial<LogEvent>) {
    this.out.push({
      ts,
      event: {
        action_id: this.id,
        actor_id: this.actor,
        case_id: this.caseId,
        ...partial,
      } as LogEvent,
    });
  }

  step(
    name: string,
    component: string,
    latency: number,
    o: { parent?: string; status?: 'success' | 'failure' | 'skipped'; code?: string | number; details?: Record<string, unknown>; at?: number; gap?: number } = {},
  ): { id: string; start: number; end: number } {
    const id = `${this.id.slice(0, 8)}-${String(++this.n).padStart(3, '0')}-${this.r.hex(4)}`;
    const start = o.at ?? this.cursor;
    const end = start + latency;
    this.emit(end, {
      event_type: 'step',
      step_id: id,
      parent_step_id: o.parent ?? null,
      step_name: name,
      component,
      started_at: iso(start),
      latency_ms: latency,
      status: o.status ?? 'success',
      response_code: String(o.code ?? 200),
      details: o.details,
    });
    if (o.at === undefined) this.cursor = end + (o.gap ?? this.r.int(1, 12));
    return { id, start, end };
  }

  /** A child that runs at the tail end of its parent. */
  child(parent: { id: string; end: number }, name: string, component: string, latency: number, o: Parameters<Action['step']>[3] = {}) {
    return this.step(name, component, latency, { ...o, parent: parent.id, at: parent.end - latency - 1 });
  }

  end(status: 'success' | 'failure') {
    const end = this.cursor + this.r.int(1, 8);
    this.emit(end, { event_type: 'action_end', component: this.component, started_at: iso(this.start), latency_ms: end - this.start, status });
    return end;
  }

  /** Drop the most recent event with this step name (simulates a lost log send, R2/R7). */
  drop(stepName: string) {
    const i = this.out.findIndex((e) => e.event.step_name === stepName);
    if (i >= 0) this.out.splice(i, 1);
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------- scenarios

export function login(r: Rng, roster: Roster, at: number): Emitted[] {
  const who = r.pick([...roster.auditors, ...roster.auditors, ...roster.tic, ...roster.cb, ...roster.admins]);
  const a = new Action(r, 'Login', who.id, null, 'Login service', at);
  const method = r.pick(['password + authenticator app', 'password + authenticator app', 'password + SMS code']);
  if (r.chance(0.0002)) {
    a.step('Validate credentials', 'Login service', r.lat(900), { status: 'failure', code: 500, details: { error_code: 'UserStoreUnavailable' } });
    a.end('failure');
    return a.out;
  }
  if (r.chance(0.05)) {
    a.step('Validate credentials', 'Login service', r.lat(140), { status: 'failure', code: 401, details: { reason_code: 'invalid_password' } });
    a.end('failure');
    return a.out;
  }
  a.step('Validate credentials', 'Login service', r.lat(140, 0.4));
  const mfaFail = r.chance(0.02);
  a.step('Check MFA code', 'Login service', r.lat(55, 0.4), { status: mfaFail ? 'failure' : 'success', code: mfaFail ? 401 : 200, details: { sign_in_method: method } });
  if (mfaFail) {
    a.end('failure');
    return a.out;
  }
  a.step('Issue session', 'Login service', r.lat(22, 0.4));
  a.step('Load role permissions', 'Login service', r.lat(35, 0.4));
  a.end('success');
  return a.out;
}

export function audit(r: Rng, roster: Roster, at: number, opts: { stallAfterCalls?: number } = {}): Emitted[] {
  const auditor = r.pick(roster.auditors);
  const tic = r.pick(roster.tic);
  const starter = r.chance(0.7) ? auditor : tic;
  const a = new Action(r, 'Audit', starter.id, randomUUIDFrom(r), 'Audit engine', at);
  a.step('Audit started', 'Audit engine', r.lat(120, 0.3), { details: { participant_ids: [auditor.id, tic.id], standard: r.pick(['ISO 9001', 'ISO 14001', 'ISO 45001', 'HACCP']) } });
  a.step('Load audit template', 'Audit engine', r.lat(45, 0.4));
  a.step('Fetch evidence documents', 'Document store', r.lat(420, 0.5), { details: { document_count: r.int(3, 18) } });

  const calls = r.int(2, 4);
  const model = r.chance(0.8) ? MODELS[0] : MODELS[1];
  for (let i = 0; i < calls; i++) {
    if (opts.stallAfterCalls !== undefined && i === opts.stallAfterCalls) return a.out; // service died mid-run
    const tokensIn = r.int(2400, 4200);
    const tokensOut = r.int(700, 1800);
    const veryslow = r.chance(0.004);
    const latency = veryslow ? r.int(61_000, 75_000) : r.lat(i === calls - 1 ? 14_000 : 8_500, 0.45);

    if (r.chance(0.02)) {
      // throttled, then retried successfully: the action finishes Partial
      a.step('Bedrock call', 'Amazon Bedrock', r.lat(300), { status: 'failure', code: 429, details: { model, error_code: 'ThrottlingException', attempt: 1 } });
    }
    if (r.chance(0.025)) {
      a.step('Bedrock call', 'Amazon Bedrock', r.lat(4000), { status: 'failure', code: 503, details: { model, error_code: 'ModelNotReadyException', input_tokens: tokensIn, output_tokens: 0 } });
      a.step('Mark audit failed', 'Audit engine', r.lat(40), { details: { reason_code: 'model_unavailable' } });
      a.end('failure');
      return a.out;
    }
    const call = a.step('Bedrock call', 'Amazon Bedrock', latency, { details: { model, input_tokens: tokensIn, output_tokens: tokensOut, purpose: ['clause mapping', 'finding extraction', 'risk scoring', 'report drafting'][i] } });
    a.child(call, 'Response validation', 'Audit engine', r.lat(12, 0.3), { code: 'ok' });
  }
  a.step('Score findings', 'Audit engine', r.lat(220, 0.4), { details: { finding_count: r.int(0, 14) } });
  a.step('Report saved', 'Document store', r.lat(310, 0.4), { code: 201 });
  const notifyFail = r.chance(0.004);
  a.step('Notify participants', 'Notifications', r.lat(180, 0.4), { status: notifyFail ? 'failure' : 'success', code: notifyFail ? 502 : 202, details: { channel: 'email', recipient_count: 2 } });
  a.end('success');
  return a.out;
}

/** A registration journey: several short actions sharing one case ID over days (section 6.2). */
export function registrationJourney(r: Rng, roster: Roster, at: number, now: number): Emitted[] {
  const kind = r.pick(['CB registration', 'TIC registration', 'Auditor registration', 'Auditor registration']);
  const applicant = kind === 'CB registration' ? r.pick(roster.cb) : kind === 'TIC registration' ? r.pick(roster.tic) : r.pick(roster.auditors);
  const caseId = randomUUIDFrom(r);
  const out: Emitted[] = [];
  let t = at;

  // Stage 1: submit
  {
    const a = new Action(r, kind, applicant.id, caseId, 'Registration services', t);
    a.step('Validate application', 'Registration services', r.lat(70, 0.4));
    a.step('Create registration record', 'Registration services', r.lat(140, 0.4), { code: 201, details: { stage: 'submitted' } });
    a.step('Send confirmation email', 'Notifications', r.lat(220, 0.4), { code: 202, details: { channel: 'email' } });
    a.end('success');
    out.push(...a.out);
  }
  // Stage 2: upload documents (hours to a day later)
  t += r.int(1, 30) * 3_600_000;
  if (t > now) return out;
  {
    const a = new Action(r, kind, applicant.id, caseId, 'Registration services', t);
    a.step('Load registration', 'Registration services', r.lat(60, 0.3));
    const n = r.int(2, 5);
    for (let i = 0; i < n; i++) {
      const up = a.step('Upload document', 'Document store', r.lat(1400, 0.5), { code: 201, details: { file_type: r.pick(['pdf', 'pdf', 'jpg', 'docx']), size_kb: r.int(80, 4200) } });
      a.child(up, 'Virus scan', 'Document store', r.lat(350, 0.4), { code: 'clean' });
    }
    const notifyFail = r.chance(0.015);
    a.step('Update registration status', 'Registration services', r.lat(90, 0.3), { details: { stage: 'documents_uploaded' } });
    a.step('Notify admin', 'Notifications', r.lat(200, 0.4), { status: notifyFail ? 'failure' : 'success', code: notifyFail ? 502 : 202 });
    a.end('success');
    out.push(...a.out);
  }
  // Stage 3: admin raises a query, applicant answers (sometimes)
  const admin = r.pick(roster.admins);
  if (r.chance(0.35)) {
    t += r.int(4, 40) * 3_600_000;
    if (t > now) return out;
    const a = new Action(r, kind, applicant.id, caseId, 'Registration services', t);
    a.step('Load registration', 'Registration services', r.lat(60, 0.3));
    a.step('Save query response', 'Registration services', r.lat(120, 0.3), { details: { stage: 'query_answered' } });
    a.step('Notify admin', 'Notifications', r.lat(200, 0.4), { code: 202, details: { approver_id: admin.id } });
    a.end('success');
    out.push(...a.out);
  }
  // Stage 4: admin approval
  t += r.int(6, 70) * 3_600_000;
  if (t > now) return out;
  {
    const a = new Action(r, 'Admin approval', admin.id, caseId, 'Approvals', t);
    a.step('Load registration', 'Approvals', r.lat(70, 0.3), { details: { registration_kind: kind } });
    a.step('Verify documents', 'Approvals', r.lat(650, 0.4), { details: { document_count: r.int(2, 5) } });
    const approve = r.chance(0.88);
    a.step(approve ? 'Approve registration' : 'Request more information', 'Approvals', r.lat(180, 0.3), { details: { decision: approve ? 'approved' : 'more_info', applicant_id: applicant.id } });
    a.step('Notify applicant', 'Notifications', r.lat(210, 0.4), { code: 202, details: { user_id: applicant.id } });
    a.end('success');
    out.push(...a.out);
  }
  return out;
}

/** An action whose parent step was lost in transit: shows as Incomplete (R7). */
export function auditWithDroppedEvent(r: Rng, roster: Roster, at: number): Emitted[] {
  let events = audit(r, roster, at);
  for (let tries = 0; tries < 20 && !events.some((e) => e.event.step_name === 'Response validation'); tries++) events = audit(r, roster, at);
  const i = events.findIndex((e) => e.event.step_name === 'Bedrock call' && e.event.status === 'success');
  if (i >= 0) events.splice(i, 1);
  return events;
}

/** R12: an action type the portal has never seen. */
export function testAction(r: Rng, at: number): Emitted[] {
  const a = new Action(r, 'Test', 'svc_synthetic_monitor', null, 'Test harness', at);
  a.step('Synthetic check', 'Test harness', r.lat(90));
  a.end('success');
  return a.out;
}

function randomUUIDFrom(r: Rng): string {
  const h = r.hex(32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[Math.floor(r.next() * 4)]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

