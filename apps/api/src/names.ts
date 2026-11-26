/**
 * R15: user IDs are resolved to names when a page is displayed, through a read-only lookup.
 * Names are never written to the action store. A short in-memory cache avoids a lookup per
 * row; it lives only in this process and expires after a few minutes.
 */
export interface NameResolver {
  resolve(ids: string[]): Promise<Record<string, string>>;
}

export function httpResolver(url: string, token?: string): NameResolver {
  return cached(async (ids) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ ids }),
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) throw new Error(`user lookup ${res.status}`);
    const body = (await res.json()) as Record<string, string> | { names: Record<string, string> };
    return 'names' in body && typeof body.names === 'object' ? (body.names as Record<string, string>) : (body as Record<string, string>);
  });
}

/** Fallback when no lookup is configured: show the ID itself. */
export const idResolver: NameResolver = { resolve: async (ids) => Object.fromEntries(ids.map((i) => [i, i])) };

export function cached(lookup: (ids: string[]) => Promise<Record<string, string>>, ttlMs = 5 * 60_000): NameResolver {
  const cache = new Map<string, { name: string; at: number }>();
  return {
    async resolve(ids) {
      const now = Date.now();
      const unique = [...new Set(ids.filter(Boolean))];
      const missing = unique.filter((id) => {
        const c = cache.get(id);
        return !c || now - c.at > ttlMs;
      });
      if (missing.length) {
        try {
          for (let i = 0; i < missing.length; i += 100) {
            const found = await lookup(missing.slice(i, i + 100));
            for (const id of missing.slice(i, i + 100)) cache.set(id, { name: found[id] ?? id, at: now });
          }
        } catch {
          // The lookup is display-only: on failure show IDs rather than fail the page.
          return Object.fromEntries(unique.map((u) => [u, cache.get(u)?.name ?? u]));
        }
      }
      return Object.fromEntries(unique.map((id) => [id, cache.get(id)?.name ?? id]));
    },
  };
}

/** Detail keys that carry user IDs and should be shown as names. */
export const USER_ID_DETAIL_KEYS = ['participant_ids', 'participants', 'user_id', 'user_ids', 'approver_id', 'reviewer_id', 'auditor_id', 'applicant_id'];

export function collectUserIds(details: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of USER_ID_DETAIL_KEYS) {
    const v = details[k];
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) out.push(...v.map(String));
  }
  return out;
}
