import { ActionIcon, Button, Divider, Group, NumberInput, Paper, SegmentedControl, Select, SimpleGrid, Stack, Switch, Table, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, useMeta } from '../lib/api';
import { fmtTimeSec, fromNow } from '../lib/format';
import type { PortalConfig, PullSetting } from '../lib/types';

const INTERVALS = [
  { value: '30', label: '30 seconds' },
  { value: '60', label: '1 minute' },
  { value: '300', label: '5 minutes' },
  { value: '900', label: '15 minutes' },
  { value: '3600', label: '1 hour' },
  { value: '21600', label: '6 hours' },
  { value: '86400', label: '24 hours' },
];

export function SettingsPage() {
  const { data: meta } = useMeta();
  if (!meta) return null;
  return (
    <Stack gap="lg" maw={860}>
      <div>
        <Title order={1}>Settings</Title>
        <Text c="dimmed" size="sm" mt={4}>
          These settings change what the portal shows. None of them touch the Complao platform.
        </Text>
      </div>
      <PullCard pull={meta.pull} />
      <ConfigCards config={meta.config} types={meta.types} components={meta.components} />
    </Stack>
  );
}

// ---------------------------------------------------------------- R9

function PullCard({ pull }: { pull: PullSetting }) {
  const qc = useQueryClient();
  const [interval, setInterval] = useState(String(pull.intervalSeconds));
  const [paused, setPaused] = useState(pull.paused);
  useEffect(() => {
    setInterval(String(pull.intervalSeconds));
    setPaused(pull.paused);
  }, [pull.intervalSeconds, pull.paused]);
  const dirty = interval !== String(pull.intervalSeconds) || paused !== pull.paused;
  const options = INTERVALS.some((i) => i.value === interval) ? INTERVALS : [...INTERVALS, { value: interval, label: `${interval} seconds` }];

  const save = useMutation({
    mutationFn: () => api<PullSetting>('/settings/pull', { method: 'PUT', json: { intervalSeconds: Number(interval), paused } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['meta'] });
      notifications.show({ color: 'green', message: paused ? 'Log pull paused.' : 'Log pull setting saved. It applies from the next scheduled run.' });
    },
    onError: (e) => notifications.show({ color: 'red', message: (e as Error).message }),
  });

  return (
    <Paper p="lg">
      <Title order={2}>Log pull</Title>
      <Text size="sm" c="dimmed" mt={4} mb="md">
        How often new events are read from CloudWatch. While paused, nothing new appears; on resume, every event from the pause is read once.
      </Text>
      <Group align="flex-end" gap="lg" wrap="wrap">
        <Select label="Pull every" data={options} value={interval} onChange={(v) => v && setInterval(v)} allowDeselect={false} w={200} disabled={paused} />
        <Switch label="Pause pulling" checked={paused} onChange={(e) => setPaused(e.currentTarget.checked)} mb={8} />
        <Button onClick={() => save.mutate()} disabled={!dirty} loading={save.isPending}>
          Save log pull
        </Button>
      </Group>
      <Divider my="md" />
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <Info label="Last successful pull" value={pull.lastSuccessAt ? `${fmtTimeSec(pull.lastSuccessAt)} (${fromNow(pull.lastSuccessAt)})` : 'None yet'} />
        <Info label="Events read in that pull" value={pull.lastSuccessAt ? pull.lastEventsIngested.toLocaleString('en-AU') : '–'} />
        <Info label="Last error" value={pull.lastError ?? 'None'} danger={Boolean(pull.lastError)} />
      </SimpleGrid>
    </Paper>
  );
}

function Info({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" c={danger ? 'red.7' : undefined}>
        {value}
      </Text>
    </div>
  );
}

// ---------------------------------------------------------------- R7, R12, R20, R21

function ConfigCards({ config, types, components }: { config: PortalConfig; types: string[]; components: string[] }) {
  const qc = useQueryClient();
  const [cfg, setCfg] = useState<PortalConfig>(config);
  useEffect(() => setCfg(config), [config]);
  const dirty = JSON.stringify(cfg) !== JSON.stringify(config);
  const patch = (fn: (c: PortalConfig) => void) =>
    setCfg((c) => {
      const n = structuredClone(c);
      fn(n);
      return n;
    });

  const save = useMutation({
    mutationFn: () => api<PortalConfig>('/settings/config', { method: 'PUT', json: cfg }),
    onSuccess: () => {
      qc.invalidateQueries();
      notifications.show({ color: 'green', message: 'Settings saved.' });
    },
    onError: (e) => notifications.show({ color: 'red', message: (e as Error).message }),
  });

  const prices = Object.entries(cfg.prices);

  return (
    <>
      <Paper p="lg">
        <Title order={2}>Thresholds</Title>
        <Text size="sm" c="dimmed" mt={4} mb="md">
          When an action counts as stalled, and when a component counts as degraded.
        </Text>
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <NumberInput
            label="Stalled after"
            description="Minutes with no new event"
            min={1}
            max={1440}
            value={cfg.stalledMinutes}
            onChange={(v) => patch((c) => (c.stalledMinutes = Number(v) || 10))}
            suffix=" min"
          />
          <NumberInput
            label="Slow step"
            description="A step longer than this flags its component"
            min={1}
            max={3600}
            value={cfg.slowStepMs / 1000}
            onChange={(v) => patch((c) => (c.slowStepMs = (Number(v) || 60) * 1000))}
            suffix=" s"
          />
          <NumberInput
            label="Server-side failure from code"
            description="Failed steps at or above this code count"
            min={400}
            max={599}
            value={cfg.serverErrorMinCode}
            onChange={(v) => patch((c) => (c.serverErrorMinCode = Number(v) || 500))}
          />
        </SimpleGrid>
        <Text size="xs" c="dimmed" mt="sm">
          The server-side code applies to steps pulled after you save. Stalled and slow-step limits apply straight away.
        </Text>
      </Paper>

      <Paper p="lg">
        <Title order={2}>Display names</Title>
        <Text size="sm" c="dimmed" mt={4} mb="md">
          New action types and components appear on their own, under the name the service logs. Give any of them a friendlier name here.
        </Text>
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xl">
          <NameList title="Action types" keys={types} map={cfg.displayNames.actionTypes} onChange={(k, v) => patch((c) => setName(c.displayNames.actionTypes, k, v))} />
          <NameList title="Components" keys={components} map={cfg.displayNames.components} onChange={(k, v) => patch((c) => setName(c.displayNames.components, k, v))} />
        </SimpleGrid>
      </Paper>

      <Paper p="lg">
        <Title order={2}>AI prices and currency</Title>
        <Text size="sm" c="dimmed" mt={4} mb="md">
          US dollars per 1,000 tokens. A model matches the longest entry its ID starts with, otherwise the default row. New prices apply to calls pulled after you save.
        </Text>
        <Table withRowBorders={false} verticalSpacing={4}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Model ID starts with</Table.Th>
              <Table.Th w={150}>Input, per 1k</Table.Th>
              <Table.Th w={150}>Output, per 1k</Table.Th>
              <Table.Th w={40} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {prices.map(([model, p], i) => (
              <Table.Tr key={i}>
                <Table.Td>
                  <TextInput
                    aria-label="Model ID prefix"
                    value={model === '*' ? 'Default (any other model)' : model}
                    disabled={model === '*'}
                    ff="monospace"
                    onChange={(e) => {
                      const next = e.currentTarget.value;
                      patch((c) => {
                        const entries = Object.entries(c.prices);
                        entries[i] = [next, entries[i][1]];
                        c.prices = Object.fromEntries(entries);
                      });
                    }}
                  />
                </Table.Td>
                <Table.Td>
                  <NumberInput aria-label="Input price" prefix="US$" decimalScale={5} min={0} step={0.0005} value={p.inputPer1k} onChange={(v) => patch((c) => (c.prices[model].inputPer1k = Number(v) || 0))} />
                </Table.Td>
                <Table.Td>
                  <NumberInput aria-label="Output price" prefix="US$" decimalScale={5} min={0} step={0.0005} value={p.outputPer1k} onChange={(v) => patch((c) => (c.prices[model].outputPer1k = Number(v) || 0))} />
                </Table.Td>
                <Table.Td>
                  {model !== '*' && (
                    <ActionIcon variant="subtle" color="gray" aria-label="Remove price" onClick={() => patch((c) => delete c.prices[model])}>
                      <IconTrash size={16} />
                    </ActionIcon>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Button
          variant="subtle"
          size="xs"
          leftSection={<IconPlus size={14} />}
          mt="xs"
          onClick={() => patch((c) => (c.prices[`anthropic.new-model-${Object.keys(c.prices).length}`] = { inputPer1k: 0, outputPer1k: 0 }))}
        >
          Add a model price
        </Button>

        <Divider my="md" />
        <Group align="flex-end" gap="lg" wrap="wrap">
          <div>
            <Text size="sm" fw={500} mb={4}>
              Show costs in
            </Text>
            <SegmentedControl
              data={[
                { value: 'AUD', label: 'Australian dollars' },
                { value: 'USD', label: 'US dollars' },
              ]}
              value={cfg.currency.primary}
              onChange={(v) => patch((c) => (c.currency.primary = v as 'AUD' | 'USD'))}
            />
          </div>
          <NumberInput label="US$1 is worth" prefix="A$" decimalScale={4} min={0.01} step={0.01} w={150} value={cfg.currency.usdToAud} onChange={(v) => patch((c) => (c.currency.usdToAud = Number(v) || 1))} />
          <Switch label="Also show the other currency in brackets" checked={cfg.currency.showSecondary} onChange={(e) => {
            const on = e.currentTarget.checked;
            patch((c) => (c.currency.showSecondary = on));
          }} mb={8} />
        </Group>
      </Paper>

      <Group
        justify="flex-end"
        pos={dirty ? 'sticky' : undefined}
        bottom={16}
        p={dirty ? 'sm' : 0}
        style={dirty ? { background: '#fff', border: '1px solid var(--rule)', borderRadius: 10, boxShadow: '0 6px 24px rgba(23,35,63,.08)' } : undefined}
      >
        {dirty && (
          <Text size="sm" c="dimmed" mr="auto">
            You have unsaved changes.
          </Text>
        )}
        {dirty && (
          <Button variant="default" onClick={() => setCfg(config)}>
            Discard changes
          </Button>
        )}
        <Button onClick={() => save.mutate()} disabled={!dirty} loading={save.isPending} size="md">
          Save settings
        </Button>
      </Group>
    </>
  );
}

function setName(map: Record<string, string>, key: string, value: string) {
  if (value.trim() && value.trim() !== key) map[key] = value.trim();
  else delete map[key];
}

function NameList({ title, keys, map, onChange }: { title: string; keys: string[]; map: Record<string, string>; onChange: (k: string, v: string) => void }) {
  return (
    <Stack gap={6}>
      <Text fw={500} size="sm">
        {title}
      </Text>
      {keys.length === 0 && (
        <Text size="sm" c="dimmed">
          None logged yet.
        </Text>
      )}
      {keys.map((k) => (
        <Group key={k} gap="xs" wrap="nowrap">
          <Text size="sm" ff="monospace" c="dimmed" w={170} truncate title={k}>
            {k}
          </Text>
          <TextInput aria-label={`Display name for ${k}`} placeholder={k} value={map[k] ?? ''} onChange={(e) => onChange(k, e.currentTarget.value)} style={{ flex: 1 }} size="xs" />
        </Group>
      ))}
    </Stack>
  );
}
