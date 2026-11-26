import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import type { LogSource } from './puller';

export interface CloudWatchSourceOptions {
  /** Explicit log group names. */
  groups?: string[];
  /** Or read every group under this prefix, e.g. "/complao/". */
  prefix?: string;
  /** Text filter so only action log lines are returned. */
  filterPattern?: string;
  client?: CloudWatchLogsClient;
}

export function cloudWatchSource(opts: CloudWatchSourceOptions): LogSource {
  const client = opts.client ?? new CloudWatchLogsClient({ maxAttempts: 8 });
  const filterPattern = opts.filterPattern ?? '"action_id"';

  return {
    async listGroups() {
      const out = new Set(opts.groups ?? []);
      if (opts.prefix) {
        let nextToken: string | undefined;
        do {
          const r = await client.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: opts.prefix, nextToken }));
          r.logGroups?.forEach((g) => g.logGroupName && out.add(g.logGroupName));
          nextToken = r.nextToken;
        } while (nextToken);
      }
      return [...out].sort();
    },

    async fetch(group, startMs, endMs, onPage) {
      let nextToken: string | undefined;
      do {
        const r = await client.send(
          new FilterLogEventsCommand({
            logGroupName: group,
            startTime: startMs,
            endTime: endMs,
            filterPattern,
            nextToken,
            limit: 10_000,
          }),
        );
        const msgs = (r.events ?? []).filter((e) => e.message).map((e) => ({ message: e.message!, timestamp: e.timestamp ?? 0 }));
        if (msgs.length) await onPage(msgs);
        nextToken = r.nextToken;
      } while (nextToken);
    },
  };
}
