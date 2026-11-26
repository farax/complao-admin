import { ingestEvents, parseLogMessage, type ActionStore, type LogEvent } from '@complao/core/browser';

export interface LogSource {
  /** All log groups to read. */
  listGroups(): Promise<string[]>;
  /** Every event with a timestamp in [startMs, endMs] for one group, page by page. */
  fetch(group: string, startMs: number, endMs: number, onPage: (messages: { message: string; timestamp: number }[]) => Promise<void>): Promise<void>;
}

export interface PullerOptions {
  /** Re-read this far behind the checkpoint to catch late-ingested events (section 6.3). */
  overlapMs: number;
  /** Largest time window read in one go while catching up after a pause. */
  maxWindowMs: number;
  /** Where to start a group that has never been read. */
  initialBackfillMs: number;
  /** Allow this much early firing so a 60 s interval is not skipped by schedule jitter. */
  intervalToleranceMs: number;
}

export const DEFAULT_OPTIONS: PullerOptions = {
  overlapMs: 2 * 60_000,
  maxWindowMs: 60 * 60_000,
  initialBackfillMs: 14 * 86_400_000,
  intervalToleranceMs: 5_000,
};

export interface PullResult {
  pulled: boolean;
  reason?: string;
  events: number;
  invalid: number;
  newSteps: number;
  duplicates: number;
  groups: { group: string; from: number; to: number; caughtUp: boolean; events: number }[];
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/**
 * One EventBridge invocation (every minute). Reads the pull setting, skips if paused or the
 * interval has not elapsed, and at a 30-second setting pulls twice.
 */
export async function runInvocation(
  store: ActionStore,
  source: LogSource,
  deadlineMs: number,
  opts: PullerOptions = DEFAULT_OPTIONS,
  clock: Clock = realClock,
): Promise<PullResult[]> {
  const results: PullResult[] = [];
  const invocationStart = clock.now();

  for (let round = 0; round < 2; round++) {
    let setting = await store.getPull();
    if (setting.paused) {
      results.push(skip('paused'));
      break;
    }
    let intervalMs = setting.intervalSeconds * 1000;
    const last = setting.lastPullAt ? new Date(setting.lastPullAt).getTime() : 0;
    const due = clock.now() - last >= intervalMs - opts.intervalToleranceMs;

    if (!due) {
      // Round 0: not this minute. Round 1 only happens at sub-minute intervals: wait for it
      // inside this invocation, because EventBridge cannot fire more often than once a minute.
      const wait = last + intervalMs - clock.now();
      if (round === 0 || clock.now() + wait > Math.min(deadlineMs, invocationStart + 55_000)) {
        if (round === 0) results.push(skip('interval not elapsed'));
        break;
      }
      await clock.sleep(Math.max(0, wait));
      setting = await store.getPull(); // the founder may have paused or changed it meanwhile
      if (setting.paused) break;
      intervalMs = setting.intervalSeconds * 1000;
      if (intervalMs >= 60_000) break;
    }
    results.push(await pullOnce(store, source, deadlineMs, opts, clock));
    if (intervalMs >= 60_000) break;
  }
  return results;
}

function skip(reason: string): PullResult {
  return { pulled: false, reason, events: 0, invalid: 0, newSteps: 0, duplicates: 0, groups: [] };
}

/** One pull across every log group, from each checkpoint less the overlap, in bounded windows. */
export async function pullOnce(
  store: ActionStore,
  source: LogSource,
  deadlineMs: number,
  opts: PullerOptions = DEFAULT_OPTIONS,
  clock: Clock = realClock,
): Promise<PullResult> {
  const startedAt = clock.now();
  await store.recordPull({ lastPullAt: new Date(startedAt).toISOString() });
  const result: PullResult = { pulled: true, events: 0, invalid: 0, newSteps: 0, duplicates: 0, groups: [] };
  const cfg = await store.getConfig();

  try {
    const groups = await source.listGroups();
    for (const group of groups) {
      const ckpt = await store.getCheckpoint(group);
      let from = ckpt === null ? startedAt - opts.initialBackfillMs : Math.max(0, ckpt - opts.overlapMs);
      const until = startedAt;
      let groupEvents = 0;
      let caughtUp = false;

      while (true) {
        const to = Math.min(until, from + opts.maxWindowMs);
        const batch: LogEvent[] = [];
        await source.fetch(group, from, to, async (msgs) => {
          for (const m of msgs) {
            const p = parseLogMessage(m.message);
            if (p.event) batch.push(p.event);
            else result.invalid++;
          }
        });
        const stats = await ingestEvents(store, batch, cfg);
        result.events += batch.length;
        result.newSteps += stats.newSteps;
        result.duplicates += stats.duplicateSteps;
        groupEvents += batch.length;
        // Advance only after the window is safely written, so a crash re-reads rather than skips.
        await store.putCheckpoint(group, to);
        if (to >= until) {
          caughtUp = true;
          break;
        }
        if (clock.now() > deadlineMs) break; // resume from the checkpoint on the next run
        from = to + 1;
      }
      result.groups.push({ group, from: ckpt ?? startedAt - opts.initialBackfillMs, to: until, caughtUp, events: groupEvents });
      if (clock.now() > deadlineMs) break;
    }
    await store.recordPull({
      lastSuccessAt: new Date(startedAt).toISOString(),
      lastError: null,
      lastEventsIngested: result.events,
    });
  } catch (e) {
    await store.recordPull({ lastError: `${(e as Error).name}: ${(e as Error).message}`.slice(0, 500) });
    throw e;
  }
  return result;
}
