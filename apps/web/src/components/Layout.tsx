import { AppShell, Badge, Burger, Group, NavLink, Stack, Text, TextInput, Tooltip, UnstyledButton } from '@mantine/core';
import { useDisclosure, useInterval } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconActivityHeartbeat, IconBroadcast, IconListDetails, IconLogout, IconSearch, IconSettings, IconStack2 } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { NavLink as RouterLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api, LOCAL_DEMO, useMeta } from '../lib/api';
import { fmtTimeSec, fromNow } from '../lib/format';

const NAV = [
  { to: '/live', label: 'Live', icon: IconBroadcast, hint: 'Who is doing what, right now' },
  { to: '/actions', label: 'Actions', icon: IconListDetails, hint: 'Every action, newest first' },
  { to: '/health', label: 'Component health', icon: IconActivityHeartbeat, hint: 'How each part of the platform is behaving' },
  { to: '/logs', label: 'Logs by area', icon: IconStack2, hint: 'Every step one component recorded' },
  { to: '/settings', label: 'Settings', icon: IconSettings, hint: 'Log pull, thresholds, names and prices' },
];

export function Layout() {
  const [opened, { toggle, close }] = useDisclosure();
  const location = useLocation();
  useEffect(close, [location.pathname, close]);

  return (
    <AppShell header={{ height: 60 }} navbar={{ width: 232, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding="lg">
      <AppShell.Header className="app-header">
        <Group h="100%" px="md" justify="space-between" wrap="nowrap" gap="md">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Open navigation" />
            <UnstyledButton component={RouterLink} to="/live" className="brand">
              <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
                <rect width="32" height="32" rx="7" fill="#17233F" />
                <path d="M9 10h6M12 16h11M12 22h7" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
                <path d="M9 10v12" stroke="#2F5BEA" strokeWidth="2.6" strokeLinecap="round" />
              </svg>
              <span>
                <b>Complao</b> action log
              </span>
            </UnstyledButton>
          </Group>
          <GlobalSearch />
          <PullStatus />
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm" className="app-nav">
        <Stack gap={2} style={{ flex: 1 }}>
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              component={RouterLink}
              to={n.to}
              label={n.label}
              description={n.hint}
              leftSection={<n.icon size={18} stroke={1.7} />}
              active={location.pathname.startsWith(n.to) || (n.to === '/actions' && location.pathname.startsWith('/cases')) || (n.to === '/live' && location.pathname.startsWith('/sessions'))}
              styles={{ description: { fontSize: 11.5, lineHeight: 1.3 } }}
            />
          ))}
        </Stack>
        <SignOut />
      </AppShell.Navbar>

      <AppShell.Main className="app-main">
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}

/** R5: paste an action ID, a traceparent or a case ID and go straight there. */
function GlobalSearch() {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const go = async () => {
    const v = q.trim();
    if (!v) return;
    setBusy(true);
    try {
      const r = await api<{ kind: 'action' | 'case' | 'none'; actionId?: string; caseId?: string }>(`/search?q=${encodeURIComponent(v)}`);
      if (r.kind === 'action') navigate(`/actions/${r.actionId}`);
      else if (r.kind === 'case') navigate(`/cases/${encodeURIComponent(r.caseId!)}`);
      else notifications.show({ color: 'gray', title: 'Nothing found', message: 'No action or case has that ID. A new action appears after the next log pull.' });
      if (r.kind !== 'none') setQ('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <TextInput
      className="global-search"
      placeholder="Paste an action ID or case ID"
      aria-label="Search by action ID or case ID"
      leftSection={<IconSearch size={16} />}
      value={q}
      onChange={(e) => setQ(e.currentTarget.value)}
      onKeyDown={(e) => e.key === 'Enter' && go()}
      disabled={busy}
      visibleFrom="xs"
      style={{ flex: 1, maxWidth: 460 }}
      styles={{ input: { fontFamily: q ? 'var(--mantine-font-family-monospace)' : undefined } }}
    />
  );
}

/** R9: shows the pull setting and the time of the last successful pull. */
function PullStatus() {
  const { data } = useMeta();
  const [, setTick] = useState(0);
  const interval = useInterval(() => setTick((t) => t + 1), 10_000);
  useEffect(() => {
    interval.start();
    return interval.stop;
  }, [interval]);
  const navigate = useNavigate();
  if (!data) return <span style={{ width: 180 }} />;
  const p = data.pull;
  const every = p.intervalSeconds < 60 ? `${p.intervalSeconds} s` : p.intervalSeconds < 3600 ? `${p.intervalSeconds / 60} min` : `${p.intervalSeconds / 3600} h`;
  const lastOk = p.lastSuccessAt;
  const hasError = Boolean(p.lastError);

  return (
    <Tooltip
      multiline
      w={280}
      label={
        <Stack gap={2}>
          <Text size="xs">{p.paused ? 'Pulling is paused. New actions will not appear until it resumes.' : `Logs are pulled from CloudWatch every ${every}.`}</Text>
          <Text size="xs">Last successful pull: {lastOk ? fmtTimeSec(lastOk) : 'none yet'}</Text>
          {hasError && <Text size="xs">Last error: {p.lastError}</Text>}
          <Text size="xs" c="dimmed">
            Change this in Settings.
          </Text>
        </Stack>
      }
    >
      <UnstyledButton onClick={() => navigate('/settings')} className="pull-status" aria-label="Log pull status">
        <Badge
          variant="dot"
          color={p.paused ? 'gray' : hasError ? 'red' : 'green'}
          size="lg"
          styles={{ root: { textTransform: 'none', fontWeight: 500 } }}
        >
          {p.paused ? 'Paused' : `Every ${every}`}
        </Badge>
        <Text size="xs" c="dimmed" visibleFrom="md">
          {lastOk ? `Pulled ${fromNow(lastOk)}` : 'No pull yet'}
        </Text>
      </UnstyledButton>
    </Tooltip>
  );
}

function SignOut() {
  const qc = useQueryClient();
  const { data } = useMeta();
  return (
    <Stack gap={4} pt="sm" style={{ borderTop: '1px solid var(--mantine-color-gray-2)' }}>
      {data?.demo && (
        <Text size="xs" c="dimmed" px="sm">
          Demo data from a simulated log group.
        </Text>
      )}
      {!LOCAL_DEMO && <NavLink
        label="Sign out"
        leftSection={<IconLogout size={18} stroke={1.7} />}
        onClick={async () => {
          await api('/auth/logout', { method: 'POST' });
          qc.clear();
          location.assign('/login');
        }}
      />}
    </Stack>
  );
}
