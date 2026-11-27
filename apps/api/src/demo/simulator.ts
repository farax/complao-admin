import type { LogEvent } from '@complao/core';

/**
 * Generates realistic Complao action events (Appendix A) for the demo.
 *
 * People sign in (a session), act in a role, and work on cases. An audit is an engagement:
 * an auditor, a TIC, an admin and sometimes a CB each sign in over hours and take their
 * turns. Registrations run over days. Mixed in: wrong passwords, Bedrock throttles and
 * outages, a stalled audit, a lost event and an unseen "Test" type (R12).
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
  role: string;
}
export function buildRoster(r: Rng) {
  const make = (label: string, role: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `usr_${r.hex(12)}`, name: `${label} ${String(i + 1).padStart(2, '0')}`, role }));
  return { auditors: make('Auditor', 'Auditor', 40), tic: make('TIC', 'TIC', 12), cb: make('CB', 'CB', 20), admins: make('Admin', 'Admin', 3) };
}
export type Roster = ReturnType<typeof buildRoster>;
const everyone = (ro: Roster) => [...ro.auditors, ...ro.tic, ...ro.cb, ...ro.admins];

const MODELS = ['anthropic.claude-sonnet-4-5-20250929-v1:0', 'anthropic.claude-haiku-4-5-20251001-v1:0'];
const iso = (ms: number) => new Date(ms).toISOString();

export function uuid(r: Rng): string {
  const h = r.hex(32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[Math.floor(r.next() * 4)]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Who is acting, in which session, on which case. */
export interface Ctx {
  person: Person;
  sessionId: string | null;
  caseId: string | null;
}

// ---------------------------------------------------------------- action builder
type StepOpts = { parent?: string; status?: 'success' | 'failure' | 'skipped'; code?: string | number; details?: Record<string, unknown>; at?: number; gap?: number };

class Action {
  readonly id: string;
  readonly out: Emitted[] = [];
  private cursor: number;
  private n = 0;
  constructor(
    private r: Rng,
    readonly type: string,
    readonly ctx: Ctx,
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
        actor_id: this.ctx.person.id,
        actor_role: this.ctx.person.role,
        session_id: this.ctx.sessionId,
        case_id: this.ctx.caseId,
        ...partial,
      } as LogEvent,
    });
  }

  step(name: string, component: string, latency: number, o: StepOpts = {}): { id: string; start: number; end: number } {
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
  child(parent: { id: string; end: number }, name: string, component: string, latency: number, o: StepOpts = {}) {
    return this.step(name, component, latency, { ...o, parent: parent.id, at: parent.end - latency - 1 });
  }

  end(status: 'success' | 'failure') {
    const end = this.cursor + this.r.int(1, 8);
    this.emit(end, { event_type: 'action_end', component: this.component, started_at: iso(this.start), latency_ms: end - this.start, status });
    return end;
  }
}

export interface Built {
  out: Emitted[];
  /** when the last event lands; the person can act again after this */
  end: number;
  failed?: boolean;
}

const finish = (a: Action, status: 'success' | 'failure'): Built => {
  const end = a.end(status);
  return { out: a.out, end, failed: status === 'failure' };
};

// ---------------------------------------------------------------- sign-in and sign-out

export function loginAction(r: Rng, ctx: Ctx, at: number, opts: { forceFail?: boolean } = {}): Built {
  const a = new Action(r, 'Login', { ...ctx, caseId: null }, 'Login service', at);
  const method = r.pick(['password + authenticator app', 'password + authenticator app', 'password + SMS code']);
  if (r.chance(0.0002)) {
    a.step('Validate credentials', 'Login service', r.lat(900), { status: 'failure', code: 500, details: { error_code: 'UserStoreUnavailable' } });
    return finish(a, 'failure');
  }
  if (opts.forceFail || r.chance(0.04)) {
    a.step('Validate credentials', 'Login service', r.lat(140), { status: 'failure', code: 401, details: { reason_code: 'invalid_password' } });
    return finish(a, 'failure');
  }
  a.step('Validate credentials', 'Login service', r.lat(140, 0.4));
  const mfaFail = r.chance(0.015);
  a.step('Check MFA code', 'Login service', r.lat(55, 0.4), { status: mfaFail ? 'failure' : 'success', code: mfaFail ? 401 : 200, details: { sign_in_method: method } });
  if (mfaFail) return finish(a, 'failure');
  a.step('Issue session', 'Login service', r.lat(22, 0.4));
  a.step('Load role permissions', 'Login service', r.lat(35, 0.4), { details: { role: ctx.person.role } });
  return finish(a, 'success');
}

export function logoutAction(r: Rng, ctx: Ctx, at: number): Built {
  const a = new Action(r, 'Logout', { ...ctx, caseId: null }, 'Login service', at);
  a.step('End session', 'Login service', r.lat(18, 0.3));
  return finish(a, 'success');
}

/** One sign-in: a login that opens a session, then whatever the person does, then maybe a sign-out. */
export class SessionSim {
  readonly id: string;
  last: number;
  ok = true;
  constructor(
    private r: Rng,
    readonly person: Person,
    at: number,
    readonly sink: (e: Emitted[]) => void,
  ) {
    this.id = `sess_${r.hex(20)}`;
    // A wrong password first, now and then: the retry is in the same session.
    if (r.chance(0.05)) {
      const bad = loginAction(r, this.ctx(null), at, { forceFail: true });
      sink(bad.out);
      at = bad.end + r.int(4_000, 20_000);
    }
    const b = loginAction(r, this.ctx(null), at);
    sink(b.out);
    this.last = b.end;
    this.ok = !b.failed;
  }
  ctx(caseId: string | null): Ctx {
    return { person: this.person, sessionId: this.id, caseId };
  }
  act(build: (r: Rng, ctx: Ctx, at: number) => Built, caseId: string | null, at?: number): Built {
    const start = Math.max(at ?? 0, this.last + this.r.int(2_000, 25_000));
    const b = build(this.r, this.ctx(caseId), start);
    this.sink(b.out);
    this.last = Math.max(this.last, b.end);
    return b;
  }
  logout(at?: number) {
    const b = logoutAction(this.r, this.ctx(null), Math.max(at ?? 0, this.last + this.r.int(3_000, 60_000)));
    this.sink(b.out);
    this.last = b.end;
  }
}

// ---------------------------------------------------------------- audit work, by role

type StepSpec = [name: string, component: string, medianMs: number, opts?: StepOpts & { child?: boolean }];

function simple(type: string, component: string, steps: (r: Rng, ctx: Ctx) => StepSpec[], fail?: { p: number; at: number; code: number; error: string; component?: string }) {
  return (r: Rng, ctx: Ctx, at: number): Built => {
    const a = new Action(r, type, ctx, component, at);
    const specs = steps(r, ctx);
    let prev: { id: string; start: number; end: number } | null = null;
    const failAt = fail && r.chance(fail.p) ? Math.min(fail.at, specs.length - 1) : -1;
    for (let i = 0; i < specs.length; i++) {
      const [name, comp, ms, o = {}] = specs[i];
      if (i === failAt) {
        a.step(name, fail!.component ?? comp, r.lat(ms), { status: 'failure', code: fail!.code, details: { error_code: fail!.error } });
        return finish(a, 'failure');
      }
      const lat = r.lat(ms, 0.45);
      if (o.child && prev) a.child(prev, name, comp, Math.min(lat, Math.max(1, prev.end - prev.start - 2)), o);
      else prev = a.step(name, comp, lat, o);
    }
    return finish(a, 'success');
  };
}

export const WORK = {
  startAudit: (participants: string[]) =>
    simple('Start audit', 'Audit engine', (r) => [
      ['Audit started', 'Audit engine', 120, { details: { participant_ids: participants, standard: r.pick(['ISO 9001', 'ISO 14001', 'ISO 45001', 'HACCP']) } }],
      ['Load audit template', 'Audit engine', 45],
      ['Assign participants', 'Audit engine', 60],
      ['Notify participants', 'Notifications', 180, { code: 202, details: { channel: 'email', recipient_count: participants.length } }],
    ]),
  uploadEvidence: simple(
    'Upload evidence',
    'Document store',
    (r) => {
      const n = r.int(1, 4);
      const out: StepSpec[] = [];
      for (let i = 0; i < n; i++) {
        out.push(['Upload document', 'Document store', 1400, { code: 201, details: { file_type: r.pick(['pdf', 'pdf', 'xlsx', 'jpg']), size_kb: r.int(80, 4200) } }]);
        out.push(['Virus scan', 'Document store', 350, { code: 'clean', child: true }]);
      }
      out.push(['Link to clauses', 'Audit engine', 90]);
      return out;
    },
    { p: 0.03, at: 0, code: 413, error: 'FileTooLarge' },
  ),
  answerQuery: simple('Answer query', 'Audit engine', () => [
    ['Load query', 'Audit engine', 60],
    ['Save response', 'Audit engine', 110],
    ['Notify auditor', 'Notifications', 190, { code: 202 }],
  ]),
  recordFinding: simple('Record finding', 'Audit engine', (r) => [
    ['Validate finding', 'Audit engine', 70, { details: { severity: r.pick(['minor', 'minor', 'major', 'observation']) } }],
    ['Save finding', 'Audit engine', 120],
    ['Notify TIC', 'Notifications', 190, { code: 202 }],
  ]),
  reviewFindings: simple('Review findings', 'Audit engine', (r) => [
    ['Load findings', 'Audit engine', 210, { details: { finding_count: r.int(1, 12) } }],
    ['Mark reviewed', 'Audit engine', 90],
  ]),
  signOff: simple(
    'Sign off',
    'Audit engine',
    () => [
      ['Verify findings closed', 'Audit engine', 150],
      ['Record sign-off', 'Audit engine', 100],
      ['Notify certification body', 'Notifications', 240, { code: 202 }],
    ],
    { p: 0.02, at: 2, code: 502, error: 'NotificationServiceTimeout', component: 'Notifications' },
  ),
  approveReport: simple('Approve report', 'Approvals', (r) => [
    ['Load report', 'Document store', 380],
    ['Verify report', 'Approvals', 650, { details: { finding_count: r.int(0, 12) } }],
    ['Approve report', 'Approvals', 180, { details: { decision: 'approved' } }],
    ['Notify participants', 'Notifications', 210, { code: 202 }],
  ]),
  viewProgress: simple('View progress', 'Audit engine', () => [['Load audit status', 'Audit engine', 120]]),
};

/** The AI review: Bedrock calls with nested validation (the doc's sample audit). */
export function aiReview(opts: { stallAfterCalls?: number } = {}) {
  return (r: Rng, ctx: Ctx, at: number): Built => {
    const a = new Action(r, 'Audit', ctx, 'Audit engine', at);
    a.step('Load audit evidence', 'Document store', r.lat(420, 0.5), { details: { document_count: r.int(3, 18) } });
    const calls = r.int(2, 4);
    const model = r.chance(0.8) ? MODELS[0] : MODELS[1];
    for (let i = 0; i < calls; i++) {
      if (opts.stallAfterCalls !== undefined && i === opts.stallAfterCalls) return { out: a.out, end: at + 60_000 }; // the service died mid-run
      const tokensIn = r.int(2400, 4200);
      const tokensOut = r.int(700, 1800);
      const veryslow = r.chance(0.004);
      const latency = veryslow ? r.int(61_000, 75_000) : r.lat(i === calls - 1 ? 14_000 : 8_500, 0.45);
      if (r.chance(0.02)) {
        a.step('Bedrock call', 'Amazon Bedrock', r.lat(300), { status: 'failure', code: 429, details: { model, error_code: 'ThrottlingException', attempt: 1 } });
      }
      if (r.chance(0.03)) {
        a.step('Bedrock call', 'Amazon Bedrock', r.lat(4000), { status: 'failure', code: 503, details: { model, error_code: 'ModelNotReadyException', input_tokens: tokensIn, output_tokens: 0 } });
        a.step('Mark review failed', 'Audit engine', r.lat(40), { details: { reason_code: 'model_unavailable' } });
        return finish(a, 'failure');
      }
      const call = a.step('Bedrock call', 'Amazon Bedrock', latency, {
        details: { model, input_tokens: tokensIn, output_tokens: tokensOut, purpose: ['clause mapping', 'finding extraction', 'risk scoring', 'report drafting'][i] },
      });
      a.child(call, 'Response validation', 'Audit engine', r.lat(12, 0.3), { code: 'ok' });
    }
    a.step('Score findings', 'Audit engine', r.lat(220, 0.4), { details: { finding_count: r.int(0, 14) } });
    a.step('Report saved', 'Document store', r.lat(310, 0.4), { code: 201 });
    return finish(a, 'success');
  };
}

// ---------------------------------------------------------------- an audit engagement

type Who = 'auditor' | 'tic' | 'admin' | 'cb';
interface Beat {
  who: Who;
  work: (r: Rng, ctx: Ctx, at: number) => Built;
}

/**
 * One audit from start to approval: several people, each signing in when it's their turn.
 * `pace` sets the gap between turns: hours in the history, a minute or two when live.
 */
export class AuditEngagement {
  readonly caseId: string;
  readonly people: Record<Who, Person | null>;
  private beats: Beat[];
  private i = 0;
  private sessions = new Map<string, SessionSim>();
  next: number;

  constructor(
    private r: Rng,
    roster: Roster,
    start: number,
    private pace: [minMs: number, maxMs: number],
    private sink: (e: Emitted[]) => void,
    opts: { stall?: boolean } = {},
  ) {
    this.caseId = uuid(r);
    const auditor = r.pick(roster.auditors);
    const tic = r.pick(roster.tic);
    this.people = { auditor, tic, admin: r.pick(roster.admins), cb: r.chance(0.5) ? r.pick(roster.cb) : null };
    const findings = r.int(1, 3);
    const aiBeat = aiReview({ stallAfterCalls: opts.stall ? 1 : undefined });
    this.beats = [
      { who: 'auditor', work: WORK.startAudit([auditor.id, tic.id]) },
      { who: 'auditor', work: WORK.uploadEvidence },
      { who: 'tic', work: WORK.uploadEvidence },
      { who: 'tic', work: WORK.answerQuery },
      ...(this.people.cb ? [{ who: 'cb' as Who, work: WORK.viewProgress }] : []),
      { who: 'auditor', work: aiBeat },
      ...Array.from({ length: findings }, () => ({ who: 'auditor' as Who, work: WORK.recordFinding })),
      { who: 'tic', work: WORK.reviewFindings },
      { who: 'tic', work: WORK.signOff },
      { who: 'admin', work: WORK.approveReport },
    ];
    // A stalled audit: the AI review never finishes, and nobody takes another turn.
    if (opts.stall) this.beats = this.beats.slice(0, this.beats.findIndex((b) => b.work === aiBeat) + 1);
    this.next = start;
  }

  get done() {
    return this.i >= this.beats.length;
  }

  /** Play the next turn at time `at` (or when it is due). Returns false when finished. */
  step(at = this.next): boolean {
    if (this.done) return false;
    const beat = this.beats[this.i++];
    const person = this.people[beat.who]!;
    let s = this.sessions.get(person.id);
    // Back after a long break: the old visit ended (or timed out) and a new sign-in starts.
    if (s && at - s.last > 25 * 60_000) {
      if (this.r.chance(0.65)) s.logout(s.last + this.r.int(20_000, 300_000));
      s = undefined;
    }
    if (!s) {
      s = new SessionSim(this.r, person, at, this.sink);
      this.sessions.set(person.id, s);
    }
    const b = s.act(beat.work, this.caseId, at);
    if (b.failed && this.r.chance(0.7)) this.i--; // a failed turn is retried
    this.next = Math.max(b.end, at) + this.r.int(this.pace[0], this.pace[1]);
    if (this.done) for (const sess of this.sessions.values()) if (this.r.chance(0.7)) sess.logout(sess.last + this.r.int(30_000, 600_000));
    return !this.done;
  }

  /** Play every turn due before `until`. */
  playUntil(until: number) {
    while (!this.done && this.next <= until) this.step();
  }
}

// ---------------------------------------------------------------- registrations

/** A registration journey: several short visits sharing one case ID over days. */
export function registrationJourney(r: Rng, roster: Roster, at: number, now: number, sink: (e: Emitted[]) => void) {
  const kind = r.pick(['CB registration', 'TIC registration', 'Auditor registration', 'Auditor registration']);
  const applicant = kind === 'CB registration' ? r.pick(roster.cb) : kind === 'TIC registration' ? r.pick(roster.tic) : r.pick(roster.auditors);
  const caseId = uuid(r);
  const admin = r.pick(roster.admins);
  const visit = (who: Person, t: number, work: (r: Rng, ctx: Ctx, at: number) => Built) => {
    const s = new SessionSim(r, who, t, sink);
    s.act(work, caseId);
    if (r.chance(0.7)) s.logout();
  };
  const stage = (steps: StepSpec[], type = kind) => simple(type, 'Registration services', () => steps);

  visit(applicant, at, stage([
    ['Validate application', 'Registration services', 70],
    ['Create registration record', 'Registration services', 140, { code: 201, details: { stage: 'submitted' } }],
    ['Send confirmation email', 'Notifications', 220, { code: 202, details: { channel: 'email' } }],
  ]));
  let t = at + r.int(1, 30) * 3_600_000;
  if (t > now) return;
  visit(applicant, t, (rr, ctx, a0) => {
    const a = new Action(rr, kind, ctx, 'Registration services', a0);
    a.step('Load registration', 'Registration services', rr.lat(60, 0.3));
    for (let i = 0, n = rr.int(2, 5); i < n; i++) {
      const up = a.step('Upload document', 'Document store', rr.lat(1400, 0.5), { code: 201, details: { file_type: rr.pick(['pdf', 'pdf', 'jpg', 'docx']), size_kb: rr.int(80, 4200) } });
      a.child(up, 'Virus scan', 'Document store', rr.lat(350, 0.4), { code: 'clean' });
    }
    a.step('Update registration status', 'Registration services', rr.lat(90, 0.3), { details: { stage: 'documents_uploaded' } });
    const nf = rr.chance(0.015);
    a.step('Notify admin', 'Notifications', rr.lat(200, 0.4), { status: nf ? 'failure' : 'success', code: nf ? 502 : 202 });
    return finish(a, 'success');
  });
  if (r.chance(0.35)) {
    t += r.int(4, 40) * 3_600_000;
    if (t > now) return;
    visit(applicant, t, stage([
      ['Load registration', 'Registration services', 60],
      ['Save query response', 'Registration services', 120, { details: { stage: 'query_answered' } }],
      ['Notify admin', 'Notifications', 200, { code: 202, details: { approver_id: admin.id } }],
    ]));
  }
  t += r.int(6, 70) * 3_600_000;
  if (t > now) return;
  const approve = r.chance(0.88);
  visit(admin, t, stage(
    [
      ['Load registration', 'Approvals', 70, { details: { registration_kind: kind } }],
      ['Verify documents', 'Approvals', 650, { details: { document_count: r.int(2, 5) } }],
      [approve ? 'Approve registration' : 'Request more information', 'Approvals', 180, { details: { decision: approve ? 'approved' : 'more_info', applicant_id: applicant.id } }],
      ['Notify applicant', 'Notifications', 210, { code: 202, details: { user_id: applicant.id } }],
    ],
    'Admin approval',
  ));
}

/** A short visit that touches no case: sign in, look around, maybe sign out. */
export function browseVisit(r: Rng, roster: Roster, at: number, sink: (e: Emitted[]) => void) {
  const s = new SessionSim(r, r.pick(everyone(roster)), at, sink);
  if (s.ok && r.chance(0.7)) s.logout(s.last + r.int(60_000, 20 * 60_000));
}

/** An action whose parent step was lost in transit: shows as Incomplete (R7). */
export function auditWithDroppedEvent(r: Rng, roster: Roster, at: number, sink: (e: Emitted[]) => void) {
  const s = new SessionSim(r, r.pick(roster.auditors), at, () => {});
  const caseId = uuid(r);
  let built = aiReview()(r, s.ctx(caseId), at + 30_000);
  for (let tries = 0; tries < 20 && built.failed; tries++) built = aiReview()(r, s.ctx(caseId), at + 30_000);
  const i = built.out.findIndex((e) => e.event.step_name === 'Bedrock call' && e.event.status === 'success');
  if (i >= 0) built.out.splice(i, 1);
  sink(built.out);
}

/** R12: an action type the portal has never seen. */
export function testAction(r: Rng, at: number, sink: (e: Emitted[]) => void) {
  const a = new Action(r, 'Test', { person: { id: 'svc_synthetic_monitor', name: 'Synthetic monitor', role: 'System' }, sessionId: null, caseId: null }, 'Test harness', at);
  a.step('Synthetic check', 'Test harness', r.lat(90));
  sink(finish(a, 'success').out);
}
