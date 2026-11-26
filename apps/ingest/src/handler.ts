import { DynamoStore } from '@complao/core';
import { cloudWatchSource } from './cloudwatch';
import { DEFAULT_OPTIONS, runInvocation } from './puller';

/**
 * EventBridge schedule target (rate(1 minute)). Runs with reserved concurrency 1
 * so two pulls never overlap (section 6.3).
 *
 * Env:
 *   TABLE_NAME             action store table
 *   LOG_GROUPS             comma-separated log group names
 *   LOG_GROUP_PREFIX       and/or a prefix to discover groups, e.g. /complao/
 *   FILTER_PATTERN         CloudWatch filter, default "action_id"
 *   INITIAL_BACKFILL_DAYS  first-run lookback per group, default 14
 */
const store = new DynamoStore({ tableName: required('TABLE_NAME') });
const source = cloudWatchSource({
  groups: (process.env.LOG_GROUPS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  prefix: process.env.LOG_GROUP_PREFIX || undefined,
  filterPattern: process.env.FILTER_PATTERN || undefined,
});
const options = {
  ...DEFAULT_OPTIONS,
  initialBackfillMs: Number(process.env.INITIAL_BACKFILL_DAYS ?? 14) * 86_400_000,
};

export const handler = async (_event: unknown, context: { getRemainingTimeInMillis(): number }) => {
  const deadline = Date.now() + context.getRemainingTimeInMillis() - 20_000;
  const results = await runInvocation(store, source, deadline, options);
  console.log(JSON.stringify({ msg: 'pull complete', results: results.map(({ groups, ...r }) => ({ ...r, groups: groups.length })) }));
  return results;
};

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}
