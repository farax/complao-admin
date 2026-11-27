import { bucketIndex, emptyBuckets } from './histogram';
import { dayOf } from './rules';
import type { ActionEndInput, ActionStartInput, ActionStore, Page, RangeQuery, RegistryKind, SessionTouch, StepTouch, Who } from './store';
import { mergeConfig } from './store';
import { DEFAULT_CONFIG, DEFAULT_PULL } from './types';
import type { ActionRecord, CostDay, HealthWindow, PortalConfig, PullSetting, SessionRecord, StepRecord } from './types';

type MutableSession = Omit<SessionRecord, 'actionIds' | 'caseIds' | 'failedActionIds'> & {
  actionIds: Set<string>;
  caseIds: Set<string>;
  failedActionIds: Set<string>;
};

type MutableAction = Omit<ActionRecord, 'stepIds' | 'parentIds' | 'failedStepIds' | 'components'> & {
  stepIds: Set<string>;
  parentIds: Set<string>;
  failedStepIds: Set<string>;
  components: Set<string>;
};

/** In-process store with the same semantics as DynamoStore. Used for the demo and tests. */
export class MemoryStore implements ActionStore {
  actions = new Map<string, MutableAction>();
  steps = new Map<string, Map<string, StepRecord>>();
  health = new Map<string, HealthWindow>();
  cost = new Map<string, CostDay>();
  sessions = new Map<string, MutableSession>();
  registry = { type: new Set<string>(), component: new Set<string>(), role: new Set<string>() };
  checkpoints = new Map<string, number>();
  views = new Map<string, string[]>();
  pull: PullSetting = { ...DEFAULT_PULL };
  config: PortalConfig = structuredClone(DEFAULT_CONFIG);

  private ensure(id: string, seed: { startedAt: string; actorId: string | null }): MutableAction {
    let a = this.actions.get(id);
    if (!a) {
      a = {
        actionId: id,
        actionType: null,
        actorId: seed.actorId,
        actorRole: null,
        sessionId: null,
        caseId: null,
        startedAt: seed.startedAt,
        hasStart: false,
        hasEnd: false,
        endedAt: null,
        latencyMs: null,
        endStatus: null,
        lastEventAt: seed.startedAt,
        stepIds: new Set(),
        parentIds: new Set(),
        failedStepIds: new Set(),
        components: new Set(),
        aiCostUsd: 0,
        aiCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      };
      this.actions.set(id, a);
    }
    return a;
  }

  private bumpLast(a: MutableAction, iso: string) {
    if (iso > a.lastEventAt) a.lastEventAt = iso;
  }

  private who(a: MutableAction, w: Who, authoritative = false) {
    if (w.sessionId && (authoritative || !a.sessionId)) a.sessionId = w.sessionId;
    if (w.actorRole && (authoritative || !a.actorRole)) a.actorRole = w.actorRole;
  }

  async putStep(step: StepRecord) {
    let m = this.steps.get(step.actionId);
    if (!m) this.steps.set(step.actionId, (m = new Map()));
    const key = `${step.startedAt}#${step.stepId}`;
    const isNew = !m.has(key);
    m.set(key, structuredClone(step));
    return isNew;
  }

  async applyActionStart(i: ActionStartInput) {
    const a = this.ensure(i.actionId, { startedAt: i.startedAt, actorId: i.actorId });
    a.actionType = i.actionType;
    a.startedAt = i.startedAt;
    a.actorId = i.actorId;
    a.hasStart = true;
    this.who(a, i, true);
    if (i.caseId) a.caseId = i.caseId;
    a.components.add(i.component);
    this.bumpLast(a, i.startedAt);
  }

  async applyActionEnd(i: ActionEndInput) {
    const a = this.ensure(i.actionId, { startedAt: i.startedAt, actorId: i.actorId });
    a.hasEnd = true;
    a.endedAt = i.endedAt;
    a.latencyMs = i.latencyMs;
    a.endStatus = i.status;
    this.who(a, i);
    if (!a.caseId && i.caseId) a.caseId = i.caseId;
    if (!a.hasStart && i.startedAt < a.startedAt) a.startedAt = i.startedAt;
    a.components.add(i.component);
    this.bumpLast(a, i.endedAt);
  }

  async touchActionFromStep({ step, isNew, completedAt, ai, sessionId, actorRole }: StepTouch) {
    const a = this.ensure(step.actionId, { startedAt: step.startedAt, actorId: step.actorId });
    this.who(a, { sessionId, actorRole });
    if (!a.caseId && step.caseId) a.caseId = step.caseId;
    a.stepIds.add(step.stepId);
    if (step.parentStepId) a.parentIds.add(step.parentStepId);
    if (step.status === 'failure') a.failedStepIds.add(step.stepId);
    a.components.add(step.component);
    if (isNew && ai) {
      a.aiCostUsd += ai.costUsd;
      a.aiCalls += 1;
      a.tokensIn += ai.tokensIn;
      a.tokensOut += ai.tokensOut;
    }
    this.bumpLast(a, completedAt);
  }

  async addHealth(component: string, windowStart: string, ms: number, failure: boolean, serverFailure: boolean) {
    const k = `${component}|${windowStart}`;
    let w = this.health.get(k);
    if (!w) this.health.set(k, (w = { component, windowStart, count: 0, failures: 0, serverFailures: 0, maxMs: 0, sumMs: 0, buckets: emptyBuckets() }));
    w.count++;
    w.sumMs += ms;
    if (failure) w.failures++;
    if (serverFailure) w.serverFailures++;
    w.maxMs = Math.max(w.maxMs, ms);
    w.buckets[bucketIndex(ms)]++;
  }

  async addCost(day: string, costUsd: number, tokensIn: number, tokensOut: number) {
    let c = this.cost.get(day);
    if (!c) this.cost.set(day, (c = { day, costUsd: 0, calls: 0, tokensIn: 0, tokensOut: 0 }));
    c.costUsd += costUsd;
    c.calls++;
    c.tokensIn += tokensIn;
    c.tokensOut += tokensOut;
  }

  async touchSession(t: SessionTouch) {
    let s = this.sessions.get(t.sessionId);
    if (!s) {
      s = {
        sessionId: t.sessionId,
        actorId: t.actorId,
        actorRole: t.actorRole,
        startedAt: t.at,
        lastEventAt: t.at,
        hasLogin: false,
        loggedOutAt: null,
        actionIds: new Set(),
        caseIds: new Set(),
        failedActionIds: new Set(),
      };
      this.sessions.set(t.sessionId, s);
    }
    if (!s.actorRole && t.actorRole) s.actorRole = t.actorRole;
    if (t.at < s.startedAt) s.startedAt = t.at;
    if (t.at > s.lastEventAt) s.lastEventAt = t.at;
    s.actionIds.add(t.actionId);
    if (t.caseId) s.caseIds.add(t.caseId);
    if (t.failed) s.failedActionIds.add(t.actionId);
    if (t.login) s.hasLogin = true;
    if (t.logout && (!s.loggedOutAt || t.at > s.loggedOutAt)) s.loggedOutAt = t.at;
  }

  async register(kind: RegistryKind, value: string) {
    this.registry[kind].add(value);
  }
  async getCheckpoint(g: string) {
    return this.checkpoints.get(g) ?? null;
  }
  async putCheckpoint(g: string, ms: number) {
    this.checkpoints.set(g, ms);
  }
  async recordPull(update: Partial<PullSetting>) {
    this.pull = { ...this.pull, ...update };
  }

  private freeze(a: MutableAction): ActionRecord {
    return {
      ...a,
      stepIds: [...a.stepIds],
      parentIds: [...a.parentIds],
      failedStepIds: [...a.failedStepIds],
      components: [...a.components],
    };
  }

  async getAction(id: string) {
    const a = this.actions.get(id);
    return a ? this.freeze(a) : null;
  }
  async getActions(ids: string[]) {
    return ids.map((id) => this.actions.get(id)).filter(Boolean).map((a) => this.freeze(a!));
  }
  async getSteps(id: string) {
    return [...(this.steps.get(id)?.values() ?? [])].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.stepId.localeCompare(b.stepId));
  }

  private page<T>(all: T[], q: RangeQuery): Page<T> {
    const offset = typeof q.next === 'number' ? q.next : 0;
    const items = all.slice(offset, offset + q.limit);
    return { items, next: offset + q.limit < all.length ? offset + q.limit : null };
  }

  async queryActionsByDay(day: string, q: RangeQuery) {
    const all = [...this.actions.values()]
      .filter((a) => dayOf(a.startedAt) === day && a.startedAt >= q.fromIso && a.startedAt <= q.toIso)
      .sort((a, b) => (q.newestFirst === false ? 1 : -1) * (a.startedAt.localeCompare(b.startedAt) || a.actionId.localeCompare(b.actionId)))
      .map((a) => this.freeze(a));
    return this.page(all, q);
  }

  async queryActionsByCase(caseId: string) {
    return [...this.actions.values()]
      .filter((a) => a.caseId === caseId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((a) => this.freeze(a));
  }

  async queryStepsByComponentDay(component: string, day: string, q: RangeQuery) {
    const all: StepRecord[] = [];
    for (const m of this.steps.values())
      for (const s of m.values())
        if (s.component === component && dayOf(s.startedAt) === day && s.startedAt >= q.fromIso && s.startedAt <= q.toIso) all.push(s);
    all.sort((a, b) => (q.newestFirst === false ? 1 : -1) * (a.startedAt.localeCompare(b.startedAt) || a.stepId.localeCompare(b.stepId)));
    return this.page(all, q);
  }

  async getHealthWindows(component: string, fromIso: string, toIso: string) {
    return [...this.health.values()]
      .filter((w) => w.component === component && w.windowStart >= fromIso && w.windowStart <= toIso)
      .map((w) => structuredClone(w));
  }

  async getCostDays(fromDay: string, toDay: string) {
    return [...this.cost.values()].filter((c) => c.day >= fromDay && c.day <= toDay).sort((a, b) => a.day.localeCompare(b.day));
  }

  async listRegistry(kind: RegistryKind) {
    return [...this.registry[kind]].sort();
  }

  private freezeSession(s: MutableSession): SessionRecord {
    return { ...s, actionIds: [...s.actionIds], caseIds: [...s.caseIds], failedActionIds: [...s.failedActionIds] };
  }

  async getSession(id: string) {
    const s = this.sessions.get(id);
    return s ? this.freezeSession(s) : null;
  }

  async querySessionsByDay(day: string, q: RangeQuery) {
    const all = [...this.sessions.values()]
      .filter((s) => dayOf(s.startedAt) === day && s.startedAt >= q.fromIso && s.startedAt <= q.toIso)
      .sort((a, b) => (q.newestFirst === false ? 1 : -1) * (a.startedAt.localeCompare(b.startedAt) || a.sessionId.localeCompare(b.sessionId)))
      .map((s) => this.freezeSession(s));
    return this.page(all, q);
  }

  async queryActionsBySession(id: string) {
    return [...this.actions.values()]
      .filter((a) => a.sessionId === id)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.actionId.localeCompare(b.actionId))
      .map((a) => this.freeze(a));
  }
  async getPull() {
    return { ...this.pull };
  }
  async getConfig() {
    return mergeConfig(DEFAULT_CONFIG, this.config);
  }
  async putPullSetting(u: Pick<PullSetting, 'intervalSeconds' | 'paused'>) {
    this.pull = { ...this.pull, ...u, updatedAt: new Date().toISOString() };
    return { ...this.pull };
  }
  async putConfig(cfg: PortalConfig) {
    this.config = structuredClone(cfg);
  }
  async recordView(id: string, at: string) {
    const v = this.views.get(id) ?? [];
    v.push(at);
    this.views.set(id, v);
  }
  async countViews(id: string) {
    return this.views.get(id)?.length ?? 0;
  }
}
