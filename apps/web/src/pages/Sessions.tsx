import { Badge, Button, Group, MultiSelect, Select, Text, Title } from '@mantine/core';
import { IconFilterOff } from '@tabler/icons-react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { DataTable } from 'mantine-datatable';
import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { rangeFromParams, RangePicker, rangeToParams, resolveRange } from '../components/bits';
import { SESSION_STATUS_OPTIONS, SessionStatusDot } from '../components/StatusBadge';
import { api, qs, useLiveInterval, useMeta } from '../lib/api';
import { fmtMs, fmtTime } from '../lib/format';
import type { Names, SessionRow } from '../lib/types';

/** R22: every sign-in, newest first. Each one is a person's visit from login to logout. */
export function SessionsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { data: meta } = useMeta();
  const live = useLiveInterval();
  const statuses = params.get('status')?.split(',').filter(Boolean) ?? [];
  const roles = params.get('role')?.split(',').filter(Boolean) ?? [];
  const actor = params.get('actor') ?? '';
  const range = rangeFromParams(params);
  const { from, to } = resolveRange(range);

  const update = (fn: (p: URLSearchParams) => void) => {
    const p = new URLSearchParams(params);
    fn(p);
    setParams(p, { replace: true });
  };

  const q = useInfiniteQuery({
    queryKey: ['sessions', { statuses, roles, actor, from, to }],
    queryFn: ({ pageParam }) =>
      api<{ items: SessionRow[]; cursor: string | null; names: Names }>(`/sessions${qs({ from, to, status: statuses, role: roles, actor, limit: 50, cursor: pageParam as string | undefined })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (l) => l.cursor ?? undefined,
    refetchInterval: live,
    placeholderData: (p) => p,
  });
  const rows = useMemo(() => (q.data?.pages ?? []).flatMap((p) => p.items), [q.data]);
  const names: Names = useMemo(() => Object.assign({}, ...(q.data?.pages ?? []).map((p) => p.names)), [q.data]);
  const actorOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.actorId) m.set(r.actorId, names[r.actorId] ?? r.actorId);
    if (actor && !m.has(actor)) m.set(actor, names[actor] ?? actor);
    return [...m].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [rows, names, actor]);
  const filtered = statuses.length > 0 || roles.length > 0 || Boolean(actor) || range.preset !== '24h';

  return (
    <>
      <div className="page-head">
        <div>
          <Title order={1}>Sessions</Title>
          <Text c="dimmed" size="sm" mt={4}>
            Every sign-in, newest first. A session is one person’s visit, from logging in to logging out. Select one to see everything they did in it.
          </Text>
        </div>
      </div>

      <Group gap="xs" mb="md" wrap="wrap">
        <MultiSelect aria-label="Status" placeholder={statuses.length ? undefined : 'All statuses'} data={SESSION_STATUS_OPTIONS} value={statuses} onChange={(v) => update((p) => (v.length ? p.set('status', v.join(',')) : p.delete('status')))} clearable w={240} />
        <MultiSelect aria-label="Role" placeholder={roles.length ? undefined : 'All roles'} data={meta?.roles ?? []} value={roles} onChange={(v) => update((p) => (v.length ? p.set('role', v.join(',')) : p.delete('role')))} clearable w={220} />
        <Select aria-label="Person" placeholder="Anyone" data={actorOptions} value={actor || null} onChange={(v) => update((p) => (v ? p.set('actor', v) : p.delete('actor')))} searchable clearable w={180} />
        <RangePicker value={range} onChange={(r) => update((p) => rangeToParams(p, r))} />
        {filtered && (
          <Button variant="subtle" color="gray" leftSection={<IconFilterOff size={16} />} onClick={() => setParams(new URLSearchParams(), { replace: true })}>
            Clear filters
          </Button>
        )}
      </Group>

      <div className="sheet">
        <DataTable<SessionRow>
          records={rows}
          idAccessor="sessionId"
          fetching={q.isLoading}
          minHeight={rows.length ? undefined : 220}
          highlightOnHover
          verticalSpacing="sm"
          horizontalSpacing="md"
          onRowClick={({ record }) => navigate(`/sessions/${encodeURIComponent(record.sessionId)}`)}
          noRecordsText="No sessions match these filters in this period."
          columns={[
            { accessor: 'startedAt', title: 'Signed in', width: 130, render: (s) => <span className="num">{fmtTime(s.startedAt)}</span> },
            { accessor: 'actorId', title: 'Person', render: (s) => <Text size="sm" fw={500}>{s.actorId ? names[s.actorId] ?? s.actorId : '–'}</Text> },
            { accessor: 'actorRole', title: 'Role', render: (s) => s.actorRole ?? '–' },
            { accessor: 'status', title: 'Status', width: 140, render: (s) => <SessionStatusDot status={s.status} /> },
            { accessor: 'durationMs', title: 'Length', textAlign: 'right', cellsClassName: 'num', render: (s) => fmtMs(s.durationMs) },
            { accessor: 'actionCount', title: 'Actions', textAlign: 'right', cellsClassName: 'num' },
            { accessor: 'caseIds', title: 'Cases', textAlign: 'right', cellsClassName: 'num', render: (s) => s.caseIds.length || '–' },
            {
              accessor: 'failedActions',
              title: 'Problems',
              textAlign: 'right',
              render: (s) => (s.failedActions ? <Badge color="red" size="sm">{s.failedActions} failed</Badge> : <Text span c="dimmed">–</Text>),
            },
          ]}
        />
      </div>
      <Group justify="space-between" mt="sm">
        <Text size="xs" c="dimmed">
          {rows.length ? `${rows.length} session${rows.length === 1 ? '' : 's'} shown` : ''}
        </Text>
        {q.hasNextPage && (
          <Button variant="default" size="xs" onClick={() => q.fetchNextPage()} loading={q.isFetchingNextPage}>
            Load older sessions
          </Button>
        )}
      </Group>
    </>
  );
}
