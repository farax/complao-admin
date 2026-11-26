import { useQuery } from '@tanstack/react-query';
import type { Meta } from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const LOCAL_DEMO = import.meta.env.VITE_LOCAL_DEMO === '1';

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  if (LOCAL_DEMO) {
    const { localApi } = await import('../demo/local-api');
    try {
      return (await localApi(path, init?.method ?? 'GET', init?.json)) as T;
    } catch (e) {
      throw new ApiError((e as { status?: number }).status ?? 500, (e as Error).message);
    }
  }
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { ...(init?.json !== undefined ? { 'content-type': 'application/json' } : {}), ...init?.headers },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/auth/')) {
    if (!location.pathname.startsWith('/login')) location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  }
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

export function qs(params: Record<string, string | number | boolean | undefined | null | string[]>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Registry, config and pull setting. Refreshes every 30 s so the header's pull time stays current. */
export function useMeta() {
  return useQuery({ queryKey: ['meta'], queryFn: () => api<Meta>('/meta'), refetchInterval: 30_000, staleTime: 10_000 });
}

/** How often list views should re-read the store: about twice per pull, never faster than 15 s. */
export function useLiveInterval(): number | false {
  const { data } = useMeta();
  if (!data || data.pull.paused) return false;
  return Math.max(15_000, Math.min(60_000, (data.pull.intervalSeconds * 1000) / 2));
}
