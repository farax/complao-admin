import type { ActionStore } from '@complao/core';
import { DEFAULT_OPTIONS, pullOnce, runInvocation, type LogSource } from '@complao/ingest/puller';
import { cached, type NameResolver } from '../names';
import { audit, auditWithDroppedEvent, buildRoster, login, registrationJourney, rng, testAction, type Emitted } from './simulator';

/**
 * Demo mode: a fake CloudWatch log group fed by the simulator, read by the real puller
 * (same checkpoint, overlap and pause logic as the Lambda) into the store.
 */
const r = rng(20261113);
const roster = buildRoster(r);
const people = new Map([...roster.auditors, ...roster.tic, ...roster.cb, ...roster.admins].map((p) => [p.id, p.name]));
people.set('svc_synthetic_monitor', 'Synthetic monitor');

export const demoNames: NameResolver = cached(async (ids) => Object.fromEntries(ids.map((id) => [id, people.get(id) ?? id])));

export class FakeCloudWatch implements LogSource {
  private events: Emitted[] = [];
  constructor(private now: () => number = Date.now) {}
  add(evs: Emitted[]) {
    this.events.push(...evs);
    this.events.sort((a, b) => a.ts - b.ts);
  }
  async listGroups() {
    return ['/complao/demo/services'];
  }
  async fetch(_g: string, startMs: number, endMs: number, onPage: (m: { message: string; timestamp: number }[]) => Promise<void>) {
    const visibleUntil = Math.min(endMs, this.now());
    const page = this.events
      .filter((e) => e.ts >= startMs && e.ts <= visibleUntil)
      .map((e) => ({ timestamp: e.ts, message: `${new Date(e.ts).toISOString()}\tINFO\t${JSON.stringify(e.event)}` }));
    for (let i = 0; i < page.length; i += 10_000) await onPage(page.slice(i, i + 10_000));
  }
  get size() {
    return this.events.length;
  }
}

export async function startDemo(store: ActionStore, days = 7, log: (m: string) => void = console.log) {
  const now = Date.now();
  const cw = new FakeCloudWatch();
  const start = now - days * 86_400_000;

  // History: a week of traffic with a daytime curve (Melbourne business hours ≈ 22:00–08:00 UTC).
  for (let t = start; t < now - 120_000; ) {
    const hourUtc = new Date(t).getUTCHours();
    const busy = hourUtc >= 21 || hourUtc <= 8 ? 1 : 0.18;
    t += Math.round((r.int(2, 9) * 60_000) / busy / 4);
    const roll = r.next();
    if (roll < 0.74) cw.add(login(r, roster, t));
    else if (roll < 0.86) cw.add(audit(r, roster, t));
    else if (roll < 0.92) cw.add(registrationJourney(r, roster, t, now - 60_000));
  }
  // Specific cases for the walkthrough.
  cw.add(audit(r, roster, now - 47 * 60_000, { stallAfterCalls: 1 })); // Stalled
  cw.add(auditWithDroppedEvent(r, roster, now - 3 * 3_600_000)); // Incomplete
  cw.add(testAction(r, now - 26 * 60_000)); // unseen type, R12
  cw.add(audit(r, roster, now - 50_000)); // in progress right now

  // Backfill through the real puller, then keep pulling on an EventBridge-like minute tick.
  await store.putPullSetting({ intervalSeconds: 60, paused: false });
  const res = await pullOnce(store, cw, Date.now() + 600_000, { ...DEFAULT_OPTIONS, initialBackfillMs: (days + 1) * 86_400_000, maxWindowMs: 6 * 3_600_000 });
  log(`[demo] ingested ${res.events} events (${res.newSteps} steps) from a simulated CloudWatch log group`);

  // Live traffic: new actions start every ~20 s; their events land as each step finishes.
  (setInterval(() => {
    const t = Date.now();
    const roll = r.next();
    if (roll < 0.6) cw.add(login(r, roster, t));
    else if (roll < 0.85) cw.add(audit(r, roster, t));
    else cw.add(registrationJourney(r, roster, t, t + 1));
  }, 20_000) as unknown as { unref?: () => void }).unref?.();

  const tick = () => runInvocation(store, cw, Date.now() + 50_000).catch((e) => console.error('[demo] pull failed', e));
  (setInterval(tick, 60_000) as unknown as { unref?: () => void }).unref?.();
  // First live tick soon after start so the header shows a recent pull.
  (setTimeout(tick, 5_000) as unknown as { unref?: () => void }).unref?.();
}
