import type { ActionRecord, ActionStatus, PortalConfig, PriceEntry, StepRecord } from './types';

/** R7: In progress, Completed, Failed, Partial or Stalled. */
export function deriveStatus(a: ActionRecord, cfg: Pick<PortalConfig, 'stalledMinutes'>, now = Date.now()): ActionStatus {
  if (a.hasEnd) {
    if (a.endStatus === 'failure') return 'failed';
    if (a.failedStepIds.length > 0) return 'partial';
    return 'completed';
  }
  const idleMs = now - new Date(a.lastEventAt).getTime();
  if (idleMs >= cfg.stalledMinutes * 60_000) return 'stalled';
  return 'in_progress';
}

/**
 * R7: an action with a missing step is marked Incomplete. We can detect a gap when the
 * start event is missing, or when a step names a parent that never arrived.
 */
export function missingSteps(a: ActionRecord): { incomplete: boolean; missingParents: string[]; missingStart: boolean } {
  const seen = new Set(a.stepIds);
  const missingParents = a.parentIds.filter((p) => !seen.has(p));
  const missingStart = !a.hasStart;
  return { incomplete: missingStart || missingParents.length > 0, missingParents, missingStart };
}

/** R20: a wrong password (4xx) is the service working; only server-side failures count. */
export function isServerFailure(status: string, responseCode: string | null | undefined, minCode = 500): boolean {
  if (status !== 'failure') return false;
  if (responseCode === null || responseCode === undefined || responseCode === '') return true;
  const n = Number(responseCode);
  if (Number.isFinite(n)) return n >= minCode || n < 400;
  // Non-numeric internal codes: treat client-ish codes as non-server.
  return !/^(client|invalid|unauth|forbidden|denied|not_found|bad_request|validation|wrong)/i.test(String(responseCode));
}

/** R21: cost from logged token counts and the price table. */
export function aiCostUsd(details: Record<string, unknown> | undefined, prices: Record<string, PriceEntry>): number | null {
  if (!details) return null;
  const input = num(details.input_tokens ?? details.inputTokens);
  const output = num(details.output_tokens ?? details.outputTokens);
  if (input === null && output === null) return null;
  const model = String(details.model ?? '*');
  const price = prices[model] ?? matchPrefix(prices, model) ?? prices['*'];
  if (!price) return 0;
  const cost = ((input ?? 0) / 1000) * price.inputPer1k + ((output ?? 0) / 1000) * price.outputPer1k;
  return Math.round(cost * 1e6) / 1e6;
}

export function tokenCounts(details: Record<string, unknown> | undefined): { input: number; output: number } {
  return { input: num(details?.input_tokens ?? details?.inputTokens) ?? 0, output: num(details?.output_tokens ?? details?.outputTokens) ?? 0 };
}

function matchPrefix(prices: Record<string, PriceEntry>, model: string): PriceEntry | undefined {
  const key = Object.keys(prices)
    .filter((k) => k !== '*' && model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return key ? prices[key] : undefined;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return v === undefined || v === null || !Number.isFinite(n) ? null : n;
}

/** Build the parent/child tree in start order, as the detail view needs it (R6). */
export interface StepNode extends StepRecord {
  depth: number;
  children: StepNode[];
  orphan: boolean;
}

export function buildTree(steps: StepRecord[]): StepNode[] {
  const sorted = [...steps].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.stepId.localeCompare(b.stepId));
  const nodes = new Map<string, StepNode>();
  for (const s of sorted) nodes.set(s.stepId, { ...s, depth: 0, children: [], orphan: false });
  const roots: StepNode[] = [];
  for (const s of sorted) {
    const node = nodes.get(s.stepId)!;
    const parent = s.parentStepId ? nodes.get(s.parentStepId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else {
      if (s.parentStepId) node.orphan = true;
      roots.push(node);
    }
  }
  const setDepth = (n: StepNode, d: number, guard = new Set<string>()) => {
    if (guard.has(n.stepId)) return;
    guard.add(n.stepId);
    n.depth = d;
    n.children.forEach((c) => setDepth(c, d + 1, guard));
  };
  roots.forEach((r) => setDepth(r, 0));
  return roots;
}

export function flattenTree(roots: StepNode[]): StepNode[] {
  const out: StepNode[] = [];
  const walk = (n: StepNode) => {
    out.push(n);
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

export function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

export const WINDOW_MS = 5 * 60_000;
export function windowOf(iso: string): string {
  const t = new Date(iso).getTime();
  return new Date(Math.floor(t / WINDOW_MS) * WINDOW_MS).toISOString();
}

/** Days (UTC) covered by [from, to], newest first. */
export function daysBetween(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  const start = new Date(dayOf(fromIso) + 'T00:00:00.000Z').getTime();
  for (let t = new Date(dayOf(toIso) + 'T00:00:00.000Z').getTime(); t >= start; t -= 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export function displayName(map: Record<string, string>, key: string | null | undefined): string {
  if (!key) return 'Unknown';
  return map[key] ?? key;
}
