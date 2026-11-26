import { Alert, Anchor, Group, Loader, Paper, Stack, Text, Timeline, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { IdText, useDisplayNames } from '../components/bits';
import { IncompleteBadge, STATUS_META, StatusDot } from '../components/StatusBadge';
import { api, useMeta } from '../lib/api';
import { fmtMoney, fmtMs, fmtTimeSec, fmtWait } from '../lib/format';
import type { JourneyResponse } from '../lib/types';

/** R18: every action that shares a case ID, in time order, with the waiting time between them. */
export function JourneyPage() {
  const { caseId = '' } = useParams();
  const dn = useDisplayNames();
  const { data: meta } = useMeta();
  const q = useQuery({ queryKey: ['case', caseId], queryFn: () => api<JourneyResponse>(`/cases/${encodeURIComponent(caseId)}`) });

  if (q.isLoading) return <Loader m="xl" />;
  if (q.isError || !q.data) return <Alert color="gray">{(q.error as Error)?.message}</Alert>;
  const j = q.data;
  const totalAi = j.actions.reduce((s, a) => s + a.aiCostUsd, 0);

  return (
    <Stack gap="lg" maw={820}>
      <div>
        <Title order={1}>Case journey</Title>
        <Group gap="xs" mt={6}>
          <Text size="sm" c="dimmed">
            Case ID
          </Text>
          <IdText id={j.caseId} chars={36} />
        </Group>
        <Text size="sm" c="dimmed" mt={6}>
          {j.actions.length} actions over {fmtWait(j.totalMs)}
          {totalAi > 0 ? `, AI cost ${fmtMoney(totalAi, meta?.config.currency)}` : ''}. Each stage is its own action; the gaps are time spent waiting on a person.
        </Text>
      </div>

      <Timeline bulletSize={14} lineWidth={2} active={j.actions.length - 1} color="navy.9">
        {j.actions.map((a) => (
          <Timeline.Item
            key={a.actionId}
            bullet={<span style={{ width: 6, height: 6, borderRadius: 6, background: `var(--mantine-color-${STATUS_META[a.status].color}-6)` }} />}
            title={
              a.waitBeforeMs !== null ? (
                <div className="journey-gap">Waited {fmtWait(a.waitBeforeMs)}</div>
              ) : undefined
            }
          >
            <Paper p="md" component={Link} to={`/actions/${a.actionId}`} style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
              <Group justify="space-between" wrap="wrap" gap="xs">
                <Stack gap={2}>
                  <Anchor component="span" fw={500} size="md" c="var(--ink-text)">
                    {dn.type(a.actionType)}
                  </Anchor>
                  <Text size="sm" c="dimmed">
                    {fmtTimeSec(a.startedAt)} by {a.actorId ? j.names[a.actorId] ?? a.actorId : 'unknown'}
                  </Text>
                </Stack>
                <Group gap="lg">
                  <Group gap={8}>
                    <StatusDot status={a.status} />
                    {a.incomplete && <IncompleteBadge />}
                  </Group>
                  <Text size="sm" className="num" w={80} ta="right">
                    {a.durationMs !== null ? fmtMs(a.durationMs) : 'running'}
                  </Text>
                </Group>
              </Group>
            </Paper>
          </Timeline.Item>
        ))}
      </Timeline>
    </Stack>
  );
}
