import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import type { PortalConfig } from './types';

dayjs.extend(relativeTime);

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '–';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 1)} s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return s ? `${m} min ${s} s` : `${m} min`;
  }
  return fmtWait(ms);
}

/** Long gaps between journey stages: "2 days 4 h", "16 h", "35 min". */
export function fmtWait(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h${min % 60 && h < 6 ? ` ${min % 60} min` : ''}`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'}${h % 24 ? ` ${h % 24} h` : ''}`;
}

export const fmtTime = (iso: string) => dayjs(iso).format('D MMM HH:mm');
export const fmtTimeSec = (iso: string) => dayjs(iso).format('D MMM YYYY, HH:mm:ss');
export const fmtClock = (iso: string) => dayjs(iso).format('HH:mm:ss.SSS');
export const fromNow = (iso: string) => dayjs(iso).fromNow();

export const shortId = (id: string | null | undefined) => (id ? id.slice(0, 4) : '');

export function fmtCount(n: number): string {
  return n.toLocaleString('en-AU');
}

export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function fmtPct(r: number | null, digits = 1): string {
  if (r === null) return '–';
  const v = r * 100;
  return v === 100 ? '100%' : `${v.toFixed(digits)}%`;
}

function money(v: number, symbol: string): string {
  const abs = Math.abs(v);
  const digits = abs === 0 ? 2 : abs < 0.1 ? 3 : 2;
  return `${symbol}${v.toLocaleString('en-AU', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/**
 * AI cost is calculated in US dollars from the price table. It is shown in the configured
 * primary currency, with the other in brackets.
 */
export function fmtMoney(usd: number | null | undefined, cfg: PortalConfig['currency'] | undefined): string {
  if (usd === null || usd === undefined) return '–';
  if (!cfg || cfg.primary === 'USD') {
    const primary = money(usd, 'US$');
    return cfg?.showSecondary ? `${primary} (${money(usd * cfg.usdToAud, 'A$')})` : primary;
  }
  const aud = money(usd * cfg.usdToAud, 'A$');
  return cfg.showSecondary ? `${aud} (${money(usd, 'US$')})` : aud;
}

export function moneyPrimary(usd: number, cfg: PortalConfig['currency'] | undefined): string {
  if (!cfg || cfg.primary === 'USD') return money(usd, 'US$');
  return money(usd * cfg.usdToAud, 'A$');
}

/** "anthropic.claude-sonnet-4-5-20250929-v1:0" → "claude-sonnet-4-5" */
export function shortModel(m: unknown): string {
  const s = String(m ?? '');
  return s.replace(/^[a-z]+\./, '').replace(/-\d{8}.*$/, '').replace(/-v\d+(:\d+)?$/, '') || s;
}

export function humanKey(k: string): string {
  const t = k.replace(/_ids?$/, (m) => (m === '_ids' ? 's' : '')).replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function deltaPct(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null || prev === 0) return null;
  return (cur - prev) / prev;
}
