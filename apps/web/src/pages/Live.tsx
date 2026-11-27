import { Anchor, Badge, Group, MultiSelect, Paper, SegmentedControl, SimpleGrid, Stack, Switch, Text, Title } from '@mantine/core';
import { useInterval } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { DataTable } from 'mantine-datatable';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ActionDrawer } from '../components/ActionDrawer';
import { IdText, useDisplayNames } from '../components/bits';
import { Lanes, type LaneGroupView } from '../components/Lanes';
import { SessionStatusDot } from '../components/StatusBadge';
import { api, useMeta } from '../lib/api';
import { fmtMs, fromNow } from '../lib/format';
import type { LaneItem, LiveResponse, SessionRow } from '../lib/types';

const WINDOWS = [
  { value: '15', label: '15 min' },
  { value: '30', label: '30 min' },
  { value: '60', label: '1 hour' },
  { value: '120', label: '2 hours' },
];

/** R23: everything happening across Complao right now, by case and by person. */
export function LivePage() {
  const [params, setParams] = useSearchParams();
  const minutes = Number(params.get('window') ?? 30);
  const roles = params.get('role')?.split(',').filter(Boolean) ?? [];
  const problemsOnly = params.get('problems') === '1';
  const { data: meta } = useMeta();
  const dn = useDisplayNames();
  const navigate = useNavigate();
  const [hovering, setHovering] = useState(false);
  const [selected, setSelected] = useState<{ item: LaneItem; caseId: string | null } | null>(null);

  // The clock moves every few seconds so running bars grow between pulls.
  const [now, setNow] = useState(Date.now());
  const clock = useInterval(() => !hovering && setNow(Date.now()), 5_000);
  useEffect(() => {
    clock.start();
    return clock.stop;
  }, [clock]);

  const q = useQuery({
    queryKey: ['live', minutes],
    queryFn: () => api<LiveResponse>(`/live?minutes=${minutes}`),
    refetchInterval: hovering || selected ? false : 15_000,
    placeholderData: (p) => p,
  });

  const set = (k: string, v: string | null) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };

  const data = q.data;
  const groups: LaneGroupView[] = useMemo(() => {
    if (!data) return [];
    return data.groups
      .filter((g) => !problemsOnly || g.failed > 0)
      .map((g) => ({ ...g, lanes: roles.length ? g.lanes.filter((l) => roles.includes(l.actorRole ?? '')) : g.lanes }))
      .filter((g) => g.lanes.length)
      .map((g) => ({
        key: g.caseId ?? 'other',
        lanes: g.lanes,
        title: g.caseId ? (
          <Group gap={8} wrap="nowrap">
            <Anchor component={Link} to={`/cases/${encodeURIComponent(g.caseId)}`} fw={500} c="var(--ink-text)" size="sm">
              {dn.type(g.kind)}
            </Anchor>
            <IdText id={g.caseId} chars={8} size="xs" />
            <Text span size="xs" c="dimmed">
              {g.lanes.length} {g.lanes.length === 1 ? 'person' : 'people'}
            </Text>
          </Group>
        ) : (
          <Text size="sm" fw={500}>
            Other activity{' '}
            <Text span size="xs" c="dimmed" fw={400}>
              sign-ins and actions not tied to a case
            </Text>
          </Text>
        ),
        aside: (
          <Text size="xs" c={g.failed ? 'red.7' : 'dimmed'}>
            {[g.failed ? `${g.failed} failed` : null, g.running ? `${g.running} running` : null].filter(Boolean).join(' · ') || (g.caseId ? 'On track' : '')}
          </Text>
        ),
      }));
  }, [data, roles, problemsOnly, dn]);

  const signedIn = (data?.sessions ?? []).filter((s) => s.status === 'active' || s.status === 'idle');

  return (
    <Stack gap="md">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <Title order={1}>Live</Title>
          <Text c="dimmed" size="sm" mt={4}>
            Everything happening across Complao, grouped by case and by person. Select any bar to see what that action did.
          </Text>
        </div>
        <SegmentedControl data={WINDOWS} value={String(minutes)} onChange={(v) => set('window', v === '30' ? null : v)} />
      </div>

      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
        <Stat label="Cases with activity" value={data?.stats.cases ?? '–'} />
        <Stat label="People signed in" value={data ? `${data.stats.activeSessions + data.stats.idleSessions}` : '–'} note={data ? `${data.stats.activeSessions} active, ${data.stats.idleSessions} idle` : undefined} />
        <Stat label="Actions running" value={data?.stats.running ?? '–'} />
        <Stat label="Failed or partial" value={data?.stats.failed ?? '–'} danger={Boolean(data?.stats.failed)} />
      </SimpleGrid>

      <Group gap="sm">
        <MultiSelect
          aria-label="Role"
          placeholder={roles.length ? undefined : 'All roles'}
          data={meta?.roles ?? []}
          value={roles}
          onChange={(v) => set('role', v.join(',') || null)}
          clearable
          w={260}
        />
        <Switch label="Only cases with a failure" checked={problemsOnly} onChange={(e) => set('problems', e.currentTarget.checked ? '1' : null)} />
        <Text size="xs" c="dimmed" ml="auto">
          {meta?.pull.lastSuccessAt ? `Logs pulled ${fromNow(meta.pull.lastSuccessAt)}` : ''}
        </Text>
      </Group>

      {q.isLoading ? null : groups.length ? (
        <Lanes
          groups={groups}
          from={now - minutes * 60_000}
          to={now}
          names={data?.names ?? {}}
          live
          selectedId={selected?.item.actionId}
          onHoverChange={setHovering}
          onSelect={(item, lane) => {
            const g = data?.groups.find((x) => x.lanes.some((l) => l === lane || l.items.includes(item)));
            setSelected({ item, caseId: g?.caseId ?? null });
          }}
          onPersonClick={(lane) => lane.sessionIds.length && navigate(`/sessions/${encodeURIComponent(lane.sessionIds[lane.sessionIds.length - 1])}`)}
        />
      ) : (
        <Paper p="xl">
          <Text c="dimmed" ta="center">
            {problemsOnly || roles.length ? 'Nothing matches these filters right now.' : 'Nobody has done anything in this window. New activity appears after the next log pull.'}
          </Text>
        </Paper>
      )}

      <div>
        <Title order={2} mb="xs">
          People signed in
        </Title>
        <div className="sheet">
          <DataTable<SessionRow>
            records={signedIn}
            idAccessor="sessionId"
            minHeight={signedIn.length ? undefined : 120}
            noRecordsText="Nobody is signed in right now."
            highlightOnHover
            verticalSpacing="xs"
            horizontalSpacing="md"
            onRowClick={({ record }) => navigate(`/sessions/${encodeURIComponent(record.sessionId)}`)}
            columns={[
              { accessor: 'actorId', title: 'Person', render: (s) => (s.actorId ? data?.names[s.actorId] ?? s.actorId : '–') },
              { accessor: 'actorRole', title: 'Role', render: (s) => s.actorRole ?? '–' },
              { accessor: 'status', title: 'Status', render: (s) => <SessionStatusDot status={s.status} /> },
              { accessor: 'startedAt', title: 'Signed in', render: (s) => fromNow(s.startedAt) },
              { accessor: 'lastEventAt', title: 'Last action', render: (s) => fromNow(s.lastEventAt) },
              { accessor: 'actionCount', title: 'Actions', textAlign: 'right', cellsClassName: 'num' },
              {
                accessor: 'caseIds',
                title: 'Cases',
                textAlign: 'right',
                cellsClassName: 'num',
                render: (s) => (s.failedActions ? <Badge color="red" size="sm">{s.caseIds.length} · {s.failedActions} failed</Badge> : s.caseIds.length),
              },
              { accessor: 'durationMs', title: 'Signed in for', textAlign: 'right', cellsClassName: 'num', render: (s) => fmtMs(s.durationMs) },
            ]}
          />
        </div>
      </div>

      <ActionDrawer actionId={selected?.item.actionId ?? null} sessionId={selected?.item.sessionId} caseId={selected?.caseId} onClose={() => setSelected(null)} />
    </Stack>
  );
}

function Stat({ label, value, note, danger }: { label: string; value: string | number; note?: string; danger?: boolean }) {
  return (
    <Paper p="md">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fz={24} fw={500} className="num" c={danger ? 'red.7' : undefined}>
        {value}
      </Text>
      {note && (
        <Text size="xs" c="dimmed">
          {note}
        </Text>
      )}
    </Paper>
  );
}
