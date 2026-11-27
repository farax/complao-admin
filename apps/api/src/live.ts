import {
  daysBetween,
  deriveSessionStatus,
  LOGIN_ACTION_TYPES,
  LOGOUT_ACTION_TYPES,
  type ActionRecord,
  type ActionStatus,
  type ActionStore,
  type PortalConfig,
  type SessionRecord,
  type SessionStatus,
} from '@complao/core/browser';
import { decodeCursor, toRow, walkDays, type ActionRow } from './queries';

/**
 * R22–R24: sessions, the Live view and multi-person journeys.
 *
 * A session ties together one person's visit; a case ties together everyone's work on one
 * audit or registration. Every action carries both, so the same action shows up in the
 * person's session and in the case's lanes.
 */

// ---------------------------------------------------------------- shared lane shapes

export type LaneItemKind = 'action' | 'login' | 'logout';

export interface LaneItem {
  actionId: string;
  actionType: string | null;
  kind: LaneItemKind;
  startedAt: string;
  /** null while the action is still running */
  endedAt: string | null;
  status: ActionStatus;
  incomplete: boolean;
  failedSteps: number;
  sessionId: string | null;
}

export interface Lane {
  actorId: string;
  actorRole: string | null;
  sessionIds: string[];
  items: LaneItem[];
}

export interface LaneGroup {
  /** case ID, or null for activity not tied to a case */
  caseId: string | null;
  /** what kind of case this is, from its action types: "Audit", "CB registration"… */
  kind: string;
  lanes: Lane[];
  failed: number;
  /** actions that went quiet before finishing (R7) */
  stalled: number;
  running: number;
  lastActivityAt: string;
}

const ROLE_ORDER = ['Auditor', 'TIC', 'CB', 'Admin'];
const roleRank = (r: string | null) => {
  const i = ROLE_ORDER.indexOf(r ?? '');
  return i < 0 ? ROLE_ORDER.length : i;
};

const isLogin = (t: string | null) => LOGIN_ACTION_TYPES.includes(t ?? '');
const isLogout = (t: string | null) => LOGOUT_ACTION_TYPES.includes(t ?? '');

function toItem(a: ActionRecord, cfg: PortalConfig, now: number): LaneItem {
  const row = toRow(a, cfg, now);
  return {
    actionId: a.actionId,
    actionType: a.actionType,
    kind: isLogin(a.actionType) ? 'login' : isLogout(a.actionType) ? 'logout' : 'action',
    startedAt: a.startedAt,
    endedAt: a.hasEnd ? (a.endedAt ?? a.lastEventAt) : row.status === 'in_progress' ? null : a.lastEventAt,
    status: row.status,
    incomplete: row.incomplete,
    failedSteps: a.failedStepIds.length,
    sessionId: a.sessionId,
  };
}

/** Name a case from its action types: anything audit-like is an Audit, registrations keep their type. */
export function caseKind(types: (string | null)[]): string {
  const t = types.filter((x): x is string => Boolean(x) && !isLogin(x) && !isLogout(x));
  if (t.some((x) => /audit/i.test(x))) return 'Audit';
  const reg = t.find((x) => /registration/i.test(x));
  if (reg) return reg;
  return t[0] ?? 'Case';
}

function buildLanes(items: { actorId: string; actorRole: string | null; item: LaneItem }[]): Lane[] {
  const lanes = new Map<string, Lane>();
  for (const { actorId, actorRole, item } of items) {
    let lane = lanes.get(actorId);
    if (!lane) lanes.set(actorId, (lane = { actorId, actorRole, sessionIds: [], items: [] }));
    if (!lane.actorRole && actorRole) lane.actorRole = actorRole;
    if (item.sessionId && !lane.sessionIds.includes(item.sessionId)) lane.sessionIds.push(item.sessionId);
    if (!lane.items.some((i) => i.actionId === item.actionId)) lane.items.push(item);
  }
  const out = [...lanes.values()];
  for (const l of out) l.items.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return out.sort((a, b) => roleRank(a.actorRole) - roleRank(b.actorRole) || (a.items[0]?.startedAt ?? '').localeCompare(b.items[0]?.startedAt ?? ''));
}

function groupStats(lanes: Lane[], now: number) {
  let failed = 0,
    stalled = 0,
    running = 0,
    last = '';
  for (const l of lanes)
    for (const i of l.items) {
      if (i.kind === 'action' && (i.status === 'failed' || i.status === 'partial')) failed++;
      if (i.kind === 'action' && i.status === 'stalled') stalled++;
      if (i.endedAt === null) running++;
      const end = i.endedAt ?? new Date(now).toISOString();
      if (end > last) last = end;
    }
  return { failed, stalled, running, lastActivityAt: last };
}

// ---------------------------------------------------------------- sessions (R22)

export interface SessionRow {
  sessionId: string;
  actorId: string | null;
  actorRole: string | null;
  status: SessionStatus;
  startedAt: string;
  lastEventAt: string;
  endedAt: string | null;
  durationMs: number;
  actionCount: number;
  caseIds: string[];
  failedActions: number;
}

export function toSessionRow(s: SessionRecord, cfg: PortalConfig, now = Date.now()): SessionRow {
  const status = deriveSessionStatus(s, cfg, now);
  const end = s.loggedOutAt ?? (status === 'active' || status === 'idle' ? new Date(now).toISOString() : s.lastEventAt);
  return {
    sessionId: s.sessionId,
    actorId: s.actorId,
    actorRole: s.actorRole,
    status,
    startedAt: s.startedAt,
    lastEventAt: s.lastEventAt,
    endedAt: s.loggedOutAt ?? (status === 'expired' ? s.lastEventAt : null),
    durationMs: Math.max(0, new Date(end).getTime() - new Date(s.startedAt).getTime()),
    actionCount: s.actionIds.length,
    caseIds: s.caseIds,
    failedActions: s.failedActionIds.length,
  };
}

export interface SessionFilters {
  from: string;
  to: string;
  statuses?: SessionStatus[];
  roles?: string[];
  actor?: string;
  limit: number;
  cursor?: string;
}

export async function listSessions(store: ActionStore, cfg: PortalConfig, f: SessionFilters, now = Date.now()) {
  const filtered = Boolean(f.statuses?.length || f.roles?.length || f.actor);
  const keep = (s: SessionRecord) => {
    const r = toSessionRow(s, cfg, now);
    return (!f.statuses?.length || f.statuses.includes(r.status)) && (!f.roles?.length || f.roles.includes(r.actorRole ?? '')) && (!f.actor || r.actorId === f.actor);
  };
  const res = await walkDays(
    daysBetween(f.from, f.to),
    (day, next) => store.querySessionsByDay(day, { fromIso: f.from, toIso: f.to, limit: filtered ? 200 : f.limit, next, newestFirst: true }),
    keep,
    f.limit,
    decodeCursor(f.cursor),
  );
  return { items: res.items.map((s) => toSessionRow(s, cfg, now)), cursor: res.cursor };
}

export async function sessionDetail(store: ActionStore, cfg: PortalConfig, sessionId: string, now = Date.now()) {
  const s = await store.getSession(sessionId);
  if (!s) return null;
  const actions = await store.queryActionsBySession(sessionId);
  const rows: (ActionRow & { gapBeforeMs: number | null; kind: LaneItemKind })[] = [];
  let prevEnd: number | null = null;
  for (const a of actions) {
    const row = toRow(a, cfg, now);
    const start = new Date(a.startedAt).getTime();
    rows.push({ ...row, kind: toItem(a, cfg, now).kind, gapBeforeMs: prevEnd === null ? null : Math.max(0, start - prevEnd) });
    const end = start + (row.durationMs ?? row.runningForMs ?? 0);
    prevEnd = prevEnd === null ? end : Math.max(prevEnd, end);
  }
  // What each case is, so the page can say "Audit" rather than a bare ID.
  const cases = await Promise.all(
    s.caseIds.map(async (caseId) => {
      const all = await store.queryActionsByCase(caseId);
      return { caseId, kind: caseKind(all.map((a) => a.actionType)), actionsInSession: actions.filter((a) => a.caseId === caseId).length, totalActions: all.length };
    }),
  );
  return { session: toSessionRow(s, cfg, now), actions: rows, cases };
}

// ---------------------------------------------------------------- live view (R23)

export interface LiveView {
  from: string;
  to: string;
  groups: LaneGroup[];
  stats: { activeSessions: number; idleSessions: number; people: number; running: number; failed: number; cases: number };
  sessions: SessionRow[];
}

/**
 * Everything that happened in the last `minutes`, grouped by case and then by person.
 * Logins and sign-outs sit in the lanes of every case their session touched; activity
 * that touched no case goes in one "other" group.
 */
export async function liveView(store: ActionStore, cfg: PortalConfig, minutes: number, now = Date.now()): Promise<LiveView> {
  const to = new Date(now).toISOString();
  const from = new Date(now - minutes * 60_000).toISOString();
  // Long-running actions may have started before the window, so read a little further back.
  const lookback = new Date(now - (minutes + 120) * 60_000).toISOString();

  const actionsRes = await walkDays(
    daysBetween(lookback, to),
    (day, next) => store.queryActionsByDay(day, { fromIso: lookback, toIso: to, limit: 1000, next, newestFirst: true }),
    (a: ActionRecord) => a.lastEventAt >= from || (!a.hasEnd && toRow(a, cfg, now).status === 'in_progress'),
    5000,
    null,
    20_000,
  );
  const sessionsRes = await walkDays(
    daysBetween(new Date(now - 24 * 3_600_000).toISOString(), to),
    (day, next) => store.querySessionsByDay(day, { fromIso: new Date(now - 24 * 3_600_000).toISOString(), toIso: to, limit: 1000, next, newestFirst: true }),
    (s: SessionRecord) => s.lastEventAt >= from || deriveSessionStatus(s, cfg, now) === 'active',
    2000,
    null,
    10_000,
  );
  const sessions = new Map(sessionsRes.items.map((s) => [s.sessionId, s]));

  // Case kinds come from all of a case's actions, not only those in the window.
  const caseIds = [...new Set(actionsRes.items.map((a) => a.caseId).filter((c): c is string => Boolean(c)))];
  const kinds = new Map<string, string>();
  await Promise.all(
    caseIds.map(async (c) => {
      const all = await store.queryActionsByCase(c);
      kinds.set(c, caseKind(all.map((a) => a.actionType)));
    }),
  );

  const byCase = new Map<string | null, { actorId: string; actorRole: string | null; item: LaneItem }[]>();
  const push = (key: string | null, a: ActionRecord, item: LaneItem) => {
    const list = byCase.get(key) ?? [];
    list.push({ actorId: a.actorId ?? 'unknown', actorRole: a.actorRole, item });
    byCase.set(key, list);
  };
  for (const a of actionsRes.items) {
    const item = toItem(a, cfg, now);
    if (a.caseId) push(a.caseId, a, item);
    else {
      // A login has no case; show it in each case its session went on to touch.
      const touched = (a.sessionId ? sessions.get(a.sessionId)?.caseIds : undefined)?.filter((c) => caseIds.includes(c)) ?? [];
      if (touched.length) touched.forEach((c) => push(c, a, item));
      else push(null, a, item);
    }
  }

  const groups: LaneGroup[] = [...byCase.entries()].map(([caseId, items]) => {
    const lanes = buildLanes(items);
    return { caseId, kind: caseId ? (kinds.get(caseId) ?? 'Case') : 'Other activity', lanes, ...groupStats(lanes, now) };
  });
  // Cases with a problem (failed, partial or stalled) first, then the most recently active.
  groups.sort((a, b) => Number(a.caseId === null) - Number(b.caseId === null) || Number(b.failed + b.stalled > 0) - Number(a.failed + a.stalled > 0) || b.lastActivityAt.localeCompare(a.lastActivityAt));

  const sessionRows = [...sessions.values()].map((s) => toSessionRow(s, cfg, now));
  const people = new Set(sessionRows.filter((s) => s.status === 'active' || s.status === 'idle').map((s) => s.actorId));
  return {
    from,
    to,
    groups,
    sessions: sessionRows.sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt)),
    stats: {
      activeSessions: sessionRows.filter((s) => s.status === 'active').length,
      idleSessions: sessionRows.filter((s) => s.status === 'idle').length,
      people: people.size,
      running: groups.reduce((n, g) => n + g.running, 0),
      failed: groups.reduce((n, g) => n + g.failed, 0),
      cases: groups.filter((g) => g.caseId).length,
    },
  };
}

// ---------------------------------------------------------------- journey lanes (R24)

/** Everyone who worked on a case, one lane each, with the logins of the sessions they used. */
export async function caseLanes(store: ActionStore, cfg: PortalConfig, caseId: string, now = Date.now()) {
  const actions = await store.queryActionsByCase(caseId);
  const items: { actorId: string; actorRole: string | null; item: LaneItem }[] = actions.map((a) => ({ actorId: a.actorId ?? 'unknown', actorRole: a.actorRole, item: toItem(a, cfg, now) }));
  const sessionIds = [...new Set(actions.map((a) => a.sessionId).filter((s): s is string => Boolean(s)))];
  const sessionActions = await Promise.all(sessionIds.map((s) => store.queryActionsBySession(s)));
  for (const list of sessionActions)
    for (const a of list) if (!a.caseId && (isLogin(a.actionType) || isLogout(a.actionType))) items.push({ actorId: a.actorId ?? 'unknown', actorRole: a.actorRole, item: toItem(a, cfg, now) });
  const lanes = buildLanes(items);
  const all = lanes.flatMap((l) => l.items);
  const first = all.reduce((m, i) => (i.startedAt < m ? i.startedAt : m), all[0]?.startedAt ?? new Date(now).toISOString());
  const last = all.reduce((m, i) => {
    const e = i.endedAt ?? new Date(now).toISOString();
    return e > m ? e : m;
  }, first);
  return { kind: caseKind(actions.map((a) => a.actionType)), lanes, from: first, to: last, sessions: sessionIds.length };
}
