import { BarChart, Sparkline } from '@mantine/charts';
import { Anchor, Badge, Button, Drawer, Group, Loader, Paper, SegmentedControl, SimpleGrid, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { IconStack2 } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { DataTable } from 'mantine-datatable';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useDisplayNames } from '../components/bits';
import { api, useLiveInterval, useMeta } from '../lib/api';
import { deltaPct, fmtCount, fmtMoney, fmtMs, fmtPct, fmtTime, moneyPrimary } from '../lib/format';
import type { CostResponse, HealthRow, StepRecord } from '../lib/types';

const PERIODS = [
  { value: '1h', label: 'Last hour' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
];

export function HealthPage() {
  const [params, setParams] = useSearchParams();
  const period = params.get('period') ?? '24h';
  const selected = params.get('component');
  const live = useLiveInterval();
  const dn = useDisplayNames();
  const { data: meta } = useMeta();

  const q = useQuery({
    queryKey: ['health', period],
    queryFn: () => api<{ rows: HealthRow[]; thresholds: { slowStepMs: number } }>(`/health?period=${period}`),
    refetchInterval: live,
    placeholderData: (p) => p,
  });
  const rows = q.data?.rows ?? [];
  const degraded = rows.filter((r) => r.degraded);
  const set = (k: string, v: string | null) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };

  const headline = !rows.length
    ? 'Component health'
    : degraded.length === 0
      ? 'Every component is healthy'
      : degraded.length === 1
        ? `${dn.component(degraded[0].component)} is the one component flagged`
        : `${degraded.length} components are flagged`;

  return (
    <Stack gap="lg">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <Title order={1}>{headline}</Title>
          <Text c="dimmed" size="sm" mt={4}>
            A component is flagged Degraded when it records a server-side failure or a step longer than {fmtMs(meta?.config.slowStepMs ?? 60000)} in the period. A rejected password does not count.
          </Text>
        </div>
        <SegmentedControl data={PERIODS} value={period} onChange={(v) => set('period', v)} />
      </div>

      <div className="sheet">
        <DataTable<HealthRow>
          records={rows}
          idAccessor="component"
          fetching={q.isLoading}
          minHeight={rows.length ? undefined : 200}
          verticalSpacing="sm"
          horizontalSpacing="md"
          highlightOnHover
          onRowClick={({ record }) => set('component', record.component)}
          rowClassName={(r) => (r.degraded ? 'row-degraded' : undefined)}
          noRecordsText="No component has logged a step yet."
          columns={[
            { accessor: 'component', title: 'Component', render: (r) => <Text fw={r.degraded ? 600 : 500} size="sm">{dn.component(r.component)}</Text> },
            {
              accessor: 'requests',
              title: 'Requests',
              textAlign: 'right',
              cellsClassName: 'num',
              render: (r) => (
                <Stack gap={0} align="flex-end">
                  <span>{fmtCount(r.requests)}</span>
                  <Delta value={deltaPct(r.requests, r.previous.requests)} neutral />
                </Stack>
              ),
            },
            {
              accessor: 'successRate',
              title: 'Success rate',
              textAlign: 'right',
              cellsClassName: 'num',
              render: (r) => (
                <Stack gap={0} align="flex-end">
                  <span>{fmtPct(r.successRate)}</span>
                  <PointsDelta cur={r.successRate} prev={r.previous.successRate} />
                </Stack>
              ),
            },
            {
              accessor: 'p50Ms',
              title: 'Median',
              textAlign: 'right',
              cellsClassName: 'num',
              render: (r) => (
                <Stack gap={0} align="flex-end">
                  <span>{fmtMs(r.p50Ms)}</span>
                  <Delta value={deltaPct(r.p50Ms, r.previous.p50Ms)} higherIsWorse />
                </Stack>
              ),
            },
            {
              accessor: 'p95Ms',
              title: '95th percentile',
              textAlign: 'right',
              cellsClassName: 'num',
              render: (r) => (
                <Stack gap={0} align="flex-end">
                  <span>{fmtMs(r.p95Ms)}</span>
                  <Delta value={deltaPct(r.p95Ms, r.previous.p95Ms)} higherIsWorse />
                </Stack>
              ),
            },
            {
              accessor: 'series',
              title: 'Trend',
              width: 160,
              render: (r) => (
                <Sparkline w={140} h={28} data={r.series.map((s) => s.requests)} curveType="monotone" color={r.degraded ? 'yellow.7' : 'ink.4'} fillOpacity={0.15} strokeWidth={1.5} />
              ),
            },
            {
              accessor: 'degraded',
              title: 'Status',
              width: 150,
              render: (r) =>
                r.degraded ? (
                  <Tooltip label={r.degradedReasons.join('; ')} multiline w={260}>
                    <Badge color="yellow" variant="dot" size="lg" styles={{ root: { textTransform: 'none', fontWeight: 500 } }}>
                      Degraded
                    </Badge>
                  </Tooltip>
                ) : (
                  <Badge color="green" variant="dot" size="lg" styles={{ root: { textTransform: 'none', fontWeight: 500 } }}>
                    Healthy
                  </Badge>
                ),
            },
          ]}
        />
      </div>
      <Text size="xs" c="dimmed" mt={-10}>
        Changes compare with the period before. Percentiles come from latency histograms, so they are accurate to within about 10%. Select a component to see the steps behind its numbers.
      </Text>

      <AiCost />

      <Drill component={selected} period={period} onClose={() => set('component', null)} />
    </Stack>
  );
}

function Delta({ value, higherIsWorse, neutral }: { value: number | null; higherIsWorse?: boolean; neutral?: boolean }) {
  if (value === null || Math.abs(value) < 0.005) return <Text size="xs" c="dimmed">no change</Text>;
  const up = value > 0;
  const bad = !neutral && (higherIsWorse ? up : !up) && Math.abs(value) >= 0.1;
  return (
    <Text size="xs" c={bad ? 'red.7' : 'dimmed'}>
      {up ? '+' : '−'}
      {Math.abs(value * 100).toFixed(0)}%
    </Text>
  );
}

function PointsDelta({ cur, prev }: { cur: number | null; prev: number | null }) {
  if (cur === null || prev === null) return <Text size="xs" c="dimmed">no earlier data</Text>;
  const pts = (cur - prev) * 100;
  if (Math.abs(pts) < 0.05) return <Text size="xs" c="dimmed">no change</Text>;
  return (
    <Text size="xs" c={pts < -0.5 ? 'red.7' : 'dimmed'}>
      {pts > 0 ? '+' : '−'}
      {Math.abs(pts).toFixed(1)} pts
    </Text>
  );
}

// ---------------------------------------------------------------- drill-down

function Drill({ component, period, onClose }: { component: string | null; period: string; onClose: () => void }) {
  const dn = useDisplayNames();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['drill', component, period],
    queryFn: () => api<{ failed: StepRecord[]; slowest: StepRecord[]; scanned: number }>(`/health/${encodeURIComponent(component!)}?period=${period}`),
    enabled: Boolean(component),
  });
  const label = PERIODS.find((p) => p.value === period)?.label.toLowerCase();

  const list = (items: StepRecord[], empty: string, failed: boolean) =>
    items.length ? (
      <Table verticalSpacing={6} highlightOnHover fz="sm">
        <Table.Tbody>
          {items.map((s) => (
            <Table.Tr key={`${s.actionId}${s.stepId}`} style={{ cursor: 'pointer' }} onClick={() => navigate(`/actions/${s.actionId}`)}>
              <Table.Td className="num" w={110} c="dimmed">
                {fmtTime(s.startedAt)}
              </Table.Td>
              <Table.Td>
                <Anchor component={Link} to={`/actions/${s.actionId}`} size="sm" c="var(--ink-text)" fw={500}>
                  {s.stepName}
                </Anchor>
                {failed && (
                  <Text size="xs" c={s.serverFailure ? 'red.7' : 'dimmed'}>
                    {s.serverFailure ? 'Server-side' : 'Rejected request'} · {String(s.details.error_code ?? s.details.reason_code ?? s.responseCode)}
                  </Text>
                )}
              </Table.Td>
              <Table.Td className="num" ta="right" w={100} style={{ whiteSpace: "nowrap" }}>
                {failed ? s.responseCode : fmtMs(s.latencyMs)}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    ) : (
      <Text size="sm" c="dimmed" py="xs">
        {empty}
      </Text>
    );

  return (
    <Drawer opened={Boolean(component)} onClose={onClose} position="right" size={560} title={<Title order={2}>{dn.component(component)}</Title>}>
      {q.isLoading ? (
        <Loader />
      ) : q.data ? (
        <Stack gap="lg">
          <Button
            variant="light"
            leftSection={<IconStack2 size={16} />}
            onClick={() => navigate(`/logs?component=${encodeURIComponent(component!)}&range=${period === '1h' ? '1h' : period}&failedFirst=1`)}
          >
            Open every step from {dn.component(component)}
          </Button>
          <div>
            <Title order={3} mb={4}>
              Failed steps, {label}
            </Title>
            {list(q.data.failed, 'No failed steps in this period.', true)}
          </div>
          <div>
            <Title order={3} mb={4}>
              Slowest steps, {label}
            </Title>
            {list(q.data.slowest, 'No steps in this period.', false)}
          </div>
        </Stack>
      ) : null}
    </Drawer>
  );
}

// ---------------------------------------------------------------- AI cost (R21)

function AiCost() {
  const { data: meta } = useMeta();
  const currency = meta?.config.currency;
  const q = useQuery({ queryKey: ['cost'], queryFn: () => api<CostResponse>('/cost?days=14'), refetchInterval: 120_000 });
  if (!q.data) return null;
  const c = q.data;
  const change = c.previousWeek ? (c.week - c.previousWeek) / c.previousWeek : null;
  const rate = currency?.primary === 'AUD' ? currency.usdToAud : 1;
  const symbol = currency?.primary === 'AUD' ? 'A$' : 'US$';

  return (
    <Paper p="lg">
      <Group justify="space-between" align="flex-start" mb="md" wrap="wrap">
        <div>
          <Title order={2}>AI cost</Title>
          <Text size="sm" c="dimmed" mt={2}>
            Bedrock calls, priced from logged token counts and the price table in Settings.
          </Text>
        </div>
        <SimpleGrid cols={3} spacing="xl">
          <Stat label="Today" value={fmtMoney(c.today, currency)} />
          <Stat label="Last 7 days" value={fmtMoney(c.week, currency)} />
          <Stat label="Change on the 7 days before" value={change === null ? '–' : `${change > 0 ? '+' : '−'}${Math.abs(change * 100).toFixed(0)}%`} />
        </SimpleGrid>
      </Group>
      <BarChart
        h={200}
        data={c.series.map((d) => ({ day: dayjs(d.day).format('D MMM'), cost: Math.round(d.costUsd * rate * 100) / 100, calls: d.calls }))}
        dataKey="day"
        series={[{ name: 'cost', label: `Cost (${symbol})`, color: 'ink.6' }]}
        valueFormatter={(v) => moneyPrimary(v / rate, currency)}
        tickLine="none"
        gridAxis="y"
        barProps={{ radius: 3 }}
        withTooltip
      />
    </Paper>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Stack gap={0}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={500} className="num">
        {value}
      </Text>
    </Stack>
  );
}
