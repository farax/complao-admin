import { Alert, Anchor, Badge, Group, Loader, Paper, Stack, Text, Timeline, Title, UnstyledButton } from '@mantine/core';
import { IconLogin2, IconLogout2 } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ActionDrawer } from '../components/ActionDrawer';
import { IdText, useDisplayNames } from '../components/bits';
import { IncompleteBadge, SessionStatusDot, STATUS_META, StatusDot } from '../components/StatusBadge';
import { api, useLiveInterval } from '../lib/api';
import { fmtMs, fmtTimeSec, fmtWait } from '../lib/format';
import type { SessionDetailResponse } from '../lib/types';

/** R22: one person's visit, from sign-in to sign-out, with every action in order. */
export function SessionDetailPage() {
  const { id = '' } = useParams();
  const live = useLiveInterval();
  const dn = useDisplayNames();
  const [open, setOpen] = useState<{ actionId: string; caseId: string | null } | null>(null);
  const q = useQuery({
    queryKey: ['session', id],
    queryFn: () => api<SessionDetailResponse>(`/sessions/${encodeURIComponent(id)}`),
    refetchInterval: (query) => (query.state.data && ['active', 'idle'].includes(query.state.data.session.status) ? live : false),
  });

  if (q.isLoading) return <Loader m="xl" />;
  if (q.isError || !q.data) return <Alert color="gray">{(q.error as Error)?.message}</Alert>;
  const { session: s, actions, cases, names } = q.data;
  const kindOf = new Map(cases.map((c) => [c.caseId, c.kind]));
  const work = actions.filter((a) => a.kind === 'action');
  const failed = work.filter((a) => a.status === 'failed' || a.status === 'partial').length;

  return (
    <Stack gap="lg" maw={900}>
      <Paper p="lg">
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
          <Stack gap={6}>
            <Group gap="sm">
              <Title order={1}>{s.actorId ? names[s.actorId] ?? s.actorId : 'Unknown person'}</Title>
              {s.actorRole && (
                <Badge variant="light" color="navy" size="lg">
                  {s.actorRole}
                </Badge>
              )}
              <SessionStatusDot status={s.status} />
            </Group>
            <Text size="sm" c="dimmed">
              Signed in {fmtTimeSec(s.startedAt)}
              {s.endedAt ? `, ${s.status === 'ended' ? 'signed out' : 'last seen'} ${fmtTimeSec(s.endedAt)}` : `, last action ${fmtTimeSec(s.lastEventAt)}`}
            </Text>
            <Group gap={6}>
              <Text size="sm" c="dimmed">
                Session ID
              </Text>
              <IdText id={s.sessionId} chars={16} />
            </Group>
          </Stack>
          <Group gap="xl">
            <Fact label="Length" value={fmtMs(s.durationMs)} />
            <Fact label="Actions" value={String(work.length)} />
            <Fact label="Failed or partial" value={String(failed)} danger={failed > 0} />
          </Group>
        </Group>
        {cases.length > 0 && (
          <Group gap="xs" mt="md">
            <Text size="sm" c="dimmed">
              Worked on
            </Text>
            {cases.map((c) => (
              <Anchor key={c.caseId} component={Link} to={`/cases/${encodeURIComponent(c.caseId)}`} size="sm">
                {dn.type(c.kind)} {c.caseId.slice(0, 8)} ({c.actionsInSession} of {c.totalActions} actions)
              </Anchor>
            ))}
          </Group>
        )}
      </Paper>

      <Timeline bulletSize={22} lineWidth={2} color="navy.9" active={actions.length}>
        {actions.map((a) => {
          const icon = a.kind === 'login' ? <IconLogin2 size={13} /> : a.kind === 'logout' ? <IconLogout2 size={13} /> : null;
          const color = a.kind === 'action' ? STATUS_META[a.status].color : a.status === 'failed' ? 'red' : 'gray';
          return (
            <Timeline.Item
              key={a.actionId}
              bullet={icon ?? <span style={{ width: 8, height: 8, borderRadius: 8, background: `var(--mantine-color-${color}-6)` }} />}
              color={color}
              title={a.gapBeforeMs !== null && a.gapBeforeMs > 60_000 ? <div className="journey-gap">Nothing for {fmtWait(a.gapBeforeMs)}</div> : undefined}
            >
              <UnstyledButton onClick={() => setOpen({ actionId: a.actionId, caseId: a.caseId })} style={{ display: 'block', width: '100%' }}>
                <Paper p="sm" className={a.status === 'failed' ? 'row-failed-card' : undefined}>
                  <Group justify="space-between" wrap="wrap" gap="xs">
                    <Stack gap={0}>
                      <Text fw={500} size="sm">
                        {a.kind === 'login' ? (a.status === 'failed' ? 'Sign-in failed' : 'Signed in') : a.kind === 'logout' ? 'Signed out' : dn.type(a.actionType)}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {fmtTimeSec(a.startedAt)}
                        {a.caseId ? ` · ${dn.type(kindOf.get(a.caseId) ?? 'Case')} ${a.caseId.slice(0, 8)}` : ''}
                      </Text>
                    </Stack>
                    <Group gap="lg">
                      {a.kind === 'action' && (
                        <Group gap={8}>
                          <StatusDot status={a.status} />
                          {a.incomplete && <IncompleteBadge />}
                        </Group>
                      )}
                      <Text size="sm" className="num" w={80} ta="right">
                        {a.durationMs !== null ? fmtMs(a.durationMs) : 'running'}
                      </Text>
                    </Group>
                  </Group>
                </Paper>
              </UnstyledButton>
            </Timeline.Item>
          );
        })}
      </Timeline>
      {!s.endedAt && (
        <Text size="xs" c="dimmed">
          {s.status === 'active' || s.status === 'idle' ? 'Still signed in. New actions appear after the next log pull.' : ''}
        </Text>
      )}

      <ActionDrawer actionId={open?.actionId ?? null} caseId={open?.caseId} onClose={() => setOpen(null)} />
    </Stack>
  );
}

function Fact({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <Stack gap={0}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="lg" fw={500} className="num" c={danger ? 'red.7' : undefined}>
        {value}
      </Text>
    </Stack>
  );
}
