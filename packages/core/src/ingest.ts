import { aiCostUsd, dayOf, isServerFailure, tokenCounts, windowOf } from './rules';
import type { ActionStore } from './store';
import { LOGIN_ACTION_TYPES, LOGOUT_ACTION_TYPES, type LogEvent, type PortalConfig, type StepRecord } from './types';

export interface IngestStats {
  events: number;
  newSteps: number;
  duplicateSteps: number;
  starts: number;
  ends: number;
}

/**
 * Write a batch of parsed events into the action store (section 6.3).
 * Safe to call with overlapping batches: steps are keyed by action ID + start + step ID,
 * and summary counters only move for steps not seen before.
 */
export async function ingestEvents(store: ActionStore, events: LogEvent[], cfg: PortalConfig): Promise<IngestStats> {
  const stats: IngestStats = { events: events.length, newSteps: 0, duplicateSteps: 0, starts: 0, ends: 0 };
  const seenComponents = new Set<string>();
  const seenTypes = new Set<string>();
  const seenRoles = new Set<string>();

  // Starts first, then steps, then ends, so a batch holding a whole action lands in order.
  const order = { action_start: 0, step: 1, action_end: 2 } as const;
  const sorted = [...events].sort((a, b) => order[a.event_type] - order[b.event_type] || a.started_at.localeCompare(b.started_at));

  for (const ev of sorted) {
    if (!seenComponents.has(ev.component)) {
      seenComponents.add(ev.component);
      await store.register('component', ev.component);
    }
    if (ev.actor_role && !seenRoles.has(ev.actor_role)) {
      seenRoles.add(ev.actor_role);
      await store.register('role', ev.actor_role);
    }
    const who = { sessionId: ev.session_id ?? null, actorRole: ev.actor_role ?? null };
    const completedAt = new Date(new Date(ev.started_at).getTime() + (ev.latency_ms ?? 0)).toISOString();
    // R22: every event with a session ID extends that session.
    if (ev.session_id) {
      const isStart = ev.event_type === 'action_start';
      await store.touchSession({
        sessionId: ev.session_id,
        actorId: ev.actor_id,
        actorRole: ev.actor_role ?? null,
        at: completedAt,
        actionId: ev.action_id,
        caseId: ev.case_id ?? null,
        failed: (ev.event_type === 'step' || ev.event_type === 'action_end') && ev.status === 'failure',
        login: isStart && LOGIN_ACTION_TYPES.includes(ev.action_type ?? ''),
        logout: isStart && LOGOUT_ACTION_TYPES.includes(ev.action_type ?? ''),
      });
    }

    if (ev.event_type === 'action_start') {
      stats.starts++;
      if (ev.action_type && !seenTypes.has(ev.action_type)) {
        seenTypes.add(ev.action_type);
        await store.register('type', ev.action_type);
      }
      await store.applyActionStart({
        ...who,
        actionId: ev.action_id,
        actionType: ev.action_type!,
        actorId: ev.actor_id,
        caseId: ev.case_id ?? null,
        component: ev.component,
        startedAt: ev.started_at,
      });
      continue;
    }

    if (ev.event_type === 'action_end') {
      stats.ends++;
      const endedAt = completedAt;
      await store.applyActionEnd({
        ...who,
        actionId: ev.action_id,
        actorId: ev.actor_id,
        caseId: ev.case_id ?? null,
        component: ev.component,
        startedAt: ev.started_at,
        endedAt,
        latencyMs: ev.latency_ms ?? 0,
        status: ev.status!,
      });
      continue;
    }

    // step
    const details = ev.details ?? {};
    const cost = aiCostUsd(details, cfg.prices);
    const tokens = tokenCounts(details);
    const responseCode = ev.response_code === undefined ? null : String(ev.response_code);
    const serverFailure = isServerFailure(ev.status!, responseCode, cfg.serverErrorMinCode);
    const step: StepRecord = {
      actionId: ev.action_id,
      stepId: ev.step_id!,
      parentStepId: ev.parent_step_id ?? null,
      stepName: ev.step_name!,
      component: ev.component,
      startedAt: ev.started_at,
      latencyMs: ev.latency_ms ?? 0,
      status: ev.status!,
      responseCode,
      actorId: ev.actor_id,
      caseId: ev.case_id ?? null,
      details,
      aiCostUsd: cost,
      serverFailure,
    };
    const isNew = await store.putStep(step);
    if (isNew) stats.newSteps++;
    else stats.duplicateSteps++;

    await store.touchActionFromStep({
      ...who,
      step,
      isNew,
      completedAt,
      ai: cost === null ? null : { costUsd: cost, tokensIn: tokens.input, tokensOut: tokens.output },
    });

    if (isNew) {
      await store.addHealth(step.component, windowOf(step.startedAt), step.latencyMs, step.status === 'failure', serverFailure);
      if (cost !== null) await store.addCost(dayOf(step.startedAt), cost, tokens.input, tokens.output);
    }
  }
  return stats;
}
