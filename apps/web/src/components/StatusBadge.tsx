import { Badge, Group, Tooltip } from '@mantine/core';
import type { ActionStatus, SessionStatus } from '../lib/types';

export const STATUS_META: Record<ActionStatus, { label: string; color: string; help: string }> = {
  in_progress: { label: 'In progress', color: 'ink', help: 'Started, still running. Updates on the next log pull.' },
  completed: { label: 'Completed', color: 'green', help: 'Finished and every step succeeded.' },
  failed: { label: 'Failed', color: 'red', help: 'The action ended in failure.' },
  partial: { label: 'Partial', color: 'yellow', help: 'Finished, with at least one failed step.' },
  stalled: { label: 'Stalled', color: 'stalled', help: 'No event has arrived for longer than the stalled limit.' },
};

export const STATUS_OPTIONS = [
  ...Object.entries(STATUS_META).map(([value, m]) => ({ value, label: m.label })),
  { value: 'incomplete', label: 'Incomplete' },
];

export function StatusDot({ status }: { status: ActionStatus }) {
  const m = STATUS_META[status];
  return (
    <Tooltip label={m.help} multiline w={240}>
      <Group gap={7} wrap="nowrap" component="span" style={{ display: 'inline-flex' }}>
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: 8,
            background: `var(--mantine-color-${m.color}-6)`,
            boxShadow: status === 'in_progress' ? '0 0 0 3px var(--mantine-color-ink-1)' : undefined,
            flex: 'none',
          }}
          className={status === 'in_progress' ? 'pulse' : undefined}
        />
        <span>{m.label}</span>
      </Group>
    </Tooltip>
  );
}

export function IncompleteBadge() {
  return (
    <Tooltip label="One or more step events never arrived. Logging is best-effort, so the tree may have gaps." multiline w={260}>
      <Badge size="xs" color="gray" variant="outline">
        Incomplete
      </Badge>
    </Tooltip>
  );
}

export function StatusBadge({ status }: { status: ActionStatus }) {
  const m = STATUS_META[status];
  return (
    <Badge color={m.color} variant="light" size="md">
      {m.label}
    </Badge>
  );
}

// ---------------------------------------------------------------- sessions (R22)

export const SESSION_META: Record<SessionStatus, { label: string; color: string; help: string }> = {
  active: { label: 'Active', color: 'green', help: 'Signed in and doing things.' },
  idle: { label: 'Idle', color: 'yellow', help: 'Signed in, but nothing for a few minutes.' },
  ended: { label: 'Signed out', color: 'gray', help: 'The person signed out.' },
  expired: { label: 'Expired', color: 'stalled', help: 'Nothing for longer than the session timeout, and no sign-out.' },
};


export function SessionStatusDot({ status }: { status: SessionStatus }) {
  const m = SESSION_META[status];
  return (
    <Tooltip label={m.help}>
      <Group gap={7} wrap="nowrap" component="span" style={{ display: 'inline-flex' }}>
        <span aria-hidden style={{ width: 8, height: 8, borderRadius: 8, background: `var(--mantine-color-${m.color}-6)`, flex: 'none' }} className={status === 'active' ? 'pulse-green' : undefined} />
        <span>{m.label}</span>
      </Group>
    </Tooltip>
  );
}
