import { Button, Group, MultiSelect, Select, Text, Title } from '@mantine/core';
import { IconFilterOff } from '@tabler/icons-react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { DataTable } from 'mantine-datatable';
import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { rangeFromParams, RangePicker, rangeToParams, resolveRange, useDisplayNames } from '../components/bits';
import { IncompleteBadge, STATUS_OPTIONS, StatusDot } from '../components/StatusBadge';
import { api, qs, useLiveInterval, useMeta } from '../lib/api';
import { fmtMoney, fmtMs, fmtTime, shortId } from '../lib/format';
import type { ActionListResponse, ActionRow, Names } from '../lib/types';

export function ActionsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { data: meta } = useMeta();
  const dn = useDisplayNames();
  const live = useLiveInterval();

  const types = params.get('type')?.split(',').filter(Boolean) ?? [];
  const statuses = params.get('status')?.split(',').filter(Boolean) ?? [];
  const actor = params.get('actor') ?? '';
  const roles = params.get('role')?.split(',').filter(Boolean) ?? [];
  const range = rangeFromParams(params);
  const { from, to } = resolveRange(range);
  const filtered = types.length > 0 || statuses.length > 0 || roles.length > 0 || Boolean(actor) || range.preset !== '24h';

  const update = (fn: (p: URLSearchParams) => void) => {
    const p = new URLSearchParams(params);
    fn(p);
    setParams(p, { replace: true });
  };
  const setList = (key: string, v: string[]) => update((p) => (v.length ? p.set(key, v.join(',')) : p.delete(key)));

  const query = useInfiniteQuery({
    queryKey: ['actions', { types, statuses, roles, actor, from, to }],
    queryFn: ({ pageParam }) =>
      api<ActionListResponse>(`/actions${qs({ from, to, type: types, status: statuses, role: roles, actor, limit: 50, cursor: pageParam as string | undefined })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.cursor ?? undefined,
    refetchInterval: live,
    placeholderData: (prev) => prev,
  });

  const rows = useMemo(() => {
    const seen = new Set<string>();
    return (query.data?.pages ?? []).flatMap((p) => p.items).filter((r) => (seen.has(r.actionId) ? false : (seen.add(r.actionId), true)));
  }, [query.data]);
  const names: Names = useMemo(() => Object.assign({}, ...(query.data?.pages ?? []).map((p) => p.names)), [query.data]);

  const actorOptions = useMemo(() => {
    const opts = new Map<string, string>();
    for (const r of rows) if (r.actorId) opts.set(r.actorId, names[r.actorId] ?? r.actorId);
    if (actor && !opts.has(actor)) opts.set(actor, names[actor] ?? actor);
    return [...opts].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [rows, names, actor]);

  const currency = meta?.config.currency;

  return (
    <>
      <div className="page-head">
        <div>
          <Title order={1}>Actions</Title>
          <Text c="dimmed" size="sm" mt={4}>
            Every login, audit, registration and approval, newest first. Select a row to see each step it ran.
          </Text>
        </div>
      </div>

      <Group gap="xs" mb="md" wrap="wrap">
        <MultiSelect
          aria-label="Action type"
          placeholder={types.length ? undefined : 'All types'}
          data={(meta?.types ?? []).map((t) => ({ value: t, label: dn.type(t) }))}
          value={types}
          onChange={(v) => setList('type', v)}
          clearable
          searchable
          w={250}
        />
        <MultiSelect
          aria-label="Status"
          placeholder={statuses.length ? undefined : 'All statuses'}
          data={STATUS_OPTIONS}
          value={statuses}
          onChange={(v) => setList('status', v)}
          clearable
          w={230}
        />
        <MultiSelect
          aria-label="Role"
          placeholder={roles.length ? undefined : 'All roles'}
          data={meta?.roles ?? []}
          value={roles}
          onChange={(v) => setList('role', v)}
          clearable
          w={200}
        />
        <Select
          aria-label="Initiator"
          placeholder="Anyone"
          data={actorOptions}
          value={actor || null}
          onChange={(v) => update((p) => (v ? p.set('actor', v) : p.delete('actor')))}
          searchable
          clearable
          w={190}
          nothingFoundMessage="Nobody in the loaded rows"
        />
        <RangePicker value={range} onChange={(r) => update((p) => rangeToParams(p, r))} />
        {filtered && (
          <Button variant="subtle" color="gray" leftSection={<IconFilterOff size={16} />} onClick={() => setParams(new URLSearchParams(), { replace: true })}>
            Clear filters
          </Button>
        )}
      </Group>

      <div className="sheet">
        <DataTable<ActionRow>
          minHeight={rows.length ? undefined : 220}
          records={rows}
          idAccessor="actionId"
          fetching={query.isLoading}
          highlightOnHover
          verticalSpacing="sm"
          horizontalSpacing="md"
          onRowClick={({ record }) => navigate(`/actions/${record.actionId}`)}
          rowClassName={(r) => (r.status === 'failed' ? 'row-failed' : undefined)}
          noRecordsText={query.isError ? (query.error as Error).message : 'No actions match these filters in this period.'}
          columns={[
            { accessor: 'startedAt', title: 'Started', width: 130, render: (r) => <span className="num">{fmtTime(r.startedAt)}</span> },
            {
              accessor: 'actionType',
              title: 'Action',
              render: (r) => (
                <Group gap={6} wrap="nowrap">
                  <Text size="sm" fw={500}>
                    {dn.type(r.actionType)}
                  </Text>
                  <Text size="sm" c="dimmed" ff="monospace">
                    {shortId(r.actionId)}
                  </Text>
                </Group>
              ),
            },
            {
              accessor: 'actorId',
              title: 'Initiator',
              render: (r) => (
                <Group gap={6} wrap="nowrap">
                  <span>{r.actorId ? names[r.actorId] ?? r.actorId : '–'}</span>
                  {r.actorRole && (
                    <Text span size="xs" c="dimmed">
                      {r.actorRole}
                    </Text>
                  )}
                </Group>
              ),
            },
            {
              accessor: 'status',
              title: 'Status',
              width: 190,
              render: (r) => (
                <Group gap={8} wrap="nowrap">
                  <StatusDot status={r.status} />
                  {r.incomplete && <IncompleteBadge />}
                </Group>
              ),
            },
            {
              accessor: 'durationMs',
              title: 'Duration',
              width: 110,
              textAlign: 'right',
              cellsClassName: 'num',
              render: (r) => (r.durationMs !== null ? fmtMs(r.durationMs) : <Text span size="sm" c="dimmed">running</Text>),
            },
            {
              accessor: 'aiCostUsd',
              title: 'AI cost',
              width: 170,
              textAlign: 'right',
              cellsClassName: 'num',
              render: (r) => (r.aiCalls ? fmtMoney(r.aiCostUsd, currency) : <Text span c="dimmed">–</Text>),
            },
          ]}
        />
      </div>

      <Group justify="space-between" mt="sm">
        <Text size="xs" c="dimmed">
          {rows.length ? `${rows.length} action${rows.length === 1 ? '' : 's'} shown` : ''}
          {live ? ' · refreshes after each log pull' : meta?.pull.paused ? ' · log pull is paused' : ''}
        </Text>
        {query.hasNextPage && (
          <Button variant="default" size="xs" onClick={() => query.fetchNextPage()} loading={query.isFetchingNextPage}>
            Load older actions
          </Button>
        )}
      </Group>
    </>
  );
}
