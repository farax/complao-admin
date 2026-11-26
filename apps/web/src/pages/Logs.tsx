import { Alert, Button, Group, Select, Switch, Text, TextInput, Title } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconSearch } from '@tabler/icons-react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { DataTable } from 'mantine-datatable';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { rangeFromParams, RangePicker, rangeToParams, resolveRange, useDisplayNames } from '../components/bits';
import { api, qs, useLiveInterval, useMeta } from '../lib/api';
import { fmtMs, fmtTimeSec, shortId } from '../lib/format';
import type { Names, StepRecord } from '../lib/types';

interface StepsResponse {
  items: StepRecord[];
  cursor: string | null;
  truncated: boolean;
  names: Names;
}

/** R8: every step one component recorded, newest first, across all actions. */
export function LogsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { data: meta } = useMeta();
  const dn = useDisplayNames();
  const live = useLiveInterval();

  const component = params.get('component') ?? meta?.components[0] ?? '';
  const status = params.get('status') ?? '';
  const failedFirst = params.get('failedFirst') === '1';
  const range = rangeFromParams(params);
  const { from, to } = resolveRange(range);

  // Text filters are typed, so debounce them before they reach the URL and the query.
  const [stepName, setStepName] = useState(params.get('step') ?? '');
  const [code, setCode] = useState(params.get('code') ?? '');
  const [actionId, setActionId] = useState(params.get('action') ?? '');
  const [debounced] = useDebouncedValue({ stepName, code, actionId }, 350);

  const update = (fn: (p: URLSearchParams) => void) => {
    const p = new URLSearchParams(params);
    fn(p);
    setParams(p, { replace: true });
  };
  useEffect(() => {
    update((p) => {
      for (const [k, v] of [
        ['step', debounced.stepName],
        ['code', debounced.code],
        ['action', debounced.actionId],
      ] as const)
        if (v.trim()) p.set(k, v.trim());
        else p.delete(k);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const filters = { component, status, failedFirst, from, to, stepName: params.get('step') ?? '', code: params.get('code') ?? '', actionId: params.get('action') ?? '' };
  const query = useInfiniteQuery({
    queryKey: ['steps', filters],
    enabled: Boolean(component),
    queryFn: ({ pageParam }) =>
      api<StepsResponse>(
        `/steps${qs({
          component,
          from,
          to,
          status,
          stepName: filters.stepName,
          responseCode: filters.code,
          actionId: filters.actionId,
          failedFirst: failedFirst ? '1' : undefined,
          limit: 100,
          cursor: pageParam as string | undefined,
        })}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (l) => l.cursor ?? undefined,
    refetchInterval: live,
    placeholderData: (p) => p,
  });

  const rows = useMemo(() => (query.data?.pages ?? []).flatMap((p) => p.items), [query.data]);
  const names: Names = useMemo(() => Object.assign({}, ...(query.data?.pages ?? []).map((p) => p.names)), [query.data]);
  const truncated = query.data?.pages.some((p) => p.truncated);

  return (
    <>
      <div className="page-head">
        <div>
          <Title order={1}>Logs by area</Title>
          <Text c="dimmed" size="sm" mt={4}>
            Every step one part of the platform recorded, newest first. Select a step to open the action it belongs to.
          </Text>
        </div>
      </div>

      <Group gap="xs" mb="xs" wrap="wrap">
        <Select
          aria-label="Component"
          data={(meta?.components ?? []).map((c) => ({ value: c, label: dn.component(c) }))}
          value={component || null}
          onChange={(v) => update((p) => (v ? p.set('component', v) : p.delete('component')))}
          allowDeselect={false}
          searchable
          w={220}
        />
        <RangePicker value={range} onChange={(r) => update((p) => rangeToParams(p, r))} />
        <Select
          aria-label="Step status"
          placeholder="Any status"
          data={[
            { value: 'failure', label: 'Failed' },
            { value: 'success', label: 'Succeeded' },
            { value: 'skipped', label: 'Skipped' },
          ]}
          value={status || null}
          onChange={(v) => update((p) => (v ? p.set('status', v) : p.delete('status')))}
          clearable
          w={150}
        />
        <Switch
          label="Failed first"
          checked={failedFirst}
          onChange={(e) => {
            const on = e.currentTarget.checked;
            update((p) => (on ? p.set('failedFirst', '1') : p.delete('failedFirst')));
          }}
          ml="xs"
        />
      </Group>
      <Group gap="xs" mb="md" wrap="wrap">
        <TextInput aria-label="Step name" placeholder="Step name contains…" leftSection={<IconSearch size={15} />} value={stepName} onChange={(e) => setStepName(e.currentTarget.value)} w={220} />
        <TextInput aria-label="Response code" placeholder="Response code" value={code} onChange={(e) => setCode(e.currentTarget.value)} w={140} />
        <TextInput
          aria-label="Action ID"
          placeholder="Action ID"
          value={actionId}
          onChange={(e) => setActionId(e.currentTarget.value)}
          w={300}
          styles={{ input: { fontFamily: actionId ? 'var(--mantine-font-family-monospace)' : undefined } }}
        />
      </Group>

      {truncated && (
        <Alert color="gray" mb="sm" py={8}>
          Failed-first ordering shows the first 5,000 matching steps. Narrow the dates to see the rest.
        </Alert>
      )}

      <div className="sheet">
        <DataTable<StepRecord>
          records={rows}
          idAccessor={(r) => `${r.actionId}:${r.stepId}`}
          fetching={query.isLoading}
          minHeight={rows.length ? undefined : 220}
          verticalSpacing="xs"
          horizontalSpacing="md"
          highlightOnHover
          onRowClick={({ record }) => navigate(`/actions/${record.actionId}`)}
          rowClassName={(r) => (r.status === 'failure' && r.serverFailure ? 'row-failed' : undefined)}
          noRecordsText={component ? 'No steps match these filters in this period.' : 'No component has logged a step yet.'}
          columns={[
            { accessor: 'startedAt', title: 'Started', width: 190, render: (r) => <span className="num">{fmtTimeSec(r.startedAt)}</span> },
            {
              accessor: 'stepName',
              title: 'Step',
              render: (r) => (
                <div>
                  <Text size="sm" fw={500}>
                    {r.stepName}
                  </Text>
                  {r.status === 'failure' && (
                    <Text size="xs" c={r.serverFailure ? 'red.7' : 'dimmed'}>
                      {r.serverFailure ? 'Server-side failure' : 'Rejected request'}
                      {r.details.error_code || r.details.reason_code ? ` · ${String(r.details.error_code ?? r.details.reason_code).replace(/_/g, ' ')}` : ''}
                    </Text>
                  )}
                </div>
              ),
            },
            { accessor: 'latencyMs', title: 'Latency', width: 100, textAlign: 'right', cellsClassName: 'num', render: (r) => fmtMs(r.latencyMs) },
            {
              accessor: 'status',
              title: 'Status',
              width: 110,
              render: (r) => (
                <Text size="sm" c={r.status === 'failure' ? 'red.7' : r.status === 'skipped' ? 'dimmed' : undefined}>
                  {r.status === 'failure' ? 'Failed' : r.status === 'skipped' ? 'Skipped' : 'Succeeded'}
                </Text>
              ),
            },
            { accessor: 'responseCode', title: 'Response', width: 105, cellsClassName: 'num' },
            {
              accessor: 'actionId',
              title: 'Action',
              width: 120,
              render: (r) => (
                <Text size="sm" c="dimmed" ff="monospace">
                  {shortId(r.actionId)}
                </Text>
              ),
            },
            { accessor: 'actorId', title: 'Initiator', width: 150, render: (r) => names[r.actorId] ?? r.actorId },
          ]}
        />
      </div>

      <Group justify="space-between" mt="sm">
        <Text size="xs" c="dimmed">
          {rows.length ? `${rows.length.toLocaleString('en-AU')} step${rows.length === 1 ? '' : 's'} shown` : ''}
        </Text>
        {query.hasNextPage && (
          <Button variant="default" size="xs" onClick={() => query.fetchNextPage()} loading={query.isFetchingNextPage}>
            Load older steps
          </Button>
        )}
      </Group>
    </>
  );
}
