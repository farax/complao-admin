import type { LogEvent, EventType, StepStatus } from './types';

const EVENT_TYPES: EventType[] = ['action_start', 'step', 'action_end'];
const STATUSES: StepStatus[] = ['success', 'failure', 'skipped'];
const TRACE_ID = /^[0-9a-f]{32}$/;

/**
 * Detail keys that must never reach the store (R3). Services should not send them,
 * but the ingester strips them as a second line of defence.
 */
const FORBIDDEN_DETAIL_KEYS = /(^|_)(name|email|prompt|response_body|completion|content|document|text|address|phone)s?$/i;

export interface ParseResult {
  event?: LogEvent;
  error?: string;
}

/**
 * Parse one CloudWatch log message into a LogEvent. Messages may carry a runtime prefix
 * (Lambda writes "2026-11-13T01:31:00.000Z <requestId> INFO {...}"), so we read from the first "{".
 */
export function parseLogMessage(message: string): ParseResult {
  const start = message.indexOf('{');
  if (start < 0) return { error: 'not json' };
  let raw: unknown;
  try {
    raw = JSON.parse(message.slice(start).trim());
  } catch {
    return { error: 'invalid json' };
  }
  return validateEvent(raw);
}

export function validateEvent(raw: unknown): ParseResult {
  if (!raw || typeof raw !== 'object') return { error: 'not an object' };
  const r = raw as Record<string, unknown>;
  const eventType = r.event_type as EventType;
  if (!EVENT_TYPES.includes(eventType)) return { error: 'bad event_type' };

  const actionId = String(r.action_id ?? '').toLowerCase();
  if (!TRACE_ID.test(actionId) || /^0+$/.test(actionId)) return { error: 'bad action_id' };

  const component = str(r.component);
  if (!component) return { error: 'missing component' };
  const actorId = str(r.actor_id);
  if (!actorId) return { error: 'missing actor_id' };

  const startedAt = toIso(r.started_at);
  if (!startedAt) return { error: 'bad started_at' };

  const ev: LogEvent = {
    event_type: eventType,
    action_id: actionId,
    component,
    actor_id: actorId,
    started_at: startedAt,
    case_id: str(r.case_id) || null,
  };
  const sessionId = str(r.session_id);
  if (sessionId) {
    if (sessionId.length > 128) return { error: 'bad session_id' };
    ev.session_id = sessionId;
  }
  const role = str(r.actor_role);
  if (role) ev.actor_role = role.slice(0, 64);

  if (eventType === 'action_start') {
    const t = str(r.action_type);
    if (!t) return { error: 'missing action_type' };
    ev.action_type = t;
  }

  if (eventType === 'step') {
    const stepId = str(r.step_id);
    const stepName = str(r.step_name);
    if (!stepId) return { error: 'missing step_id' };
    if (!stepName) return { error: 'missing step_name' };
    ev.step_id = stepId;
    ev.step_name = stepName;
    ev.parent_step_id = str(r.parent_step_id) || null;
    if (r.response_code !== undefined && r.response_code !== null) ev.response_code = String(r.response_code);
  }

  if (eventType === 'step' || eventType === 'action_end') {
    const status = r.status as StepStatus;
    if (!STATUSES.includes(status)) return { error: 'bad status' };
    ev.status = status;
    const latency = Number(r.latency_ms);
    if (!Number.isFinite(latency) || latency < 0) return { error: 'bad latency_ms' };
    ev.latency_ms = Math.round(latency);
  }

  if (r.action_type && !ev.action_type) ev.action_type = str(r.action_type);
  if (r.details && typeof r.details === 'object' && !Array.isArray(r.details)) {
    ev.details = sanitizeDetails(r.details as Record<string, unknown>);
  }
  return { event: ev };
}

/** Keep only scalar values and arrays of scalars; drop keys that look like personal data or content. */
export function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if (FORBIDDEN_DETAIL_KEYS.test(k)) continue;
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
      if (typeof v === 'string' && v.length > 200) continue; // long strings are content, not codes
      out[k] = v;
    } else if (Array.isArray(v) && v.every((x) => ['string', 'number'].includes(typeof x))) {
      out[k] = v.slice(0, 50);
    }
  }
  return out;
}

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v).trim();
}

function toIso(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
