import type { ActionStore } from '@complao/core';
import { DEFAULT_OPTIONS, pullOnce, runInvocation, type LogSource } from '@complao/ingest/puller';
import { cached, type NameResolver } from '../names';
import { AuditEngagement, auditWithDroppedEvent, browseVisit, buildRoster, registrationJourney, rng, testAction, type Emitted } from './simulator';

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
  private sorted = true;
  constructor(private now: () => number = Date.now) {}
  add = (evs: Emitted[]) => {
    this.events.push(...evs);
    this.sorted = false;
  };
  async listGroups() {
    return ['/complao/demo/services'];
  }
  async fetch(_g: string, startMs: number, endMs: number, onPage: (m: { message: string; timestamp: number }[]) => Promise<void>) {
    if (!this.sorted) {
      this.events.sort((a, b) => a.ts - b.ts);
      this.sorted = true;
    }
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

/** How many audits are in progress at once in the live demo. */
const LIVE_AUDITS = 5;
const LIVE_PACE: [number, number] = [90_000, 300_000];

type Timer = { unref?: () => void };

export async function startDemo(store: ActionStore, days = 7, log: (m: string) => void = console.log) {
  const now = Date.now();
  const cw = new FakeCloudWatch();
  const start = now - days * 86_400_000;
  const historyEnd = now - 90 * 60_000;

  // History: a week of traffic with a daytime curve (Melbourne business hours ≈ 22:00–08:00 UTC).
  for (let t = start; t < historyEnd; ) {
    const hourUtc = new Date(t).getUTCHours();
    const busy = hourUtc >= 21 || hourUtc <= 8 ? 1 : 0.15;
    t += Math.round((r.int(3, 12) * 60_000) / busy / 2);
    const roll = r.next();
    if (roll < 0.62) browseVisit(r, roster, t, cw.add);
    else if (roll < 0.8) {
      const e = new AuditEngagement(r, roster, t, [5 * 60_000, 90 * 60_000], cw.add);
      e.playUntil(historyEnd);
    } else registrationJourney(r, roster, t, historyEnd, cw.add);
  }

  // The walkthrough cases.
  const stalled = new AuditEngagement(r, roster, now - 80 * 60_000, [2 * 60_000, 6 * 60_000], cw.add, { stall: true });
  stalled.playUntil(now);
  auditWithDroppedEvent(r, roster, now - 3 * 3_600_000, cw.add);
  testAction(r, now - 26 * 60_000, cw.add);

  // Audits running right now: started in the last hour, each part-way through.
  const live: AuditEngagement[] = [];
  for (let i = 0; i < LIVE_AUDITS; i++) {
    const e = new AuditEngagement(r, roster, now - r.int(5, 35) * 60_000, LIVE_PACE, cw.add);
    e.playUntil(now - 30_000);
    live.push(e);
  }
  for (let t = historyEnd; t < now; t += r.int(4, 9) * 60_000) browseVisit(r, roster, t, cw.add);

  // Backfill through the real puller, then keep pulling on an EventBridge-like minute tick.
  await store.putPullSetting({ intervalSeconds: 60, paused: false });
  const res = await pullOnce(store, cw, Date.now() + 600_000, { ...DEFAULT_OPTIONS, initialBackfillMs: (days + 1) * 86_400_000, maxWindowMs: 6 * 3_600_000 });
  log(`[demo] ingested ${res.events} events (${res.newSteps} steps) from a simulated CloudWatch log group`);

  // Live traffic: every few seconds the next turn in one of the running audits happens.
  // When an audit finishes, a new one starts, so there are always LIVE_AUDITS in flight.
  (setInterval(() => {
    const t = Date.now();
    for (let i = 0; i < live.length; i++) {
      if (live[i].done) live[i] = new AuditEngagement(r, roster, t, LIVE_PACE, cw.add);
      if (live[i].next <= t) live[i].step(t);
    }
    if (r.chance(0.12)) browseVisit(r, roster, t, cw.add);
    if (r.chance(0.02)) registrationJourney(r, roster, t, t + 1, cw.add);
  }, 5_000) as unknown as Timer).unref?.();

  const tick = () => runInvocation(store, cw, Date.now() + 50_000).catch((e) => console.error('[demo] pull failed', e));
  (setInterval(tick, 60_000) as unknown as Timer).unref?.();
  (setTimeout(tick, 5_000) as unknown as Timer).unref?.();
}
