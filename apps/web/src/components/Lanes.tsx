import { Text, Tooltip } from '@mantine/core';
import dayjs from 'dayjs';
import type { ReactNode } from 'react';
import { fmtMs } from '../lib/format';
import type { Lane, LaneItem, Names } from '../lib/types';
import { useDisplayNames } from './bits';
import { STATUS_META } from './StatusBadge';

export interface LaneGroupView {
  key: string;
  title: ReactNode;
  aside?: ReactNode;
  lanes: Lane[];
}

interface Props {
  groups: LaneGroupView[];
  from: number;
  to: number;
  names: Names;
  selectedId?: string | null;
  onSelect: (item: LaneItem, lane: Lane) => void;
  onPersonClick?: (lane: Lane) => void;
  /** Pause live updates while the pointer is over the lanes, so bars don't move under it. */
  onHoverChange?: (hovering: boolean) => void;
  /** A vertical "now" marker at the right edge. */
  live?: boolean;
}

/**
 * Swimlanes (R23, R24): one row per person, one bar per action, grouped by case.
 * The bar's length is how long the action took; running bars reach to "now".
 */
export function Lanes({ groups, from, to, names, selectedId, onSelect, onPersonClick, onHoverChange, live }: Props) {
  const dn = useDisplayNames();
  const span = Math.max(1, to - from);
  const pos = (iso: string) => ((new Date(iso).getTime() - from) / span) * 100;
  const multiDay = span > 20 * 3_600_000;
  const ticks = Array.from({ length: 5 }, (_, i) => from + (span * i) / 4);

  return (
    <div className="lanes" onPointerEnter={() => onHoverChange?.(true)} onPointerLeave={() => onHoverChange?.(false)}>
      <div className="lanes-axis" aria-hidden>
        <div />
        <div className="lanes-ticks">
          {ticks.map((t, i) => (
            <span key={i} style={{ left: `${(i / 4) * 100}%` }} className={live && i === 4 ? 'now' : undefined}>
              {live && i === 4 ? 'now' : dayjs(t).format(multiDay ? 'D MMM HH:mm' : 'HH:mm')}
            </span>
          ))}
        </div>
      </div>

      {groups.map((g) => (
        <section key={g.key} className="lanes-group" aria-label={typeof g.title === 'string' ? g.title : undefined}>
          <div className="lanes-group-head">
            <div>{g.title}</div>
            {g.aside}
          </div>
          {g.lanes.map((lane) => (
            <div className="lane" key={lane.actorId}>
              <button
                type="button"
                className="lane-who"
                onClick={() => onPersonClick?.(lane)}
                disabled={!onPersonClick}
                title={onPersonClick ? 'Open this person’s session' : undefined}
              >
                <span className="lane-name">{names[lane.actorId] ?? lane.actorId}</span>
                {lane.actorRole && <span className="lane-role">{lane.actorRole}</span>}
              </button>
              <div className="lane-track">
                {ticks.slice(1, 4).map((_, i) => (
                  <span key={i} className="lane-grid" style={{ left: `${((i + 1) / 4) * 100}%` }} />
                ))}
                {lane.items.map((it) => {
                  const end = it.endedAt ? new Date(it.endedAt).getTime() : to;
                  if (end < from || new Date(it.startedAt).getTime() > to) return null;
                  const left = Math.max(0, pos(it.startedAt));
                  const right = Math.min(100, ((end - from) / span) * 100);
                  const label = it.kind === 'login' ? 'Signed in' : it.kind === 'logout' ? 'Signed out' : dn.type(it.actionType);
                  const ms = end - new Date(it.startedAt).getTime();
                  const tip = (
                    <div>
                      <div style={{ fontWeight: 500 }}>{label}</div>
                      <div>
                        {dayjs(it.startedAt).format('HH:mm:ss')}
                        {it.kind === 'action' ? ` · ${it.endedAt ? fmtMs(ms) : `running ${fmtMs(ms)}`} · ${STATUS_META[it.status].label}` : it.status === 'failed' ? ' · failed' : ''}
                      </div>
                    </div>
                  );
                  if (it.kind !== 'action') {
                    return (
                      <Tooltip key={it.actionId} label={tip}>
                        <button
                          type="button"
                          aria-label={`${label}, ${names[lane.actorId] ?? ''}`}
                          className={`lane-pin ${it.kind}${it.status === 'failed' ? ' failed' : ''}${selectedId === it.actionId ? ' sel' : ''}`}
                          style={{ left: `${left}%` }}
                          onClick={() => onSelect(it, lane)}
                        />
                      </Tooltip>
                    );
                  }
                  const cls = it.endedAt === null ? 'running' : it.status;
                  return (
                    <Tooltip key={it.actionId} label={tip}>
                      <button
                        type="button"
                        aria-label={`${label} by ${names[lane.actorId] ?? ''}: ${STATUS_META[it.status].label}`}
                        className={`lane-bar ${cls}${selectedId === it.actionId ? ' sel' : ''}`}
                        style={{ left: `${left}%`, width: `${Math.max(0, right - left)}%` }}
                        onClick={() => onSelect(it, lane)}
                      />
                    </Tooltip>
                  );
                })}
              </div>
            </div>
          ))}
        </section>
      ))}

      <div className="lanes-legend">
        <span><i className="lane-bar running" />Running</span>
        <span><i className="lane-bar completed" />Finished</span>
        <span><i className="lane-bar partial" />Partial</span>
        <span><i className="lane-bar failed" />Failed</span>
        <span><i className="lane-bar stalled" />Stalled</span>
        <span><i className="lane-pin login" />Signed in</span>
        <span><i className="lane-pin logout" />Signed out</span>
        {onHoverChange && (
          <Text span size="xs" c="dimmed" ml="auto">
            Updates pause while your pointer is over the timeline.
          </Text>
        )}
      </div>
    </div>
  );
}
