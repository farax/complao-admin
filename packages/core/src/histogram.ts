/**
 * Latency histogram (section 6.4). Percentiles cannot be combined across windows,
 * histograms can, so each 5-minute window keeps bucket counts and the portal adds them up.
 *
 * Buckets are geometric with ratio 1.2 from 1 ms, so a percentile is accurate to about ±10%.
 * Bucket i holds latencies in (BOUNDS[i-1], BOUNDS[i]]. The last bucket is open-ended.
 */
const RATIO = 1.2;
const COUNT = 80; // 1.2^79 ms ≈ 1.8M ms ≈ 30 minutes

export const BUCKET_BOUNDS: number[] = Array.from({ length: COUNT }, (_, i) =>
  i === COUNT - 1 ? Number.POSITIVE_INFINITY : Math.round(Math.pow(RATIO, i) * 1000) / 1000,
);

export function bucketIndex(ms: number): number {
  if (ms <= 1) return 0;
  const i = Math.ceil(Math.log(ms) / Math.log(RATIO) - 1e-9);
  return Math.min(Math.max(i, 0), COUNT - 1);
}

export function emptyBuckets(): number[] {
  return new Array(COUNT).fill(0);
}

export function mergeBuckets(into: number[], from: number[]): number[] {
  for (let i = 0; i < COUNT; i++) into[i] += from[i] ?? 0;
  return into;
}

/**
 * Percentile from a histogram. Returns the geometric midpoint of the bucket that holds
 * the requested rank, capped by the observed maximum.
 */
export function percentile(buckets: number[], p: number, maxMs?: number): number | null {
  const total = buckets.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * total));
  let seen = 0;
  for (let i = 0; i < buckets.length; i++) {
    seen += buckets[i];
    if (seen >= rank) {
      const lo = i === 0 ? 0 : BUCKET_BOUNDS[i - 1];
      const hi = BUCKET_BOUNDS[i];
      const mid = !Number.isFinite(hi) ? lo : i === 0 ? hi : Math.sqrt(lo * hi);
      return maxMs !== undefined && maxMs > 0 ? Math.min(mid, maxMs) : mid;
    }
  }
  return maxMs ?? null;
}
