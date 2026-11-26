import { Alert, Anchor, Badge, Button, Group, Loader, Paper, Stack, Text, Title, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconArrowLeft, IconChevronDown, IconChevronRight, IconRoute } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Fragment, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { IdText, useDisplayNames } from '../components/bits';
import { IncompleteBadge, StatusBadge } from '../components/StatusBadge';
import { api, useLiveInterval, useMeta } from '../lib/api';
import { fmtClock, fmtMoney, fmtMs, fmtTime, fmtTimeSec, fmtTokens, humanKey, shortModel } from '../lib/format';
import type { ActionDetailResponse, Names, PortalConfig, StepView } from '../lib/types';

export function ActionDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data: meta } = useMeta();
  const live = useLiveInterval();
  const dn = useDisplayNames();
  // R16: one view record per opening. Live refreshes of a running action pass refresh=1.
  const opened = useRef<string | null>(null);
  const q = useQuery({
    queryKey: ['action', id],
    queryFn: () => {
      const refresh = opened.current === id;
      opened.current = id;
      return api<ActionDetailResponse>(`/actions/${id}${refresh ? '?refresh=1' : ''}`);
    },
    // Running actions keep updating; finished ones are fixed, so no polling and no extra view records.
    refetchInterval: (query) => (query.state.data && query.state.data.action.status === 'in_progress' ? live : false),
    refetchOnWindowFocus: false,
  });

  if (q.isLoading) return <Loader m="xl" />;
  if (q.isError || !q.data)
    return (
      <Stack align="flex-start">
        <Back />
        <Alert color="gray" title="Action not found">
          {(q.error as Error)?.message}
        </Alert>
      </Stack>
    );

  const d = q.data;
  const a = d.action;
  const currency = meta?.config.currency;
  const otherInCase = d.journey.filter((j) => j.actionId !== a.actionId);

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Back />
        <Text size="xs" c="dimmed">
          Opened {d.views} time{d.views === 1 ? '' : 's'}
        </Text>
      </Group>

      {/* ---------------- header */}
      <Paper p="lg" radius="md">
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
          <Stack gap={6}>
            <Group gap="sm">
              <Title order={1}>{dn.type(a.actionType)}</Title>
              <StatusBadge status={a.status} />
              {a.incomplete && <IncompleteBadge />}
            </Group>
            <Text size="sm" c="dimmed">
              Started {fmtTimeSec(a.startedAt)} by <b style={{ color: 'var(--ink-text)', fontWeight: 500 }}>{a.actorId ? d.names[a.actorId] ?? a.actorId : 'unknown'}</b>
            </Text>
          </Stack>
          <Group gap="xl" wrap="wrap">
            <Fact label="Duration" value={a.durationMs !== null ? fmtMs(a.durationMs) : `running for ${fmtMs(a.runningForMs)}`} />
            <Fact label="Steps" value={`${a.stepCount}${a.failedSteps ? ` (${a.failedSteps} failed)` : ''}`} />
            {a.aiCalls > 0 && <Fact label={`AI cost, ${a.aiCalls} call${a.aiCalls === 1 ? '' : 's'}`} value={fmtMoney(a.aiCostUsd, currency)} />}
            {a.aiCalls > 0 && <Fact label="Tokens" value={`${fmtTokens(a.tokensIn)} in, ${fmtTokens(a.tokensOut)} out`} />}
          </Group>
        </Group>
        <Group gap="lg" mt="md" wrap="wrap">
          <Group gap={6}>
            <Text size="sm" c="dimmed">
              Action ID
            </Text>
            <IdText id={a.actionId} chars={12} />
          </Group>
          {a.caseId && (
            <Group gap={6}>
              <Text size="sm" c="dimmed">
                Case ID
              </Text>
              <IdText id={a.caseId} chars={13} />
            </Group>
          )}
          <Text size="sm" c="dimmed">
            {otherInCase.length === 0 ? (a.caseId ? 'No other actions on this case' : 'Not linked to a case') : null}
          </Text>
        </Group>

        {otherInCase.length > 0 && (
          <Paper withBorder={false} bg="var(--paper)" p="sm" mt="md" radius="sm">
            <Group justify="space-between" mb={6}>
              <Text size="sm" fw={500}>
                This case has {d.journey.length} actions
              </Text>
              <Button size="compact-sm" variant="light" leftSection={<IconRoute size={15} />} onClick={() => navigate(`/cases/${encodeURIComponent(a.caseId!)}`)}>
                View the whole journey
              </Button>
            </Group>
            <Group gap={6} wrap="wrap">
              {d.journey.map((j, i) => (
                <Fragment key={j.actionId}>
                  {i > 0 && <IconChevronRight size={14} color="var(--mantine-color-gray-5)" />}
                  {j.actionId === a.actionId ? (
                    <Badge variant="filled" color="navy.9" size="lg" radius="sm" styles={{ label: { fontWeight: 500 } }}>
                      {dn.type(j.actionType)} · {fmtTime(j.startedAt)}
                    </Badge>
                  ) : (
                    <Anchor component={Link} to={`/actions/${j.actionId}`} size="sm">
                      {dn.type(j.actionType)} · {fmtTime(j.startedAt)}
                    </Anchor>
                  )}
                </Fragment>
              ))}
            </Group>
          </Paper>
        )}
      </Paper>

      {d.missing.incomplete && (
        <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={18} />} title="Some events did not arrive">
          {d.missing.missingStart && 'The start event for this action is missing. '}
          {d.missing.missingParents.length > 0 &&
            `${d.missing.missingParents.length} step${d.missing.missingParents.length === 1 ? ' is' : 's are'} missing, so ${d.missing.missingParents.length === 1 ? 'its children are' : 'their children are'} shown at the top level. `}
          Logging never holds up a customer's action, so an event can be lost when a send fails.
        </Alert>
      )}

      <StepTree steps={d.steps} spanMs={d.spanMs} names={d.names} cfg={meta?.config} />
      <Text size="xs" c="dimmed">
        Bars show when each step ran within the action. The slowest step is highlighted; failed steps are red and opened. Select any step for its full record.
      </Text>
    </Stack>
  );
}

function Back() {
  const navigate = useNavigate();
  return (
    <Button variant="subtle" color="gray" size="compact-sm" leftSection={<IconArrowLeft size={15} />} onClick={() => (history.length > 1 ? navigate(-1) : navigate('/actions'))}>
      Back
    </Button>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <Stack gap={0}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="lg" fw={500} className="num">
        {value}
      </Text>
    </Stack>
  );
}

// ---------------------------------------------------------------- the tree (R6)

function StepTree({ steps, spanMs, names, cfg }: { steps: StepView[]; spanMs: number; names: Names; cfg?: PortalConfig }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(() => new Set(steps.filter((s) => s.status === 'failure').map((s) => s.stepId)));
  const dn = useDisplayNames();

  // Which steps are visible (ancestors not collapsed), and the guide-line shape for each.
  const rows = useMemo(() => {
    const byId = new Map(steps.map((s) => [s.stepId, s]));
    const lastChild = new Set<string>();
    const kids = new Map<string | null, StepView[]>();
    for (const s of steps) {
      const k = s.parentStepId && byId.has(s.parentStepId) ? s.parentStepId : null;
      kids.set(k, [...(kids.get(k) ?? []), s]);
    }
    for (const list of kids.values()) lastChild.add(list[list.length - 1].stepId);
    const hidden = (s: StepView): boolean => {
      let p = s.parentStepId ? byId.get(s.parentStepId) : undefined;
      while (p) {
        if (collapsed.has(p.stepId)) return true;
        p = p.parentStepId ? byId.get(p.parentStepId) : undefined;
      }
      return false;
    };
    return steps
      .filter((s) => !hidden(s))
      .map((s) => {
        // For each ancestor level, draw a continuing line if that ancestor has later siblings.
        const chain: boolean[] = [];
        let p = s.parentStepId ? byId.get(s.parentStepId) : undefined;
        while (p) {
          chain.unshift(!lastChild.has(p.stepId));
          p = p.parentStepId ? byId.get(p.parentStepId) : undefined;
        }
        // The root ancestor has no guide column; the step's own level is drawn as the elbow.
        return { s, continuing: chain.slice(1), isLast: lastChild.has(s.stepId) };
      });
  }, [steps, collapsed]);

  if (!steps.length)
    return (
      <Paper p="xl">
        <Text c="dimmed" ta="center">
          No steps have arrived for this action yet. They appear after the next log pull.
        </Text>
      </Paper>
    );

  const toggle = (set: Set<string>, id: string) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  };

  return (
    <div className="trace" role="table" aria-label="Steps in this action">
      <div className="trace-head" role="row">
        <div role="columnheader">Step</div>
        <div role="columnheader" style={{ textAlign: 'right' }}>
          Latency
        </div>
        <div role="columnheader">Response</div>
        <div role="columnheader">Timeline</div>
      </div>
      {rows.map(({ s, continuing, isLast }) => {
        const failed = s.status === 'failure';
        const isOpen = open.has(s.stepId);
        const left = Math.max(0, Math.min(100, (s.offsetMs / spanMs) * 100));
        const width = Math.max(0.4, Math.min(100 - left, (s.latencyMs / spanMs) * 100));
        const isAi = s.aiCostUsd !== null;
        return (
          <div
            key={s.stepId}
            role="row"
            tabIndex={0}
            className={`trace-row${s.slowest ? ' is-slowest' : ''}${failed ? ' is-failed' : ''}`}
            onClick={() => setOpen((o) => toggle(o, s.stepId))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setOpen((o) => toggle(o, s.stepId));
              }
            }}
            aria-expanded={isOpen}
          >
            <div className="cell" role="cell">
              <div className="step-name">
                <span className="guides" aria-hidden>
                  {continuing.map((c, i) => (
                    <span key={i} className="guide" style={c ? undefined : { visibility: 'hidden' }} />
                  ))}
                  {s.depth > 0 || s.orphan ? <span className={`guide elbow${isLast ? ' last' : ''}`} /> : null}
                </span>
                {s.hasChildren ? (
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={collapsed.has(s.stepId) ? 'Show child steps' : 'Hide child steps'}
                    onClick={(e) => {
                      e.stopPropagation();
                      setCollapsed((c) => toggle(c, s.stepId));
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.stopPropagation();
                        setCollapsed((c) => toggle(c, s.stepId));
                      }
                    }}
                    style={{ display: 'inline-flex', paddingTop: 2, color: 'var(--mantine-color-gray-6)' }}
                  >
                    {collapsed.has(s.stepId) ? <IconChevronRight size={15} /> : <IconChevronDown size={15} />}
                  </span>
                ) : (
                  <span style={{ width: 15, flex: 'none' }} />
                )}
                <div style={{ minWidth: 0 }}>
                  <div className="step-label">
                    {s.stepName}
                    {s.orphan && (
                      <Tooltip label="This step's parent never arrived.">
                        <Badge ml={6} size="xs" color="gray" variant="outline">
                          parent missing
                        </Badge>
                      </Tooltip>
                    )}
                  </div>
                  <Summary s={s} names={names} cfg={cfg} />
                </div>
              </div>
            </div>
            <div className="cell num" role="cell" style={{ textAlign: 'right', fontWeight: s.slowest ? 600 : undefined }}>
              {fmtMs(s.latencyMs)}
            </div>
            <div className="cell num" role="cell" style={{ color: failed ? 'var(--mantine-color-red-7)' : undefined }}>
              {s.responseCode ?? '–'}
            </div>
            <div className="cell tl" role="cell">
              <Tooltip label={`Starts at +${fmtMs(s.offsetMs)}, runs ${fmtMs(s.latencyMs)}`}>
                <div className="timeline">
                  <div className="track" />
                  <div className={`bar${isAi ? ' ai' : ''}`} style={{ left: `${left}%`, width: `${width}%` }} />
                </div>
              </Tooltip>
            </div>
            {isOpen && (
              <div className="trace-detail" onClick={(e) => e.stopPropagation()}>
                <Paper p="sm" radius="sm" withBorder bg="white">
                  <dl className="kv">
                    <dt>Status</dt>
                    <dd>
                      {failed ? (s.serverFailure ? 'Failed, server side' : 'Failed, rejected request (does not mark the component Degraded)') : s.status === 'skipped' ? 'Skipped' : 'Succeeded'}
                    </dd>
                    <dt>Component</dt>
                    <dd>{dn.component(s.component)}</dd>
                    <dt>Started</dt>
                    <dd className="num">
                      {fmtClock(s.startedAt)} (+{fmtMs(s.offsetMs)})
                    </dd>
                    <dt>Step ID</dt>
                    <dd>
                      <IdText id={s.stepId} chars={24} size="xs" />
                    </dd>
                    {Object.entries(s.details).map(([k, v]) => (
                      <Fragment key={k}>
                        <dt>{humanKey(k)}</dt>
                        <dd>{renderValue(k, v, names)}</dd>
                      </Fragment>
                    ))}
                    {s.aiCostUsd !== null && (
                      <>
                        <dt>AI cost</dt>
                        <dd>{fmtMoney(s.aiCostUsd, cfg?.currency)}</dd>
                      </>
                    )}
                  </dl>
                </Paper>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const USER_KEYS = ['participant_ids', 'participants', 'user_id', 'user_ids', 'approver_id', 'reviewer_id', 'auditor_id', 'applicant_id'];

function renderValue(k: string, v: unknown, names: Names): string {
  if (USER_KEYS.includes(k)) return (Array.isArray(v) ? v : [v]).map((x) => names[String(x)] ?? String(x)).join(', ');
  if (k === 'model') return String(v);
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'number') return v.toLocaleString('en-AU');
  return String(v);
}

/** The one-line, type-specific summary under a step name (section 4.2). */
function Summary({ s, names, cfg }: { s: StepView; names: Names; cfg?: PortalConfig }) {
  const d = s.details;
  const parts: string[] = [];
  if (d.model !== undefined) {
    parts.push(shortModel(d.model));
    if (d.input_tokens !== undefined) parts.push(`${fmtTokens(Number(d.input_tokens))} tokens in, ${fmtTokens(Number(d.output_tokens ?? 0))} out`);
    if (s.aiCostUsd !== null) parts.push(fmtMoney(s.aiCostUsd, cfg?.currency));
  }
  const people = d.participant_ids ?? d.participants;
  if (people) parts.push(`Participants: ${(Array.isArray(people) ? people : [people]).map((p) => names[String(p)] ?? p).join(', ')}`);
  if (d.sign_in_method) parts.push(`Signed in with ${d.sign_in_method}`);
  if (d.error_code) parts.push(String(d.error_code));
  if (d.reason_code) parts.push(String(d.reason_code).replace(/_/g, ' '));
  if (d.document_count !== undefined) parts.push(`${d.document_count} documents`);
  if (d.decision) parts.push(`Decision: ${String(d.decision).replace(/_/g, ' ')}`);
  if (d.file_type) parts.push(`${String(d.file_type).toUpperCase()}, ${Number(d.size_kb ?? 0).toLocaleString('en-AU')} KB`);
  if (d.purpose && !parts.length) parts.push(String(d.purpose));
  if (!parts.length) return null;
  return <div className="step-sub">{parts.join(' · ')}</div>;
}

