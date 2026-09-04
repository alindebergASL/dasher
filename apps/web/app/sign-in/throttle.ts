/**
 * In-memory sliding-window rate limit, keyed by caller.
 *
 * Per process and per window only: it bounds how fast one address can hit the
 * sign-in form on this instance, and nothing more. The database's per-email
 * hourly limit remains the limit that matters; this keeps a burst from reaching
 * it at all.
 */
export class SlidingWindowThrottle {
  private readonly hits = new Map<string, number[]>();

  /**
   * @param limit    Calls allowed per key within one window.
   * @param windowMs Window length in milliseconds.
   * @param maxKeys  Distinct keys kept; the oldest is evicted past this.
   */
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("limit must be a positive integer");
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError("windowMs must be positive");
    }
    if (!Number.isInteger(maxKeys) || maxKeys < 1) {
      throw new RangeError("maxKeys must be a positive integer");
    }
  }

  /** Records a call for `key` and reports whether it fits within the limit. */
  allow(key: string, now: number = Date.now()): boolean {
    const floor = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > floor);

    if (recent.length >= this.limit) {
      this.remember(key, recent);
      return false;
    }

    recent.push(now);
    this.remember(key, recent);
    return true;
  }

  /** Distinct keys currently held. */
  get size(): number {
    return this.hits.size;
  }

  private remember(key: string, recent: number[]): void {
    // Delete-then-set keeps insertion order equal to recency, so the first
    // entry is always the least recently seen key.
    this.hits.delete(key);
    if (recent.length === 0) return;
    this.hits.set(key, recent);
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
  }
}

/**
 * The caller's address as the nearest proxy reported it.
 *
 * First `x-forwarded-for` hop, else `x-real-ip`, else `"unknown"`. Both headers
 * are client-influenced unless a trusted proxy overwrites them, so this is a
 * throttle key and never an identity.
 */
export function clientKey(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded !== null) {
    const first = forwarded.split(",")[0]?.trim();
    if (first !== undefined && first !== "") return first;
  }
  const real = headers.get("x-real-ip")?.trim();
  if (real !== undefined && real !== "") return real;
  return "unknown";
}
