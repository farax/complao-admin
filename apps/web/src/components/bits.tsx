import { ActionIcon, CopyButton, Group, Select, Text, Tooltip } from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import dayjs from 'dayjs';
import { displayName } from '@complao/core/shared';
import { useMeta } from '../lib/api';

/** An identifier: monospace, truncated, with a copy button for the full value. */
export function IdText({ id, chars = 8, size = 'sm' }: { id: string; chars?: number; size?: string }) {
  return (
    <Group gap={2} wrap="nowrap" component="span" style={{ display: 'inline-flex' }}>
      <Tooltip label={id} ff="monospace">
        <Text span ff="monospace" size={size} c="dimmed">
          {id.length > chars ? `${id.slice(0, chars)}…` : id}
        </Text>
      </Tooltip>
      <CopyButton value={id} timeout={1500}>
        {({ copied, copy }) => (
          <ActionIcon
            size="xs"
            variant="subtle"
            color={copied ? 'green' : 'gray'}
            onClick={(e) => {
              e.stopPropagation();
              copy();
            }}
            aria-label="Copy ID"
          >
            {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
          </ActionIcon>
        )}
      </CopyButton>
    </Group>
  );
}

export function useDisplayNames() {
  const { data } = useMeta();
  const dn = data?.config.displayNames ?? { actionTypes: {}, components: {} };
  return {
    type: (t: string | null | undefined) => displayName(dn.actionTypes, t),
    component: (c: string | null | undefined) => displayName(dn.components, c),
  };
}

// ---------------------------------------------------------------- date range

export const RANGE_PRESETS = [
  { value: '1h', label: 'Last hour', ms: 3_600_000 },
  { value: '24h', label: 'Last 24 hours', ms: 86_400_000 },
  { value: '7d', label: 'Last 7 days', ms: 7 * 86_400_000 },
  { value: '30d', label: 'Last 30 days', ms: 30 * 86_400_000 },
  { value: '90d', label: 'Last 90 days', ms: 90 * 86_400_000 },
  { value: 'custom', label: 'Custom dates', ms: 0 },
];

export interface RangeValue {
  preset: string;
  from?: string; // YYYY-MM-DD for custom
  to?: string;
}

/** Turn a range into ISO bounds. Presets are anchored to "now" each time they are read. */
export function resolveRange(r: RangeValue): { from: string; to: string } {
  if (r.preset === 'custom' && r.from) {
    return {
      from: dayjs(r.from).startOf('day').toISOString(),
      to: dayjs(r.to ?? r.from).endOf('day').toISOString(),
    };
  }
  const p = RANGE_PRESETS.find((x) => x.value === r.preset) ?? RANGE_PRESETS[1];
  // Round "now" to the minute so the query key is stable between renders.
  const now = Math.ceil(Date.now() / 60_000) * 60_000;
  return { from: new Date(now - p.ms).toISOString(), to: new Date(now).toISOString() };
}

export function RangePicker({ value, onChange }: { value: RangeValue; onChange: (v: RangeValue) => void }) {
  return (
    <Group gap="xs" wrap="nowrap">
      <Select
        aria-label="Date range"
        data={RANGE_PRESETS.map(({ value, label }) => ({ value, label }))}
        value={value.preset}
        onChange={(v) => onChange({ preset: v ?? '24h' })}
        allowDeselect={false}
        w={150}
      />
      {value.preset === 'custom' && (
        <DatePickerInput
          type="range"
          aria-label="Custom dates"
          placeholder="Pick dates"
          value={[value.from ?? null, value.to ?? null]}
          onChange={([a, b]) => onChange({ preset: 'custom', from: a ? dayjs(a).format('YYYY-MM-DD') : undefined, to: b ? dayjs(b).format('YYYY-MM-DD') : undefined })}
          maxDate={new Date()}
          w={230}
          valueFormat="D MMM YYYY"
        />
      )}
    </Group>
  );
}

export function rangeFromParams(p: URLSearchParams, fallback = '24h'): RangeValue {
  return { preset: p.get('range') ?? fallback, from: p.get('fromDay') ?? undefined, to: p.get('toDay') ?? undefined };
}

export function rangeToParams(p: URLSearchParams, r: RangeValue) {
  p.set('range', r.preset);
  if (r.preset === 'custom' && r.from) {
    p.set('fromDay', r.from);
    if (r.to) p.set('toDay', r.to);
    else p.delete('toDay');
  } else {
    p.delete('fromDay');
    p.delete('toDay');
  }
}
