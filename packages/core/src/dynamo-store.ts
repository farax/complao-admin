import { DynamoDBClient, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { bucketIndex, emptyBuckets } from './histogram';
import { dayOf } from './rules';
import type { ActionEndInput, ActionStartInput, ActionStore, Page, RangeQuery, RegistryKind, SessionTouch, StepTouch, Who } from './store';
import { mergeConfig } from './store';
import { DEFAULT_CONFIG, DEFAULT_PULL } from './types';
import type { ActionRecord, CostDay, HealthWindow, PortalConfig, PullSetting, SessionRecord, StepRecord } from './types';

/**
 * Appendix B key design, one table:
 *
 *  Item              pk                     sk                         GSI
 *  Action header     A#<actionId>           #H                         gsi1: D#<day> / <startedAt>#<id>   (action list)
 *                                                                      gsi2: K#<caseId> / <startedAt>#<id> (journeys)
 *  Step              A#<actionId>           S#<startedAt>#<stepId>     gsi3: C#<component>#<day> / <startedAt>#<actionId>#<stepId>
 *  Health summary    H#<component>          W#<windowStart>
 *  AI cost per day   COST                   D#<day>
 *  Registry          REG                    T#<type> | C#<component>
 *  Pull setting      SETTINGS               pull
 *  Portal config     SETTINGS               config
 *  Checkpoint        SETTINGS               CKPT#<logGroup>
 *  View record (R16) V#<actionId>           <viewedAt>#<rand>
 *  Session (R22)     SS#<sessionId>         #H                         gsi1: SD#<day> / <startedAt>#<id>  (sessions list)
 *  (action header, continued)                                          gsi4: SN#<sessionId> / <startedAt>#<id> (session detail)
 */
const REG_PREFIX: Record<RegistryKind, string> = { type: 'T#', component: 'C#', role: 'R#' };

export const KEYS = {
  action: (id: string) => ({ pk: `A#${id}`, sk: '#H' }),
  step: (s: { actionId: string; startedAt: string; stepId: string }) => ({ pk: `A#${s.actionId}`, sk: `S#${s.startedAt}#${s.stepId}` }),
  health: (c: string, w: string) => ({ pk: `H#${c}`, sk: `W#${w}` }),
  cost: (d: string) => ({ pk: 'COST', sk: `D#${d}` }),
  settings: (name: string) => ({ pk: 'SETTINGS', sk: name }),
};

export interface DynamoStoreOptions {
  tableName: string;
  client?: DynamoDBClient;
  endpoint?: string;
  region?: string;
}

export class DynamoStore implements ActionStore {
  readonly table: string;
  readonly doc: DynamoDBDocumentClient;
  private registered = new Set<string>();

  constructor(opts: DynamoStoreOptions) {
    this.table = opts.tableName;
    const client = opts.client ?? new DynamoDBClient({ endpoint: opts.endpoint, region: opts.region });
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
    });
  }

  // ---------------- ingestion writes ----------------

  async putStep(step: StepRecord): Promise<boolean> {
    const day = dayOf(step.startedAt);
    const res = await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          ...KEYS.step(step),
          entity: 'step',
          ...step,
          gsi3pk: `C#${step.component}#${day}`,
          gsi3sk: `${step.startedAt}#${step.actionId}#${step.stepId}`,
        },
        ReturnValues: 'ALL_OLD',
      }),
    );
    return !res.Attributes;
  }

  async applyActionStart(i: ActionStartInput) {
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {
      ':id': i.actionId,
      ':type': i.actionType,
      ':st': i.startedAt,
      ':actor': i.actorId,
      ':g1': `D#${dayOf(i.startedAt)}`,
      ':g1s': `${i.startedAt}#${i.actionId}`,
      ':t': true,
      ':f': false,
      ':comp': new Set([i.component]),
      ':e': 'action',
    };
    const set = [
      'entity = :e',
      'actionId = :id',
      'actionType = :type',
      'startedAt = :st',
      'actorId = :actor',
      'hasStart = :t',
      'hasEnd = if_not_exists(hasEnd, :f)',
      'gsi1pk = :g1',
      'gsi1sk = :g1s',
      'lastEventAt = if_not_exists(lastEventAt, :st)',
    ];
    this.who(set, values, i, true);
    if (i.caseId) {
      values[':case'] = i.caseId;
      values[':g2'] = `K#${i.caseId}`;
      set.push('caseId = :case', 'gsi2pk = :g2', 'gsi2sk = :g1s');
    } else {
      // keep gsi2sk aligned with the authoritative start time if a step already set the case
      set.push('gsi2sk = :g1s');
    }
    await this.update(KEYS.action(i.actionId), `SET ${set.join(', ')} ADD components :comp`, values, names);
    await this.bumpLastEvent(i.actionId, i.startedAt);
  }

  async applyActionEnd(i: ActionEndInput) {
    const values: Record<string, unknown> = {
      ':id': i.actionId,
      ':t': true,
      ':f': false,
      ':end': i.endedAt,
      ':lat': i.latencyMs,
      ':status': i.status,
      ':st': i.startedAt,
      ':actor': i.actorId,
      ':g1': `D#${dayOf(i.startedAt)}`,
      ':g1s': `${i.startedAt}#${i.actionId}`,
      ':comp': new Set([i.component]),
      ':e': 'action',
    };
    const set = [
      'entity = :e',
      'actionId = :id',
      'hasEnd = :t',
      'hasStart = if_not_exists(hasStart, :f)',
      'endedAt = :end',
      'latencyMs = :lat',
      'endStatus = :status',
      'startedAt = if_not_exists(startedAt, :st)',
      'actorId = if_not_exists(actorId, :actor)',
      'gsi1pk = if_not_exists(gsi1pk, :g1)',
      'gsi1sk = if_not_exists(gsi1sk, :g1s)',
    ];
    this.who(set, values, i, false);
    if (i.caseId) {
      values[':case'] = i.caseId;
      values[':g2'] = `K#${i.caseId}`;
      set.push('caseId = if_not_exists(caseId, :case)', 'gsi2pk = if_not_exists(gsi2pk, :g2)', 'gsi2sk = if_not_exists(gsi2sk, :g1s)');
    }
    await this.update(KEYS.action(i.actionId), `SET ${set.join(', ')} ADD components :comp`, values);
    await this.bumpLastEvent(i.actionId, i.endedAt);
  }

  async touchActionFromStep({ step, isNew, completedAt, ai, sessionId, actorRole }: StepTouch) {
    const values: Record<string, unknown> = {
      ':id': step.actionId,
      ':st': step.startedAt,
      ':actor': step.actorId,
      ':f': false,
      ':g1': `D#${dayOf(step.startedAt)}`,
      ':g1s': `${step.startedAt}#${step.actionId}`,
      ':sid': new Set([step.stepId]),
      ':comp': new Set([step.component]),
      ':e': 'action',
    };
    const set = [
      'entity = :e',
      'actionId = :id',
      'startedAt = if_not_exists(startedAt, :st)',
      'actorId = if_not_exists(actorId, :actor)',
      'hasStart = if_not_exists(hasStart, :f)',
      'hasEnd = if_not_exists(hasEnd, :f)',
      'gsi1pk = if_not_exists(gsi1pk, :g1)',
      'gsi1sk = if_not_exists(gsi1sk, :g1s)',
      'lastEventAt = if_not_exists(lastEventAt, :st)',
    ];
    this.who(set, values, { sessionId, actorRole }, false);
    const add = ['stepIds :sid', 'components :comp'];
    if (step.caseId) {
      values[':case'] = step.caseId;
      values[':g2'] = `K#${step.caseId}`;
      set.push('caseId = if_not_exists(caseId, :case)', 'gsi2pk = if_not_exists(gsi2pk, :g2)', 'gsi2sk = if_not_exists(gsi2sk, :g1s)');
    }
    if (step.parentStepId) {
      values[':pid'] = new Set([step.parentStepId]);
      add.push('parentIds :pid');
    }
    if (step.status === 'failure') add.push('failedStepIds :sid');
    if (isNew && ai) {
      values[':cost'] = ai.costUsd;
      values[':one'] = 1;
      values[':tin'] = ai.tokensIn;
      values[':tout'] = ai.tokensOut;
      add.push('aiCostUsd :cost', 'aiCalls :one', 'tokensIn :tin', 'tokensOut :tout');
    }
    await this.update(KEYS.action(step.actionId), `SET ${set.join(', ')} ADD ${add.join(', ')}`, values);
    await this.bumpLastEvent(step.actionId, completedAt);
  }

  /** Session and role on the action header, plus the session index (gsi4). The start event is authoritative. */
  private who(set: string[], values: Record<string, unknown>, w: Who, authoritative: boolean) {
    const v = (expr: string, name: string) => (authoritative ? `${name} = ${expr}` : `${name} = if_not_exists(${name}, ${expr})`);
    if (w.sessionId) {
      values[':sess'] = w.sessionId;
      values[':g4'] = `SN#${w.sessionId}`;
      set.push(v(':sess', 'sessionId'), v(':g4', 'gsi4pk'), v(':g1s', 'gsi4sk'));
    }
    if (w.actorRole) {
      values[':role'] = w.actorRole;
      set.push(v(':role', 'actorRole'));
    }
  }

  async touchSession(t: SessionTouch) {
    const key = { pk: `SS#${t.sessionId}`, sk: '#H' };
    const values: Record<string, unknown> = {
      ':e': 'session',
      ':id': t.sessionId,
      ':actor': t.actorId,
      ':at': t.at,
      ':g1': `SD#${dayOf(t.at)}`,
      ':g1s': `${t.at}#${t.sessionId}`,
      ':a': new Set([t.actionId]),
    };
    const set = [
      'entity = :e',
      'sessionId = :id',
      'actorId = if_not_exists(actorId, :actor)',
      'startedAt = if_not_exists(startedAt, :at)',
      'lastEventAt = if_not_exists(lastEventAt, :at)',
      'gsi1pk = if_not_exists(gsi1pk, :g1)',
      'gsi1sk = if_not_exists(gsi1sk, :g1s)',
      t.login ? 'hasLogin = :t' : 'hasLogin = if_not_exists(hasLogin, :f)',
    ];
    if (t.login) values[':t'] = true;
    else values[':f'] = false;
    const add = ['actionIds :a'];
    if (t.actorRole) {
      values[':role'] = t.actorRole;
      set.push('actorRole = if_not_exists(actorRole, :role)');
    }
    if (t.caseId) {
      values[':c'] = new Set([t.caseId]);
      add.push('caseIds :c');
    }
    if (t.failed) add.push('failedActionIds :a');
    await this.update(key, `SET ${set.join(', ')} ADD ${add.join(', ')}`, values);
    // Earliest start and latest activity, whatever order events arrive in.
    await this.conditional(key, 'SET startedAt = :at, gsi1pk = :g1, gsi1sk = :g1s', 'startedAt > :at', { ':at': t.at, ':g1': values[':g1'], ':g1s': values[':g1s'] });
    await this.conditional(key, 'SET lastEventAt = :at', 'lastEventAt < :at', { ':at': t.at });
    if (t.logout) await this.conditional(key, 'SET loggedOutAt = :at', 'attribute_not_exists(loggedOutAt) OR loggedOutAt < :at', { ':at': t.at });
  }

  private async conditional(key: Record<string, string>, expr: string, cond: string, values: Record<string, unknown>) {
    try {
      await this.doc.send(new UpdateCommand({ TableName: this.table, Key: key, UpdateExpression: expr, ConditionExpression: cond, ExpressionAttributeValues: values }));
    } catch (e) {
      if ((e as Error).name !== 'ConditionalCheckFailedException') throw e;
    }
  }

  private async bumpLastEvent(actionId: string, iso: string) {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: KEYS.action(actionId),
          UpdateExpression: 'SET lastEventAt = :t',
          ConditionExpression: 'attribute_not_exists(lastEventAt) OR lastEventAt < :t',
          ExpressionAttributeValues: { ':t': iso },
        }),
      );
    } catch (e) {
      if (!(e instanceof ConditionalCheckFailedException) && (e as Error).name !== 'ConditionalCheckFailedException') throw e;
    }
  }

  async addHealth(component: string, windowStart: string, ms: number, failure: boolean, serverFailure: boolean) {
    const b = bucketIndex(ms);
    await this.update(
      KEYS.health(component, windowStart),
      `SET component = :c, windowStart = :w, entity = :e ADD #count :one, sumMs :ms, failures :f, serverFailures :sf, h${b} :one`,
      { ':c': component, ':w': windowStart, ':e': 'health', ':one': 1, ':ms': ms, ':f': failure ? 1 : 0, ':sf': serverFailure ? 1 : 0 },
      { '#count': 'count' },
    );
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: KEYS.health(component, windowStart),
          UpdateExpression: 'SET maxMs = :ms',
          ConditionExpression: 'attribute_not_exists(maxMs) OR maxMs < :ms',
          ExpressionAttributeValues: { ':ms': ms },
        }),
      );
    } catch (e) {
      if ((e as Error).name !== 'ConditionalCheckFailedException') throw e;
    }
  }

  async addCost(day: string, costUsd: number, tokensIn: number, tokensOut: number) {
    await this.update(
      KEYS.cost(day),
      'SET #day = :d, entity = :e ADD costUsd :c, calls :one, tokensIn :ti, tokensOut :to',
      { ':d': day, ':e': 'cost', ':c': costUsd, ':one': 1, ':ti': tokensIn, ':to': tokensOut },
      { '#day': 'day' },
    );
  }

  async register(kind: RegistryKind, value: string) {
    const sk = `${REG_PREFIX[kind]}${value}`;
    if (this.registered.has(sk)) return;
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { pk: 'REG', sk, kind, value } }));
    this.registered.add(sk);
  }

  async getCheckpoint(logGroup: string) {
    const r = await this.doc.send(new GetCommand({ TableName: this.table, Key: KEYS.settings(`CKPT#${logGroup}`) }));
    return (r.Item?.checkpointMs as number) ?? null;
  }

  async putCheckpoint(logGroup: string, ms: number) {
    await this.doc.send(
      new PutCommand({ TableName: this.table, Item: { ...KEYS.settings(`CKPT#${logGroup}`), logGroup, checkpointMs: ms, updatedAt: new Date().toISOString() } }),
    );
  }

  async recordPull(update: Partial<PullSetting>) {
    // Ingestion only writes run results, never the founder's interval or pause choice.
    const allowed: (keyof PullSetting)[] = ['lastPullAt', 'lastSuccessAt', 'lastError', 'lastEventsIngested'];
    const entries = Object.entries(update).filter(([k]) => allowed.includes(k as keyof PullSetting));
    if (!entries.length) return;
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const set = entries.map(([k, v], i) => {
      names[`#k${i}`] = k;
      values[`:v${i}`] = v;
      return `#k${i} = :v${i}`;
    });
    await this.update(KEYS.settings('run'), `SET ${set.join(', ')}`, values, names);
  }

  // ---------------- portal reads ----------------

  async getAction(id: string) {
    const r = await this.doc.send(new GetCommand({ TableName: this.table, Key: KEYS.action(id) }));
    return r.Item ? toAction(r.Item) : null;
  }

  async getActions(ids: string[]) {
    const out: ActionRecord[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      let keys = ids.slice(i, i + 100).map((id) => KEYS.action(id));
      for (let attempt = 0; keys.length && attempt < 5; attempt++) {
        const r = await this.doc.send(new BatchGetCommand({ RequestItems: { [this.table]: { Keys: keys } } }));
        out.push(...(r.Responses?.[this.table] ?? []).map(toAction));
        keys = (r.UnprocessedKeys?.[this.table]?.Keys as typeof keys) ?? [];
      }
    }
    return out;
  }

  async getSteps(actionId: string) {
    const items = await this.queryAll({
      TableName: this.table,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :s)',
      ExpressionAttributeValues: { ':pk': `A#${actionId}`, ':s': 'S#' },
    });
    return items.map(toStep);
  }

  async queryActionsByDay(day: string, q: RangeQuery): Promise<Page<ActionRecord>> {
    const r = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :d AND gsi1sk BETWEEN :a AND :b',
        ExpressionAttributeValues: { ':d': `D#${day}`, ':a': q.fromIso, ':b': `${q.toIso}~` },
        ScanIndexForward: q.newestFirst === false,
        Limit: q.limit,
        ExclusiveStartKey: (q.next as Record<string, unknown>) ?? undefined,
      }),
    );
    return { items: (r.Items ?? []).map(toAction), next: r.LastEvaluatedKey ?? null };
  }

  async queryActionsByCase(caseId: string) {
    const items = await this.queryAll({
      TableName: this.table,
      IndexName: 'gsi2',
      KeyConditionExpression: 'gsi2pk = :k',
      ExpressionAttributeValues: { ':k': `K#${caseId}` },
    });
    return items.map(toAction).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async queryStepsByComponentDay(component: string, day: string, q: RangeQuery): Promise<Page<StepRecord>> {
    const r = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: 'gsi3',
        KeyConditionExpression: 'gsi3pk = :c AND gsi3sk BETWEEN :a AND :b',
        ExpressionAttributeValues: { ':c': `C#${component}#${day}`, ':a': q.fromIso, ':b': `${q.toIso}~` },
        ScanIndexForward: q.newestFirst === false,
        Limit: q.limit,
        ExclusiveStartKey: (q.next as Record<string, unknown>) ?? undefined,
      }),
    );
    return { items: (r.Items ?? []).map(toStep), next: r.LastEvaluatedKey ?? null };
  }

  async getHealthWindows(component: string, fromIso: string, toIso: string): Promise<HealthWindow[]> {
    const items = await this.queryAll({
      TableName: this.table,
      KeyConditionExpression: 'pk = :pk AND sk BETWEEN :a AND :b',
      ExpressionAttributeValues: { ':pk': `H#${component}`, ':a': `W#${fromIso}`, ':b': `W#${toIso}` },
    });
    return items.map((it) => {
      const buckets = emptyBuckets();
      for (const [k, v] of Object.entries(it)) {
        const m = /^h(\d+)$/.exec(k);
        if (m) buckets[Number(m[1])] = Number(v);
      }
      return {
        component,
        windowStart: String(it.windowStart),
        count: Number(it.count ?? 0),
        failures: Number(it.failures ?? 0),
        serverFailures: Number(it.serverFailures ?? 0),
        maxMs: Number(it.maxMs ?? 0),
        sumMs: Number(it.sumMs ?? 0),
        buckets,
      };
    });
  }

  async getCostDays(fromDay: string, toDay: string): Promise<CostDay[]> {
    const items = await this.queryAll({
      TableName: this.table,
      KeyConditionExpression: 'pk = :pk AND sk BETWEEN :a AND :b',
      ExpressionAttributeValues: { ':pk': 'COST', ':a': `D#${fromDay}`, ':b': `D#${toDay}` },
    });
    return items.map((it) => ({
      day: String(it.day),
      costUsd: Number(it.costUsd ?? 0),
      calls: Number(it.calls ?? 0),
      tokensIn: Number(it.tokensIn ?? 0),
      tokensOut: Number(it.tokensOut ?? 0),
    }));
  }

  async listRegistry(kind: RegistryKind) {
    const items = await this.queryAll({
      TableName: this.table,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
      ExpressionAttributeValues: { ':pk': 'REG', ':p': REG_PREFIX[kind] },
    });
    return items.map((i) => String(i.value)).sort();
  }

  async getSession(id: string) {
    const r = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: `SS#${id}`, sk: '#H' } }));
    return r.Item ? toSession(r.Item) : null;
  }

  async querySessionsByDay(day: string, q: RangeQuery): Promise<Page<SessionRecord>> {
    const r = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :d AND gsi1sk BETWEEN :a AND :b',
        ExpressionAttributeValues: { ':d': `SD#${day}`, ':a': q.fromIso, ':b': `${q.toIso}~` },
        ScanIndexForward: q.newestFirst === false,
        Limit: q.limit,
        ExclusiveStartKey: (q.next as Record<string, unknown>) ?? undefined,
      }),
    );
    return { items: (r.Items ?? []).map(toSession), next: r.LastEvaluatedKey ?? null };
  }

  async queryActionsBySession(id: string) {
    const items = await this.queryAll({
      TableName: this.table,
      IndexName: 'gsi4',
      KeyConditionExpression: 'gsi4pk = :k',
      ExpressionAttributeValues: { ':k': `SN#${id}` },
    });
    return items.map(toAction).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.actionId.localeCompare(b.actionId));
  }

  async getPull(): Promise<PullSetting> {
    const [setting, run] = await Promise.all([
      this.doc.send(new GetCommand({ TableName: this.table, Key: KEYS.settings('pull') })),
      this.doc.send(new GetCommand({ TableName: this.table, Key: KEYS.settings('run') })),
    ]);
    const s = setting.Item ?? {};
    const r = run.Item ?? {};
    return {
      ...DEFAULT_PULL,
      intervalSeconds: Number(s.intervalSeconds ?? DEFAULT_PULL.intervalSeconds),
      paused: Boolean(s.paused ?? false),
      updatedAt: (s.updatedAt as string) ?? null,
      lastPullAt: (r.lastPullAt as string) ?? null,
      lastSuccessAt: (r.lastSuccessAt as string) ?? null,
      lastError: (r.lastError as string) ?? null,
      lastEventsIngested: Number(r.lastEventsIngested ?? 0),
    };
  }

  async getConfig(): Promise<PortalConfig> {
    const r = await this.doc.send(new GetCommand({ TableName: this.table, Key: KEYS.settings('config') }));
    return mergeConfig(DEFAULT_CONFIG, (r.Item?.value as Partial<PortalConfig>) ?? undefined);
  }

  // ---------------- portal writes ----------------

  async putPullSetting(u: Pick<PullSetting, 'intervalSeconds' | 'paused'>) {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { ...KEYS.settings('pull'), intervalSeconds: u.intervalSeconds, paused: u.paused, updatedAt: new Date().toISOString() },
      }),
    );
    return this.getPull();
  }

  async putConfig(cfg: PortalConfig) {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { ...KEYS.settings('config'), value: cfg, updatedAt: new Date().toISOString() } }));
  }

  async recordView(actionId: string, atIso: string) {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { pk: `V#${actionId}`, sk: `${atIso}#${Math.random().toString(36).slice(2, 8)}`, actionId, viewedAt: atIso, entity: 'view' },
      }),
    );
  }

  async countViews(actionId: string) {
    const r = await this.doc.send(
      new QueryCommand({ TableName: this.table, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': `V#${actionId}` }, Select: 'COUNT' }),
    );
    return r.Count ?? 0;
  }

  // ---------------- helpers ----------------

  private async update(key: Record<string, string>, expr: string, values: Record<string, unknown>, names?: Record<string, string>) {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: key,
        UpdateExpression: expr,
        ExpressionAttributeValues: values,
        ExpressionAttributeNames: names && Object.keys(names).length ? names : undefined,
      }),
    );
  }

  private async queryAll(input: QueryCommandInput): Promise<Record<string, any>[]> {
    const out: Record<string, any>[] = [];
    let start: Record<string, any> | undefined;
    do {
      const r = await this.doc.send(new QueryCommand({ ...input, ExclusiveStartKey: start }));
      out.push(...(r.Items ?? []));
      start = r.LastEvaluatedKey;
    } while (start);
    return out;
  }
}

function arr(v: unknown): string[] {
  if (!v) return [];
  if (v instanceof Set) return [...v].map(String);
  if (Array.isArray(v)) return v.map(String);
  return [];
}

function toAction(it: Record<string, any>): ActionRecord {
  return {
    actionId: it.actionId,
    actionType: it.actionType ?? null,
    actorId: it.actorId ?? null,
    actorRole: it.actorRole ?? null,
    sessionId: it.sessionId ?? null,
    caseId: it.caseId ?? null,
    startedAt: it.startedAt,
    hasStart: Boolean(it.hasStart),
    hasEnd: Boolean(it.hasEnd),
    endedAt: it.endedAt ?? null,
    latencyMs: it.latencyMs ?? null,
    endStatus: it.endStatus ?? null,
    lastEventAt: it.lastEventAt ?? it.startedAt,
    stepIds: arr(it.stepIds),
    parentIds: arr(it.parentIds),
    failedStepIds: arr(it.failedStepIds),
    components: arr(it.components),
    aiCostUsd: Number(it.aiCostUsd ?? 0),
    aiCalls: Number(it.aiCalls ?? 0),
    tokensIn: Number(it.tokensIn ?? 0),
    tokensOut: Number(it.tokensOut ?? 0),
  };
}

function toSession(it: Record<string, any>): SessionRecord {
  return {
    sessionId: it.sessionId,
    actorId: it.actorId ?? null,
    actorRole: it.actorRole ?? null,
    startedAt: it.startedAt,
    lastEventAt: it.lastEventAt ?? it.startedAt,
    hasLogin: Boolean(it.hasLogin),
    loggedOutAt: it.loggedOutAt ?? null,
    actionIds: arr(it.actionIds),
    caseIds: arr(it.caseIds),
    failedActionIds: arr(it.failedActionIds),
  };
}

function toStep(it: Record<string, any>): StepRecord {
  return {
    actionId: it.actionId,
    stepId: it.stepId,
    parentStepId: it.parentStepId ?? null,
    stepName: it.stepName,
    component: it.component,
    startedAt: it.startedAt,
    latencyMs: Number(it.latencyMs ?? 0),
    status: it.status,
    responseCode: it.responseCode ?? null,
    actorId: it.actorId,
    caseId: it.caseId ?? null,
    details: it.details ?? {},
    aiCostUsd: it.aiCostUsd ?? null,
    serverFailure: Boolean(it.serverFailure),
  };
}
